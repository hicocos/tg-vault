import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../.vitepress/dist');
const files = new Set(await readdir(dist, { recursive: true }));
const pages = new Map();
for (const file of files) {
  if (!file.endsWith('.html')) continue;
  const html = await readFile(resolve(dist, file), 'utf8');
  pages.set(file, {
    html,
    ids: new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1])),
  });
}

const errors = new Set();
for (const [file, { html }] of pages) {
  for (const [, href] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const url = new URL(href, `https://docs.invalid/${file}`);
    if (url.origin !== 'https://docs.invalid') continue;
    let target = decodeURIComponent(url.pathname).slice(1);
    if (target.endsWith('/') || !target) target += 'index.html';
    else if (!files.has(target)) target += '.html';
    if (!files.has(target)) {
      errors.add(`${file}: missing target ${href}`);
      continue;
    }
    if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) {
      errors.add(`${file}: missing anchor ${href}`);
    }
  }
}
if (errors.size) throw new Error(`Broken documentation links:\n${Array.from(errors).join('\n')}`);
console.log(`Checked ${pages.size} HTML pages: all local page, asset and anchor targets exist.`);
