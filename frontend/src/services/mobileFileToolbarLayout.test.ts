import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('mobile file toolbar wraps complete control groups instead of clipping the view toggle', () => {
  assert.match(source, /data-testid="file-toolbar"[^>]*className="[^"]*w-full[^"]*flex-wrap[^"]*"/);
  assert.match(source, /data-testid="file-toolbar-primary"[^>]*className="[^"]*min-w-0[^"]*"/);
  assert.match(source, /data-testid="file-toolbar-secondary"[^>]*className="[^"]*shrink-0[^"]*"/);
});
