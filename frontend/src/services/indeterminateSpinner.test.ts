import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const componentPath = new URL('../components/ui/IndeterminateSpinner.tsx', import.meta.url);
const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('global indeterminate spinner exposes correct accessible semantics', () => {
    const source = fs.readFileSync(componentPath, 'utf8');
    assert.match(source, /role="progressbar"/);
    assert.match(source, /aria-label=\{label\}/);
    assert.doesNotMatch(source, /aria-valuenow/);
    assert.match(source, /aria-hidden="true"/);
    assert.match(source, /circle/);
    assert.match(source, /size.*sm.*md.*lg/s);
    assert.match(source, /tone.*blue.*current.*inverse/s);
    assert.match(source, /#4DA3FF/i);
    assert.match(source, /#D9E9FA/i);
    assert.match(source, /#55A7FF/i);
    assert.match(source, /#29425F/i);
    assert.match(source, /stroke=\{colors\.track\}/);
    assert.match(source, /stroke=\{colors\.arc\}/);
});

test('spinner motion respects reduced-motion preferences', () => {
    assert.match(css, /@keyframes indeterminate-spinner-rotate/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /\.indeterminate-spinner/);
});
