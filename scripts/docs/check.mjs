import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

const [directory, base = '/stratos'] = process.argv.slice(2);
if (!directory) {
  throw new Error(
    'Usage: node scripts/docs/check.mjs <site-directory> [baseurl]',
  );
}
const prefix = `${base.replace(/\/$/, '')}/`;
const origin = 'https://docs.invalid';
const files = new Set();
const pages = new Map();

function decode(value) {
  const entities = {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'};
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (_, entity) => {
      if (entity.startsWith('#')) {
        return String.fromCodePoint(
          entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10),
        );
      }
      return entities[entity.toLowerCase()];
    },
  );
}

async function collect(relative = '') {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symlink in site: ${file}`);
    }
    if (entry.isDirectory()) {
      await collect(file);
      continue;
    }
    files.add(file);
    if (!file.endsWith('.html')) {
      continue;
    }
    const html = (await readFile(path.join(directory, file), 'utf8'))
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
    const ids = new Set();
    const links = [];
    // Inspect generated HTML attributes, not escaped code examples or comments.
    for (const tag of html.matchAll(/<[a-z][\w-]*\b([^<>]*?)>/gi)) {
      for (const attribute of tag[1].matchAll(
        /(?:^|\s)(id|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      )) {
        const value = decode(attribute[2] ?? attribute[3]);
        if (attribute[1].toLowerCase() === 'id') {
          ids.add(value);
        } else {
          links.push(value);
        }
      }
    }
    pages.set(file, {ids, links});
  }
}

await collect();
if (!files.has('index.html') || pages.size === 0) {
  throw new Error('Site has no rendered index.html');
}
const errors = [];
let checked = 0;
for (const [file, {links}] of pages) {
  for (const link of links) {
    const url = new URL(link, `${origin}${prefix}${file}`);
    if (url.origin !== origin) {
      continue;
    }
    checked++;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname !== prefix.slice(0, -1) && !pathname.startsWith(prefix)) {
      errors.push(`${file}: link escapes the Pages baseurl: ${link}`);
      continue;
    }
    let target = pathname.slice(prefix.length);
    if (!target || target.endsWith('/')) {
      target += 'index.html';
    }
    if (!files.has(target)) {
      errors.push(`${file}: missing file: ${link}`);
      continue;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && pages.has(target) && !pages.get(target).ids.has(fragment)) {
      errors.push(`${file}: missing anchor: ${link}`);
    }
  }
}
if (errors.length) {
  throw new Error(errors.join('\n'));
}
console.info(
  `Checked ${pages.size} rendered pages and ${checked} local links/anchors.`,
);
