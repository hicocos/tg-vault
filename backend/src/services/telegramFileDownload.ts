import { Api, TelegramClient, utils } from 'telegram';
import bigInt from 'big-integer';
import { DirectDownloadIter, type IterDownloadFunction } from 'telegram/client/downloads.js';
import type { FileHandle } from 'node:fs/promises';

export const TELEGRAM_DOWNLOAD_PART_SIZE = 1024 * 1024;

/** GramJS 2.26.22's iterDownload clamps requests to 512 KiB; its direct iterator does not. */
export async function* createTelegramDownloadIterator(client: TelegramClient, params: IterDownloadFunction): AsyncGenerator<Buffer> {
    const { file } = params;
    if (!(file instanceof Api.MessageMediaDocument || file instanceof Api.MessageMediaPhoto ||
        file instanceof Api.InputDocumentFileLocation || file instanceof Api.InputPhotoFileLocation)) {
        throw new Error('TELEGRAM_DOWNLOAD_INVALID_MEDIA');
    }
    const info = utils.getFileInfo(file);
    const offset = params.offset ?? bigInt.zero;
    const stride = params.stride ?? TELEGRAM_DOWNLOAD_PART_SIZE;
    // A GetFile request must stay inside one 1 MiB window, including the final short read.
    if (params.requestSize !== TELEGRAM_DOWNLOAD_PART_SIZE ||
        (params.chunkSize !== undefined && params.chunkSize !== TELEGRAM_DOWNLOAD_PART_SIZE) ||
        offset.isNegative() || !offset.mod(TELEGRAM_DOWNLOAD_PART_SIZE).isZero() ||
        !Number.isSafeInteger(stride) || stride < TELEGRAM_DOWNLOAD_PART_SIZE || stride % TELEGRAM_DOWNLOAD_PART_SIZE !== 0) {
        throw new Error('TELEGRAM_DOWNLOAD_INVALID_ALIGNMENT');
    }
    const fileSize = params.fileSize ?? info.size;
    let limit = params.limit;
    if (fileSize !== undefined) {
        const remaining = fileSize.subtract(offset);
        if (remaining.lesserOrEquals(0)) return;
        const stripeChunks = remaining.add(stride - 1).divide(stride).toJSNumber();
        limit = limit === undefined ? stripeChunks : Math.min(limit, stripeChunks);
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('TELEGRAM_DOWNLOAD_INVALID_LIMIT');
    // RequestIter treats zero as unlimited, so handle exhausted stripes before constructing it.
    if (limit === 0) return;
    const iterator = new DirectDownloadIter(client, limit, {}, {
        fileLocation: info.location,
        dcId: info.dcId ?? params.dcId,
        offset,
        stride,
        chunkSize: TELEGRAM_DOWNLOAD_PART_SIZE,
        requestSize: TELEGRAM_DOWNLOAD_PART_SIZE,
        fileSize,
        msgData: params.msgData,
    });
    for await (const chunk of iterator) {
        if (chunk.length === 0) return;
        yield chunk;
    }
}

/** Commit a positioned chunk completely before the caller advances its stripe or progress. */
export async function writeTelegramDownloadChunk(file: Pick<FileHandle, 'write'>, chunk: Buffer, length: number, position: number, signal: AbortSignal): Promise<void> {
    let written = 0;
    while (written < length) {
        signal.throwIfAborted();
        const { bytesWritten } = await file.write(chunk, written, length - written, position + written);
        if (bytesWritten === 0) throw new Error('TELEGRAM_DOWNLOAD_WRITE_STALLED');
        written += bytesWritten;
    }
}
