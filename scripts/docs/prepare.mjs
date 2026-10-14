import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = process.argv[2];
if (!destination) {
  throw new Error('Usage: node scripts/docs/prepare.mjs <new-directory>');
}

const pages = [
  'docs/reference/CLI.md',
  'docs/reference/RUNTIME.md',
  'docs/reference/SPEC.md',
  'docs/reference/DECISION.md',
  'docs/reference/TELEMETRY.md',
  'DESIGN_PHILOSOPHY.md',
  'VISION.md',
  'CONTRIBUTING.md',
  'examples/gha-security-review/README.md',
  'docs/index.md',
  'docs/getting-started.md',
  'docs/authoring.md',
  'docs/composition.md',
  'docs/mcp.md',
  'docs/primitives.md',
];
const siteFiles = [
  '_config.yml',
  '_data/navigation.yml',
  '_layouts/default.html',
  'assets/style.scss',
];
const brandIcon = 'assets/brand/stratos-icon.svg';
const toc = [
  '<details class="page-toc" markdown="1">',
  '<summary>On this page</summary>',
  '',
  '* Contents',
  '{:toc}',
  '',
  '</details>',
].join('\n');

await mkdir(destination);
for (const file of pages) {
  const source = await readFile(path.join(root, file), 'utf8');
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0] ?? '';
  let body = source.slice(header.length);
  if (!/^# .+$/m.test(body) || body.includes('{% endraw %}')) {
    throw new Error(`Cannot prepare Markdown heading/Liquid content: ${file}`);
  }
  if (/^#{2,3} .+$/m.test(body)) {
    body = body.replace(/^# .+$/m, heading => `${heading}\n\n${toc}`);
  }
  // Only allowlisted pages ship; other repository links must open on GitHub.
  body = body.replace(
    /(\[[^\]]*\]\()([^)\s]+)(\))/g,
    (match, opening, target, closing) => {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(target)) {
        return match;
      }
      const [pathname] = target.split(/[?#]/);
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), pathname),
      );
      if (resolved.startsWith('../')) {
        throw new Error(`Link escapes the repository: ${file}: ${target}`);
      }
      if (pages.includes(resolved)) {
        return match;
      }
      const suffix = target.slice(pathname.length);
      return `${opening}https://github.com/talktoajayprakash/stratos/blob/main/${resolved}${suffix}${closing}`;
    },
  );
  const output = path.join(destination, file);
  await mkdir(path.dirname(output), {recursive: true});
  // Liquid must not consume Handlebars or other template examples in code fences.
  await writeFile(
    output,
    `${header || '---\n---\n'}{% raw %}\n${body}\n{% endraw %}\n`,
  );
}
for (const file of siteFiles) {
  const output = path.join(destination, file);
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, await readFile(path.join(root, 'docs', file)));
}
const iconOutput = path.join(destination, brandIcon);
await mkdir(path.dirname(iconOutput), {recursive: true});
await writeFile(iconOutput, await readFile(path.join(root, brandIcon)));
console.info(`Prepared ${pages.length} documentation pages in ${destination}`);
