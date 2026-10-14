import {mkdir, appendFile, realpath} from 'node:fs/promises';
import {resolve, join} from 'node:path';

import {Metadata} from '@grpc/grpc-js';
import {createContextKey, type Context} from '@opentelemetry/api';
import {OTLPTraceExporter as GrpcExporter} from '@opentelemetry/exporter-trace-otlp-grpc';
import {OTLPTraceExporter as JsonExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {OTLPTraceExporter as ProtoExporter} from '@opentelemetry/exporter-trace-otlp-proto';
import {JsonTraceSerializer} from '@opentelemetry/otlp-transformer';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
  type Span,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

import {interpolateSecretReferences, readSecretFile} from '../secrets.js';

const routes = createContextKey('stratos.trace.destinations');
const configSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('file'), path: z.string().min(1)}),
  z.strictObject({
    type: z.literal('otlp'),
    endpoint: z.string().min(1),
    protocol: z.enum(['http/json', 'http/protobuf', 'grpc']),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
type Destination = {key: string; processor: BatchSpanProcessor};
const credentialKey =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|cookie/i;

/** One provider per top-level execution; no process-global provider/context mutation. */
export class RunTelemetry implements SpanProcessor {
  readonly provider = new BasicTracerProvider({spanProcessors: [this]});
  readonly tracer = this.provider.getTracer('stratos');
  private readonly destinations = new Set<Destination>();
  private readonly spans = new Map<string, Destination[]>();
  private readonly secrets = new Set<string>();
  constructor() {
    for (const [key, value] of Object.entries(process.env)) {
      if (credentialKey.test(key) && value) {
        this.addSecret(value);
      }
    }
  }
  addSecret(value: string) {
    if (value) {
      this.secrets.add(value);
      if (/^Bearer /i.test(value)) {
        this.secrets.add(value.slice(7));
      }
    }
  }
  private warning() {
    try {
      console.error(
        'Stratos telemetry export failed; workflow execution continues',
      );
    } catch {
      // An unavailable diagnostic stream must not fail the workflow.
    }
  }
  redact(value: unknown, ancestors = new Set<object>()): unknown {
    if (typeof value === 'string') {
      let result = value;
      for (const secret of this.secrets) {
        result = result.split(secret).join('[redacted]');
      }
      try {
        const object = JSON.parse(result);
        if (object && typeof object === 'object') {
          return JSON.stringify(this.redact(object));
        }
      } catch {
        // Non-JSON strings still receive literal-secret redaction above.
      }
      return result;
    }
    if (value && typeof value === 'object') {
      if (ancestors.has(value)) {
        return '[Circular]';
      }
      ancestors.add(value);
      try {
        if (value instanceof Date) {
          return new Date(value);
        }
        if (value instanceof RegExp) {
          return new RegExp(
            String(this.redact(value.source, ancestors)),
            value.flags,
          );
        }
        if (value instanceof Map) {
          return new Map(
            [...value].map(([key, item]) => [
              this.redact(key, ancestors),
              typeof key === 'string' && credentialKey.test(key)
                ? '[redacted]'
                : this.redact(item, ancestors),
            ]),
          );
        }
        if (value instanceof Set) {
          return new Set([...value].map(item => this.redact(item, ancestors)));
        }
        if (Buffer.isBuffer(value)) {
          return Buffer.from(
            String(this.redact(value.toString('utf8'), ancestors)),
          );
        }
        if (value instanceof Error) {
          const clean = new Error(
            String(this.redact(value.message, ancestors)),
          );
          clean.name = String(this.redact(value.name, ancestors));
          clean.stack =
            value.stack === undefined
              ? undefined
              : String(this.redact(value.stack, ancestors));
          if (value.cause !== undefined) {
            clean.cause = this.redact(value.cause, ancestors);
          }
          return Object.assign(
            clean,
            this.redact(Object.fromEntries(Object.entries(value)), ancestors),
          );
        }
        if (Array.isArray(value)) {
          return value.map(item => this.redact(item, ancestors));
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            credentialKey.test(key)
              ? '[redacted]'
              : this.redact(item, ancestors),
          ]),
        );
      } finally {
        ancestors.delete(value);
      }
    }
    return value;
  }
  async context(
    parent: Context,
    raw: unknown,
    cwd: string,
    root: string,
    name: string,
    id: string,
  ): Promise<Context> {
    const inherited =
      (parent.getValue(routes) as Destination[] | undefined) ?? [];
    if (raw === undefined) {
      return parent.setValue(routes, inherited);
    }
    try {
      const config = configSchema.parse(raw);
      let exporter: SpanExporter;
      let key: string;
      if (config.type === 'file') {
        await mkdir(resolve(cwd, config.path), {recursive: true});
        const directory = await realpath(resolve(cwd, config.path));
        key = JSON.stringify(['file', directory]);
        const existing = inherited.find(item => item.key === key);
        if (existing) {
          return parent;
        }
        const file = join(
          directory,
          `${new Date().toISOString().replaceAll(':', '-')}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${id}.jsonl`,
        );
        let writes = Promise.resolve();
        exporter = {
          export: (spans, callback) => {
            writes = writes.then(async () => {
              const bytes = JsonTraceSerializer.serializeRequest(spans);
              if (!bytes) {
                throw new Error();
              }
              await appendFile(
                file,
                Buffer.from(bytes).toString('utf8') + '\n',
                {mode: 0o600},
              );
            });
            void writes.then(
              () => callback({code: 0}),
              () => {
                this.warning();
                callback({code: 1});
              },
            );
          },
          shutdown: () => writes,
        };
      } else {
        const headers: Record<string, string> = {};
        for (const [header, template] of Object.entries(
          config.headers ?? {},
        ).sort(([a], [b]) => a.localeCompare(b))) {
          const value = await interpolateSecretReferences(
            template,
            async (kind, name) => {
              let secret: string | undefined;
              if (kind === 'env') {
                secret = process.env[name];
              } else {
                secret = await readSecretFile(name, root, info => {
                  if (!info.isFile()) {
                    throw new Error();
                  }
                });
              }
              if (secret === undefined) {
                throw new Error();
              }
              this.addSecret(secret);
              return secret;
            },
          );
          if (/[\r\n]/.test(value) || !/^[!#$%&'*+.^_`|~\w-]+$/.test(header)) {
            throw new Error();
          }
          headers[header] = value;
          // References are registered above; literal non-auth headers are not secrets.
          if (
            credentialKey.test(header) ||
            /(?:^|[-_])(?:auth|token|secret|key|credentials?)(?:$|[-_])/i.test(
              header,
            )
          ) {
            this.addSecret(value);
          }
        }
        const url = new URL(config.endpoint);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new Error();
        }
        key = JSON.stringify([config.protocol, url.href, headers]);
        if (inherited.some(item => item.key === key)) {
          return parent;
        }
        const options = {url: config.endpoint, headers};
        exporter =
          config.protocol === 'http/json'
            ? new JsonExporter(options)
            : config.protocol === 'http/protobuf'
              ? new ProtoExporter(options)
              : new GrpcExporter({
                  url: config.endpoint,
                  metadata: (() => {
                    const metadata = new Metadata();
                    for (const [key, value] of Object.entries(headers)) {
                      metadata.set(key, value);
                    }
                    return metadata;
                  })(),
                });
      }
      const native = exporter;
      const safe: SpanExporter = {
        export: (spans, callback) => {
          try {
            native.export(spans, result => {
              if (result.code !== 0) {
                this.warning();
              }
              callback(result.code === 0 ? {code: 0} : {code: 1});
            });
          } catch {
            this.warning();
            callback({code: 1});
          }
        },
        shutdown: async () => {
          try {
            await native.shutdown();
          } catch {
            this.warning();
          }
        },
      };
      const destination = {key, processor: new BatchSpanProcessor(safe)};
      this.destinations.add(destination);
      return parent.setValue(routes, [...inherited, destination]);
    } catch {
      this.warning();
      return parent.setValue(routes, inherited);
    }
  }
  onStart(span: Span, parent: Context) {
    this.spans.set(
      span.spanContext().spanId,
      (parent.getValue(routes) as Destination[] | undefined) ?? [],
    );
  }
  onEnd(span: ReadableSpan) {
    const destinations = this.spans.get(span.spanContext().spanId) ?? [];
    this.spans.delete(span.spanContext().spanId);
    // Preserve SDK methods/prototype while replacing only credential-bearing fields.
    const clean = Object.create(span) as ReadableSpan;
    Object.defineProperties(clean, {
      attributes: {value: this.redact(span.attributes)},
      events: {
        value: span.events.map(event => ({
          ...event,
          attributes: this.redact(event.attributes),
        })),
      },
      status: {value: this.redact(span.status)},
    });
    for (const destination of destinations) {
      try {
        destination.processor.onEnd(clean);
      } catch {
        this.warning();
      }
    }
  }
  async forceFlush() {
    await Promise.all(
      [...this.destinations].map(async item => {
        try {
          await item.processor.forceFlush();
        } catch {
          this.warning();
        }
      }),
    );
  }
  async shutdown() {
    await Promise.all(
      [...this.destinations].map(async item => {
        try {
          await item.processor.shutdown();
        } catch {
          this.warning();
        }
      }),
    );
  }
  async close() {
    try {
      await this.provider.shutdown();
    } catch {
      this.warning();
    }
  }
}
