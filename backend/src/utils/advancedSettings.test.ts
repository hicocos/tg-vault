import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdvancedSettings, normalizeAdvancedSettingsPatch } from './advancedSettings.js';

test('advanced task settings expose one shared Web and Bot contract', () => {
    assert.deepEqual(buildAdvancedSettings({
        telegramDownloadWorkers: '8',
        telegramFileConcurrency: '3',
        duplicateMode: 'skip',
        autoCleanupOrphans: 'false',
    }), {
        telegramDownloadWorkers: 8,
        telegramFileConcurrency: 3,
        duplicateMode: 'skip',
        autoCleanupOrphans: false,
        highRisk: { telegramDownloadWorkers: false, telegramFileConcurrency: false },
    });
});

test('advanced settings reject invalid values and flag high-risk concurrency', () => {
    assert.deepEqual(normalizeAdvancedSettingsPatch({ telegramDownloadWorkers: 16 }), {
        telegramDownloadWorkers: 16,
        highRisk: true,
    });
    assert.throws(() => normalizeAdvancedSettingsPatch({ telegramFileConcurrency: 9 }), /telegramFileConcurrency/);
    assert.throws(() => normalizeAdvancedSettingsPatch({ duplicateMode: 'overwrite' }), /duplicateMode/);
});
