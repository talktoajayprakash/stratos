import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {parse} from 'yaml';
import {z} from 'zod';

const exec = promisify(execFile);
const root = new URL('../../../', import.meta.url);
const script = (name: string) =>
  fileURLToPath(new URL(`scripts/docs/${name}.mjs`, root));
const referenceRoutes = {
  'CLI.md': '/cli/',
  'RUNTIME.md': '/runtime/',
  'SPEC.md': '/specification/',
  'DECISION.md': '/decision/',
  'TELEMETRY.md': '/telemetry/',
};

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-docs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

void test('documentation preparation publishes only listed files and preserves templates', async t => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, 'source');
  const {stdout} = await exec(process.execPath, [script('prepare'), output]);
  assert.match(stdout, /Prepared 15 documentation pages/);
  const files = (await readdir(output, {recursive: true})).sort();
  assert.ok(files.includes('docs/primitives.md'));
  for (const name of Object.keys(referenceRoutes)) {
    assert.ok(files.includes(`docs/reference/${name}`));
    assert.equal(files.includes(name), false);
  }
  assert.ok(files.includes('assets/style.scss'));
  const brandIcon = 'assets/brand/stratos-icon.svg';
  assert.deepEqual(await readdir(join(output, 'assets/brand')), [
    'stratos-icon.svg',
  ]);
  assert.equal(
    await readFile(join(output, brandIcon), 'utf8'),
    await readFile(new URL(brandIcon, root), 'utf8'),
  );
  for (const guide of ['getting-started', 'authoring', 'composition', 'mcp']) {
    assert.ok(files.includes(`docs/${guide}.md`));
  }
  for (const sourceOnly of ['README.md', 'AGENTS.md', 'skills']) {
    assert.equal(files.includes(sourceOnly), false);
  }
  assert.equal(
    files.some(file => /^(src|test|scripts|node_modules)\//.test(file)),
    false,
  );
  assert.equal(
    files.some(file => file.includes('.github')),
    false,
  );
  const markdown = await readFile(
    join(output, 'docs/reference/RUNTIME.md'),
    'utf8',
  );
  assert.ok(markdown.startsWith('---\n---\n{% raw %}\n'));
  assert.ok(markdown.includes('<summary>On this page</summary>'));
  assert.ok(markdown.includes('{% endraw %}'));
  assert.ok(
    markdown.includes(
      'https://github.com/talktoajayprakash/stratos/blob/main/src/agents/codex/provider.ts',
    ),
  );
  const source = await readFile(
    new URL('docs/reference/RUNTIME.md', root),
    'utf8',
  );
  for (const template of source.matchAll(/\{\{[^}]+\}\}/g)) {
    assert.ok(markdown.includes(template[0]));
  }
  const example = await readFile(
    join(output, 'examples/gha-security-review/README.md'),
    'utf8',
  );
  assert.ok(example.includes('<summary>On this page</summary>'));
  const spec = await readFile(join(output, 'docs/reference/SPEC.md'), 'utf8');
  assert.ok(
    spec.includes(
      '(https://github.com/talktoajayprakash/stratos/blob/main/skills/stratos-workflows/SKILL.md)',
    ),
  );
  assert.ok(spec.includes('(../authoring.md)'));
  assert.ok(spec.includes('(RUNTIME.md)'));
  assert.ok(spec.includes('(../../CONTRIBUTING.md)'));
  const contributing = await readFile(join(output, 'CONTRIBUTING.md'), 'utf8');
  assert.ok(
    contributing.includes(
      '(https://github.com/talktoajayprakash/stratos/blob/main/AGENTS.md)',
    ),
  );
  await assert.rejects(
    exec(process.execPath, [script('prepare'), output]),
    /EEXIST/,
  );
});

void test('technical references live under docs/reference and keep their public URLs', async () => {
  const config = z
    .object({
      defaults: z.array(
        z.object({
          scope: z.object({path: z.string()}),
          values: z.object({permalink: z.string().optional()}),
        }),
      ),
    })
    .parse(parse(await readFile(new URL('docs/_config.yml', root), 'utf8')));
  const rootFiles = await readdir(root);
  const agents = await readFile(new URL('AGENTS.md', root), 'utf8');
  for (const [name, permalink] of Object.entries(referenceRoutes)) {
    const source = `docs/reference/${name}`;
    assert.equal(rootFiles.includes(name), false);
    assert.match(await readFile(new URL(source, root), 'utf8'), /^# /);
    assert.ok(agents.includes(`](${source})`));
    assert.deepEqual(
      config.defaults
        .filter(entry => entry.values.permalink === permalink)
        .map(entry => entry.scope.path),
      [source],
    );
  }
  for (const name of [
    'README.md',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'VISION.md',
    'DESIGN_PHILOSOPHY.md',
  ]) {
    assert.ok(rootFiles.includes(name));
  }
});

void test('README and Pages use the selected icon with a white background', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const layout = await readFile(
    new URL('docs/_layouts/default.html', root),
    'utf8',
  );
  const icon = await readFile(
    new URL('assets/brand/stratos-icon.svg', root),
    'utf8',
  );
  const selected = await readFile(
    new URL('assets/brand/stratos-slipstream-s-both-ends-thin.svg', root),
    'utf8',
  );
  assert.match(
    readme,
    /<img src="assets\/brand\/stratos-icon\.svg" alt="Stratos icon" width="96" height="96">/,
  );
  assert.match(
    layout,
    /src="\{\{ '\/assets\/brand\/stratos-icon\.svg' \| relative_url \}\}"/,
  );
  assert.match(icon, /<rect width="128" height="128" fill="#FFFFFF"\/>/);
  const selectedPath = selected.match(/<path fill="#000000" d="([^"]+)"/)?.[1];
  assert.ok(selectedPath);
  assert.equal(
    icon.match(/<path fill="#000000" d="([^"]+)"/)?.[1],
    selectedPath,
  );
});

void test('documentation has consolidated navigation and discoverable primitive details', async () => {
  const navigation = z
    .array(
      z.object({
        title: z.string(),
        links: z.array(z.object({title: z.string(), url: z.string()})),
      }),
    )
    .parse(
      parse(await readFile(new URL('docs/_data/navigation.yml', root), 'utf8')),
    );
  assert.deepEqual(
    navigation.map(group => group.title),
    ['Documentation', 'Examples', 'Project'],
  );
  const documentation = navigation[0]!.links;
  assert.deepEqual(
    documentation.slice(0, 3).map(link => link.title),
    ['Overview', 'Getting started', 'Author a workflow'],
  );
  assert.ok(documentation.some(link => link.url === '/telemetry/'));
  assert.ok(
    navigation[1]!.links.some(link => link.url === '/guides/composition/'),
  );
  const urls = navigation.flatMap(group => group.links.map(link => link.url));
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.includes('/decision/'), false);
  assert.equal(urls.includes('/guides/mcp/'), false);
  const primitives = await readFile(
    new URL('docs/primitives.md', root),
    'utf8',
  );
  assert.ok(primitives.includes('(reference/DECISION.md)'));
  assert.ok(primitives.includes('(mcp.md)'));
  assert.ok(primitives.includes('(authoring.md)'));
  assert.ok(primitives.includes('(composition.md#child-workflows)'));
});

void test('telemetry has one reference while previous section links remain valid', async () => {
  const spec = await readFile(new URL('docs/reference/SPEC.md', root), 'utf8');
  const decision = await readFile(
    new URL('docs/reference/DECISION.md', root),
    'utf8',
  );
  const telemetry = await readFile(
    new URL('docs/reference/TELEMETRY.md', root),
    'utf8',
  );
  for (const heading of [
    'Harness telemetry collection',
    'Trace hierarchy and node spans',
    'Harness preparation and startup timing',
    'Trace exporter configuration',
    'Telemetry authentication references',
    'Trace file export',
    'Default local logs and agent events',
    'OTEL metrics (deferred)',
  ]) {
    const anchor = heading
      .toLowerCase()
      .replace(/[()]/g, '')
      .replaceAll(' ', '-');
    assert.ok(spec.includes(`<a id="${anchor}"></a>`));
    assert.ok(spec.includes(`(TELEMETRY.md#${anchor})`));
    assert.ok(telemetry.includes(`## ${heading}\n`));
  }
  assert.ok(decision.includes('<a id="content-and-measurement-mapping"></a>'));
  assert.ok(telemetry.includes('### Content and measurement mapping\n'));
  assert.ok(telemetry.includes('### Send traces to Langfuse\n'));
  for (const reference of [spec, decision]) {
    assert.equal(reference.includes('gen_ai.usage.input_tokens'), false);
    assert.equal(reference.includes('maxRunsPerWorkspace'), false);
  }
});

void test('rendered documentation checks base paths, assets, entities, and fragments', async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, 'guide'));
  await mkdir(join(directory, 'assets/brand'), {recursive: true});
  await writeFile(
    join(directory, 'assets/brand/stratos-icon.svg'),
    await readFile(new URL('assets/brand/stratos-icon.svg', root)),
  );
  await writeFile(join(directory, 'style.css'), 'body {}');
  await writeFile(
    join(directory, 'index.html'),
    '<a href="/stratos/guide/#a%26b">Guide</a>' +
      '<img src="/stratos/assets/brand/stratos-icon.svg" alt="Stratos icon">' +
      '<a href="https://example.invalid/">External</a>' +
      '<span data-href="missing.html">Not a link attribute</span>' +
      '<!-- <a href="missing.html">Not a link</a> -->',
  );
  await writeFile(
    join(directory, 'guide/index.html'),
    '<h1 id="a&amp;b">Title</h1>' +
      '<link href="../style.css" rel="stylesheet">' +
      '<img src="/stratos/assets/brand/stratos-icon.svg" alt="">' +
      '<a href="/stratos/">Home</a>',
  );
  const {stdout} = await exec(process.execPath, [
    script('check'),
    directory,
    '/stratos',
  ]);
  assert.match(stdout, /2 rendered pages and 5 local links\/anchors/);
});

for (const [name, link, message] of [
  ['missing file', '/stratos/missing/', 'missing file'],
  ['missing fragment', '/stratos/#missing', 'missing anchor'],
  ['missing project prefix', '/cli/', 'escapes the Pages baseurl'],
] as const) {
  void test(`rendered documentation rejects ${name}`, async t => {
    const directory = await temporaryDirectory(t);
    await writeFile(
      join(directory, 'index.html'),
      `<a href="${link}">Bad</a><span data-id="missing">Not an ID</span>`,
    );
    await assert.rejects(
      exec(process.execPath, [script('check'), directory, '/stratos']),
      new RegExp(message),
    );
  });
}

void test('rendered documentation rejects missing script assets', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(
    join(directory, 'index.html'),
    '<script src="/stratos/missing.js"></script>',
  );
  await assert.rejects(
    exec(process.execPath, [script('check'), directory, '/stratos']),
    /missing file/,
  );
});

void test('rendered documentation rejects a missing brand icon', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(
    join(directory, 'index.html'),
    '<img src="/stratos/assets/brand/stratos-icon.svg" alt="Stratos icon">',
  );
  await assert.rejects(
    exec(process.execPath, [script('check'), directory, '/stratos']),
    /missing file/,
  );
});
