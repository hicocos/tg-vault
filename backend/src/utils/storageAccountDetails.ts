import { decryptCredential, isEncryptedCredential } from './credentialCrypto.js';

interface ProviderFields {
    fields: readonly string[];
    secrets: readonly string[];
}

const PROVIDER_FIELDS: Record<string, ProviderFields> = {
    google_drive: { fields: ['clientId', 'redirectUri', 'sharedDriveId'], secrets: ['clientSecret', 'refreshToken', 'accessToken'] },
    onedrive: { fields: ['clientId', 'tenantId'], secrets: ['clientSecret', 'refreshToken', 'accessToken'] },
    s3: { fields: ['endpoint', 'region', 'bucket', 'forcePathStyle'], secrets: ['accessKeyId', 'accessKeySecret', 'sessionToken'] },
    aliyun_oss: { fields: ['region', 'bucket'], secrets: ['accessKeyId', 'accessKeySecret', 'securityToken'] },
    webdav: { fields: ['url', 'username'], secrets: ['password'] },
    openlist: { fields: ['baseUrl', 'rootPath', 'username'], secrets: ['password', 'token'] },
};
const URL_FIELDS: Record<string, true> = { endpoint: true, redirectUri: true, url: true, baseUrl: true };

const EDITABLE_CREDENTIALS: Record<string, readonly string[]> = {
    google_drive: ['clientId', 'clientSecret', 'refreshToken'],
    onedrive: ['clientId', 'clientSecret', 'refreshToken'],
    s3: ['accessKeyId', 'accessKeySecret'],
    aliyun_oss: ['accessKeyId', 'accessKeySecret'],
    webdav: ['username', 'password'],
    openlist: ['username', 'password'],
};

export function editableStorageCredentials(provider: string): readonly string[] {
    return Object.hasOwn(EDITABLE_CREDENTIALS, provider) ? EDITABLE_CREDENTIALS[provider] : [];
}

export interface StorageAccountDetailsRow {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    created_at: Date | string;
    updated_at: Date | string;
    config: unknown;
}

function publicUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return undefined;
    }
}

export function buildStorageAccountDetails(row: StorageAccountDetailsRow) {
    const fields: Record<string, string | boolean> = {};
    const secrets: Record<string, boolean> = {};
    const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config as Record<string, unknown>
        : {};
    const schema = Object.hasOwn(PROVIDER_FIELDS, row.type) ? PROVIDER_FIELDS[row.type] : undefined;
    if (schema) {
        for (const key of schema.fields) {
            if (!Object.hasOwn(config, key)) continue;
            let value = config[key];
            if (key === 'forcePathStyle') {
                if (typeof value === 'boolean') fields[key] = value;
                continue;
            }
            if (typeof value !== 'string') continue;
            // username is the only public field encrypted by encryptStorageConfig.
            // Never decrypt the whole config or any secret, even to test its presence.
            if (key === 'username') value = decryptCredential(value);
            if (typeof value !== 'string') continue;
            if (isEncryptedCredential(value)) continue;
            if (Object.hasOwn(URL_FIELDS, key)) {
                const sanitized = publicUrl(value);
                if (sanitized !== undefined) fields[key] = sanitized;
            } else {
                fields[key] = value;
            }
        }
        for (const key of schema.secrets) {
            secrets[key] = Object.hasOwn(config, key) && typeof config[key] === 'string' && config[key].length > 0;
        }
    }
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        fields,
        secrets,
        editableCredentials: editableStorageCredentials(row.type),
    };
}
