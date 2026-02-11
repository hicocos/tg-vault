
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { query } from '../db/index.js';

// 接口定义
export interface IStorageProvider {
    id?: string; // 对于云盘，这是账户 ID
    name: string;
    /**
     * 保存文件
     * @param tempPath 临时文件路径
     * @param fileName 目标文件名
     * @param mimeType 文件类型
     * @returns 存储后的路径或标识符
     */
    saveFile(tempPath: string, fileName: string, mimeType: string): Promise<string>;

    /**
     * 获取文件流（用于下载）
     * @param storedPath 存储路径或标识符
     */
    getFileStream(storedPath: string): Promise<NodeJS.ReadableStream>;

    /**
     * 获取预览URL（可能是临时的）
     * @param storedPath 存储路径或标识符
     */
    getPreviewUrl(storedPath: string): Promise<string>;

    /**
     * 删除文件
     * @param storedPath 存储路径或标识符
     */
    deleteFile(storedPath: string): Promise<void>;

    /**
     * 获取文件大小（可选）
     */
    getFileSize?(storedPath: string): Promise<number>;
}

// 本地存储实现
export class LocalStorageProvider implements IStorageProvider {
    name = 'local';
    private uploadDir: string;

    constructor(uploadDir: string = process.env.UPLOAD_DIR || './data/uploads') {
        this.uploadDir = uploadDir;
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    async saveFile(tempPath: string, fileName: string): Promise<string> {
        const destPath = path.join(this.uploadDir, fileName);
        try {
            await fs.promises.rename(tempPath, destPath);
        } catch (error: any) {
            // 如果是跨设备移动 (EXDEV)，则使用复制+删除
            if (error.code === 'EXDEV') {
                await fs.promises.copyFile(tempPath, destPath);
                await fs.promises.unlink(tempPath);
            } else {
                throw error;
            }
        }
        return destPath; // 返回绝对路径
    }

    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        if (!fs.existsSync(storedPath)) {
            throw new Error(`File not found: ${storedPath}`);
        }
        return fs.createReadStream(storedPath);
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        // 本地文件通过现有的 serve-static 或 API 路由提供服务
        // 这里我们返回文件名，让上层路由处理
        // 注意：目前架构是 controller 层组装 URL，这里其实可能不需要具体 URL
        // 或者我们可以返回 null，让上层使用默认逻辑
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        if (fs.existsSync(storedPath)) {
            await fs.promises.unlink(storedPath);
        }
    }
}

// OneDrive 国际版存储实现
export class OneDriveStorageProvider implements IStorageProvider {
    name = 'onedrive';
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;
    private readonly ONEDRIVE_FOLDER = 'FoomClous'; // 存储文件夹名

    constructor(
        public id: string,
        private clientId: string,
        private clientSecret: string,
        private refreshToken: string,
        private tenantId: string = 'common'
    ) {
        console.log(`[OneDrive] Provider ${id} initialized with clientId:`, clientId.substring(0, 8) + '...', 'Tenant:', tenantId);
    }

    /**
     * 生成 OAuth 授权 URL
     */
    static generateAuthUrl(clientId: string, tenantId: string = 'common', redirectUri: string): string {
        const scope = encodeURIComponent('Files.ReadWrite.All offline_access');
        const encodedRedirect = encodeURIComponent(redirectUri);
        return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&scope=${scope}&response_type=code&redirect_uri=${encodedRedirect}&response_mode=query`;
    }

    /**
     * 使用授权码交换令牌
     */
    static async exchangeCodeForToken(clientId: string, clientSecret: string, tenantId: string = 'common', redirectUri: string, code: string) {
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        if (clientSecret) params.append('client_secret', clientSecret);
        params.append('code', code);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri);

        const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const response = await axios.post(endpoint, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000
        });

        return response.data; // 包含 access_token, refresh_token, expires_in 等
    }

    /**
     * 获取有效的访问令牌，自动刷新过期令牌
     */
    private async getAccessToken(): Promise<string> {
        // 提前5分钟刷新令牌
        if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) {
            return this.accessToken;
        }

        console.log('[OneDrive] Refreshing access token...');

        // 重试逻辑
        let lastError: any = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const params = new URLSearchParams();
                params.append('client_id', this.clientId);
                params.append('scope', 'Files.ReadWrite.All offline_access');

                // 只有在 clientSecret 存在时才添加 (支持 confidential 和 public client)
                if (this.clientSecret) {
                    params.append('client_secret', this.clientSecret);
                }

                params.append('refresh_token', this.refreshToken);
                params.append('grant_type', 'refresh_token');

                const endpoint = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

                const response = await axios.post(
                    endpoint,
                    params.toString(),
                    {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000
                    }
                );

                this.accessToken = response.data.access_token;
                this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
                console.log('[OneDrive] Token refreshed successfully, expires in:', response.data.expires_in, 'seconds');

                // 更新 refresh_token（如果返回了新的）
                if (response.data.refresh_token && response.data.refresh_token !== this.refreshToken) {
                    console.log(`[OneDrive] New refresh token received for account ${this.id}, updating database...`);
                    this.refreshToken = response.data.refresh_token;
                    await StorageManager.updateAccountToken(this.id, this.refreshToken);
                }

                return this.accessToken!;
            } catch (error: any) {
                lastError = error;
                const errorData = error.response?.data;
                console.error(`[OneDrive] Token refresh attempt ${attempt}/3 failed:`, {
                    status: error.response?.status,
                    error: errorData?.error,
                    description: errorData?.error_description
                });

                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }

        throw new Error(`Failed to refresh OneDrive token after 3 attempts: ${lastError?.response?.data?.error_description || lastError?.message}`);
    }

    /**
     * 确保存储文件夹存在
     */
    private async ensureFolderExists(token: string): Promise<void> {
        try {
            await axios.get(
                `https://graph.microsoft.com/v1.0/me/drive/root:/${this.ONEDRIVE_FOLDER}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
        } catch (error: any) {
            if (error.response?.status === 404) {
                console.log('[OneDrive] Creating storage folder:', this.ONEDRIVE_FOLDER);
                await axios.post(
                    `https://graph.microsoft.com/v1.0/me/drive/root/children`,
                    {
                        name: this.ONEDRIVE_FOLDER,
                        folder: {},
                        "@microsoft.graph.conflictBehavior": "fail"
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                console.log('[OneDrive] Storage folder created successfully');
            } else {
                throw error;
            }
        }
    }

    /**
     * 保存文件到 OneDrive
     */
    async saveFile(tempPath: string, fileName: string, mimeType: string): Promise<string> {
        const token = await this.getAccessToken();
        const stats = await fs.promises.stat(tempPath);
        const fileSize = stats.size;

        console.log(`[OneDrive] Uploading file: ${fileName}, size: ${fileSize} bytes, type: ${mimeType}`);

        // 确保文件夹存在
        await this.ensureFolderExists(token);

        // URL编码文件名，处理特殊字符
        const encodedFileName = encodeURIComponent(fileName);

        try {
            // 小于 4MB 使用简单上传
            if (fileSize < 4 * 1024 * 1024) {
                console.log('[OneDrive] Using simple upload for small file');
                const fileBuffer = await fs.promises.readFile(tempPath);

                const response = await axios.put(
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.ONEDRIVE_FOLDER}/${encodedFileName}:/content`,
                    fileBuffer,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': mimeType || 'application/octet-stream',
                            'Content-Length': fileSize.toString()
                        },
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity,
                        timeout: 60000
                    }
                );

                console.log('[OneDrive] Simple upload successful, file ID:', response.data.id);
                return response.data.id;
            } else {
                // 大文件使用分片上传会话
                console.log('[OneDrive] Using chunked upload session for large file');

                // 1. 创建上传会话
                const sessionRes = await axios.post(
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.ONEDRIVE_FOLDER}/${encodedFileName}:/createUploadSession`,
                    {
                        item: {
                            "@microsoft.graph.conflictBehavior": "rename",
                            name: fileName
                        }
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 30000
                    }
                );

                const uploadUrl = sessionRes.data.uploadUrl;
                console.log('[OneDrive] Upload session created');

                // 2. 分片上传 - 使用流式读取避免内存溢出
                const CHUNK_SIZE = 320 * 1024 * 10; // 3.2MB (必须是 320KB 的倍数)
                let uploadedBytes = 0;
                let lastResponse: any = null;

                const fd = await fs.promises.open(tempPath, 'r');
                try {
                    while (uploadedBytes < fileSize) {
                        const chunkSize = Math.min(CHUNK_SIZE, fileSize - uploadedBytes);
                        const buffer = Buffer.alloc(chunkSize);
                        await fd.read(buffer, 0, chunkSize, uploadedBytes);

                        const rangeEnd = uploadedBytes + chunkSize - 1;
                        const contentRange = `bytes ${uploadedBytes}-${rangeEnd}/${fileSize}`;

                        console.log(`[OneDrive] Uploading chunk: ${contentRange}`);

                        lastResponse = await axios.put(uploadUrl, buffer, {
                            headers: {
                                'Content-Length': chunkSize.toString(),
                                'Content-Range': contentRange
                            },
                            maxBodyLength: Infinity,
                            maxContentLength: Infinity,
                            timeout: 120000
                        });

                        uploadedBytes += chunkSize;
                        const progress = Math.round((uploadedBytes / fileSize) * 100);
                        console.log(`[OneDrive] Upload progress: ${progress}%`);
                    }
                } catch (chunkError: any) {
                    await fd.close();
                    // 分片上传失败，尝试取消会话
                    console.error('[OneDrive] Chunk upload failed, cancelling session...');
                    await this.cancelUploadSession(uploadUrl);
                    throw chunkError;
                } finally {
                    try { await fd.close(); } catch { /* ignore */ }
                }

                // 最后一个分片的响应包含完整的文件信息
                if (lastResponse?.data?.id) {
                    console.log('[OneDrive] Chunked upload successful, file ID:', lastResponse.data.id);
                    return lastResponse.data.id;
                }

                // 如果最后响应没有ID，查询文件信息
                const itemRes = await axios.get(
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.ONEDRIVE_FOLDER}/${encodedFileName}`,
                    {
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 30000
                    }
                );
                console.log('[OneDrive] File ID retrieved:', itemRes.data.id);
                return itemRes.data.id;
            }
        } catch (error: any) {
            console.error('[OneDrive] Upload failed:', {
                status: error.response?.status,
                error: error.response?.data?.error,
                message: error.message
            });
            throw new Error(`OneDrive upload failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * 取消上传会话（清理服务器上的未完成上传）
     */
    async cancelUploadSession(uploadUrl: string): Promise<void> {
        try {
            await axios.delete(uploadUrl, { timeout: 10000 });
            console.log('[OneDrive] Upload session cancelled successfully');
        } catch (error: any) {
            // 会话可能已过期或不存在，忽略错误
            console.warn('[OneDrive] Failed to cancel upload session (may already be expired):', error.message);
        }
    }

    /**
     * 获取文件流用于下载
     */
    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}/content`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    responseType: 'stream',
                    timeout: 60000
                }
            );
            return response.data;
        } catch (error: any) {
            console.error('[OneDrive] Get file stream failed:', {
                fileId: storedPath,
                status: error.response?.status,
                error: error.response?.data?.error
            });
            throw new Error(`OneDrive download failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * 获取文件预览URL（临时下载链接，有效期约1小时）
     */
    async getPreviewUrl(storedPath: string): Promise<string> {
        const token = await this.getAccessToken();

        try {
            // 不使用 $select，因为 @microsoft.graph.downloadUrl 是系统注解，显式选择反而拿不到
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 30000
                }
            );

            const downloadUrl = response.data['@microsoft.graph.downloadUrl'];
            if (!downloadUrl) {
                console.error('[OneDrive] Download URL missing from response:', {
                    fileId: storedPath,
                    responseKeys: Object.keys(response.data)
                });
                throw new Error('Download URL not available');
            }

            return downloadUrl;
        } catch (error: any) {
            console.error('[OneDrive] Get preview URL failed:', {
                fileId: storedPath,
                status: error.response?.status,
                error: error.response?.data?.error
            });
            throw new Error(`OneDrive preview URL failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * 删除文件
     */
    async deleteFile(storedPath: string): Promise<void> {
        const token = await this.getAccessToken();

        try {
            await axios.delete(
                `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 30000
                }
            );
            console.log('[OneDrive] File deleted:', storedPath);
        } catch (error: any) {
            // 如果文件已经不存在，不报错
            if (error.response?.status === 404) {
                console.log('[OneDrive] File already deleted or not found:', storedPath);
                return;
            }
            console.error('[OneDrive] Delete file failed:', {
                fileId: storedPath,
                status: error.response?.status,
                error: error.response?.data?.error
            });
            throw new Error(`OneDrive delete failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * 获取文件大小
     */
    async getFileSize(storedPath: string): Promise<number> {
        const token = await this.getAccessToken();

        try {
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}?$select=size`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 30000
                }
            );
            return response.data.size || 0;
        } catch (error: any) {
            console.error('[OneDrive] Get file size failed:', error.message);
            return 0;
        }
    }
}

// 存储管理器
export class StorageManager {
    private static instance: StorageManager;
    private activeProvider: IStorageProvider;
    private providers: Map<string, IStorageProvider> = new Map();
    private activeAccountId: string | null = null;

    private constructor() {
        // 默认初始化 LocalProvider
        const local = new LocalStorageProvider();
        this.providers.set(local.name, local);
        this.activeProvider = local;
    }

    static getInstance(): StorageManager {
        if (!StorageManager.instance) {
            StorageManager.instance = new StorageManager();
        }
        return StorageManager.instance;
    }

    // 初始化：从数据库加载配置
    async init() {
        try {
            // 0. 确保表存在
            await query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(255) PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE TABLE IF NOT EXISTS storage_accounts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    type VARCHAR(50) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    config JSONB NOT NULL,
                    is_active BOOLEAN DEFAULT false,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );

                -- 确保 files 表有 storage_account_id 字段
                DO $$ 
                BEGIN 
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='files' AND column_name='storage_account_id') THEN
                        ALTER TABLE files ADD COLUMN storage_account_id UUID;
                    END IF;
                END $$;
            `);

            // 1. 迁移旧配置（如果存在且尚未迁移）
            await this.migrateLegacyConfig();

            // 2. 获取当前激活的 Provider 类型 (统一使用 active_storage_provider)
            let providerRes = await query('SELECT value FROM system_settings WHERE key = $1', ['active_storage_provider']);
            let providerName = providerRes.rows[0]?.value || null;

            // 兼容旧版本：如果新 key 不存在，检查旧 key
            if (!providerName) {
                const legacyRes = await query('SELECT value FROM system_settings WHERE key = $1', ['storage_provider']);
                providerName = legacyRes.rows[0]?.value || 'local';
                // 迁移旧 key 到新 key
                if (legacyRes.rows[0]) {
                    console.log(`[StorageManager] Migrating legacy key 'storage_provider' -> 'active_storage_provider' = ${providerName}`);
                    await StorageManager.updateSetting('active_storage_provider', providerName);
                }
            }

            console.log(`[StorageManager] Active provider from settings: ${providerName}`);

            // 3. 加载所有 OneDrive 账户
            const accountsRes = await query('SELECT * FROM storage_accounts WHERE type = $1', ['onedrive']);
            for (const row of accountsRes.rows) {
                const config = row.config;
                const oneDrive = new OneDriveStorageProvider(
                    row.id,
                    config.clientId,
                    config.clientSecret || '',
                    config.refreshToken,
                    config.tenantId || 'common'
                );
                this.providers.set(`onedrive:${row.id}`, oneDrive);

                if (row.is_active && providerName === 'onedrive') {
                    this.activeProvider = oneDrive;
                    this.activeAccountId = row.id;
                    console.log(`Storage Provider initialized: OneDrive Account (${row.name})`);
                }
            }

            if (providerName === 'local' || !this.activeAccountId) {
                this.activeProvider = this.providers.get('local')!;
                this.activeAccountId = null;
                console.log('Storage Provider initialized: Local');
            }
        } catch (error) {
            console.error('Failed to init storage manager:', error);
            this.activeProvider = this.providers.get('local')!;
        }
    }

    private async migrateLegacyConfig() {
        const clientId = await this.getSetting('onedrive_client_id');
        const refreshToken = await this.getSetting('onedrive_refresh_token');

        if (clientId && refreshToken) {
            console.log('[StorageManager] Migrating legacy OneDrive config...');
            const clientSecret = await this.getSetting('onedrive_client_secret') || '';
            const tenantId = await this.getSetting('onedrive_tenant_id') || 'common';

            // 检查是否已经迁移过（通过 clientId 匹配测试）
            const existing = await query('SELECT id FROM storage_accounts WHERE config->>\'clientId\' = $1', [clientId]);
            let accountId: string;

            if (existing.rows.length === 0) {
                const insertRes = await query(
                    `INSERT INTO storage_accounts (type, name, config, is_active) 
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    ['onedrive', 'Default Account', JSON.stringify({ clientId, clientSecret, refreshToken, tenantId }), true]
                );
                accountId = insertRes.rows[0].id;
                console.log('[StorageManager] Legacy config migrated successfully.');
            } else {
                accountId = existing.rows[0].id;
            }

            // 关键修复：确保所有 source='onedrive' 且没有 storage_account_id 的文件都关联到此账号
            const updateRes = await query(
                'UPDATE files SET storage_account_id = $1 WHERE source = $2 AND storage_account_id IS NULL',
                [accountId, 'onedrive']
            );
            if (updateRes.rowCount! > 0) {
                console.log(`[StorageManager] Associated ${updateRes.rowCount} legacy OneDrive files with account ${accountId}`);
            }
        }
    }

    async getSetting(key: string): Promise<string | null> {
        const res = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
        return res.rows[0]?.value || null;
    }

    static async updateSetting(key: string, value: string) {
        await query(
            `INSERT INTO system_settings (key, value, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value]
        );
    }

    static async updateAccountToken(accountId: string, refreshToken: string) {
        await query(
            `UPDATE storage_accounts 
             SET config = config || jsonb_build_object('refreshToken', $2::text), updated_at = NOW()
             WHERE id = $1`,
            [accountId, refreshToken]
        );
    }

    getProvider(name?: string): IStorageProvider {
        if (name && this.providers.has(name)) {
            return this.providers.get(name)!;
        }
        return this.activeProvider;
    }

    getActiveAccountId(): string | null {
        return this.activeAccountId;
    }

    async getAccounts() {
        const res = await query('SELECT id, name, type, is_active FROM storage_accounts ORDER BY created_at ASC');
        return res.rows;
    }

    // 从内存中移除 Provider
    removeProvider(key: string) {
        this.providers.delete(key);
    }

    // 添加新的 OneDrive 账户
    async addOneDriveAccount(name: string, clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common') {
        const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            ['onedrive', name, JSON.stringify({ clientId, clientSecret, refreshToken, tenantId }), false]
        );

        const newId = res.rows[0].id;
        // 初始化 Provider
        const oneDrive = new OneDriveStorageProvider(newId, clientId, clientSecret, refreshToken, tenantId);
        this.providers.set(`onedrive:${newId}`, oneDrive);

        return newId;
    }

    // 切换激活账户
    async switchAccount(accountId: string | 'local') {
        if (accountId === 'local') {
            await StorageManager.updateSetting('active_storage_provider', 'local');
            await query('UPDATE storage_accounts SET is_active = false');
        } else {
            await StorageManager.updateSetting('active_storage_provider', 'onedrive');
            await query('UPDATE storage_accounts SET is_active = (id = $1)', [accountId]);
        }

        // 重新初始化以刷新状态
        await this.init();
    }

    async updateOneDriveConfig(clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common') {
        // 同步更新 system_settings 以便 OAuth 回调获取最新的 Client ID/Secret
        await StorageManager.updateSetting('onedrive_client_id', clientId);
        await StorageManager.updateSetting('onedrive_client_secret', clientSecret);
        await StorageManager.updateSetting('onedrive_tenant_id', tenantId);

        if (this.activeAccountId && this.activeProvider.name === 'onedrive') {
            await query(
                `UPDATE storage_accounts 
                 SET config = $2, updated_at = NOW()
                 WHERE id = $1`,
                [this.activeAccountId, JSON.stringify({ clientId, clientSecret, refreshToken, tenantId })]
            );
        } else if (refreshToken !== 'pending') {
            // 只有在有实际 Token 时才添加或更新账户，或者如果是第一次设置
            await this.addOneDriveAccount('OneDrive', clientId, clientSecret, refreshToken, tenantId);
            // 自动开启
            const res = await query('SELECT id FROM storage_accounts WHERE type = $1 ORDER BY created_at DESC LIMIT 1', ['onedrive']);
            if (res.rows[0]) {
                await this.switchAccount(res.rows[0].id);
            }
        }
        await this.init();
    }

    // 切换回本地
    async switchToLocal() {
        await this.switchAccount('local');
    }
}

export const storageManager = StorageManager.getInstance();
