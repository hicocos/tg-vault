import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { telegramDownloadStream, runTelegramDownloadStripes } from '../src/services/telegramDownloadStream.js';
import { BotDownloadRuntime } from '../src/services/telegramBotDownloadRuntime.js';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import bigInt from 'big-integer';
import { refreshTelegramDownloadMessage } from '../src/services/telegramDownloadSource.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('network loss resumes each stripe from committed bytes without rewriting earlier chunks', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-resume-'));
    const target = path.join(directory, 'file.bin');
    const partSize = 4096;
    const source = Buffer.alloc(partSize * 11 + 37);
    for (let i = 0; i < source.length; i++) source[i] = (i * 31 + Math.floor(i / partSize)) % 256;
    const handle = await fs.open(target, 'w');
    const writes = new Map<number, number>();
    const opened: number[][] = Array.from({ length: 4 }, () => []);
    const injected = new Set<number>();
    try {
        await handle.truncate(source.length);
        await runTelegramDownloadStripes(4, async (stripe, signal) => {
            let writeOffset = stripe * partSize;
            for await (const chunk of telegramDownloadStream(offset => ({ async *[Symbol.asyncIterator]() {
                opened[stripe].push(offset);
                for (let position = offset; position < source.length; position += partSize * 4) {
                    if (!injected.has(stripe) && position >= (stripe + 4) * partSize) {
                        injected.add(stripe);
                        throw new Error('ECONNRESET');
                    }
                    yield source.subarray(position, Math.min(source.length, position + partSize));
                }
            } }), { offset: writeOffset, stride: partSize * 4, end: source.length, signal })) {
                await handle.write(chunk, 0, chunk.length, writeOffset);
                writes.set(writeOffset, (writes.get(writeOffset) || 0) + 1);
                writeOffset += partSize * 4;
            }
        });
        await handle.close();
        assert.equal(createHash('sha256').update(await fs.readFile(target)).digest('hex'), createHash('sha256').update(source).digest('hex'));
        for (const count of writes.values()) assert.equal(count, 1);
        for (let stripe = 0; stripe < 4; stripe++) assert.deepEqual(opened[stripe], [stripe * partSize, (stripe + 4) * partSize]);
    } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(directory, { recursive: true });
    }
});

test('main connection replacement resumes a read with the new client and retains its offset', async () => {
    const runtime = new BotDownloadRuntime<{ connected: boolean; generation: number }>();
    const old = { connected: true, generation: 1 };
    const next = { connected: true, generation: 2 };
    runtime.register(old, 'bot-a'); runtime.ready(old);
    let current = old;
    const offsets: number[] = [];
    const values: number[] = [];
    for await (const value of telegramDownloadStream(offset => ({ async *[Symbol.asyncIterator]() {
        offsets.push(offset);
        if (current.generation === 1) {
            yield { length: 1, value: 10 };
            old.connected = false;
            runtime.unavailable(true);
            runtime.register(next, 'bot-a'); runtime.ready(next);
            throw new Error('BOT_CONNECTION_LOST');
        }
        yield { length: 1, value: 20 };
    } }), { offset: 0, end: 2, recover: async () => { current = await runtime.acquire(current); } })) values.push(value.value);
    assert.deepEqual(values, [10, 20]);
    assert.deepEqual(offsets, [0, 1]);
});

test('queued downloads wait for one ready replacement, and cancellation or credential cutover never starts a read', async () => {
    const runtime = new BotDownloadRuntime<{ connected: boolean }>();
    const old = { connected: true };
    runtime.register(old, 'bot-a'); runtime.ready(old);
    old.connected = false; runtime.unavailable(true);
    const abort = new AbortController();
    const cancelled = runtime.acquire(old, abort.signal);
    const rejected = assert.rejects(cancelled, /cancelled/);
    abort.abort(new Error('cancelled'));
    await rejected;
    const first = runtime.acquire(old);
    const second = runtime.acquire(old);
    const next = { connected: true };
    runtime.register(next, 'bot-a'); runtime.ready(next);
    assert.equal(await first, next); assert.equal(await second, next);
    runtime.unavailable(true);
    const pending = runtime.acquire(next);
    const changed = assert.rejects(pending, /BOT_IDENTITY_CHANGED/);
    runtime.register({ connected: true }, 'bot-b');
    await changed;
});

test('manual stop and cleanup quarantine wake transfer waiters without reconnecting', async () => {
    const runtime = new BotDownloadRuntime<{ connected: boolean }>();
    const old = { connected: true };
    runtime.register(old, 'bot'); runtime.ready(old);
    old.connected = false; runtime.unavailable(true);
    const stopped = runtime.acquire(old);
    const rejected = assert.rejects(stopped, /BOT_CLEANUP_UNCONFIRMED/);
    runtime.unavailable(false, new Error('BOT_CLEANUP_UNCONFIRMED'));
    await rejected;
    await assert.rejects(runtime.acquire(old), /BOT_CLEANUP_UNCONFIRMED/);
});

test('replacement rereads the original peer and rejects edited or missing media before appending bytes', async () => {
    const peer = new Api.InputPeerUser({ userId: bigInt(1), accessHash: bigInt(2) });
    const doc = new Api.Document({ id: bigInt(10), accessHash: bigInt(20), fileReference: Buffer.from('old'), date: 1,
        mimeType: 'application/octet-stream', size: bigInt(100), dcId: 2, attributes: [] });
    const original = new Api.Message({ id: 50, peerId: new Api.PeerUser({ userId: bigInt(1) }), date: 1,
        message: '', media: new Api.MessageMediaDocument({ document: doc }) });
    original.getInputChat = async () => peer;
    const client = new TelegramClient(new StringSession(''), 1, '00000000000000000000000000000000', {});
    let returned: Api.Message[] = [];
    client.getMessages = async (entity, options) => {
        assert.equal(entity, peer);
        assert.deepEqual(options?.ids, [50]);
        const messages = Object.assign([...returned], { total: returned.length });
        return messages;
    };
    const refreshed = new Api.Message({ ...original, media: new Api.MessageMediaDocument({ document: new Api.Document({ ...doc, fileReference: Buffer.from('new') }) }) });
    returned = [refreshed];
    assert.equal(await refreshTelegramDownloadMessage(client, original), refreshed);
    returned = [new Api.Message({ ...original, media: new Api.MessageMediaDocument({ document: new Api.Document({ ...doc, id: bigInt(11) }) }) })];
    await assert.rejects(refreshTelegramDownloadMessage(client, original), /SOURCE_CHANGED/);
    returned = [];
    await assert.rejects(refreshTelegramDownloadMessage(client, original), /SOURCE_MISSING/);
});

test('transport retries are bounded, permission failures are terminal, and cancelled recovery does not reopen', async () => {
    let opens = 0;
    const exhausted = telegramDownloadStream(() => ({ async *[Symbol.asyncIterator]() { opens++; throw new Error('ECONNRESET'); } }), { offset: 0, end: 1 });
    await assert.rejects(async () => { for await (const _chunk of exhausted) {} }, /ECONNRESET/);
    assert.equal(opens, 4);
    let deniedOpens = 0;
    const denied = telegramDownloadStream(() => ({ async *[Symbol.asyncIterator]() { deniedOpens++; throw new Error('CHANNEL_PRIVATE'); } }), { offset: 0, end: 1 });
    await assert.rejects(async () => { for await (const _chunk of denied) {} }, /CHANNEL_PRIVATE/);
    assert.equal(deniedOpens, 1);
    const entered = deferred();
    const controller = new AbortController();
    let resumed = false;
    const interrupted = telegramDownloadStream(() => ({ async *[Symbol.asyncIterator]() { entered.resolve(); throw new Error('BOT_CONNECTION_LOST'); } }), {
        offset: 0, end: 1, signal: controller.signal, recover: async () => { resumed = true; },
    });
    const reading = interrupted.next();
    const rejected = assert.rejects(reading, /cancelled/);
    await entered.promise;
    controller.abort(new Error('cancelled'));
    await rejected;
    assert.equal(resumed, false);
});
