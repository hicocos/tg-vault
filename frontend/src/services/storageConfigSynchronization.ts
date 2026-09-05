import type { StorageConfig } from './api.js';
import { tr } from '../i18n/runtime';
import { createUploadTargetSnapshot } from './uploadTargetSnapshot.js';

export interface StorageConfigSynchronizationDependencies {
    loadConfig: () => Promise<StorageConfig>;
    publishConfig: (config: StorageConfig) => void | Promise<void>;
}

export async function synchronizeStorageConfig(
    dependencies: StorageConfigSynchronizationDependencies,
    expectedAccountId?: string,
): Promise<StorageConfig> {
    const config = await dependencies.loadConfig();
    if (expectedAccountId && config.activeAccountId !== expectedAccountId) {
        throw new Error(tr('errors.services.storage.authorizationNotSynchronized'));
    }
    await dependencies.publishConfig(config);
    return config;
}

export function uploadTargetAfterStorageSync(config: StorageConfig, folder?: string | null) {
    return createUploadTargetSnapshot(config, null, folder ?? undefined);
}
