import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import bigInt from 'big-integer';
import { open } from 'node:fs/promises';
import type { IterDownloadFunction, DownloadMediaInterface } from 'telegram/client/downloads.js';
import { ownUserTransport, withUserTransportSignal } from './telegramUserTransport.js';
import { decodeTelegramValue, encodeTelegramValue, parseWorkerRequest, telegramWorkerError, type WorkerResponse } from './telegramWorkerProtocol.js';
import { createTelegramDownloadIterator } from './telegramFileDownload.js';

import { isRecord } from '../utils/typeGuards.js';
function requestArgument(value: unknown): value is Api.AnyRequest {
    return isRecord(value) && value.classType === 'request' && typeof value.getBytes === 'function' && typeof value.resolve === 'function';
}
function downloadArgument(value: unknown): IterDownloadFunction {
    if (!isRecord(value) || !Number.isSafeInteger(value.requestSize) || Number(value.requestSize) <= 0) throw new Error('TELEGRAM_WORKER_INVALID_DOWNLOAD');
    for (const field of ['offset', 'fileSize']) if (value[field] !== undefined && !bigInt.isInstance(value[field])) throw new Error('TELEGRAM_WORKER_INVALID_OFFSET');
    for (const field of ['stride', 'limit', 'chunkSize', 'dcId']) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || Number(value[field]) <= 0)) throw new Error('TELEGRAM_WORKER_INVALID_DOWNLOAD_LIMIT');
    if (!(value.file instanceof Api.MessageMediaDocument || value.file instanceof Api.MessageMediaPhoto || value.file instanceof Api.InputDocumentFileLocation || value.file instanceof Api.InputPhotoFileLocation)) throw new Error('TELEGRAM_WORKER_INVALID_MEDIA');
    // Schema above establishes the SDK-supported numeric and TL location fields.
    const params = value as unknown as IterDownloadFunction;
    return params;
}

let client: TelegramClient | undefined;
let closing = false;
let iteratorSequence = 0;
const iterators = new Map<number, AsyncIterator<Buffer>>();
const operations = new Map<number, AbortController>();
const progressWaiters = new Map<number, () => void>();
let lastSession = '';
const send = (message: WorkerResponse) => { if (process.connected) process.send?.(message); };
const heartbeat = setInterval(() => send({ id: 0, heartbeat: true, connected: Boolean(client?.connected) }), 1_000);
heartbeat.unref();

async function close() {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    for (const controller of operations.values()) controller.abort(new Error('TELEGRAM_WORKER_CLOSED'));
    for (const resolve of progressWaiters.values()) resolve();
    if (client) await client.destroy();
    iterators.clear();
}
process.once('disconnect', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });

process.on('message', (raw: unknown) => {
    const request = parseWorkerRequest(raw);
    if (request.method === 'cancel') { operations.get(request.id)?.abort(new DOMException('Cancelled', 'AbortError')); progressWaiters.get(request.id)?.(); return; }
    if (request.method === 'progressAck') { progressWaiters.get(request.id)?.(); return; }
    const controller = new AbortController();
    operations.set(request.id, controller);
    let waitDepth = 0;
    void withUserTransportSignal(controller.signal, async () => {
        const args = request.args.map(decodeTelegramValue);
        let value: unknown;
        if (request.method === 'initialize') {
            const [session, apiId, apiHash, accountId] = args;
            if (client || typeof session !== 'string' || typeof apiId !== 'number' || typeof apiHash !== 'string' || typeof accountId !== 'string') throw new Error('TELEGRAM_WORKER_INVALID_INITIALIZATION');
            client = ownUserTransport(new TelegramClient(new StringSession(session), apiId, apiHash, {
                connectionRetries: 1, reconnectRetries: 0, requestRetries: 2, downloadRetries: 1,
                retryDelay: 0, useWSS: false, floodSleepThreshold: 0,
                deviceModel: 'TG Vault User Downloader', systemVersion: '1.0.0', appVersion: '1.0.0',
            }), { accountId, onRuntimeEvent: runtime => send({ id: 0, runtime }) });
            value = await client.connect();
        } else {
            if (!client || closing) throw new Error('TELEGRAM_WORKER_CLOSED');
            // These arguments originate from the typed SDK-facing parent API and TL decoder.
            switch (request.method) {
                case 'invoke': {
                    const [request, dcId] = args;
                    if (!requestArgument(request) || (dcId !== undefined && !Number.isSafeInteger(dcId))) throw new Error('TELEGRAM_WORKER_INVALID_RPC');
                    value = await client.invoke(request, typeof dcId === 'number' ? dcId : undefined);
                    break;
                }
                case 'open': {
                    const iterator = createTelegramDownloadIterator(client, downloadArgument(args[0]))[Symbol.asyncIterator]();
                    const id = ++iteratorSequence;
                    iterators.set(id, iterator);
                    value = id;
                    break;
                }
                case 'next': {
                    const iterator = iterators.get(Number(args[0]));
                    if (!iterator) throw new Error('TELEGRAM_WORKER_ITERATOR_CLOSED');
                    const result = await iterator.next();
                    if (result.done) iterators.delete(Number(args[0]));
                    value = result;
                    break;
                }
                case 'return': {
                    const id = Number(args[0]);
                    const iterator = iterators.get(id);
                    iterators.delete(id);
                    await iterator?.return?.();
                    value = undefined;
                    break;
                }
                case 'downloadMedia': {
                    const [message, options] = args;
                    if (!(message instanceof Api.Message) || !isRecord(options) || typeof options.outputFile !== 'string') throw new Error('TELEGRAM_WORKER_INVALID_PHOTO_DOWNLOAD');
                    const file = await open(options.outputFile, 'w');
                    try {
                        const params: DownloadMediaInterface = { outputFile: { write: (chunk: Buffer) => file.writeFile(chunk) } };
                        await client.downloadMedia(message, { ...params,
                            progressCallback: async (downloaded, total) => {
                                controller.signal.throwIfAborted();
                                await new Promise<void>(resolve => {
                                    progressWaiters.set(request.id, resolve);
                                    send({ id: request.id, progress: [Number(downloaded), Number(total)] });
                                });
                                progressWaiters.delete(request.id);
                                controller.signal.throwIfAborted();
                            },
                        });
                        value = options.outputFile;
                    } finally { await file.close(); }
                    break;
                }
                case 'destroy': await close(); value = undefined; break;
                default: throw new Error('TELEGRAM_WORKER_UNKNOWN_METHOD');
            }
        }
        const session = client?.session.save();
        send({ id: request.id, value: encodeTelegramValue(value), connected: Boolean(client?.connected), session: typeof session === 'string' && session !== lastSession ? session : undefined });
        if (typeof session === 'string') lastSession = session;
    }, waiting => {
        const previous = waitDepth;
        waitDepth += waiting ? 1 : -1;
        if ((previous === 0) !== (waitDepth === 0)) send({ id: request.id, waiting: waitDepth > 0 });
    }).catch((error: unknown) => send({ id: request.id, error: telegramWorkerError(error), connected: Boolean(client?.connected) }))
        .finally(() => { operations.delete(request.id); progressWaiters.delete(request.id); });
});
