import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requireApiKeyPermission } from './apiKey.js';

function responseRecorder() {
    const state: any = { statusCode: 200, body: undefined };
    return {
        state,
        res: {
            status(code: number) { state.statusCode = code; return this; },
            json(body: unknown) { state.body = body; return this; },
        } as any,
    };
}

{
    const { state, res } = responseRecorder();
    let nextCalled = false;
    requireApiKeyPermission('upload')({ apiKeyInfo: { id: '1', name: 'read', permissions: ['read'] } } as any, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(state.statusCode, 403);
}

{
    const { res } = responseRecorder();
    let nextCalled = false;
    requireApiKeyPermission('upload')({ apiKeyInfo: { id: '1', name: 'write', permissions: ['upload'] } } as any, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
}

const indexSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
assert.match(indexSource, /app\.use\('\/api\/v1\/upload', apiUploadRouter\)/);
assert.doesNotMatch(indexSource, /app\.use\('\/api\/v1\/upload', requireAuth, uploadRouter\)/);
const uploadSource = fs.readFileSync(new URL('../routes/upload.ts', import.meta.url), 'utf8');
assert.match(uploadSource, /apiRouter\.post\('\/', uploadLimiter, validateApiKey, requireApiKeyPermission\('upload'\)/);

console.log('api key upload permission ok');
