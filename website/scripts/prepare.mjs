import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(website, '..');
const generated = [
  ['deploy/DEPLOY.md', 'deploy/installation.md'],
  ['docs/configuration.md', 'reference/configuration.md'],
  ['docs/local-storage.md', 'storage/local.md'],
  ['docs/development.md', 'reference/development.md'],
  ['docs/mcp.md', 'usage/mcp.md'],
  ['CHANGELOG.md', 'reference/changelog.md'],
];
const routes = new Map([
  ...generated.map(([source, page]) => [source, `/${page.replace(/\.md$/, '')}`]),
  ['README.md', '/guide/introduction'],
  ['README_EN.md', 'https://github.com/hicocos/tg-vault/blob/main/README_EN.md'],
  ['website/src/storage/index.md', '/storage/'],
  ['website/README.md', 'https://github.com/hicocos/tg-vault/blob/main/website/README.md'],
]);
const normalize = path => path.replaceAll('\\', '/');

await mkdir(resolve(website, 'src/public'), { recursive: true });
await cp(resolve(repo, 'frontend/public/logo-160.webp'), resolve(website, 'src/public/logo.webp'));
for (const icon of ['favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
  await cp(resolve(repo, `frontend/public/${icon}`), resolve(website, `src/public/${icon}`));
}
await cp(resolve(repo, 'LICENSE'), resolve(website, 'src/public/LICENSE.txt'));
await mkdir(resolve(website, 'src/public/fonts'), { recursive: true });
await cp(resolve(repo, 'frontend/public/fonts/geist/files/geist-latin-wght-normal.woff2'), resolve(website, 'src/public/fonts/geist-latin.woff2'));
await cp(resolve(repo, 'frontend/public/fonts/geist/LICENSE'), resolve(website, 'src/public/fonts/LICENSE.txt'));
await cp(resolve(website, 'node_modules/@fontsource-variable/noto-sans-sc/LICENSE'), resolve(website, 'src/public/fonts/NOTO-LICENSE.txt'));

for (const [source, page] of generated) {
  let content = await readFile(resolve(repo, source), 'utf8');
  content = content.replace(/(\]\()([^\s)]+)(\))/g, (match, open, href, close) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(href)) return match;
    const [pathname, fragment] = href.split('#');
    const target = normalize(resolve(dirname(resolve(repo, source)), pathname).slice(repo.length + 1));
    const destination = routes.get(target) || `https://github.com/hicocos/tg-vault/blob/main/${target}`;
    const anchor = routes.has(target) && /^\d/.test(fragment || '') ? `_${fragment}` : fragment;
    return `${open}${destination}${anchor ? `#${anchor}` : ''}${close}`;
  });
  const sourceLink = `\n\n[查看仓库原文](https://github.com/hicocos/tg-vault/blob/main/${source})\n`;
  if (source === 'docs/mcp.md') {
    content = content.replace(/^\[首页\]\([^)]+\)\s*·[^\n]+\n+/m, '');
  }
  if (source === 'CHANGELOG.md') {
    const releases = content.split(/(?=^# )/m).filter(section => /^# v\d/.test(section)).join('');
    content = `---\noutline: 2\n---\n\n# 更新日志\n\n${releases.replace(/^(#{1,5}) /gm, '#$1 ')}`;
  }
  content += sourceLink;
  const output = resolve(website, 'src', page);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
}
console.log(`Prepared ${generated.length} repository-backed pages and public brand assets.`);
