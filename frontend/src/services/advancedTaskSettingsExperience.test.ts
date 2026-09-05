import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');

test('Web advanced task settings use the shared server contract and retain risk confirmation', () => {
    assert.match(api, /getAdvancedTaskSettings/);
    assert.match(api, /updateAdvancedTaskSetting/);
    assert.match(settings, /settings\.maintenance\.advancedTasks/);
    assert.match(settings, /telegramDownloadWorkers/);
    assert.match(settings, /telegramFileConcurrency/);
    assert.match(settings, /duplicateMode/);
    assert.match(settings, /autoCleanupOrphans/);
    assert.match(api, /skipTelegramPhotosInBatch/);
    assert.match(settings, /skipTelegramPhotosInBatch/);
    assert.match(settings, /settings\.cards\.maintenance\.skipPhotos\.title/);
    assert.match(settings, /settings\.cards\.maintenance\.skipPhotos\.description/);
    assert.match(settings, /CONFIRMATION_REQUIRED/);
});
