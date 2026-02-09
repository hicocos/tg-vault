import crypto from 'crypto';
import path from 'path';

const ACCESS_PASSWORD_HASH = process.env.ACCESS_PASSWORD_HASH || '';

// Verify password using timing-safe comparison
export function verifyPassword(password: string): boolean {
    if (!ACCESS_PASSWORD_HASH) {
        return true;
    }
    const inputHash = crypto.createHash('sha256').update(password).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(ACCESS_PASSWORD_HASH));
    } catch (e) {
        // Length mismatch or other error
        return false;
    }
}

// Format bytes
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get file type emoji
export function getTypeEmoji(mimeType: string): string {
    if (!mimeType) return '📁';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text')) return '📄';
    return '📁';
}

// Determine broad file type
export function getFileType(mimeType: string): string {
    if (!mimeType) return 'other';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text')) return 'document';
    return 'other';
}

// Get MIME type from filename
export function getMimeTypeFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.txt': 'text/plain', '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// Sanitize directory/file name
export function sanitizeFilename(name: string): string {
    if (!name) return 'unknown';

    // Take ONLY the first line if it's a multi-line caption
    const firstLine = name.split('\n')[0].trim();

    let sanitized = firstLine
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
        .replace(/\s+/g, ' ')                   // Collapse whitespace
        .trim();

    // Remove trailing dots and spaces (problematic on Windows/some filesystems)
    sanitized = sanitized.replace(/[.\s]+$/, '');

    if (!sanitized) return 'unknown';

    // Limit character length first
    let result = sanitized.substring(0, 50);

    // Further limit by byte length (UTF-8) to ensure it stays well under the 255-byte limit
    // 150 bytes is a safe limit for most filesystems considering the prefix paths
    const MAX_BYTES = 150;
    while (Buffer.byteLength(result, 'utf8') > MAX_BYTES && result.length > 0) {
        result = result.substring(0, result.length - 1);
    }

    return result || 'unknown';
}
