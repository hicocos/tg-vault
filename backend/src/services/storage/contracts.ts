export interface PreparedStorageWrite {
    storedPath: string;
    save(signal?: AbortSignal): Promise<string>;
}

export interface IStorageProvider {
    id?: string; // 对于云盘，这是账户 ID
    name: string;
    /** Performs a read-only connectivity and authorization check. */
    probe(): Promise<void>;
    /**
     * 保存文件
     * @param tempPath 临时文件路径
     * @param fileName 目标文件名
     * @param mimeType 文件类型
     * @returns 存储后的路径或标识符
     */
    saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null, options?: { signal?: AbortSignal }): Promise<string>;
    /** Allocates a stable object identity before any upload side effect. */
    prepareSaveFile?(tempPath: string, fileName: string, mimeType: string, folder?: string | null): Promise<PreparedStorageWrite>;

    /**
     * 获取文件流（用于下载）
     * @param storedPath 存储路径或标识符
     */
    getFileStream(storedPath: string, options?: { range?: string }): Promise<NodeJS.ReadableStream>;

    /** Checks whether a remote media source still exists without downloading its bytes. */
    getFileAvailability?(storedPath: string): Promise<{ available: true }>;

    /** Probes whether the source bytes can be read without downloading the whole object. */
    probeFileReadable?(storedPath: string): Promise<{ available: true }>;

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

    /** Returns remote account quota when the provider exposes it. */
    getQuota?(): Promise<{ totalBytes: number; usedBytes: number } | null>;


    /**
     * 创建分享链接
     * @param storedPath 存储路径或标识符
     * @param password 访问密码（可选）
     * @param expiration 过期时间 ISO 字符串（可选）
     */
    createShareLink?(storedPath: string, password?: string, expiration?: string): Promise<{ link: string; error?: string }>;
}

export interface StorageTargetSnapshot {
    provider: IStorageProvider;
    accountId: string | null;
    providerKey: string;
}

export class StorageProbeError extends Error {
    constructor(public readonly provider: string, message: string, public readonly causeCode?: string) {
        super(message);
        this.name = 'StorageProbeError';
    }
}
