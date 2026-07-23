import runtimeEn from './runtime-en.json';

const englishByChinese = runtimeEn as Record<string, string>;
const chineseByEnglish = Object.fromEntries(Object.entries(englishByChinese).map(([zh, en]) => [en, zh]));
const originals = new WeakMap<Text | Element, Record<string, string>>();

function translateTemplate(text: string, english: boolean): string {
  const forward: Array<[RegExp, string]> = [
    [/^已配置 (\d+) 个$/, '$1 configured'], [/^保留 (\d+) 天$/, 'Keep $1 days'], [/^(\d+) 个文件$/, '$1 files'],
    [/^目标：/, 'Target: '], [/^更新：/, 'Updated: '], [/^速度 /, 'Speed '], [/^条目 /, 'Items '], [/^数据 /, 'Data '],
    [/^进行中 (\d+)$/, 'Active $1'], [/^需处理 (\d+)$/, 'Needs attention $1'], [/^已完成 (\d+)$/, 'Completed $1'],
  ];
  const reverse: Array<[RegExp, string]> = [
    [/^(\d+) configured$/, '已配置 $1 个'], [/^Keep (\d+) days$/, '保留 $1 天'], [/^(\d+) files$/, '$1 个文件'],
    [/^Target: /, '目标：'], [/^Updated: /, '更新：'], [/^Speed /, '速度 '], [/^Items /, '条目 '], [/^Data /, '数据 '],
    [/^Active (\d+)$/, '进行中 $1'], [/^Needs attention (\d+)$/, '需处理 $1'], [/^Completed (\d+)$/, '已完成 $1'],
  ];
  let result = text;
  for (const [pattern, replacement] of english ? forward : reverse) result = result.replace(pattern, replacement);
  return result;
}

function translateValue(value: string, english: boolean): string {
  return (english ? englishByChinese[value] : chineseByEnglish[value]) || translateTemplate(value, english);
}

export function localizeChineseText(root: ParentNode, language: string): void {
  const english = language.toLowerCase().startsWith('en');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('script, style, code, pre')) continue;
    const raw = node.nodeValue || '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const remembered = originals.get(node)?.text;
    const source = english ? (remembered || trimmed) : (remembered || trimmed);
    const translated = translateValue(source, english);
    if (english && translated !== source && !remembered) originals.set(node, { text: source });
    if (!english && remembered) {
      node.nodeValue = raw.replace(trimmed, remembered);
      originals.delete(node);
    } else if (translated !== trimmed) {
      node.nodeValue = raw.replace(trimmed, translated);
    }
  }
  root.querySelectorAll<HTMLElement>('[placeholder],[title],[aria-label]').forEach(element => {
    for (const name of ['placeholder', 'title', 'aria-label']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const key = `attr:${name}`;
      const remembered = originals.get(element)?.[key];
      const source = remembered || value;
      const translated = translateValue(source, english);
      if (english && translated !== source && !remembered) originals.set(element, { ...(originals.get(element) || {}), [key]: source });
      if (!english && remembered) {
        element.setAttribute(name, remembered);
        const next = { ...(originals.get(element) || {}) };
        delete next[key];
        originals.set(element, next);
      } else if (translated !== value) element.setAttribute(name, translated);
    }
  });
}
