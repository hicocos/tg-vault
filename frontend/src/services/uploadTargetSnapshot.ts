import type { StorageAccount, StorageConfig, UploadTargetSnapshot } from './api.js';
import { tr } from '../i18n/runtime';

export const STORAGE_PROVIDER_IDS = ['local', 'onedrive', 'google_drive', 'aliyun_oss', 's3', 'webdav', 'openlist'] as const;
export type StorageProviderId = typeof STORAGE_PROVIDER_IDS[number];

type UploadStorageConfig = {
    provider: string;
    activeAccountId: string | null;
    activeAccountName?: string | null;
    accounts?: Pick<StorageAccount, 'id' | 'name' | 'type'>[];
};

export interface UploadTargetDisplaySnapshot extends UploadTargetSnapshot {
    label: string;
}

function canonicalProviderId(provider: string | null | undefined): StorageProviderId {
    if (!provider) return 'local';
    if ((STORAGE_PROVIDER_IDS as readonly string[]).includes(provider)) return provider as StorageProviderId;
    throw new Error(tr('errors.services.storage.unsupportedProvider', { provider }));
}

export function createUploadTargetSnapshot(
    storageConfig: UploadStorageConfig | Pick<StorageConfig, 'provider' | 'activeAccountId' | 'activeAccountName' | 'accounts'> | null,
    providerLabel: string | null,
    folder?: string | null,
): UploadTargetDisplaySnapshot {
    const provider = canonicalProviderId(storageConfig?.provider);
    const accountName = storageConfig?.activeAccountName
        || storageConfig?.accounts?.find(account => account.id === storageConfig.activeAccountId)?.name
        || null;
    const normalizedFolder = folder || null;

    return {
        provider,
        accountId: storageConfig?.activeAccountId || null,
        accountName,
        folder: normalizedFolder,
        label: `${providerLabel || (provider === 'local' ? tr('errors.services.storage.local') : provider)} / ${accountName || (provider === 'local' ? tr('errors.services.storage.localDirectory') : tr('errors.services.storage.currentAccount'))} / ${normalizedFolder || tr('errors.services.storage.root')}`,
    };
}
