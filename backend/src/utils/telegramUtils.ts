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
    if (mimeType === 'application/pdf') return '📕';
    if (mimeType === 'text/markdown' || mimeType.includes('markdown')) return '📝';
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return '📄';
    if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml')) return '📝';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheetml') || mimeType === 'text/csv') return '📊';
    if (mimeType.includes('powerpoint') || mimeType.includes('presentationml')) return '📉';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z') || mimeType.includes('tar') || mimeType.includes('compressed')) return '📦';
    if (mimeType.includes('epub') || mimeType.includes('mobi')) return '📚';
    if (mimeType.includes('executable') || mimeType.includes('msdownload') || mimeType.includes('apk')) return '⚙️';
    if (mimeType.includes('sql') || mimeType.includes('database')) return '🗄️';
    if (mimeType.includes('key') || mimeType.includes('pem') || mimeType.includes('certificate') || mimeType.includes('pkcs')) return '🔑';
    if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('python') || mimeType.includes('php') || mimeType.includes('java') || mimeType.includes('cplusplus') || mimeType.includes('x-httpd-php')) return '💻';
    if (mimeType.includes('pdf') || mimeType.includes('document')) return '📄';
    return '📁';
}

// Determine broad file type
export function getFileType(mimeType: string): string {
    if (!mimeType) return 'other';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text') ||
        mimeType.includes('word') || mimeType.includes('excel') || mimeType.includes('spreadsheet') ||
        mimeType.includes('powerpoint') || mimeType.includes('presentation') ||
        mimeType.includes('markdown') || mimeType.includes('json') || mimeType.includes('xml') ||
        mimeType.includes('sql') || mimeType.includes('javascript') || mimeType.includes('typescript')) return 'document';
    return 'other';
}

// Get MIME type from filename
export function getMimeTypeFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.flv': 'video/x-flv',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
        '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
        '.ts': 'application/typescript', '.json': 'application/json', '.xml': 'application/xml',
        '.py': 'text/x-python', '.java': 'text/x-java-source', '.sql': 'application/sql',
        '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar', '.gz': 'application/x-gzip',
        '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook',
        '.exe': 'application/x-msdownload', '.apk': 'application/vnd.android.package-archive',
        '.iso': 'application/x-iso9660-image', '.dmg': 'application/x-apple-diskimage',
        '.crt': 'application/x-x509-ca-cert', '.pem': 'application/x-pem-file', '.key': 'application/octet-stream',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// Sanitize directory/file name
export function sanitizeFilename(name: string): string {
    if (!name) return 'unknown';

    // Take ONLY the first line if it's a multi-line caption
    const firstLine = name.split('\n')[0].trim();
    const originalExt = path.extname(firstLine);
    const ext = (originalExt && originalExt.length <= 15) ? originalExt : '';
    const withoutExt = ext ? firstLine.slice(0, -ext.length) : firstLine;

    let sanitized = withoutExt
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
        .replace(/\s+/g, ' ')                   // Collapse whitespace
        .trim();

    // Remove trailing dots and spaces (problematic on Windows/some filesystems)
    sanitized = sanitized.replace(/[.\s]+$/, '');

    if (!sanitized) return 'unknown';

    // Limit character length first (preserve extension)
    const MAX_CHARS = 50;
    const baseMaxChars = Math.max(1, MAX_CHARS - ext.length);
    let base = sanitized.substring(0, baseMaxChars);
    let result = `${base}${ext}`;

    // Further limit by byte length (UTF-8) to ensure it stays well under the 255-byte limit
    // 150 bytes is a safe limit for most filesystems considering the prefix paths
    const MAX_BYTES = 150;
    while (Buffer.byteLength(result, 'utf8') > MAX_BYTES && base.length > 0) {
        base = base.substring(0, base.length - 1);
        result = `${base}${ext}`;
    }

    return result || 'unknown';
}
