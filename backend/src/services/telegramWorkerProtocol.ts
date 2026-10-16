import { BinaryReader } from 'telegram/extensions/BinaryReader.js';
import bigInt from 'big-integer';

import { isRecord as record } from '../utils/typeGuards.js';

// Only trusted parent/child pipes use this codec; TL bytes preserve GramJS classes.
export function encodeTelegramValue(value: unknown): unknown {
    if (Array.isArray(value)) return { $telegram: 'array', value: value.map(encodeTelegramValue), total: 'total' in value ? value.total : undefined };
    if (!record(value) || Buffer.isBuffer(value)) return value;
    if (value instanceof Date) return { $telegram: 'date', value: value.getTime() };
    if (bigInt.isInstance(value)) return { $telegram: 'long', value: value.toString() };
    if (typeof value.getBytes === 'function' && typeof value.className === 'string') return { $telegram: 'tl', value: value.getBytes() };
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeTelegramValue(entry)]));
}

export function decodeTelegramValue(value: unknown): unknown {
    if (!record(value) || Buffer.isBuffer(value)) return value;
    switch (value.$telegram) {
        case 'date':
            if (typeof value.value === 'number') return new Date(value.value);
            break;
        case 'long':
            if (typeof value.value === 'string' && /^-?\d+$/.test(value.value)) return bigInt(value.value);
            break;
        case 'tl':
            if (Buffer.isBuffer(value.value)) return new BinaryReader(value.value).tgReadObject();
            break;
        case 'array': {
            if (!Array.isArray(value.value)) break;
            const result: unknown[] & { total?: number } = value.value.map(decodeTelegramValue);
            if (value.total !== undefined) {
                if (typeof value.total !== 'number') break;
                result.total = value.total;
            }
            return result;
        }
        case undefined: return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeTelegramValue(entry)]));
    }
    throw new Error('TELEGRAM_WORKER_INVALID_VALUE');
}

export interface TelegramWorkerError { name: string; message: string; code?: string; errorMessage?: string; seconds?: number }

export function telegramWorkerError(error: unknown) {
    const value = record(error) ? error : {};
    return { name: typeof value.name === 'string' ? value.name : 'Error',
        message: typeof value.message === 'string' ? value.message : 'TELEGRAM_WORKER_FAILED',
        code: typeof value.code === 'string' ? value.code : undefined,
        errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : undefined,
        seconds: typeof value.seconds === 'number' ? value.seconds : undefined };
}

export interface WorkerRequest { id: number; method: string; args: unknown[] }
export function parseWorkerRequest(value: unknown): WorkerRequest {
    if (!record(value) || !Number.isSafeInteger(value.id) || typeof value.method !== 'string' || !Array.isArray(value.args)) throw new Error('TELEGRAM_WORKER_INVALID_REQUEST');
    return { id: Number(value.id), method: value.method, args: value.args };
}

// Short server cooldowns must not reduce configured download concurrency.
export const TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS = 60 * 60;

export type TelegramTransportRuntimeEvent =
    | { type: 'cooldown'; seconds: number; until: number; reason: 'FLOOD_WAIT' | 'FLOOD_TEST_PHONE_WAIT'; file: boolean; episode: number; fragmentLimit: number; activeFragments: number }
    | { type: 'file_success'; at: number; episode: number; successfulReads: number; fragmentLimit: number; activeFragments: number };

function parseRuntimeEvent(value: unknown): TelegramTransportRuntimeEvent {
    if (!record(value) || !Number.isSafeInteger(value.episode) || Number(value.episode) < 0 ||
        !Number.isSafeInteger(value.fragmentLimit) || Number(value.fragmentLimit) < 1 || Number(value.fragmentLimit) > 12 ||
        !Number.isSafeInteger(value.activeFragments) || Number(value.activeFragments) < 0 || Number(value.activeFragments) > 12) throw new Error('TELEGRAM_WORKER_INVALID_RUNTIME');
    if (value.type === 'cooldown' && Number.isSafeInteger(value.seconds) && Number(value.seconds) >= 0 &&
        Number.isSafeInteger(value.until) && Number(value.until) >= 0 && Number(value.until) <= 8_640_000_000_000_000 &&
        (value.reason === 'FLOOD_WAIT' || value.reason === 'FLOOD_TEST_PHONE_WAIT') && typeof value.file === 'boolean') {
        return { type: value.type, seconds: Number(value.seconds), until: Number(value.until), reason: value.reason, file: value.file,
            episode: Number(value.episode), fragmentLimit: Number(value.fragmentLimit), activeFragments: Number(value.activeFragments) };
    }
    if (value.type === 'file_success' && Number.isSafeInteger(value.at) && Number(value.at) >= 0 && Number(value.at) <= 8_640_000_000_000_000 &&
        Number.isSafeInteger(value.successfulReads) && Number(value.successfulReads) > 0) {
        return { type: value.type, at: Number(value.at), episode: Number(value.episode), successfulReads: Number(value.successfulReads),
            fragmentLimit: Number(value.fragmentLimit), activeFragments: Number(value.activeFragments) };
    }
    throw new Error('TELEGRAM_WORKER_INVALID_RUNTIME');
}

export interface WorkerResponse { id: number; value?: unknown; error?: TelegramWorkerError; progress?: [number, number]; waiting?: boolean; connected?: boolean; session?: string; heartbeat?: boolean; runtime?: TelegramTransportRuntimeEvent }
export function parseWorkerResponse(value: unknown): WorkerResponse {
    if (!record(value) || !Number.isSafeInteger(value.id)) throw new Error('TELEGRAM_WORKER_INVALID_RESPONSE');
    if (value.error !== undefined && (!record(value.error) || typeof value.error.message !== 'string' || typeof value.error.name !== 'string')) throw new Error('TELEGRAM_WORKER_INVALID_ERROR');
    if (value.progress !== undefined && (!Array.isArray(value.progress) || value.progress.length !== 2 || !value.progress.every(entry => typeof entry === 'number'))) throw new Error('TELEGRAM_WORKER_INVALID_PROGRESS');
    if (value.waiting !== undefined && typeof value.waiting !== 'boolean') throw new Error('TELEGRAM_WORKER_INVALID_WAIT');
    // Parsed discriminator/fields above; remaining optional runtime fields checked here.
    return { id: Number(value.id), value: value.value,
        error: value.error === undefined ? undefined : telegramWorkerError(value.error),
        progress: Array.isArray(value.progress) ? [Number(value.progress[0]), Number(value.progress[1])] : undefined,
        waiting: typeof value.waiting === 'boolean' ? value.waiting : undefined,
        connected: typeof value.connected === 'boolean' ? value.connected : undefined,
        session: typeof value.session === 'string' ? value.session : undefined,
        runtime: value.runtime === undefined ? undefined : parseRuntimeEvent(value.runtime),
        heartbeat: value.heartbeat === true };
}
