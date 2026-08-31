import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const backend = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../../../frontend/Dockerfile', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../../../.github/workflows/docker-publish.yml', import.meta.url), 'utf8');
const backendPackage = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const frontendPackage = JSON.parse(fs.readFileSync(new URL('../../../frontend/package.json', import.meta.url), 'utf8'));
const installScript = fs.readFileSync(new URL('../../../deploy/install.sh', import.meta.url), 'utf8');
const deployGuide = fs.readFileSync(new URL('../../../deploy/DEPLOY.md', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

function assertBeginnerFriendlyInstall(source: string): void {
    assert.match(source, /CORS_ORIGIN_VALUE=.*CORS_ORIGIN/);
    assert.match(source, /VITE_API_URL_VALUE=.*VITE_API_URL/);
    assert.match(source, /prompt_origin '请输入 Web 前端 URL'/);
    assert.match(source, /prompt_origin '请输入后端 API URL'/);
    assert.match(source, /ensure_generated_secret DB_PASSWORD/);
    assert.match(source, /if \[\[ "\$created_env" == true \]\]; then[\s\S]*ensure_generated_secret SESSION_SECRET[\s\S]*ensure_generated_secret STORAGE_CREDENTIALS_SECRET/);
    assert.match(source, /RELEASE_REVISION=.*git rev-parse HEAD/);
    assert.match(source, /RELEASE_VERSION=.*python3[\s\S]*backend\/package\.json/);
    assert.match(source, /env IMAGE_VERSION="\$RELEASE_VERSION"/);
}

test('release images use locked dependencies, pinned bases, verified yt-dlp and source labels', () => {
    assert.equal(backendPackage.version, '2.3.1');
    assert.equal(frontendPackage.version, '2.3.1');
    assert.equal((backend.match(/npm ci/g) || []).length, 2);
    assert.doesNotMatch(backend, /npm install/);
    assert.match(backend, /node@sha256:/);
    assert.match(frontend, /node@sha256:/);
    assert.match(frontend, /nginx@sha256:/);
    assert.match(compose, /postgres@sha256:/);
    assert.doesNotMatch(compose, /pgvector\/pgvector/);
    assert.equal((compose.match(/\$\{IMAGE_VERSION:-source\}/g) || []).length, 2);
    assert.doesNotMatch(compose, /IMAGE_VERSION:\?IMAGE_VERSION is required/);
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

test('installer keeps beginner input to two public origins and derives the rest', () => {
    assert.equal((compose.match(/\$\{IMAGE_VERSION:-source\}/g) || []).length, 2);
    assert.equal((compose.match(/\$\{SOURCE_REVISION:-unknown\}/g) || []).length, 2);
    assert.equal((compose.match(/\$\{SOURCE_VERSION:-worktree\}/g) || []).length, 2);
    assert.doesNotMatch(compose, /IMAGE_VERSION:\?IMAGE_VERSION is required/);
    assert.doesNotMatch(compose, /SOURCE_REVISION:\?SOURCE_REVISION is required/);
    assert.doesNotMatch(compose, /SOURCE_VERSION:\?SOURCE_VERSION is required/);
    assert.doesNotMatch(compose, /DOMAIN=/);
    assertBeginnerFriendlyInstall(installScript);
    assert.match(envExample, /自动生成：数据库密码/);
    assert.match(envExample, /高级覆盖：OAuth/);
    assert.match(readme, /新手只需填写（2 项）/);
    assert.match(deployGuide, /只需填写以下 2 项/);
    assert.match(deployGuide, /docker inspect/);
    assert.match(deployGuide, /assets\//);
    assert.match(deployGuide, /镜像名称会使用 `source`/);
});

test('release metadata is derived per deployment and never persisted in user env files', () => {
    for (const key of ['IMAGE_VERSION', 'SOURCE_REVISION', 'SOURCE_VERSION']) {
        assert.doesNotMatch(envExample, new RegExp(`^${key}=`, 'm'));
        assert.doesNotMatch(installScript, new RegExp(`upsert_env ${key}\\b`));
    }
    assert.match(installScript, /remove_env_keys IMAGE_VERSION SOURCE_REVISION SOURCE_VERSION/);
    assert.match(installScript, /env IMAGE_VERSION="\$RELEASE_VERSION" SOURCE_REVISION="\$RELEASE_REVISION" SOURCE_VERSION="\$RELEASE_VERSION" docker compose config --quiet/);
    assert.match(installScript, /env IMAGE_VERSION="\$RELEASE_VERSION" SOURCE_REVISION="\$RELEASE_REVISION" SOURCE_VERSION="\$RELEASE_VERSION" docker compose build backend frontend/);
    assert.match(installScript, /env IMAGE_VERSION="\$RELEASE_VERSION" SOURCE_REVISION="\$RELEASE_REVISION" SOURCE_VERSION="\$RELEASE_VERSION" docker compose up -d --no-build --no-deps backend frontend/);
});
