import { tr } from '../i18n/runtime';

export function errorMessage(error: unknown, fallback = tr('errors.services.generic.operationFailed')): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
}

export function errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}

export function isErrorNamed(error: unknown, name: string): boolean {
    return error instanceof Error && error.name === name;
}
