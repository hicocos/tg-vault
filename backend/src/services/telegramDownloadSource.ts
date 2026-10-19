import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

/** A reconnect may refresh a file reference, never splice bytes from an edited file. */
export async function refreshTelegramDownloadMessage(client: Pick<TelegramClient, 'getMessages'>, original: Api.Message): Promise<Api.Message> {
    const peer = await original.getInputChat();
    if (!peer) throw new Error('TELEGRAM_DOWNLOAD_SOURCE_MISSING');
    const refreshed = (await client.getMessages(peer, { ids: [original.id] }))[0];
    if (!refreshed?.media) throw new Error('TELEGRAM_DOWNLOAD_SOURCE_MISSING');
    const before = original.document;
    const after = refreshed.document;
    if (before?.id.toString() !== after?.id.toString() || before?.size.toString() !== after?.size.toString()
        || original.photo?.id.toString() !== refreshed.photo?.id.toString()) throw new Error('TELEGRAM_DOWNLOAD_SOURCE_CHANGED');
    return refreshed;
}
