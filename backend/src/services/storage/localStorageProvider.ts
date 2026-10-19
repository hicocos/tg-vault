import fs from 'node:fs';
import path from 'node:path';
import { safeJoin } from '../../utils/localPath.js';
import { type IStorageProvider, StorageProbeError } from './contracts.js';

export class LocalStorageProvider implements IStorageProvider {
    name = 'local';
    private uploadDir: string;

    constructor(uploadDir: string = process.env.UPLOAD_DIR || './data/uploads') {
        this.uploadDir = path.resolve(uploadDir);
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    async probe(): Promise<void> {
        const stats = await fs.promises.stat(this.uploadDir);
        if (!stats.isDirectory()) throw new StorageProbeError(this.name, '本地存储路径不是目录');
        await fs.promises.access(this.uploadDir, fs.constants.R_OK | fs.constants.W_OK);
    }

    async prepareSaveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null) {
        const destDir = folder ? safeJoin(this.uploadDir, folder) : this.uploadDir;
        return { storedPath: safeJoin(destDir, fileName), save: async (signal?: AbortSignal) => {
            signal?.throwIfAborted();
            return this.saveFile(tempPath, fileName, mimeType, folder);
        } };
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
