import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildTaskCancelConfirm,
    buildTaskCenterDetail,
    buildTaskCenterPage,
    channelTaskCenterItem,
    ordinaryTaskCenterItem,
    parseTaskCenterCallback,
    sortTaskCenterItems,
    ytdlpTaskCenterItem,
    type TaskCenterItem,
} from './telegramTaskCenter.js';
import { buildSilentModeNotice, buildSilentProgress, buildTaskControlButtons } from '../utils/telegramMessages.js';
import { mergeTaskCardPauseState } from './telegramUpload.js';
import { DownloadTaskQueue } from './downloadTaskQueue.js';

const now = Date.parse('2026-07-10T10:00:00.000Z');

function item(overrides: Partial<TaskCenterItem> = {}): TaskCenterItem {
    return {
        sourceType: 'memory',
        id: 'm1234567',
        kind: 'single',
        title: 'report.pdf',
        state: 'waiting',
        total: 1,
        active: 0,
        pending: 1,
        completed: 0,
        failed: 0,
        skipped: 0,
        createdAt: now - 60_000,
        updatedAt: now - 10_000,
        ...overrides,
    };
}

function flattenData(rows: Array<Array<{ text: string; data: string }>>): string[] {
    return rows.flat().map(button => button.data);
}

function findButtonText(rows: Array<Array<{ text: string; data: string }>>, pattern: RegExp): string | undefined {
    return rows.flat().find(button => pattern.test(button.text))?.text;
}

function testBuildsConcisePaginatedListAndClampsPage() {
    const items = [
        item({ id: 'run1', state: 'running', title: '夏日相册', kind: 'album', total: 12, active: 1, pending: 7, completed: 4, currentFileName: 'IMG_004.jpg' }),
        item({ id: 'wait1', state: 'waiting', title: 'report.pdf' }),
        item({ id: 'pausing1', state: 'pausing', title: '正在收尾的相册', kind: 'album', total: 4, active: 1, pending: 2, completed: 1 }),
        item({ id: 'paused1', state: 'paused', title: '暂停任务', kind: 'album', total: 5, pending: 4, completed: 1 }),
        item({ sourceType: 'channel', id: 'cafebabedead', kind: 'channel', state: 'cooling', title: '@channel · #壁纸', total: 120, active: 0, pending: 82, completed: 38, reason: 'Google Drive 限额冷却中' }),
        item({ id: 'wait2', title: 'long-file-name-that-will-be-shortened-for-button-display.zip' }),
        item({ id: 'wait3', title: '第七个任务' }),
    ];

    const page = buildTaskCenterPage(items, 99, { now });
    assert.equal(page.page, 1);
    assert.equal(page.totalPages, 2);
    assert.equal(page.visibleItems.length, 1);
    assert.match(page.text, /📥 \*\*下载任务\*\*/);
    assert.match(page.text, /🟢 运行中 1/);
    assert.match(page.text, /⏳ 等待 3/);
    assert.match(page.text, /⏸ 已暂停 2/);
    assert.match(page.text, /🧊 系统等待 1/);
    assert.match(page.text, /共 7 个进行中的任务/);
    assert.match(page.text, /第 2\/2 页/);
    assert.match(page.text, /@channel · \\#壁纸/);
    assert.doesNotMatch(page.text, /夏日相册/);

    const callbackData = flattenData(page.rows);
    assert(callbackData.includes('tc_d_c_cafebabedead_1'));
    assert(callbackData.includes('tc_l_0'));
    assert(callbackData.includes('tc_l_1'));
    assert(callbackData.every(data => Buffer.byteLength(data, 'utf8') <= 64));
}

function testSortsActiveBeforeWaitingAndPaused() {
    const sorted = sortTaskCenterItems([
        item({ id: 'paused', state: 'paused', updatedAt: 100 }),
        item({ id: 'wait-old', state: 'waiting', updatedAt: 200 }),
        item({ id: 'run-old', state: 'running', updatedAt: 300 }),
        item({ id: 'run-new', state: 'running', updatedAt: 400 }),
        item({ id: 'wait-new', state: 'waiting', updatedAt: 500 }),
    ]);
    assert.deepEqual(sorted.map(value => value.id), ['run-new', 'run-old', 'wait-new', 'wait-old', 'paused']);
}

function testBuildsStateSpecificDetailControls() {
    const waiting = buildTaskCenterDetail(item({ state: 'waiting', targetFolder: '文档/报告' }), 0, { now });
    assert.match(waiting.text, /⏳ \*\*等待开始\*\*/);
    assert.match(waiting.text, /保存位置：文档\/报告/);
    assert(findButtonText(waiting.rows, /优先开始/));
    assert(findButtonText(waiting.rows, /取消/));
    assert(flattenData(waiting.rows).includes('tc_a_s_m_m1234567_0'));
    assert(flattenData(waiting.rows).includes('tc_a_x_m_m1234567_0'));

    const running = buildTaskCenterDetail(item({ state: 'running', active: 1, pending: 3, total: 6, completed: 2, currentFileName: 'part-3.bin' }), 0, { now });
    assert.match(running.text, /🟢 \*\*正在运行\*\*/);
    assert.match(running.text, /当前文件：part-3.bin/);
    assert(findButtonText(running.rows, /暂停任务/));
    assert(!findButtonText(running.rows, /优先开始/));

    const pausing = buildTaskCenterDetail(item({ state: 'pausing', active: 1, pending: 2, total: 4, completed: 1 }), 0, { now });
    assert.match(pausing.text, /正在完成当前文件/);
    assert(!findButtonText(pausing.rows, /完成当前文件后暂停/));
    assert(findButtonText(pausing.rows, /撤销暂停/));
    assert(findButtonText(pausing.rows, /取消/));

    const paused = buildTaskCenterDetail(item({ state: 'paused', pending: 4, total: 5, completed: 1, reason: '用户请求暂停' }), 0, { now });
    assert.match(paused.text, /⏸ \*\*已暂停\*\*/);
    assert.match(paused.text, /原因：用户请求暂停/);
    assert(findButtonText(paused.rows, /继续/));

    const pausedByUser = buildTaskCenterDetail(item({ state: 'paused', pending: 2, reason: '下载队列已全局暂停' }), 0, { now });
    assert(findButtonText(pausedByUser.rows, /继续/));
    assert.doesNotMatch(pausedByUser.text, /系统保护暂停/);

    const pausedBySystem = buildTaskCenterDetail(item({
        state: 'cooling',
        pending: 2,
        reason: '磁盘空间不足：可用 1 GB',
        protection: { kind: 'disk_pressure', reason: '磁盘空间不足：可用 1 GB', autoResume: true, recheckMs: 30_000 },
    }), 0, { now });
    assert(!findButtonText(pausedBySystem.rows, /继续/));
    assert.match(pausedBySystem.text, /系统保护暂停/);
    assert.match(pausedBySystem.text, /每 30 秒重新检查/);
    assert.match(pausedBySystem.text, /自动恢复/);

    const realSystemQueue = new DownloadTaskQueue({ maxConcurrent: 1 });
    realSystemQueue.ensureGroup({ id: 'real-system', kind: 'single', title: 'real', chatId: 'chat', expectedTotal: 1 });
    realSystemQueue.acquireDiskPressureBlocker('disk', '容量低于安全阈值', 30_000);
    const realGroup = realSystemQueue.getSnapshot({ chatId: 'chat' }).groups[0];
    const realItem = ordinaryTaskCenterItem(realGroup!);
    assert.equal(realItem?.state, 'cooling');
    const realView = buildTaskCenterDetail(realItem!, 0, { now });
    assert.match(realView.text, /系统保护暂停/);
    assert.match(realView.text, /每 30 秒重新检查/);
    assert(!findButtonText(realView.rows, /继续/));
    realSystemQueue.releaseDiskPressureBlocker('disk');

    const cooling = buildTaskCenterDetail(item({
        sourceType: 'channel',
        id: 'deadbeef',
        kind: 'channel',
        state: 'cooling',
        reason: 'Google Drive 今日上传额度已达上限',
        protection: { kind: 'storage_cooldown', reason: 'Google Drive 今日上传额度已达上限', autoResume: true, retryAt: '2026/7/11 12:00:00' },
    }), 0, { now });
    assert.match(cooling.text, /系统等待/);
    assert.match(cooling.text, /2026\/7\/11 12:00:00 后重新检查并自动恢复/);
    assert(!findButtonText(cooling.rows, /继续/));
    assert(findButtonText(cooling.rows, /取消/));

    const scanningOnlyChannel = buildTaskCenterDetail(item({ sourceType: 'channel', id: 'scanonly', kind: 'channel', state: 'running', active: 0, pending: 0, title: '@channel scanning' }), 0, { now });
    assert(findButtonText(scanningOnlyChannel.rows, /暂停/));
    assert(findButtonText(scanningOnlyChannel.rows, /取消/));

    for (const view of [waiting, running, pausing, paused, cooling, scanningOnlyChannel]) {
        assert(findButtonText(view.rows, /返回任务列表/));
        assert(findButtonText(view.rows, /刷新/));
        assert(flattenData(view.rows).every(data => Buffer.byteLength(data, 'utf8') <= 64));
    }
}

function testCancelRequiresConfirmationAndCallbackCodecRoundTrips() {
    const target = item({ id: 'album77', kind: 'album', title: '家庭相册', total: 10, completed: 3, active: 1, pending: 6 });
    const confirm = buildTaskCancelConfirm(target, 2);
    assert.match(confirm.text, /确认取消/);
    assert.match(confirm.text, /家庭相册/);
    assert.match(confirm.text, /正在下载的文件会被中止/);
    assert(flattenData(confirm.rows).includes('tc_a_k_m_album77_2'));
    assert(flattenData(confirm.rows).includes('tc_d_m_album77_2'));

    assert.deepEqual(parseTaskCenterCallback('tc_l_3'), { view: 'list', page: 3 });
    assert.deepEqual(parseTaskCenterCallback('tc_d_c_cafebabedead_1'), { view: 'detail', sourceType: 'channel', id: 'cafebabedead', page: 1 });
    assert.deepEqual(parseTaskCenterCallback('tc_a_p_m_album77_2'), { view: 'action', action: 'pause', sourceType: 'memory', id: 'album77', page: 2 });
    assert.deepEqual(parseTaskCenterCallback('invalid'), null);
    assert.deepEqual(parseTaskCenterCallback('tc_a_p_m_bad_id_0'), null);
}

function testAdaptersHideTerminalOrdinaryGroupsAndMapChannelRows() {
    const ordinary = ordinaryTaskCenterItem({
        id: 'ordinary1',
        kind: 'album',
        title: '普通相册',
        chatId: '123',
        userId: 7,
        state: 'running',
        total: 4,
        active: 1,
        pending: 2,
        completed: 1,
        failed: 0,
        cancelled: 0,
        currentFileName: '2.jpg',
        createdAt: now - 1000,
        updatedAt: now,
    });
    assert.equal(ordinary?.sourceType, 'memory');
    assert.equal(ordinary?.kind, 'album');
    assert.equal(ordinary?.completed, 1);

    assert.equal(ordinaryTaskCenterItem({
        id: 'done1', kind: 'single', title: 'done', chatId: '123', state: 'completed', total: 1,
        active: 0, pending: 0, completed: 1, failed: 0, cancelled: 0, createdAt: now, updatedAt: now,
    }), null);

    const channel = channelTaskCenterItem({
        id: 'cafebabedeadbeef',
        kind: 'tag_download',
        source: '@wallpaper',
        status: 'paused',
        total_count: 20,
        item_count: 20,
        pending_count: 12,
        downloading_count: 0,
        success_count: 7,
        failed_count: 1,
        skipped_count_items: 0,
        current_file_name: null,
        folder_override: '频道/壁纸',
        options: { tag: '#壁纸' },
        created_at: new Date(now - 1000).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.equal(channel?.id, 'cafebabedead');
    assert.equal(channel?.state, 'paused');
    assert.equal(channel?.title, '@wallpaper · #壁纸');
    assert.equal(channel?.targetFolder, '频道/壁纸');
    const cooldownChannel = channelTaskCenterItem({
        id: 'fedcba9876543210',
        source: '@cooldown',
        status: 'cooling',
        cooldown_until: new Date(Date.now() + 60_000).toISOString(),
        error: 'Google Drive 今日上传额度已达上限',
        pending_count: 3,
        created_at: new Date(now - 1000).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.equal(cooldownChannel?.state, 'cooling');
    assert.equal(cooldownChannel?.protection?.kind, 'storage_cooldown');
    assert.equal(cooldownChannel?.protection?.autoResume, true);
    assert.match(cooldownChannel?.reason || '', /Google Drive 今日上传额度已达上限/);
    assert.match(cooldownChannel?.reason || '', /自动恢复/);

    const expiredCoolingChannel = channelTaskCenterItem({
        id: 'edcba98765432100',
        source: '@expired',
        status: 'cooling',
        cooldown_until: new Date(Date.now() - 60_000).toISOString(),
        error: 'Google Drive 今日上传额度已达上限',
        pending_count: 3,
        created_at: new Date(now - 1000).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.notEqual(expiredCoolingChannel?.state, 'cooling');
    assert.equal(expiredCoolingChannel?.protection, undefined);

    const waitingChannel = channelTaskCenterItem({
        id: 'abcdef1234567890',
        source: '@queued',
        status: 'queued',
        scan_status: 'pending',
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.equal(waitingChannel?.state, 'waiting');

    const channelFromStringParams = channelTaskCenterItem({
        id: '1234567890abcdef',
        source: '@news',
        status: 'paused',
        pending_count: 1,
        params: JSON.stringify({ startDate: '2026-07-01', endDate: '2026-07-10', folderOverride: '频道/新闻' }),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.equal(channelFromStringParams?.title, '@news · 2026-07-01 → 2026-07-10');
    assert.equal(channelFromStringParams?.targetFolder, '频道/新闻');
}

function testEscapesUserControlledMarkdownInTaskCards() {
    const unsafe = item({
        title: 'bad **title** [x](tg://user?id=1)',
        currentFileName: 'part_[1].zip',
        targetFolder: 'folder_*_name',
        source: '@source_[x]',
        reason: 'error **boom**',
    });
    const detail = buildTaskCenterDetail(unsafe, 0, { now });
    assert.match(detail.text, /bad \\\*\\\*title\\\*\\\*/);
    assert(detail.text.includes('当前文件：part\\_\\[1\\].zip'));
    assert(detail.text.includes('保存位置：folder\\_\\*\\_name'));
    assert.doesNotMatch(detail.text, /\[x\]\(tg:\/\/user/);

    const page = buildTaskCenterPage([unsafe], 0, { now });
    assert.match(page.text, /bad \\\*\\\*title\\\*\\\*/);
}

function testUsesLongerChannelSelectorsToAvoidAmbiguousShortPrefixes() {
    const first = channelTaskCenterItem({
        id: 'cafebabe111111111111111111111111',
        source: '@first',
        status: 'paused',
        pending_count: 1,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    const second = channelTaskCenterItem({
        id: 'cafebabe222222222222222222222222',
        source: '@second',
        status: 'paused',
        pending_count: 1,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
    });
    assert.equal(first?.id, 'cafebabe1111');
    assert.equal(second?.id, 'cafebabe2222');
    assert.notEqual(first?.id, second?.id);
}

function testYtDlpTasksUseRealisticControlsAndCallbackCodec() {
    const task = ytdlpTaskCenterItem({
        sourceType: 'ytdlp',
        id: 'yd-1234567890abcdef',
        kind: 'video_download',
        title: 'yt-dlp: example.com',
        status: 'running',
        stage: 'downloading',
        progress: 42.5,
        ownerUserId: 7,
        chatId: '123',
        source: 'https://example.com/video',
        targetProvider: 'google_drive',
        targetAccountId: '11111111-1111-1111-1111-111111111111',
        targetFolder: 'ytdlp',
        totalItems: 1,
        completedItems: 0,
        failedItems: 0,
        totalBytes: 0,
        transferredBytes: 0,
        payload: { targetAccountName: '主盘' },
        error: null,
        retryable: false,
        cancelRequested: false,
        startedAt: new Date(now - 30_000),
        finishedAt: null,
        createdAt: new Date(now - 60_000),
        updatedAt: new Date(now),
    });
    assert.equal(task?.sourceType, 'ytdlp');
    assert.equal(task?.progressPercent, 42.5);
    assert.equal(task?.targetFolder, '主盘 / ytdlp');
    const detail = buildTaskCenterDetail(task!, 0, { now });
    assert.match(detail.text, /43%/);
    assert(!findButtonText(detail.rows, /暂停任务/));
    assert(!findButtonText(detail.rows, /优先开始/));
    assert(findButtonText(detail.rows, /取消/));
    assert(flattenData(detail.rows).includes('tc_a_x_y_yd-1234567890abcdef_0'));
    assert.deepEqual(parseTaskCenterCallback('tc_d_y_yd-1234567890abcdef_0'), {
        view: 'detail', sourceType: 'ytdlp', id: 'yd-1234567890abcdef', page: 0,
    });

    const failed = ytdlpTaskCenterItem({
        sourceType: 'ytdlp', id: 'yd-1234567890abcdef', kind: 'video_download', title: 'yt-dlp: example.com',
        status: 'failed', stage: 'failed', progress: 42.5, ownerUserId: 7, chatId: '123',
        source: 'https://example.com/video', targetProvider: 'google_drive',
        targetAccountId: '11111111-1111-1111-1111-111111111111', targetFolder: 'ytdlp',
        totalItems: 1, completedItems: 0, failedItems: 1, totalBytes: 0, transferredBytes: 0,
        payload: { targetAccountName: '主盘' }, error: '网络暂时不可用', retryable: true,
        cancelRequested: false, startedAt: new Date(now - 30_000), finishedAt: new Date(now),
        createdAt: new Date(now - 60_000), updatedAt: new Date(now),
    });
    assert.equal(failed?.state, 'failed');
    const failedDetail = buildTaskCenterDetail(failed!, 0, { now });
    assert(findButtonText(failedDetail.rows, /重试/));
    assert(flattenData(failedDetail.rows).includes('tc_a_t_y_yd-1234567890abcdef_0'));
    assert.deepEqual(parseTaskCenterCallback('tc_a_t_y_yd-1234567890abcdef_0'), {
        view: 'action', action: 'retry', sourceType: 'ytdlp', id: 'yd-1234567890abcdef', page: 0,
    });
}

async function testPausedProgressDoesNotShowQueuedFileAsCurrent() {
    const text = buildSilentProgress(6, [{
        folderName: '相册',
        totalFiles: 6,
        completed: 0,
        successful: 0,
        failed: 0,
        queuePending: 6,
        currentFileName: 'image_1041.jpg',
        currentFileActive: true,
    }], [], 0, 0, 'task', true, '用户暂停');
    assert.doesNotMatch(text, /📄 当前:/);
}

function testActiveProgressUsesCanonicalStoredDisplayName() {
    const text = buildSilentProgress(6, [{
        folderName: '相册',
        totalFiles: 6,
        completed: 0,
        successful: 0,
        failed: 0,
        queuePending: 5,
        currentFileName: '雅儿贝德_01.jpg',
        currentFileActive: true,
    }], [], 0, 0, 'task', false);
    assert.match(text, /📄 当前: 雅儿贝德_01\.jpg/);
    assert.doesNotMatch(text, /image_1041\.jpg/);
}

function taskControlButtonTexts(paused: boolean, systemPause?: { kind: 'disk_pressure'; reason: string; autoResume: true; recheckMs?: number }, pausing = false, userPaused = paused && !systemPause): string[] {
    return (buildTaskControlButtons('task', paused, systemPause, pausing, userPaused)?.rows || [])
        .flatMap((row: any) => row.buttons || [])
        .map((button: any) => String(button.text || ''));
}

function testLegacyTaskCardShowsOnlyValidActions() {
    assert.deepEqual(taskControlButtonTexts(false), ['⏸ 暂停', '🛑 取消']);
    assert.deepEqual(taskControlButtonTexts(true), ['▶️ 继续', '🛑 取消']);
    assert.deepEqual(taskControlButtonTexts(false, undefined, true), ['▶️ 继续', '🛑 取消']);
    assert.deepEqual(taskControlButtonTexts(true, { kind: 'disk_pressure', reason: '磁盘空间不足', autoResume: true, recheckMs: 30_000 }), ['🛑 取消']);
    assert.deepEqual(taskControlButtonTexts(true, { kind: 'disk_pressure', reason: '磁盘空间不足', autoResume: true, recheckMs: 30_000 }, false, true), ['▶️ 继续', '🛑 取消']);
    const initialSystemNotice = buildSilentModeNotice(
        2,
        'task',
        true,
        '容量低于安全阈值',
        { kind: 'disk_pressure', reason: '容量低于安全阈值', autoResume: true, recheckMs: 30_000 },
    );
    assert.match(initialSystemNotice, /系统保护暂停/);
    assert.match(initialSystemNotice, /容量低于安全阈值/);
    assert.match(initialSystemNotice, /每 30 秒重新检查/);
    assert.doesNotMatch(initialSystemNotice, /用户暂停|点击下方“继续”/);

    const systemPausedText = buildSilentProgress(
        1,
        [],
        [],
        0,
        0,
        'task',
        true,
        '磁盘空间不足：可用 1 GB，系统需保留 2 GB',
        false,
        { kind: 'disk_pressure', reason: '磁盘空间不足：可用 1 GB，系统需保留 2 GB', autoResume: true, recheckMs: 30_000 },
    );
    assert.match(systemPausedText, /当前状态：系统保护暂停/);
    assert.match(systemPausedText, /磁盘空间不足/);
    assert.match(systemPausedText, /每 30 秒重新检查/);
    assert.match(systemPausedText, /条件满足后自动恢复/);

    const pausingText = buildSilentProgress(9, [{
        folderName: '相册',
        totalFiles: 9,
        completed: 4,
        successful: 4,
        failed: 0,
        queuePending: 5,
    }], [], 4, 0, 'task', false, '正在完成当前文件，随后暂停', true);
    assert.match(pausingText, /正在完成当前文件，随后暂停/);
    assert.doesNotMatch(pausingText, /后台批量处理中/);

    const userPausedText = buildSilentProgress(1, [], [], 0, 0, 'task', true, '用户已暂停下载队列');
    assert.match(userPausedText, /当前状态：用户暂停/);
    assert.doesNotMatch(userPausedText, /系统保护暂停/);
}

function testTaskCardUsesScopedPauseEvenWhenGlobalQueueIsRunning() {
    assert.deepEqual(
        mergeTaskCardPauseState(false, undefined, { paused: true, pausing: false, userPaused: true, reason: '用户已暂停任务' }),
        { paused: true, pausing: false, reason: '用户已暂停任务', systemPause: undefined, userPaused: true },
    );
    assert.deepEqual(
        mergeTaskCardPauseState(false, undefined, { paused: false, pausing: true, userPaused: false, reason: '正在完成当前文件，随后暂停' }),
        { paused: false, pausing: true, reason: '正在完成当前文件，随后暂停', systemPause: undefined, userPaused: false },
    );
    assert.deepEqual(
        mergeTaskCardPauseState(false, undefined, {
            paused: true,
            pausing: false,
            userPaused: true,
            reason: '用户暂停：等待磁盘整理完成',
        }),
        { paused: true, pausing: false, reason: '用户暂停：等待磁盘整理完成', systemPause: undefined, userPaused: true },
    );
    const systemPause = { kind: 'disk_pressure' as const, reason: '磁盘空间不足', autoResume: true as const, recheckMs: 30_000 };
    assert.deepEqual(
        mergeTaskCardPauseState(true, '磁盘空间不足：可用 1 GB', {
            paused: true,
            pausing: false,
            userPaused: false,
            reason: '磁盘空间不足',
            systemPause,
        }),
        {
            paused: true,
            pausing: false,
            reason: '磁盘空间不足：可用 1 GB',
            systemPause: { ...systemPause, reason: '磁盘空间不足：可用 1 GB' },
            userPaused: false,
        },
    );
    assert.deepEqual(
        mergeTaskCardPauseState(true, '容量低于安全阈值', {
            paused: true,
            pausing: false,
            userPaused: true,
            reason: '容量低于安全阈值',
            systemPause,
        }, systemPause, true),
        {
            paused: true,
            pausing: false,
            reason: '容量低于安全阈值',
            systemPause: { ...systemPause, reason: '容量低于安全阈值' },
            userPaused: true,
        },
    );
}

async function testCanonicalNameIsComputedBeforeQueueDisplay() {
    const uploadSource = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');
    const canonicalize = uploadSource.indexOf("if (file.generatedName !== false) {\n        file.fileName = await getCanonicalTelegramFileName");
    const displayName = uploadSource.indexOf('const taskDisplayName = queue?.folderName');
    assert(canonicalize >= 0 && displayName > canonicalize);
    assert.match(uploadSource, /currentFileName: file\.fileName, currentFileActive: true/);
}

async function main() {
    testBuildsConcisePaginatedListAndClampsPage();
    testSortsActiveBeforeWaitingAndPaused();
    testBuildsStateSpecificDetailControls();
    testCancelRequiresConfirmationAndCallbackCodecRoundTrips();
    testAdaptersHideTerminalOrdinaryGroupsAndMapChannelRows();
    testEscapesUserControlledMarkdownInTaskCards();
    testUsesLongerChannelSelectorsToAvoidAmbiguousShortPrefixes();
    testYtDlpTasksUseRealisticControlsAndCallbackCodec();
    await testPausedProgressDoesNotShowQueuedFileAsCurrent();
    testActiveProgressUsesCanonicalStoredDisplayName();
    testLegacyTaskCardShowsOnlyValidActions();
    testTaskCardUsesScopedPauseEvenWhenGlobalQueueIsRunning();
    await testCanonicalNameIsComputedBeforeQueueDisplay();
    console.log('telegram task center ok');
}

main();
