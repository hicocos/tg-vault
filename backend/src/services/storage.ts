import fs from 'fs';
import path from 'path';
import axios from 'axios';
import OSS from 'ali-oss';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient, WebDAVClient } from 'webdav';
import { google } from 'googleapis';
import { query } from '../db/index.js';
import { safeJoin } from '../utils/localPath.js';
import {
    decryptSettingValue,
    decryptStorageConfig,
    encryptCredential,
    encryptSettingValue,
    encryptStorageConfig,
    isEncryptedCredential,
    isSensitiveSettingKey,
    storageConfigNeedsEncryption,
} from '../utils/credentialCrypto.js';

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
    saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<string>;

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


    /**
     * 创建分享链接
     * @param storedPath 存储路径或标识符
     * @param password 访问密码（可选）
     * @param expiration 过期时间 ISO 字符串（可选）
     */
    createShareLink?(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }>;
}

// 本地存储实现
export class LocalStorageProvider implements IStorageProvider {
    name = 'local';
    private uploadDir: string;

    constructor(uploadDir: string = process.env.UPLOAD_DIR || './data/uploads') {
        this.uploadDir = path.resolve(uploadDir);
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    async saveFile(tempPath: string, fileName: string, _mimeType?: string, folder?: string | null): Promise<string> {
        const destDir = folder ? safeJoin(this.uploadDir, folder) : this.uploadDir;
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        const destPath = safeJoin(destDir, fileName);
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
        const safePath = safeJoin(this.uploadDir, path.relative(this.uploadDir, storedPath));
        if (safePath !== path.resolve(storedPath)) {
            throw new Error('Unsafe local file path');
        }
        if (!fs.existsSync(safePath)) {
            throw new Error(`File not found: ${safePath}`);
        }
        return fs.createReadStream(safePath);
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        // 本地文件通过现有的 serve-static 或 API 路由提供服务
        // 这里我们返回文件名，让上层路由处理
        // 注意：目前架构是 controller 层组装 URL，这里其实可能不需要具体 URL
        // 或者我们可以返回 null，让上层使用默认逻辑
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        const safePath = safeJoin(this.uploadDir, path.relative(this.uploadDir, storedPath));
        if (safePath !== path.resolve(storedPath)) {
            throw new Error('Unsafe local file path');
        }
        if (fs.existsSync(safePath)) {
            await fs.promises.unlink(safePath);
        }
    }

    async createShareLink(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }> {
        // 本地存储暂不支持生成外部访问链接，除非我们自己实现一个分享页面
        // 这里返回错误提示
        return { link: '', error: '本地存储暂不支持生成分享链接，请使用 OneDrive 存储。' };
    }
}

// Aliyun OSS 存储实现
export class AliyunOSSStorageProvider implements IStorageProvider {
    name = 'aliyun_oss';
    private client: any;

    constructor(
        public id: string,
        region: string,
        accessKeyId: string,
        accessKeySecret: string,
        bucket: string
    ) {
        const sanitizedRegion = this.sanitizeRegion(region);
        this.client = new OSS({
            region: sanitizedRegion,
            accessKeyId: accessKeyId,
            accessKeySecret: accessKeySecret,
            bucket: bucket,
            secure: true
        });
    }

    private sanitizeRegion(region: string): string {
        let r = region.trim().toLowerCase();
        // 移除协议头
        r = r.replace(/^https?:\/\//, '');
        // 如果输入的是完整的 endpoint (如 oss-cn-hangzhou.aliyuncs.com)，提取 region 部分
        if (r.includes('.aliyuncs.com')) {
            r = r.split('.')[0];
        }
        // 如果以 oss- 开头，ali-oss SDK 通常可以自动处理，但有些版本可能只需要 cn-hangzhou
        // 实际上 ali-oss 会自动处理 oss- 前缀，所以保留或移除通常都可以，但要确保没有多余的后缀
        return r;
    }

    async saveFile(tempPath: string, fileName: string, _mimeType?: string, folder?: string | null): Promise<string> {
        try {
            const objectKey = folder ? `${folder}/${fileName}` : fileName;
            const result = await this.client.put(objectKey, tempPath);
            console.log('[AliyunOSS] Upload successful:', result.name);
            return result.name;
        } catch (error: any) {
            console.error('[AliyunOSS] Upload failed:', error.message);
            throw new Error(`Aliyun OSS upload failed: ${error.message}`);
        }
    }

    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        try {
            const result = await this.client.getStream(storedPath);
            return result.stream;
        } catch (error: any) {
            console.error('[AliyunOSS] Get stream failed:', error.message);
            throw new Error(`Aliyun OSS get stream failed: ${error.message}`);
        }
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        try {
            // 生成带签名的 URL，有效期 1 小时
            const url = this.client.signatureUrl(storedPath, { expires: 3600 });
            return url;
        } catch (error: any) {
            console.error('[AliyunOSS] Get preview URL failed:', error.message);
            return '';
        }
    }

    async deleteFile(storedPath: string): Promise<void> {
        try {
            await this.client.delete(storedPath);
            console.log('[AliyunOSS] Delete successful:', storedPath);
        } catch (error: any) {
            console.error('[AliyunOSS] Delete failed:', error.message);
            throw new Error(`Aliyun OSS delete failed: ${error.message}`);
        }
    }

    async getFileSize(storedPath: string): Promise<number> {
        try {
            const result = await this.client.head(storedPath);
            return parseInt(result.meta['content-length'] || result.res.headers['content-length'] || '0');
        } catch (error: any) {
            console.error('[AliyunOSS] Get file size failed:', error.message);
            return 0;
        }
    }
}

// S3 兼容存储实现
export class S3StorageProvider implements IStorageProvider {
    name = 's3';
    private client: S3Client;

    constructor(
        public id: string,
        private endpoint: string,
        private region: string,
        private accessKeyId: string,
        private secretAccessKey: string,
        private bucket: string,
        private forcePathStyle: boolean = false
    ) {
        this.client = new S3Client({
            endpoint: endpoint,
            region: region,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
            forcePathStyle: forcePathStyle,
        });
    }

    async saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<string> {
        try {
            const objectKey = folder ? `${folder}/${fileName}` : fileName;
            const stats = await fs.promises.stat(tempPath);
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: objectKey,
                Body: fs.createReadStream(tempPath),
                ContentType: mimeType,
                ContentLength: stats.size,
            });
            await this.client.send(command);
            return objectKey;
        } catch (error: any) {
            console.error('[S3] Upload failed:', error.message);
            throw new Error(`S3 upload failed: ${error.message}`);
        }
    }

    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: storedPath,
            });
            const response = await this.client.send(command);
            // AWS SDK v3 response.Body is a SDK stream, which can be piped
            return response.Body as NodeJS.ReadableStream;
        } catch (error: any) {
            console.error('[S3] Get stream failed:', error.message);
            throw new Error(`S3 get stream failed: ${error.message}`);
        }
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: storedPath,
            });
            // 默认有效期 1 小时
            return await getS3SignedUrl(this.client, command, { expiresIn: 3600 });
        } catch (error: any) {
            console.error('[S3] Get preview URL failed:', error.message);
            return '';
        }
    }

    async deleteFile(storedPath: string): Promise<void> {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: storedPath,
            });
            await this.client.send(command);
        } catch (error: any) {
            console.error('[S3] Delete failed:', error.message);
            throw new Error(`S3 delete failed: ${error.message}`);
        }
    }

    async getFileSize(storedPath: string): Promise<number> {
        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: storedPath,
            });
            const response = await this.client.send(command);
            return response.ContentLength || 0;
        } catch (error: any) {
            console.error('[S3] Get file size failed:', error.message);
            return 0;
        }
    }
}

// WebDAV 存储实现
export class WebDAVStorageProvider implements IStorageProvider {
    name = 'webdav';
    private client: WebDAVClient;

    constructor(
        public id: string,
        private url: string,
        private username?: string,
        private password?: string
    ) {
        this.client = createClient(url, {
            username: username,
            password: password
        });
    }

    async saveFile(tempPath: string, fileName: string, _mimeType?: string, folder?: string | null): Promise<string> {
        try {
            const remotePath = folder ? `${folder}/${fileName}` : fileName;
            if (folder) {
                await this.client.createDirectory(`/${folder}`, { recursive: true });
            }
            await this.client.putFileContents(`/${remotePath}`, fs.createReadStream(tempPath));
            console.log('[WebDAV] Upload successful:', remotePath);
            return remotePath;
        } catch (error: any) {
            console.error('[WebDAV] Upload failed:', error.message);
            throw new Error(`WebDAV upload failed: ${error.message}`);
        }
    }

    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        try {
            return this.client.createReadStream(`/${storedPath}`);
        } catch (error: any) {
            console.error('[WebDAV] Get stream failed:', error.message);
            throw new Error(`WebDAV get stream failed: ${error.message}`);
        }
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        try {
            await this.client.deleteFile(`/${storedPath}`);
            console.log('[WebDAV] Delete successful:', storedPath);
        } catch (error: any) {
            console.error('[WebDAV] Delete failed:', error.message);
            throw new Error(`WebDAV delete failed: ${error.message}`);
        }
    }

    async getFileSize(storedPath: string): Promise<number> {
        try {
            const stat = await this.client.stat(`/${storedPath}`) as any;
            return stat.size || 0;
        } catch (error: any) {
            console.error('[WebDAV] Get file size failed:', error.message);
            return 0;
        }
    }
}

// OneDrive 国际版存储实现
export class OneDriveStorageProvider implements IStorageProvider {
    name = 'onedrive';
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;
    private readonly ONEDRIVE_FOLDER = ''; // 使用第三方存储根目录，不再额外套 TG Vault 目录

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
    static generateAuthUrl(clientId: string, tenantId: string = 'common', redirectUri: string, state?: string): string {
        const scope = encodeURIComponent('Files.ReadWrite.All offline_access');
        const encodedRedirect = encodeURIComponent(redirectUri);
        const stateParam = state ? `&state=${encodeURIComponent(state)}` : '';
        return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&scope=${scope}&response_type=code&redirect_uri=${encodedRedirect}&response_mode=query${stateParam}`;
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
                params.append('client_id', this.clientId.trim());
                // params.append('scope', ...); // Remove scope to use default scopes from refresh token

                // 只有在 clientSecret 存在且非空时才添加
                if (this.clientSecret && this.clientSecret.trim()) {
                    params.append('client_secret', this.clientSecret.trim());
                }

                params.append('refresh_token', this.refreshToken.trim());
                params.append('grant_type', 'refresh_token');

                const endpoint = `https://login.microsoftonline.com/${this.tenantId.trim()}/oauth2/v2.0/token`;

                console.log(`[OneDrive] Refreshing token. ClientID: ${this.clientId}, HasSecret: ${!!this.clientSecret}, Scope: ${params.get('scope')}`);
                // console.log('Params:', params.toString()); // Uncomment for deep debug (sensitive!)

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

    private encodeOneDrivePath(rawPath: string): string {
        return rawPath.split('/').filter(Boolean).map(part => encodeURIComponent(part)).join('/');
    }

    /**
     * 确保存储文件夹存在
     */
    private async ensureFolderExists(token: string, folder?: string | null): Promise<string> {
        const fullFolderPath = [this.ONEDRIVE_FOLDER, folder].filter(Boolean).join('/');
        if (!fullFolderPath) return '';
        try {
            // 使用标准的路径寻址格式，并在末尾添加冒号确保路径闭合
            const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(fullFolderPath)}:`;
            await axios.get(endpoint, {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 30000
            });
            return fullFolderPath;
        } catch (error: any) {
            if (error.response?.status === 404) {
                const segments = fullFolderPath.split('/').filter(Boolean);
                let currentPath = '';
                for (const segment of segments) {
                    const parentPath = currentPath;
                    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                    try {
                        await axios.get(`https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(currentPath)}:`, {
                            headers: { 'Authorization': `Bearer ${token}` },
                            timeout: 30000
                        });
                    } catch (getError: any) {
                        if (getError.response?.status !== 404) throw getError;
                        const parentEndpoint = parentPath
                            ? `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(parentPath)}:/children`
                            : 'https://graph.microsoft.com/v1.0/me/drive/root/children';
                        await axios.post(
                            parentEndpoint,
                            { name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
                            {
                                headers: {
                                    'Authorization': `Bearer ${token}`,
                                    'Content-Type': 'application/json'
                                },
                                timeout: 30000
                            }
                        );
                    }
                }
                console.log('[OneDrive] Storage folder created successfully:', fullFolderPath);
                return fullFolderPath;
            } else {
                const errorDetails = error.response?.data?.error || error.message;
                console.error('[OneDrive] Check folder failed:', errorDetails);
                throw new Error(`OneDrive folder check failed (Status ${error.response?.status}): ${JSON.stringify(errorDetails)}`);
            }
        }
    }

    /**
     * 保存文件到 OneDrive
     */
    async saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<string> {
        const token = await this.getAccessToken();
        const stats = await fs.promises.stat(tempPath);
        const fileSize = stats.size;

        console.log(`[OneDrive] Uploading file: ${fileName}, size: ${fileSize} bytes, type: ${mimeType}`);

        // 确保文件夹存在
        const uploadFolder = await this.ensureFolderExists(token, folder);

        // URL编码文件名，处理特殊字符
        const targetPath = uploadFolder ? `${uploadFolder}/${fileName}` : fileName;

        try {
            // 小于 4MB 使用简单上传
            if (fileSize < 4 * 1024 * 1024) {
                console.log('[OneDrive] Using simple upload for small file');
                const fileBuffer = await fs.promises.readFile(tempPath);

                const response = await axios.put(
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}:/content`,
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
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}:/createUploadSession`,
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
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodeOneDrivePath(targetPath)}`,
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

    /**
     * 创建分享链接
     */
    async createShareLink(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }> {
        const token = await this.getAccessToken();

        try {
            const body: any = {
                type: 'view',
                scope: 'anonymous' // 任何人（可能需要根据组织策略调整）
            };

            if (password) {
                body.password = password;
            }

            if (expiration) {
                // 确保时间格式是 ISO 8601 UTC
                body.expirationDateTime = expiration;
            }

            console.log(`[OneDrive] Creating share link for ${storedPath} with params:`, { ...body, password: body.password ? '***' : undefined });

            const response = await axios.post(
                `https://graph.microsoft.com/v1.0/me/drive/items/${storedPath}/createLink`,
                body,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );

            if (response.data && response.data.link && response.data.link.webUrl) {
                console.log('[OneDrive] Share link created successfully');
                return { link: response.data.link.webUrl };
            } else {
                return { link: '', error: 'OneDrive 未返回有效的分享链接' };
            }

        } catch (error: any) {
            console.error('[OneDrive] Create share link failed:', {
                status: error.response?.status,
                error: error.response?.data?.error
            });

            // 处理特定错误
            const errorData = error.response?.data?.error;
            if (errorData?.code === 'notSupported' || errorData?.code === 'invalidRequest') {
                if (password || expiration) {
                    return { link: '', error: '您的 OneDrive 账户可能不支持设置密码或过期时间，请尝试不带这些选项重试，或检查 OneDrive 账户类型（部分个人版/商业版限制）。' };
                }
            }

            return { link: '', error: `创建分享链接失败: ${errorData?.message || error.message}` };
        }
    }
}

// Google Drive 存储实现
export class GoogleDriveStorageProvider implements IStorageProvider {
    name = 'google_drive';
    private oauth2Client: any;
    private drive: any;
    private tokenExpiresAt: number = 0;
    private readonly GOOGLE_DRIVE_FOLDER = 'TG Vault';
    private folderIdCache = new Map<string, string>();
    private folderEnsureLocks = new Map<string, Promise<string>>();

    constructor(
        public id: string,
        private clientId: string,
        private clientSecret: string,
        private refreshToken: string,
        private redirectUri: string
    ) {
        this.oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            this.redirectUri
        );
        this.oauth2Client.setCredentials({
            refresh_token: this.refreshToken
        });
        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    }

    static generateAuthUrl(clientId: string, clientSecret: string, redirectUri: string, state?: string): string {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        return oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive.file'],
            prompt: 'consent',
            state
        });
    }

    static async exchangeCodeForToken(clientId: string, clientSecret: string, redirectUri: string, code: string) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        return tokens;
    }

    private async ensureAuthenticated() {
        const credentials = await this.oauth2Client.getAccessToken();
        if (credentials.token) {
            this.tokenExpiresAt = credentials.res?.data?.expiry_date || 0;
        }
    }

    private escapeDriveQuery(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    private async findFolderId(segment: string, parentId: string | null): Promise<string | null> {
        const parentClause: string = parentId ? `'${parentId}' in parents` : `'root' in parents`;
        const response: any = await this.drive.files.list({
            q: `name = '${this.escapeDriveQuery(segment)}' and mimeType = 'application/vnd.google-apps.folder' and ${parentClause} and trashed = false`,
            fields: 'files(id, name, createdTime)',
            orderBy: 'createdTime',
            spaces: 'drive',
            pageSize: 10,
        });
        return response.data.files?.[0]?.id || null;
    }

    private async ensureChildFolder(segment: string, parentId: string | null): Promise<string> {
        const cacheKey = `${parentId || 'root'}/${segment}`;
        const cachedId = this.folderIdCache.get(cacheKey);
        if (cachedId) return cachedId;

        const existingLock = this.folderEnsureLocks.get(cacheKey);
        if (existingLock) return existingLock;

        const lock = (async () => {
            const existingFolderId = await this.findFolderId(segment, parentId);
            if (existingFolderId) {
                this.folderIdCache.set(cacheKey, existingFolderId);
                return existingFolderId;
            }

            const folderMetadata: any = {
                name: segment,
                mimeType: 'application/vnd.google-apps.folder'
            };
            if (parentId) folderMetadata.parents = [parentId];

            const createdFolder = await this.drive.files.create({
                resource: folderMetadata,
                fields: 'id'
            });
            const createdId = createdFolder.data.id;
            this.folderIdCache.set(cacheKey, createdId);
            return createdId;
        })();

        this.folderEnsureLocks.set(cacheKey, lock);
        try {
            return await lock;
        } finally {
            this.folderEnsureLocks.delete(cacheKey);
        }
    }

    private async ensureFolderExists(folder?: string | null): Promise<string> {
        await this.ensureAuthenticated();
        const segments = [this.GOOGLE_DRIVE_FOLDER, ...(folder ? folder.split('/').filter(Boolean) : [])];
        let parentId: string | null = null;

        for (const segment of segments) {
            parentId = await this.ensureChildFolder(segment, parentId);
        }

        return parentId!;
    }

    async saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<string> {
        await this.ensureAuthenticated();
        const folderId = await this.ensureFolderExists(folder);

        const fileMetadata = {
            name: fileName,
            parents: [folderId]
        };

        const media = {
            mimeType: mimeType,
            body: fs.createReadStream(tempPath)
        };

        try {
            const file = await this.drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id'
            });
            console.log('[GoogleDrive] Upload successful, file ID:', file.data.id);
            return file.data.id;
        } catch (error: any) {
            console.error('[GoogleDrive] Upload failed:', error.message);
            throw new Error(`Google Drive upload failed: ${error.message}`);
        }
    }

    async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
        await this.ensureAuthenticated();
        try {
            const response = await this.drive.files.get(
                { fileId: storedPath, alt: 'media' },
                { responseType: 'stream' }
            );
            return response.data;
        } catch (error: any) {
            console.error('[GoogleDrive] Get stream failed:', error.message);
            throw new Error(`Google Drive get stream failed: ${error.message}`);
        }
    }

    async getPreviewUrl(storedPath: string): Promise<string> {
        // Google Drive 预览 URL 需要 OAuth 或公开分享。目前我们返回空以便通过代理下载。
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        await this.ensureAuthenticated();
        try {
            await this.drive.files.delete({ fileId: storedPath });
            console.log('[GoogleDrive] Delete successful:', storedPath);
        } catch (error: any) {
            if (error.code === 404) {
                console.log('[GoogleDrive] File not found, skipping delete:', storedPath);
                return;
            }
            console.error('[GoogleDrive] Delete failed:', error.message);
            throw new Error(`Google Drive delete failed: ${error.message}`);
        }
    }

    async getFileSize(storedPath: string): Promise<number> {
        await this.ensureAuthenticated();
        try {
            const response = await this.drive.files.get({
                fileId: storedPath,
                fields: 'size'
            });
            return parseInt(response.data.size || '0');
        } catch (error: any) {
            console.error('[GoogleDrive] Get file size failed:', error.message);
            return 0;
        }
    }

    /**
     * 创建分享链接
     */
    async createShareLink(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }> {
        await this.ensureAuthenticated();

        try {
            // 1. 设置权限为“任何拥有链接的人均可查看”
            // 注意：drive.file 作用域下，只能对应用创建的文件起作用
            await this.drive.permissions.create({
                fileId: storedPath,
                requestBody: {
                    role: 'reader',
                    type: 'anyone',
                },
            });

            // 2. 获取 webViewLink
            const response = await this.drive.files.get({
                fileId: storedPath,
                fields: 'webViewLink',
            });

            const link = response.data.webViewLink;
            if (!link) {
                return { link: '', error: 'Google Drive 未返回有效的分享链接' };
            }

            console.log('[GoogleDrive] Share link created successfully:', link);

            // 提示用户 Google Drive 不支持在 API 层面直接设置密码或过期时间（针对普通账户）
            let errorMsg = undefined;
            if (password || expiration) {
                errorMsg = 'Google Drive 普通账户暂不支持通过 API 设置分享密码或过期时间，已为您生成公开分享链接。';
            }

            return { link, error: errorMsg };

        } catch (error: any) {
            console.error('[GoogleDrive] Create share link failed:', error.message);
            return { link: '', error: `创建分享链接失败: ${error.message}` };
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

            // 3. 加载所有存储账户。敏感字段在数据库中加密存储，读取时解密；旧明文配置会自动迁移为加密格式。
            const accountsRes = await query('SELECT * FROM storage_accounts');
            // 获取全局 Secret 作为回退（兼容旧版本或用户未特定输入的情况）
            const globalSecretRes = await query("SELECT value FROM system_settings WHERE key = 'onedrive_client_secret'");
            const globalSecretRaw = globalSecretRes.rows[0]?.value || '';
            const globalSecret = globalSecretRaw ? decryptSettingValue('onedrive_client_secret', globalSecretRaw) : '';
            if (globalSecretRaw && !isEncryptedCredential(globalSecretRaw)) {
                await StorageManager.updateSetting('onedrive_client_secret', globalSecretRaw);
            }
            await this.encryptLegacySensitiveSettings();

            for (const row of accountsRes.rows) {
                const rawConfig = row.config || {};
                const config = decryptStorageConfig(rawConfig);
                if (storageConfigNeedsEncryption(rawConfig)) {
                    await query('UPDATE storage_accounts SET config = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(encryptStorageConfig(rawConfig)), row.id]);
                    console.log(`[StorageManager] Encrypted stored credentials for account ${row.id}`);
                }
                let provider: IStorageProvider | null = null;

                if (row.type === 'onedrive') {
                    provider = new OneDriveStorageProvider(
                        row.id,
                        config.clientId,
                        config.clientSecret || globalSecret || '',
                        config.refreshToken,
                        config.tenantId || 'common'
                    );
                    this.providers.set(`onedrive:${row.id}`, provider);
                } else if (row.type === 'aliyun_oss') {
                    provider = new AliyunOSSStorageProvider(
                        row.id,
                        config.region,
                        config.accessKeyId,
                        config.accessKeySecret,
                        config.bucket
                    );
                    this.providers.set(`aliyun_oss:${row.id}`, provider);
                } else if (row.type === 's3') {
                    provider = new S3StorageProvider(
                        row.id,
                        config.endpoint,
                        config.region,
                        config.accessKeyId,
                        config.accessKeySecret,
                        config.bucket,
                        config.forcePathStyle || false
                    );
                    this.providers.set(`s3:${row.id}`, provider);
                } else if (row.type === 'webdav') {
                    provider = new WebDAVStorageProvider(
                        row.id,
                        config.url,
                        config.username,
                        config.password
                    );
                    this.providers.set(`webdav:${row.id}`, provider);
                } else if (row.type === 'google_drive') {
                    provider = new GoogleDriveStorageProvider(
                        row.id,
                        config.clientId,
                        config.clientSecret,
                        config.refreshToken,
                        config.redirectUri
                    );
                    this.providers.set(`google_drive:${row.id}`, provider);
                }

                if (provider && row.is_active) {
                    this.activeProvider = provider;
                    this.activeAccountId = row.id;
                    console.log(`Storage Provider initialized: ${row.type} Account (${row.name})`);
                }
            }

            // 如果没有激活的云存储账户，或者激活的是local，则使用local
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

            // 检查是否已经迁移过（通过 clientId 匹配测试，兼容加密后的 config）
            const existingAccounts = await query('SELECT id, config FROM storage_accounts WHERE type = $1', ['onedrive']);
            const existing = existingAccounts.rows.find((row: any) => decryptStorageConfig(row.config || {}).clientId === clientId);
            let accountId: string;

            if (!existing) {
                const encryptedConfig = encryptStorageConfig({ clientId, clientSecret, refreshToken, tenantId });
                const insertRes = await query(
                    `INSERT INTO storage_accounts (type, name, config, is_active) 
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    ['onedrive', 'Default Account', JSON.stringify(encryptedConfig), true]
                );
                accountId = insertRes.rows[0].id;
                console.log('[StorageManager] Legacy config migrated successfully.');
            } else {
                accountId = existing.id;
                console.log('[StorageManager] Legacy config already migrated, account ID:', accountId);
            }

            // 关键修复：迁移后立即删除旧配置，防止下次启动再次进入此逻辑
            console.log('[StorageManager] Cleaning up legacy settings...');
            await query("DELETE FROM system_settings WHERE key IN ('onedrive_client_id', 'onedrive_client_secret', 'onedrive_refresh_token', 'onedrive_tenant_id')");

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

    private async encryptLegacySensitiveSettings() {
        const res = await query('SELECT key, value FROM system_settings');
        for (const row of res.rows) {
            if (isSensitiveSettingKey(row.key) && row.value && !isEncryptedCredential(row.value)) {
                await StorageManager.updateSetting(row.key, row.value);
                console.log(`[StorageManager] Encrypted sensitive setting ${row.key}`);
            }
        }
    }

    async getSetting(key: string): Promise<string | null> {
        const res = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
        const value = res.rows[0]?.value || null;
        return value ? decryptSettingValue(key, value) : null;
    }

    static async updateSetting(key: string, value: string) {
        const storedValue = encryptSettingValue(key, value);
        await query(
            `INSERT INTO system_settings (key, value, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, storedValue]
        );
    }

    static async updateAccountToken(accountId: string, refreshToken: string) {
        await query(
            `UPDATE storage_accounts 
             SET config = config || jsonb_build_object('refreshToken', $2::text), updated_at = NOW()
             WHERE id = $1`,
            [accountId, encryptCredential(refreshToken)]
        );
    }

    getProvider(name?: string): IStorageProvider {
        if (name) {
            const provider = this.providers.get(name);
            if (!provider) {
                throw new Error(`Storage provider not found: ${name}`);
            }
            return provider;
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

    // 添加新的 OneDrive 账户 (如果 Client ID 已存在则更新现有记录)
    async addOneDriveAccount(name: string, clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common') {
        const config = JSON.stringify(encryptStorageConfig({ clientId, clientSecret, refreshToken, tenantId }));

        // 检查是否已存在相同 Client ID 的账户（兼容旧明文/新加密 config，避免 JSONB 里明文可查敏感字段）
        const existingAccounts = await query('SELECT id, config FROM storage_accounts WHERE type = $1', ['onedrive']);
        const existing = existingAccounts.rows.find((row: any) => decryptStorageConfig(row.config || {}).clientId === clientId);

        let targetId: string;
        if (existing) {
            targetId = existing.id;
            console.log(`[StorageManager] Updating existing OneDrive account: ${targetId} (ClientID: ${clientId.substring(0, 8)}...)`);
            await query(
                'UPDATE storage_accounts SET name = $1, config = $2, updated_at = NOW() WHERE id = $3',
                [name, config, targetId]
            );
        } else {
            const res = await query(
                `INSERT INTO storage_accounts (type, name, config, is_active) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                ['onedrive', name, config, false]
            );
            targetId = res.rows[0].id;
            console.log(`[StorageManager] Added new OneDrive account: ${targetId}`);
        }

        // 初始化/更新内存中的 Provider
        const oneDrive = new OneDriveStorageProvider(targetId, clientId, clientSecret, refreshToken, tenantId);
        this.providers.set(`onedrive:${targetId}`, oneDrive);

        return targetId;
    }

    // 切换激活账户
    async switchAccount(accountId: string | 'local') {
        if (accountId === 'local') {
            await StorageManager.updateSetting('active_storage_provider', 'local');
            await query('UPDATE storage_accounts SET is_active = false');
        } else {
            const accRes = await query('SELECT type FROM storage_accounts WHERE id = $1', [accountId]);
            const type = accRes.rows[0]?.type || 'local';
            await StorageManager.updateSetting('active_storage_provider', type);
            await query('UPDATE storage_accounts SET is_active = (id = $1)', [accountId]);
        }

        // 重新初始化以刷新状态
        await this.init();
    }

    async addAliyunOSSAccount(name: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string) {
        const config = JSON.stringify(encryptStorageConfig({ region, accessKeyId, accessKeySecret, bucket }));

        const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            ['aliyun_oss', name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new Aliyun OSS account: ${targetId}`);

        const oss = new AliyunOSSStorageProvider(targetId, region, accessKeyId, accessKeySecret, bucket);
        this.providers.set(`aliyun_oss:${targetId}`, oss);

        return targetId;
    }

    async addS3Account(name: string, endpoint: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string, forcePathStyle: boolean = false) {
        const config = JSON.stringify(encryptStorageConfig({ endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle }));

        const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            ['s3', name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new S3 account: ${targetId}`);

        const s3 = new S3StorageProvider(targetId, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle);
        this.providers.set(`s3:${targetId}`, s3);

        return targetId;
    }

    async addWebDAVAccount(name: string, url: string, username?: string, password?: string) {
        const config = JSON.stringify(encryptStorageConfig({ url, username, password }));

        const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            ['webdav', name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new WebDAV account: ${targetId}`);

        const webdav = new WebDAVStorageProvider(targetId, url, username, password);
        this.providers.set(`webdav:${targetId}`, webdav);

        return targetId;
    }

    async addGoogleDriveAccount(name: string, clientId: string, clientSecret: string, refreshToken: string, redirectUri: string) {
        const config = JSON.stringify(encryptStorageConfig({ clientId, clientSecret, refreshToken, redirectUri }));

        const res = await query(
            `INSERT INTO storage_accounts (type, name, config, is_active) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            ['google_drive', name, config, false]
        );
        const targetId = res.rows[0].id;
        console.log(`[StorageManager] Added new Google Drive account: ${targetId}`);

        const gd = new GoogleDriveStorageProvider(targetId, clientId, clientSecret, refreshToken, redirectUri);
        this.providers.set(`google_drive:${targetId}`, gd);

        return targetId;
    }

    async updateOneDriveConfig(clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common', name?: string) {
        // 同步更新 system_settings 以便 OAuth 回调获取最新的 Client ID/Secret 以及作为全局回退
        await StorageManager.updateSetting('onedrive_client_id', clientId);
        await StorageManager.updateSetting('onedrive_client_secret', clientSecret);
        await StorageManager.updateSetting('onedrive_tenant_id', tenantId);
        if (refreshToken !== 'pending') {
            await StorageManager.updateSetting('onedrive_refresh_token', refreshToken);
        }

        // 如果提供了 name，也暂时存到 system_settings，以便 OAuth 回调时使用
        if (name) {
            await StorageManager.updateSetting('onedrive_pending_name', name);
        }

        // 漏洞修复：不再自动更新当前激活的账户
        // 如果 refreshToken != 'pending'，说明是在 OAuth 回调或其他场景
        if (refreshToken !== 'pending') {
            // 添加新账户
            // 此时 name 应该从 Microsoft Graph 获取，或者使用 pending name
            const pendingName = await this.getSetting('onedrive_pending_name');
            const finalName = name || pendingName || 'OneDrive Account';

            await this.addOneDriveAccount(finalName, clientId, clientSecret, refreshToken, tenantId);

            // 关键修复：一旦账户成功进入 storage_accounts 表，清理所有临时/旧设置，防止启动时触发 migrateLegacyConfig
            console.log('[StorageManager] Cleaning up temporary settings after successful account add/update...');
            await query("DELETE FROM system_settings WHERE key IN ('onedrive_client_id', 'onedrive_client_secret', 'onedrive_refresh_token', 'onedrive_tenant_id', 'onedrive_pending_name')");

            // 自动开启新账户
            const res = await query('SELECT id FROM storage_accounts WHERE type = $1 ORDER BY created_at DESC LIMIT 1', ['onedrive']);
            if (res.rows[0]) {
                await this.switchAccount(res.rows[0].id);
            }
        }
    }

    // 切换回本地
    async switchToLocal() {
        await this.switchAccount('local');
    }
}

export const storageManager = StorageManager.getInstance();
