import { Api, TelegramClient } from 'telegram';
import { query } from '../db/index.js';
import { channelRuntimeView } from './telegramChannelRuntimeView.js';
import { getChannelExecutionGroup } from './telegramUpload.js';
import { channelTaskCenterItem, buildTaskCenterDetail } from './telegramTaskCenter.js';
import { registerProgressCard, taskCenterCardKey, taskCenterCardOwners } from './telegramProgressControls.js';
import { getTelegramUserLocaleOrDefault } from './telegramLocalePreferences.js';
import { formatBytes, t, type TelegramLocale } from '../i18n/telegram.js';
import { TELEGRAM_BATCH_FILE_TYPES, type TelegramBatchFileType } from '../utils/telegramBatchMediaFilter.js';
import { telegramChannelJobCounts } from './unifiedTaskMapper.js';

function channelFileSelection(row: Record<string, unknown>) {
    const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {};
    const available = Array.isArray(params.availableFileTypes)
        ? params.availableFileTypes.filter((entry): entry is { fileType: TelegramBatchFileType; count: number } =>
            Boolean(entry && typeof entry === 'object' && TELEGRAM_BATCH_FILE_TYPES.includes(entry.fileType)
                && Number.isFinite(entry.count) && entry.count > 0))
        : [];
    const selected = Array.isArray(params.selectedFileTypes)
        ? available.filter(entry => (params.selectedFileTypes as unknown[]).includes(entry.fileType)).map(entry => entry.fileType)
        : available.map(entry => entry.fileType);
    return { available, selected };
}

export function buildTelegramChannelFileSelectionKeyboard(row: Record<string, unknown>, locale: TelegramLocale): Api.KeyboardButtonRow[] {
    const { available, selected } = channelFileSelection(row);
    const id = String(row.id);
    const rows: Api.KeyboardButtonRow[] = [];
    for (let index = 0; index < available.length; index += 2) {
        rows.push(new Api.KeyboardButtonRow({ buttons: available.slice(index, index + 2).map(entry => new Api.KeyboardButtonCallback({
            text: `${selected.includes(entry.fileType) ? '☑ ' : '☐ '}${t(locale, `bot.wizard.fileType.${entry.fileType}`)} (${entry.count})`,
            data: Buffer.from(`tgfs_${id}_${entry.fileType}`),
        })) }));
    }
    rows.push(new Api.KeyboardButtonRow({ buttons: [
        new Api.KeyboardButtonCallback({ text: `${selected.length === available.length ? '● ' : ''}${t(locale, 'bot.wizard.fileType.all')}`, data: Buffer.from(`tgfs_${id}_all`) }),
        new Api.KeyboardButtonCallback({ text: t(locale, 'channelCard.selectionConfirm'), data: Buffer.from(`tgfs_${id}_confirm`) }),
    ] }));
    return rows;
}

export function channelProgressText(row: Record<string, unknown>, locale: TelegramLocale): string {
    const runtime = String(row.runtime_status || row.status);
    const noMatches = runtime === 'completed' && row.scan_cursor && typeof row.scan_cursor === 'object'
        && 'outcome' in row.scan_cursor && row.scan_cursor.outcome === 'no_matches';
    const state = ['completed', 'completed_with_errors'].includes(runtime)
        ? t(locale, noMatches ? 'channelCard.noMatches' : runtime === 'completed' ? 'bot.subscription.result.completed' : 'bot.subscription.result.partial')
        : t(locale, runtime === 'cancelled' ? 'bot.callback.cancelled' : runtime === 'paused' ? 'taskCenter.state.paused'
            : runtime === 'pausing' ? 'taskCenter.state.pausing' : runtime === 'failed' ? 'taskCenter.state.failed'
                : runtime === 'cooling' ? 'taskCenter.state.cooling' : runtime === 'awaiting_selection' ? 'taskCenter.state.awaitingSelection'
                    : row.scan_status !== 'done' ? 'bot.legacy.state.scanning'
                    : Number(row.downloading_count) > 0 ? 'bot.legacy.state.downloading' : 'taskCenter.state.waiting');
    const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {};
    const { total, processed: done, failed, skipped, active, pending } = telegramChannelJobCounts(row);
    const item = channelTaskCenterItem(row, locale);
    const scanProgressText = item?.scanProgressText;
    const lines = [
        `${state} · ${String(row.source)}`,
        params.tag || (params.startDate && params.endDate ? `${params.startDate} → ${params.endDate}` : ''),
        item?.storageLabel ? t(locale, 'taskCenter.detail.storage', { value: item.storageLabel }) : '',
        item?.targetFolder ? t(locale, 'taskCenter.detail.targetFolder', { value: item.targetFolder }) : '',
        scanProgressText,
        t(locale, 'channelCard.progress', { done, total }),
        [t(locale, 'channelCard.queue', { active, pending }), failed > 0 ? t(locale, 'channelCard.failures', { count: failed }) : ''].filter(Boolean).join(' · '),
        skipped > 0 ? t(locale, 'channelCard.skipped', { count: skipped }) : '',
        active > 0 ? t(locale, 'bot.legacy.speed', { speed: formatBytes(Number(row.speed_bytes_per_second || 0), locale) }) : '',
        runtime === 'pausing' ? t(locale, 'taskCenter.note.pausing') : '',
        row.error ? String(row.error) : '',
        t(locale, 'channelCard.updated', { time: new Date().toLocaleTimeString(locale, { hour12: false, timeZone: 'Asia/Shanghai' }) }),
        ...(runtime === 'awaiting_selection' ? (() => {
            const { available, selected } = channelFileSelection(row);
            const types = selected.length === available.length ? t(locale, 'bot.wizard.fileType.all')
                : selected.length ? selected.map(fileType => t(locale, `bot.wizard.fileType.${fileType}`)).join(', ')
                    : t(locale, 'channelCard.selectionNone');
            return ['', t(locale, 'channelCard.selectionTitle'),
                ...available.map(entry => t(locale, 'channelCard.selectionCategory', { type: t(locale, `bot.wizard.fileType.${entry.fileType}`), count: entry.count })),
                t(locale, 'channelCard.selectionSummary', { types }), t(locale, 'channelCard.selectionInstructions'),
                t(locale, 'bot.wizard.imageTypeNote')];
        })() : []),
    ];
    return lines.filter(Boolean).join('\n');
}

let timer: NodeJS.Timeout | undefined;
let updating: Promise<void> | undefined;
const rendered = new Map<string, { signature: string; at: number; retryAt: number }>();

export async function syncTelegramChannelCards(client: TelegramClient): Promise<void> {
    const rows = await query(`SELECT j.*, a.name AS storage_account_name,
        COUNT(i.id)::int AS item_count,
        COUNT(i.id) FILTER (WHERE i.status='success')::int AS success_count,
        COUNT(i.id) FILTER (WHERE i.status='failed')::int AS failed_count,
        COUNT(i.id) FILTER (WHERE i.status='skipped')::int AS skipped_count_items,
        COUNT(i.id) FILTER (WHERE i.status='pending')::int AS pending_count,
        COUNT(i.id) FILTER (WHERE i.status='downloading')::int AS downloading_count
        FROM telegram_background_jobs j LEFT JOIN telegram_download_items i ON i.job_id=j.id AND i.status<>'excluded'
        LEFT JOIN storage_accounts a ON a.id::text=j.params->>'storageAccountId'
        WHERE j.kind IN ('date_range','tag_download')
          AND (j.params->>'progressMessageId' IS NOT NULL OR j.finished_at IS NULL)
          AND (j.finished_at IS NULL OR j.updated_at > NOW()-INTERVAL '24 hours')
        GROUP BY j.id, a.name ORDER BY j.created_at`);
    const seen = new Set<string>();
    for (const original of rows.rows) {
        const id = String(original.id);
        seen.add(id);
        const row = channelRuntimeView(original, getChannelExecutionGroup(id));
        const locale = await getTelegramUserLocaleOrDefault(Number(row.user_id));
        const chatId = String(row.chat_id || row.user_id);
        let messageId = Number(row.params?.progressMessageId || 0);
        const owner = messageId ? taskCenterCardOwners.get(taskCenterCardKey(chatId, messageId)) : undefined;
        if (owner?.interactive && (owner.interactiveUntil || 0) > Date.now()) continue;
        if (owner) owner.interactive = false;
        const signature = JSON.stringify([row.status, row.runtime_status, row.scan_status, row.total_count, row.success_count,
            row.failed_count, row.skipped_count_items, row.pending_count, row.downloading_count,
            Math.round(row.speed_bytes_per_second / 1024), row.scan_cursor, row.error, locale,
            row.params?.availableFileTypes, row.params?.selectedFileTypes, row.params?.fileSelectionConfirmed,
            row.params?.excludedCount, row.params?.storageProvider, row.params?.storageAccountName,
            row.params?.compactedSuccessCount, row.params?.compactedSkippedCount,
            row.params?.storageAccountId, row.storage_account_name, row.params?.folderOverride]);
        const previous = rendered.get(id);
        if (previous && (previous.retryAt > Date.now() || (previous.signature === signature
            && (row.finished_at || Date.now() - previous.at < 30_000)))) continue;
        const text = channelProgressText(row, locale);
        const terminal = ['completed','cancelled'].includes(row.status);
        const item = terminal ? null : channelTaskCenterItem(row, locale);
        const detailRows = item ? buildTaskCenterDetail(item, 0, { locale }).rows : [];
        const selection = row.status === 'awaiting_selection';
        const taskRows = selection ? detailRows.map(buttons => buttons.filter(button => button.data.startsWith('tc_a_x_'))).filter(buttons => buttons.length) : detailRows;
        const keyboardRows = [
            ...(selection ? buildTelegramChannelFileSelectionKeyboard(row, locale) : []),
            ...taskRows.map(buttons => new Api.KeyboardButtonRow({ buttons: buttons.map(button => new Api.KeyboardButtonCallback({ text: button.text, data: Buffer.from(button.data) })) })),
        ];
        const buttons = keyboardRows.length ? new Api.ReplyInlineMarkup({ rows: keyboardRows }) : undefined;
        try {
            if (messageId) {
                try { await client.editMessage(chatId, { message: messageId, text, buttons, linkPreview: false }); }
                catch (error) {
                    const code = String(error && typeof error === 'object' && 'errorMessage' in error ? error.errorMessage : error);
                    if (/MESSAGE_NOT_MODIFIED/.test(code)) { /* Same content is already visible. */ }
                    else if (/MESSAGE_ID_INVALID|MESSAGE_EDIT_TIME_EXPIRED/.test(code)) messageId = 0;
                    else throw error;
                }
            }
            if (!messageId) {
                const message = await client.sendMessage(chatId, { message: text, buttons, linkPreview: false });
                messageId = message.id;
                await query(`UPDATE telegram_background_jobs SET params=jsonb_set(params,'{progressMessageId}',to_jsonb($2::int)) WHERE id=$1`, [id, messageId]);
            }
            registerProgressCard(chatId, messageId, Number(row.user_id));
            rendered.set(id, { signature, at: Date.now(), retryAt: 0 });
        } catch (error) {
            const seconds = Math.max(5, Number(error && typeof error === 'object' && 'seconds' in error ? error.seconds : 15) || 15);
            rendered.set(id, { signature: previous?.signature || '', at: previous?.at || 0, retryAt: Date.now() + seconds * 1000 });
            console.warn('Telegram progress card update failed', { jobId: id, messageId, error: String(error) });
        }
    }
    for (const id of rendered.keys()) if (!seen.has(id)) rendered.delete(id);
}

export function startTelegramChannelCards(client: TelegramClient): void {
    clearInterval(timer);
    const tick = () => {
        if (updating) return;
        updating = syncTelegramChannelCards(client).catch(error => console.warn('Telegram card sync failed:', error))
            .finally(() => { updating = undefined; });
    };
    tick();
    timer = setInterval(tick, 5000);
}
export async function stopTelegramChannelCards(): Promise<void> {
    clearInterval(timer);
    timer = undefined;
    await updating;
    rendered.clear();
}
