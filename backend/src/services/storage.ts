
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { query } from '../db/index.js';

// 接口定义
export interface IStorageProvider {
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
        private clientId: string,
        private clientSecret: string,
        private refreshToken: string,
        private tenantId: string = 'common'
    ) {
        console.log('[OneDrive] Provider initialized with clientId:', clientId.substring(0, 8) + '...', 'Tenant:', tenantId);
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
                    console.log('[OneDrive] New refresh token received, updating database...');
                    this.refreshToken = response.data.refresh_token;
                    await StorageManager.updateSetting('onedrive_refresh_token', this.refreshToken);
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
            // 0. Ensure table exists (Migration on init)
            await query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(255) PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 1. 获取当前激活的 Provider
            const providerRes = await query('SELECT value FROM system_settings WHERE key = $1', ['storage_provider']);
            const providerName = providerRes.rows[0]?.value || 'local';

            // 2. 如果是 OneDrive，加载凭证
            if (providerName === 'onedrive') {
                const clientId = await this.getSetting('onedrive_client_id');
                const clientSecret = await this.getSetting('onedrive_client_secret'); // Can be empty
                const refreshToken = await this.getSetting('onedrive_refresh_token');
                const tenantId = await this.getSetting('onedrive_tenant_id') || 'common';

                if (clientId && refreshToken) {
                    const oneDrive = new OneDriveStorageProvider(clientId, clientSecret || '', refreshToken, tenantId);
                    this.providers.set('onedrive', oneDrive);
                    this.activeProvider = oneDrive;
                    console.log('Storage Provider initialized: OneDrive');
                } else {
                    console.warn('OneDrive credentials missing, fallback to Local');
                    this.activeProvider = this.providers.get('local')!;
                }
            } else {
                this.activeProvider = this.providers.get('local')!;
                console.log('Storage Provider initialized: Local');
            }
        } catch (error) {
            console.error('Failed to init storage manager:', error);
            // Fallback to local
            this.activeProvider = this.providers.get('local')!;
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

    getProvider(name?: string): IStorageProvider {
        if (name && this.providers.has(name)) {
            return this.providers.get(name)!;
        }
        return this.activeProvider;
    }

    // 更新 OneDrive 配置并切换
    async updateOneDriveConfig(clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common') {
        await StorageManager.updateSetting('onedrive_client_id', clientId);
        await StorageManager.updateSetting('onedrive_client_secret', clientSecret);
        await StorageManager.updateSetting('onedrive_refresh_token', refreshToken);
        await StorageManager.updateSetting('onedrive_tenant_id', tenantId);
        await StorageManager.updateSetting('storage_provider', 'onedrive');

        // 重新初始化
        await this.init();
    }

    // 切换回本地
    async switchToLocal() {
        await StorageManager.updateSetting('storage_provider', 'local');
        await this.init();
    }
}

export const storageManager = StorageManager.getInstance();
