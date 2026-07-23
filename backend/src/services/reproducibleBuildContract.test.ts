import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const backend = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../../../frontend/Dockerfile', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../../../.github/workflows/docker-publish.yml', import.meta.url), 'utf8');
const backendPackage = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const frontendPackage = JSON.parse(fs.readFileSync(new URL('../../../frontend/package.json', import.meta.url), 'utf8'));

test('release images use locked dependencies, pinned bases, verified yt-dlp and source labels', () => {
    assert.equal(backendPackage.version, '2.0.1');
    assert.equal(frontendPackage.version, '2.0.1');
    assert.equal((backend.match(/npm ci/g) || []).length, 2);
    assert.doesNotMatch(backend, /npm install/);
    assert.match(backend, /node@sha256:/);
    assert.match(frontend, /node@sha256:/);
    assert.match(frontend, /nginx@sha256:/);
    assert.match(compose, /postgres@sha256:/);
    assert.equal((compose.match(/\$\{IMAGE_VERSION:\?IMAGE_VERSION is required\}/g) || []).length, 2);
    assert.doesNotMatch(compose, /IMAGE_VERSION:-latest/);
    assert.match(compose, /OAUTH_CALLBACK_BASE_URL/);
    assert.match(compose, /OAUTH_FRONTEND_ORIGIN/);
    assert.match(backend, /YTDLP_VERSION=2026\.06\.09/);
    assert.match(backend, /sha256sum -c/);
    for (const dockerfile of [backend, frontend]) {
        assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
        assert.match(dockerfile, /org\.opencontainers\.image\.source/);
    }
    assert.equal((compose.match(/sbom: true/g) || []).length, 2);
    assert.equal((compose.match(/provenance: mode=max/g) || []).length, 2);
    const actionRefs = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1]);
    assert.ok(actionRefs.length >= 15);
    assert.ok(actionRefs.every(ref => /@[0-9a-f]{40}$/.test(ref)));
    assert.match(workflow, /Generate CycloneDX SBOM release assets/);
    assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});