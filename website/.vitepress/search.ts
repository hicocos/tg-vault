const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

export function tokenize(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment)
    .filter(part => /[\p{L}\p{N}]/u.test(part));
}
