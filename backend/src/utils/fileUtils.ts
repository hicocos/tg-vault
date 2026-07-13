import path from 'path';
import crypto from 'crypto';
import { sanitizeFilename } from './telegramUtils.js';

/**
 * 生成不会因并发“先查后写”而碰撞的物理对象名。
 * 展示名仍保存在 files.name；stored_name 只作为不可变对象键。
 */
export async function getUniqueStoredName(
    originalName: string,
    _folder: string | null = null,
    _storageAccountId: string | null = null,
): Promise<string> {
    const sanitizedName = sanitizeFilename(originalName);
    const ext = path.extname(sanitizedName);
    const rawBaseName = ext ? sanitizedName.slice(0, -ext.length) : sanitizedName;
    const suffix = `--${crypto.randomUUID()}`;
    const maxBaseLength = Math.max(1, 255 - ext.length - suffix.length);
    const baseName = rawBaseName.slice(0, maxBaseLength) || 'file';
    return `${baseName}${suffix}${ext}`;
}
