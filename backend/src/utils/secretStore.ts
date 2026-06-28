import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function getCandidateSecretDirs(): string[] {
    const dirs: string[] = [];
    if (process.env.FLCLOUDS_SECRET_DIR?.trim()) {
        dirs.push(process.env.FLCLOUDS_SECRET_DIR.trim());
    }

    const uploadDir = process.env.UPLOAD_DIR || './data/uploads';
    dirs.push(path.join(path.dirname(path.resolve(uploadDir)), 'secrets'));
    dirs.push(path.join(process.cwd(), 'data', 'secrets'));

    return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

export function getPersistentSecretPath(fileName: string): string {
    return path.join(getCandidateSecretDirs()[0], fileName);
}

function readSecretFile(filePath: string): string {
    try {
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
        console.warn(`[SecretStore] Failed to read ${filePath}:`, error);
        return '';
    }
}

function tryWriteSecretFile(filePath: string, value: string): boolean {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        } catch {
            // Best-effort on filesystems that do not support chmod.
        }
        return true;
    } catch (error) {
        console.warn(`[SecretStore] Failed to write ${filePath}:`, error);
        return false;
    }
}

export function getExistingPersistentSecret(fileName: string): string {
    for (const dir of getCandidateSecretDirs()) {
        const value = readSecretFile(path.join(dir, fileName));
        if (value) return value;
    }
    return '';
}

function persistSecretWithFallback(envName: string, fileName: string, value: string): string {
    for (const dir of getCandidateSecretDirs()) {
        const filePath = path.join(dir, fileName);
        if (tryWriteSecretFile(filePath, value)) {
            console.log(`[SecretStore] Persisted ${envName} to ${filePath}`);
            return filePath;
        }
    }
    throw new Error(`Unable to persist ${envName}. Please make /data/secrets writable or set ${envName} manually.`);
}

export function getOrCreatePersistentSecret(envName: string, fileName: string): string {
    const fromEnv = process.env[envName]?.trim() || '';
    const fromFile = getExistingPersistentSecret(fileName);

    if (fromEnv) {
        if (!fromFile) {
            persistSecretWithFallback(envName, fileName, fromEnv);
        } else if (fromFile !== fromEnv) {
            console.warn(`[SecretStore] ${envName} is set and differs from the persisted secret; using environment value for this process.`);
        }
        return fromEnv;
    }

    if (fromFile) {
        return fromFile;
    }

    const generated = crypto.randomBytes(32).toString('hex');
    persistSecretWithFallback(envName, fileName, generated);
    return generated;
}
