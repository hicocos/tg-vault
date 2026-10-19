import { DownloadSpeedSampler, validBytes, type DownloadByteProgress } from './downloadProgress.js';

export type DownloadTaskGroupKind = 'single' | 'album' | 'channel';
export type DownloadTaskGroupState =
    | 'waiting'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'cancelling'
    | 'completed'
    | 'cancelled';

export interface DownloadTaskGroupInput {
    id: string;
    kind: DownloadTaskGroupKind;
    title: string;
    chatId: string;
    userId?: number;
    source?: string;
    targetProvider?: string;
    targetAccountId?: string | null;
    targetFolder?: string | null;
    expectedTotal?: number;
    hidden?: boolean;
}

export interface DownloadTaskScope {
    chatId?: string;
    userId?: number;
}

export type DownloadTaskSystemPauseKind = 'disk_pressure';

export interface DownloadTaskSystemPause {
    kind: DownloadTaskSystemPauseKind;
    reason: string;
    autoResume: true;
    recheckMs?: number;
    blockerCount?: number;
}

export interface DownloadTaskGroupSnapshot extends DownloadTaskGroupInput, DownloadByteProgress {
    state: DownloadTaskGroupState;
    total: number;
    active: number;
    downloading: number;
    uploading: number;
    waitingUpload: number;
    retrying: number;
    stage: 'waiting' | 'downloading' | 'uploading';
    pending: number;
    completed: number;
    failed: number;
    cancelled: number;
    currentFileName?: string;
    reason?: string;
    systemPause?: DownloadTaskSystemPause;
    createdAt: number;
    updatedAt: number;
}

export interface DownloadTaskQueueSnapshot {
    groups: DownloadTaskGroupSnapshot[];
    active: number;
    pending: number;
    paused: boolean;
    pauseReason?: string;
    userPaused: boolean;
    systemPause?: DownloadTaskSystemPause;
}

export interface DownloadTaskScopeStatus {
    paused: boolean;
    pausing: boolean;
    systemBlocked: boolean;
    userPaused: boolean;
    reason?: string;
    systemPause?: DownloadTaskSystemPause;
}

export interface DownloadTaskQueueOptions {
    maxConcurrent?: number;
    uploadConcurrency?: number;
    maxInFlight?: number;
    maxStagedBytes?: number;
    idFactory?: () => string;
    onGroupChanged?: (group: DownloadTaskGroupSnapshot) => void | Promise<void>;
}

export type DownloadFileTaskState = 'pending' | 'active' | 'success' | 'failed' | 'cancelled';
export type DownloadFilePhase = 'downloading' | 'retrying' | 'waiting_upload' | 'uploading' | 'waiting_storage';

export interface DownloadTaskExecutionResult {
    status: 'success' | 'failed';
    error?: string;
}

interface DownloadTaskGroupRecord extends DownloadTaskGroupInput {
    expectedTotal: number;
    settledBytes?: number;
    settledTotalBytes?: number;
    settledKnown?: number;
    completed: number;
    failed: number;
    cancelled: number;
    createdAt: number;
    updatedAt: number;
    stateOverride?: 'pausing' | 'paused' | 'cancelling' | 'cancelled';
}

export interface DownloadFileTaskSnapshot {
    id: string;
    groupId: string;
    fileName: string;
    status: DownloadFileTaskState;
    error?: string;
    phase?: DownloadFilePhase;
    retryAttempt?: number;
    maxAttempts?: number;
    reason?: string;
    startTime?: number;
    endTime?: number;
    totalSize?: number;
    downloadedSize?: number;
}

interface DownloadFileTask extends DownloadFileTaskSnapshot {
    speedSampler?: DownloadSpeedSampler;
    execute: () => Promise<void>;
    rawExecute: (signal: AbortSignal, taskId?: string) => Promise<void | DownloadTaskExecutionResult>;
    abortController: AbortController;
    settleCancelled?: () => void;
    onPendingCancelled?: () => void | Promise<void>;
}

export type DownloadTaskGroupControlStatus = 'ok' | 'not_found' | 'forbidden' | 'terminal' | 'blocked';

export interface DownloadTaskGroupControlResult {
    status: DownloadTaskGroupControlStatus;
    group?: DownloadTaskGroupSnapshot;
    active: number;
    pending: number;
}

export type DownloadTaskPauseOrigin = 'user' | 'system';

export class DownloadTaskQueue {
    private queue: DownloadFileTask[] = [];
    private active: DownloadFileTask[] = [];
    private history: DownloadFileTask[] = [];
    private groups = new Map<string, DownloadTaskGroupRecord>();
    private readonly maxHistory = 50;
    private maxConcurrent: number;
    private readonly uploadConcurrency: number;
    private readonly maxInFlight: number;
    private readonly maxStagedBytes: number;
    private readonly uploadWaiters = new Map<string, { resolve(): void; reject(error: unknown): void; cleanup(): void }>();
    private readonly idFactory: () => string;
    private readonly onGroupChanged?: (group: DownloadTaskGroupSnapshot) => void | Promise<void>;
    private userPaused = false;
    private readonly scopedUserPauses = new Map<string, { scope: DownloadTaskScope; reason: string }>();
    private readonly scopeResumeOverrides = new Set<string>();
    private systemPause?: DownloadTaskSystemPause;
    private readonly diskPressureBlockers = new Map<string, { reason: string; recheckMs?: number }>();
    private readonly notificationChains = new Map<string, Promise<void>>();

    constructor(options: DownloadTaskQueueOptions = {}) {
        this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent || 1));
        this.uploadConcurrency = Math.max(1, Math.floor(options.uploadConcurrency || 2));
        this.maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? 2));
        this.maxStagedBytes = Math.max(1, options.maxStagedBytes ?? 4 * 1024 ** 3);
        this.idFactory = options.idFactory || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
        this.onGroupChanged = options.onGroupChanged;
    }

    private nextGroupVersion(group: DownloadTaskGroupRecord, candidate = Date.now()): number {
        return Math.max(candidate, group.updatedAt + 1);
    }

    ensureGroup(input: DownloadTaskGroupInput): DownloadTaskGroupSnapshot {
        const id = input.id.trim();
        if (!id) throw new Error('下载任务组 ID 不能为空');
        const now = Date.now();
        const existing = this.groups.get(id);
        if (existing && ['completed', 'cancelled'].includes(this.snapshotGroup(existing).state)) {
            this.groups.delete(id);
            this.scopeResumeOverrides.delete(id);
        }
        const current = this.groups.get(id);
        if (current) {
            current.kind = input.kind;
            current.title = input.title || current.title;
            current.chatId = input.chatId || current.chatId;
            current.userId = input.userId ?? current.userId;
            current.source = input.source ?? current.source;
            if (current.targetProvider === undefined && input.targetProvider !== undefined) current.targetProvider = input.targetProvider;
            if (current.targetAccountId === undefined && input.targetAccountId !== undefined) current.targetAccountId = input.targetAccountId;
            current.targetFolder = input.targetFolder ?? current.targetFolder;
            current.hidden = input.hidden ?? current.hidden;
            current.expectedTotal = Math.max(current.expectedTotal, Math.max(0, input.expectedTotal || 0));
            current.updatedAt = this.nextGroupVersion(current, now);
            this.notifyGroup(current);
            return this.snapshotGroup(current);
        }

        const record: DownloadTaskGroupRecord = {
            ...input,
            id,
            expectedTotal: Math.max(0, input.expectedTotal || 0),
            completed: 0,
            failed: 0,
            cancelled: 0,
            createdAt: now,
            updatedAt: existing ? this.nextGroupVersion(existing, now) : now,
        };
        this.groups.set(id, record);
        this.notifyGroup(record);
        return this.snapshotGroup(record);
    }

    restoreGroup(input: DownloadTaskGroupInput, settled: { completed: number; failed: number; cancelled: number; paused: boolean }): void {
        this.ensureGroup(input);
        const group = this.groups.get(input.id)!;
        group.completed = settled.completed;
        group.failed = settled.failed;
        group.cancelled = settled.cancelled;
        if (settled.paused) group.stateOverride = 'paused';
        group.updatedAt = this.nextGroupVersion(group);
        this.notifyGroup(group);
    }

    async add(
        groupId: string,
        fileName: string,
        execute: (signal: AbortSignal, taskId?: string) => Promise<void | DownloadTaskExecutionResult>,
        totalSize = 0,
        onPendingCancelled?: () => void | Promise<void>,
    ): Promise<void> {
        const group = this.groups.get(groupId);
        if (!group) throw new Error(`下载任务组不存在: ${groupId}`);
        if (group.stateOverride === 'cancelled' || group.stateOverride === 'cancelling') {
            try {
                await Promise.resolve(onPendingCancelled?.());
            } catch (error) {
                console.error(`[Queue] late cancellation callback failed: ${fileName}`, error);
            }
            return;
        }
        const queuedBehindPausedGroup = group.stateOverride === 'paused' || group.stateOverride === 'pausing';
        group.expectedTotal = Math.max(
            group.expectedTotal,
            this.countGroupFiles(groupId) + group.completed + group.failed + group.cancelled + 1,
        );
        group.updatedAt = this.nextGroupVersion(group);

        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const id = this.idFactory();
            const task: DownloadFileTask = {
                id,
                groupId,
                fileName,
                status: 'pending',
                abortController,
                totalSize: validBytes(totalSize),
                downloadedSize: 0,
                rawExecute: execute,
                settleCancelled: resolve,
                onPendingCancelled,
                execute: async () => {
                    task.status = 'active';
                    task.phase = 'downloading';
                    task.startTime = Date.now();
                    task.speedSampler = new DownloadSpeedSampler(task.startTime);
                    group.updatedAt = this.nextGroupVersion(group, task.startTime);
                    this.active.push(task);
                    this.notifyGroup(group);
                    try {
                        const outcome = await execute(abortController.signal, task.id);
                        if (abortController.signal.aborted) {
                            task.status = 'cancelled';
                            group.cancelled += 1;
                        } else if (outcome?.status === 'failed') {
                            task.status = 'failed';
                            task.error = outcome.error;
                            group.failed += 1;
                        } else {
                            task.status = 'success';
                            group.completed += 1;
                        }
                        resolve();
                    } catch (error) {
                        task.status = abortController.signal.aborted ? 'cancelled' : 'failed';
                        task.error = error instanceof Error ? error.message : String(error);
                        if (task.status === 'cancelled') {
                            group.cancelled += 1;
                            resolve();
                        } else {
                            group.failed += 1;
                            reject(error);
                        }
                    } finally {
                        const waiter = this.uploadWaiters.get(task.id);
                        if (waiter) { this.uploadWaiters.delete(task.id); waiter.cleanup(); waiter.reject(abortController.signal.reason || new Error('下载任务已结束')); }
                        task.endTime = Date.now();
                        group.updatedAt = this.nextGroupVersion(group, task.endTime);
                        const activeIndex = this.active.findIndex(item => item.id === task.id);
                        if (activeIndex >= 0) this.active.splice(activeIndex, 1);
                        if (group.stateOverride === 'pausing' && !this.hasActiveGroupTask(group.id)) {
                            group.stateOverride = this.queue.some(item => item.groupId === group.id)
                                || group.completed + group.failed + group.cancelled < group.expectedTotal ? 'paused' : undefined;
                        } else if (group.stateOverride === 'cancelling' && !this.hasActiveGroupTask(group.id)) {
                            group.stateOverride = 'cancelled';
                        }
                        this.pushHistory(task);
                        if (['completed', 'cancelled'].includes(this.snapshotGroup(group).state)) this.scopeResumeOverrides.delete(group.id);
                        this.notifyGroup(group);
                        this.processNext();
                        this.processUploads();
                    }
                },
            };
            this.queue.push(task);
            if (queuedBehindPausedGroup && group.stateOverride === 'pausing' && !this.hasActiveGroupTask(group.id)) {
                group.stateOverride = 'paused';
            }
            this.notifyGroup(group);
            this.processNext();
        });
    }

    getDebugGroupCount(): number {
        return this.groups.size;
    }

    getSnapshot(scope: DownloadTaskScope = {}): DownloadTaskQueueSnapshot {
        const groups = Array.from(this.groups.values())
            .filter(group => !group.hidden)
            .filter(group => this.matchesScope(group, scope))
            .map(group => this.snapshotGroup(group))
            .filter(group => !['completed', 'cancelled'].includes(group.state))
            .sort((a, b) => a.createdAt - b.createdAt);
        const counts = this.countsForScope(scope);
        const status = this.getScopeStatus(scope);
        return {
            groups,
            active: counts.active,
            pending: counts.pending,
            paused: status.paused,
            pauseReason: status.reason,
            userPaused: status.userPaused,
            systemPause: status.systemPause,
        };
    }

    getGroupForControl(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupSnapshot | undefined {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status !== 'ok' || !access.record) return undefined;
        return this.snapshotGroup(access.record);
    }

    /** Includes terminal state while the final persistence notification is in flight. */
    getGroupSnapshot(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupSnapshot | undefined {
        const exact = this.groups.get(groupId);
        const matches = (exact ? [exact] : this.findGroupMatches(groupId))
            .filter(group => includeHidden || !group.hidden)
            .filter(group => this.matchesScope(group, scope));
        return matches.length === 1 ? this.snapshotGroup(matches[0]) : undefined;
    }

    getGroup(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupSnapshot | undefined {
        const matches = Array.from(this.groups.values())
            .filter(group => includeHidden || !group.hidden)
            .filter(group => this.matchesScope(group, scope))
            .filter(group => group.id === groupId || group.id.startsWith(groupId))
            .map(group => this.snapshotGroup(group))
            .filter(group => !['completed', 'cancelled'].includes(group.state));
        return matches.length === 1 ? matches[0] : undefined;
    }

    getScopeStatus(scope: DownloadTaskScope = {}): DownloadTaskScopeStatus {
        const groups = Array.from(this.groups.values())
            .filter(group => this.matchesScope(group, scope))
            .map(group => this.snapshotGroup(group))
            .filter(group => !['completed', 'cancelled'].includes(group.state));
        const systemBlocked = Boolean(this.systemPause);
        const pausing = groups.some(group => group.state === 'pausing');
        const groupPaused = groups.some(group => {
            const record = this.groups.get(group.id)!;
            return record.stateOverride === 'paused' || record.stateOverride === 'pausing'
                || Boolean(this.getScopedUserPause(record));
        });
        const scopedPause = this.getScopedUserPause(scope);
        const paused = systemBlocked || this.userPaused || Boolean(scopedPause) || groupPaused;
        return {
            paused,
            pausing,
            systemBlocked,
            userPaused: this.userPaused || Boolean(scopedPause) || groupPaused,
            reason: systemBlocked
                ? this.systemPause?.reason || '系统保护暂停'
                : this.userPaused || scopedPause || groupPaused
                    ? scopedPause?.reason || '用户已暂停任务'
                    : pausing
                        ? '正在完成当前文件，随后暂停'
                        : undefined,
            systemPause: this.systemPause,
        };
    }

    getStats() {
        return {
            ...this.counts(),
            maxConcurrent: this.maxConcurrent,
            maxInFlight: this.maxInFlight,
            maxStagedBytes: this.maxStagedBytes,
            reservedBytes: this.active.reduce((sum, task) => sum + this.reservationSize(task), 0),
            paused: this.isGloballyPaused(),
            userPaused: this.userPaused,
            diskPressurePaused: Boolean(this.systemPause),
            diskPressureReason: this.systemPause?.reason,
            systemPause: this.systemPause,
            pauseReason: this.getPauseReason(),
        };
    }

    getDetailedStatus() {
        const stats = this.getStats();
        return {
            active: this.active.map(task => this.publicTask(task)),
            pending: this.queue.map(task => this.publicTask(task)),
            history: this.history.map(task => this.publicTask(task)),
            maxConcurrent: stats.maxConcurrent,
            paused: stats.paused,
            diskPressurePaused: stats.diskPressurePaused,
            systemPause: stats.systemPause,
            pauseReason: stats.pauseReason,
        };
    }

    getMaxConcurrent(): number {
        return this.maxConcurrent;
    }

    setMaxConcurrent(value: number): number {
        this.maxConcurrent = Math.max(1, Math.floor(value || 1));
        this.processNext();
        return this.maxConcurrent;
    }

    setRetrying(taskId: string, attempt: number, maxAttempts: number, reason: string): void {
        const task = this.active.find(item => item.id === taskId);
        if (!task) return;
        task.phase = 'retrying';
        task.retryAttempt = attempt;
        task.maxAttempts = maxAttempts;
        task.reason = reason;
        this.stopProgress(taskId);
    }

    async beginUpload(taskId: string): Promise<void> {
        const task = this.active.find(item => item.id === taskId);
        if (!task) throw new Error('下载任务已结束');
        task.abortController.signal.throwIfAborted();
        if (task.phase === 'uploading') return;
        task.phase = 'waiting_upload';
        task.reason = '源文件已下载，等待保存';
        this.stopProgress(taskId);
        const pending = new Promise<void>((resolve, reject) => {
            const abort = () => {
                this.uploadWaiters.delete(taskId);
                reject(task.abortController.signal.reason);
            };
            task.abortController.signal.addEventListener('abort', abort, { once: true });
            this.uploadWaiters.set(taskId, { resolve, reject, cleanup: () => task.abortController.signal.removeEventListener('abort', abort) });
        });
        this.processUploads();
        this.processNext();
        await pending;
    }

    waitForStorage(taskId: string, reason: string): void {
        const task = this.active.find(item => item.id === taskId);
        if (!task) return;
        task.phase = 'waiting_storage';
        task.reason = reason;
        this.stopProgress(taskId);
        this.processUploads();
    }

    private processUploads(): void {
        let available = this.uploadConcurrency - this.active.filter(task => task.phase === 'uploading').length;
        for (const [id, waiter] of this.uploadWaiters) {
            if (available <= 0) break;
            const task = this.active.find(item => item.id === id);
            if (!task || task.abortController.signal.aborted) continue;
            this.uploadWaiters.delete(id);
            waiter.cleanup();
            task.phase = 'uploading';
            task.reason = undefined;
            const group = this.groups.get(task.groupId);
            if (group) { group.updatedAt = this.nextGroupVersion(group); this.notifyGroup(group); }
            available--;
            waiter.resolve();
        }
    }

    resetProgress(taskId: string): void {
        const task = this.active.find(item => item.id === taskId);
        if (!task) return;
        task.phase = 'downloading';
        task.reason = undefined;
        task.speedSampler?.reset(Date.now());
        this.updateProgress(taskId, 0, task.totalSize);
    }

    stopProgress(taskId: string): void {
        const task = this.active.find(item => item.id === taskId);
        if (!task) return;
        task.speedSampler?.reset(Date.now(), task.downloadedSize || 0);
        const group = this.groups.get(task.groupId);
        if (group) { group.updatedAt = this.nextGroupVersion(group); this.notifyGroup(group); }
    }

    updateProgress(taskId: string, downloaded: number, total?: number): void {
        const task = this.active.find(item => item.id === taskId);
        if (task) {
            task.downloadedSize = validBytes(downloaded);
            if (task.phase === 'retrying') { task.phase = 'downloading'; task.reason = undefined; }
            task.speedSampler?.update(task.downloadedSize, Date.now());
            if (validBytes(total) > 0) task.totalSize = total;
            const group = this.groups.get(task.groupId);
            if (group) {
                group.updatedAt = this.nextGroupVersion(group);
                this.notifyGroup(group);
            }
        }
    }

    prioritizeGroup(groupId: string, scope: DownloadTaskScope = {}): DownloadTaskGroupControlResult {
        const access = this.resolveGroupForControl(groupId, scope);
        if (access.status !== 'ok' || !access.record) return this.controlResult(access.status, access.record);
        const group = access.record;
        if (group.stateOverride === 'paused' || group.stateOverride === 'pausing' || group.stateOverride === 'cancelling') {
            return this.controlResult('blocked', group);
        }
        const selected = this.queue.filter(task => task.groupId === group.id);
        if (selected.length === 0) return this.controlResult('terminal', group);
        this.queue = [...selected, ...this.queue.filter(task => task.groupId !== group.id)];
        group.updatedAt = this.nextGroupVersion(group);
        this.notifyGroup(group);
        this.processNext();
        return this.controlResult('ok', group);
    }

    pauseGroup(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupControlResult {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status !== 'ok' || !access.record) return this.controlResult(access.status, access.record);
        const group = access.record;
        if (group.stateOverride === 'cancelling') return this.controlResult('terminal', group);
        if (group.stateOverride === 'paused' || group.stateOverride === 'pausing') {
            return this.controlResult('ok', group);
        }
        group.stateOverride = this.hasActiveGroupTask(group.id) ? 'pausing' : 'paused';
        group.updatedAt = this.nextGroupVersion(group);
        this.notifyGroup(group);
        this.processNext();
        return this.controlResult('ok', group);
    }

    resumeGroup(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupControlResult {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status !== 'ok' || !access.record) return this.controlResult(access.status, access.record);
        const group = access.record;
        if (this.systemPause) return this.controlResult('blocked', group);
        if (group.stateOverride === 'cancelling' || group.stateOverride === 'cancelled') {
            return this.controlResult('terminal', group);
        }
        if (this.userPaused) return this.controlResult('blocked', group);
        if (this.getScopedUserPause(group)) this.scopeResumeOverrides.add(group.id);
        group.stateOverride = undefined;
        group.updatedAt = this.nextGroupVersion(group);
        this.notifyGroup(group);
        this.processNext();
        return this.controlResult('ok', group);
    }

    cancelGroup(groupId: string, scope: DownloadTaskScope = {}, reason = '用户取消任务', includeHidden = false): DownloadTaskGroupControlResult {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status === 'terminal' && access.record?.stateOverride === 'cancelled') {
            return this.controlResult('ok', access.record);
        }
        if (access.status !== 'ok' || !access.record) return this.controlResult(access.status, access.record);
        const group = access.record;
        if (group.stateOverride === 'cancelled' || group.stateOverride === 'cancelling') {
            return this.controlResult('ok', group);
        }
        if (this.snapshotGroup(group).state === 'completed') return this.controlResult('terminal', group);

        this.cancelGroupTasks(group, reason);
        this.processNext();
        return this.controlResult('ok', group);
    }

    private cancelGroupTasks(group: DownloadTaskGroupRecord, reason: string): void {
        group.stateOverride = 'cancelling';
        this.scopeResumeOverrides.delete(group.id);
        const removed: DownloadFileTask[] = [];
        this.queue = this.queue.filter(task => {
            if (task.groupId !== group.id) return true;
            removed.push(task);
            return false;
        });
        for (const task of removed) this.settlePendingCancellation(task, reason, false);
        for (const task of this.active) {
            if (task.groupId === group.id && !task.abortController.signal.aborted) {
                task.error = reason;
                task.abortController.abort(reason);
            }
        }
        if (!this.hasActiveGroupTask(group.id)) group.stateOverride = 'cancelled';
        group.updatedAt = this.nextGroupVersion(group);
        this.notifyGroup(group);
    }

    pauseAll(reason = '用户已暂停下载队列', origin: DownloadTaskPauseOrigin = 'user'): { active: number; pending: number; total: number } {
        if (origin === 'system') {
            return this.pauseForDiskPressure(reason);
        } else {
            this.userPaused = true;
        }
        this.notifyGroups();
        return this.counts();
    }

    resumeAll(origin: DownloadTaskPauseOrigin = 'user'): { active: number; pending: number; total: number } {
        if (origin === 'system') {
            return this.resumeFromDiskPressure();
        } else {
            this.userPaused = false;
        }
        this.notifyGroups();
        this.processNext();
        return this.counts();
    }

    pause(): { active: number; pending: number; total: number } {
        return this.pauseAll('用户已暂停下载队列', 'user');
    }

    resume(): { active: number; pending: number; total: number } {
        return this.resumeAll('user');
    }

    pauseScope(scope: DownloadTaskScope, reason = '用户已暂停当前聊天下载队列'): { active: number; pending: number; total: number } {
        this.scopedUserPauses.set(this.scopePauseKey(scope), { scope: { ...scope }, reason });
        for (const group of this.groups.values()) {
            if (this.matchesScope(group, scope)) this.scopeResumeOverrides.delete(group.id);
        }
        this.notifyGroups(scope);
        return this.countsForScope(scope);
    }

    resumeScope(scope: DownloadTaskScope): { active: number; pending: number; total: number } {
        this.scopedUserPauses.delete(this.scopePauseKey(scope));
        this.notifyGroups(scope);
        this.processNext();
        return this.countsForScope(scope);
    }

    acquireDiskPressureBlocker(blockerId: string, reason: string, recheckMs?: number): { active: number; pending: number; total: number } {
        const id = blockerId.trim();
        if (!id) throw new Error('磁盘保护 blocker ID 不能为空');
        this.diskPressureBlockers.set(id, { reason, recheckMs });
        this.refreshDiskPressurePause();
        this.notifyGroups();
        return this.counts();
    }

    releaseDiskPressureBlocker(blockerId: string): { active: number; pending: number; total: number } {
        this.diskPressureBlockers.delete(blockerId.trim());
        this.refreshDiskPressurePause();
        this.notifyGroups();
        if (!this.systemPause) this.processNext();
        return this.counts();
    }

    pauseForDiskPressure(reason: string, recheckMs?: number): { active: number; pending: number; total: number } {
        return this.acquireDiskPressureBlocker('__legacy_disk_pressure__', reason, recheckMs);
    }

    resumeFromDiskPressure(): { active: number; pending: number; total: number } {
        return this.releaseDiskPressureBlocker('__legacy_disk_pressure__');
    }

    cancel(selector?: string, reason = '用户取消任务'): { active: number; pending: number; total: number } {
        const normalized = selector?.trim();
        if (!normalized || normalized === 'all') return this.forceStopAll(reason);

        const group = this.findGroup(normalized);
        if (group) {
            const active = this.active.filter(task => task.groupId === group.id).length;
            const pending = this.queue.filter(task => task.groupId === group.id).length;
            this.cancelGroup(group.id, {}, reason);
            return { active, pending, total: active + pending };
        }

        const pendingIndex = this.queue.findIndex((task, index) => (
            task.id.startsWith(normalized)
            || String(index + 1) === normalized
            || task.fileName.includes(normalized)
        ));
        let pending = 0;
        if (pendingIndex >= 0) {
            const [task] = this.queue.splice(pendingIndex, 1);
            this.settlePendingCancellation(task, reason);
            pending = 1;
        }
        let active = 0;
        for (const task of this.active) {
            if (task.id.startsWith(normalized) || task.fileName.includes(normalized)) {
                task.error = reason;
                if (!task.abortController.signal.aborted) task.abortController.abort(reason);
                active += 1;
            }
        }
        this.processNext();
        return { active, pending, total: active + pending };
    }

    async retryFailed(limit = 10, scope: DownloadTaskScope = {}, groupId?: string): Promise<{ retried: number }> {
        const failed = this.history
            .filter(task => task.status === 'failed')
            .filter(task => !groupId || task.groupId === groupId)
            .filter(task => {
                const group = this.groups.get(task.groupId);
                return Boolean(group && this.matchesScope(group, scope));
            })
            .slice(0, Math.max(1, limit));
        let retried = 0;
        for (const task of failed) {
            const group = this.groups.get(task.groupId);
            if (!group || group.stateOverride === 'cancelled' || group.stateOverride === 'cancelling') continue;
            group.failed = Math.max(0, group.failed - 1);
            group.settledBytes = Math.max(0, (group.settledBytes || 0) - validBytes(task.downloadedSize));
            group.settledTotalBytes = Math.max(0, (group.settledTotalBytes || 0) - validBytes(task.totalSize));
            group.settledKnown = Math.max(0, (group.settledKnown || 0) - (validBytes(task.totalSize) > 0 ? 1 : 0));
            this.removeHistoryTask(task);
            void this.add(task.groupId, task.fileName, task.rawExecute, task.totalSize || 0, task.onPendingCancelled)
                .catch(error => console.error(`[Queue] retry failed: ${task.fileName}`, error));
            retried += 1;
        }
        return { retried };
    }

    cancelScope(scope: DownloadTaskScope, reason = '用户取消当前聊天任务'): { active: number; pending: number; total: number } {
        const counts = this.countsForScope(scope);
        for (const group of this.groups.values()) {
            if (!this.matchesScope(group, scope)) continue;
            if (['completed', 'cancelled', 'cancelling'].includes(this.snapshotGroup(group).state)) continue;
            this.cancelGroupTasks(group, reason);
        }
        this.scopedUserPauses.delete(this.scopePauseKey(scope));
        this.processNext();
        return counts;
    }

    forceStopAll(reason = '用户强制停止'): { active: number; pending: number; total: number } {
        const counts = this.counts();
        for (const group of this.groups.values()) {
            if (['completed', 'cancelled', 'cancelling'].includes(this.snapshotGroup(group).state)) continue;
            this.cancelGroupTasks(group, reason);
        }
        return counts;
    }

    private reservationSize(task: DownloadFileTask): number {
        return Math.max(validBytes(task.totalSize), validBytes(task.downloadedSize), 64 * 1024 ** 2);
    }

    private processNext(): void {
        while (!this.isGloballyPaused() && this.active.length < this.maxInFlight && this.active.filter(task => task.phase === 'downloading' || task.phase === 'retrying').length < this.maxConcurrent && this.queue.length > 0) {
            const runnableIndex = this.queue.findIndex(task => {
                const group = this.groups.get(task.groupId);
                return group
                    && !this.isGroupScopePaused(group)
                    && !['pausing', 'paused', 'cancelling', 'cancelled'].includes(group.stateOverride || '');
            });
            if (runnableIndex < 0) break;
            const next = this.queue[runnableIndex];
            const reserved = this.active.reduce((sum, task) => sum + this.reservationSize(task), 0);
            // A file larger than the staging budget may run alone, never beside another file.
            if (this.active.length > 0 && reserved + this.reservationSize(next) > this.maxStagedBytes) break;
            const [task] = this.queue.splice(runnableIndex, 1);
            if (!task) break;
            void task.execute();
        }
    }

    private settlePendingCancellation(task: DownloadFileTask, reason: string, notify = true): void {
        task.status = 'cancelled';
        task.error = reason;
        task.endTime = Date.now();
        const group = this.groups.get(task.groupId);
        if (group) {
            group.cancelled += 1;
            group.updatedAt = this.nextGroupVersion(group, task.endTime);
        }
        this.pushHistory(task);
        if (group && notify) this.notifyGroup(group);
        task.settleCancelled?.();
        if (task.onPendingCancelled) {
            void Promise.resolve().then(() => task.onPendingCancelled!()).catch(error => {
                console.error(`[Queue] pending cancellation callback failed: ${task.fileName}`, error);
            });
        }
    }

    private removeHistoryTask(task: DownloadFileTask): void {
        const index = this.history.indexOf(task);
        if (index >= 0) this.history.splice(index, 1);
    }

    private pruneTerminalGroups(): void {
        if (this.groups.size <= 500) return;
        const terminal = Array.from(this.groups.values())
            .filter(group => ['completed', 'cancelled'].includes(this.snapshotGroup(group).state))
            .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const group of terminal.slice(0, Math.max(0, this.groups.size - 500))) {
            this.groups.delete(group.id);
            this.scopeResumeOverrides.delete(group.id);
        }
    }

    private pushHistory(task: DownloadFileTask): void {
        this.removeHistoryTask(task);
        const group = this.groups.get(task.groupId);
        if (group) {
            group.settledBytes = (group.settledBytes || 0) + (task.status === 'success' ? Math.max(validBytes(task.downloadedSize), validBytes(task.totalSize)) : validBytes(task.downloadedSize));
            group.settledTotalBytes = (group.settledTotalBytes || 0) + validBytes(task.totalSize);
            group.settledKnown = (group.settledKnown || 0) + (validBytes(task.totalSize) > 0 ? 1 : 0);
        }
        this.history.unshift(task);
        if (this.history.length > this.maxHistory) this.history.splice(this.maxHistory);
        this.pruneTerminalGroups();
    }

    private publicTask(task: DownloadFileTask): DownloadFileTaskSnapshot {
        return {
            id: task.id,
            groupId: task.groupId,
            fileName: task.fileName,
            status: task.status,
            error: task.error,
            phase: task.phase,
            retryAttempt: task.retryAttempt,
            maxAttempts: task.maxAttempts,
            reason: task.reason,
            startTime: task.startTime,
            endTime: task.endTime,
            totalSize: task.totalSize,
            downloadedSize: task.downloadedSize,
        };
    }

    private countGroupFiles(groupId: string): number {
        return this.queue.filter(task => task.groupId === groupId).length
            + this.active.filter(task => task.groupId === groupId).length;
    }

    private hasActiveGroupTask(groupId: string): boolean {
        return this.active.some(task => task.groupId === groupId);
    }

    private counts(): { active: number; pending: number; total: number } {
        return {
            active: this.active.length,
            pending: this.queue.length,
            total: this.active.length + this.queue.length,
        };
    }

    private countsForScope(scope: DownloadTaskScope): { active: number; pending: number; total: number } {
        const groupIds = new Set(Array.from(this.groups.values())
            .filter(group => this.matchesScope(group, scope))
            .map(group => group.id));
        const active = this.active.filter(task => groupIds.has(task.groupId)).length;
        const pending = this.queue.filter(task => groupIds.has(task.groupId)).length;
        return { active, pending, total: active + pending };
    }

    private refreshDiskPressurePause(): void {
        if (this.diskPressureBlockers.size === 0) {
            this.systemPause = undefined;
            return;
        }
        const blockers = Array.from(this.diskPressureBlockers.values());
        const latest = blockers[blockers.length - 1];
        const recheckValues = blockers
            .map(blocker => blocker.recheckMs)
            .filter((value): value is number => typeof value === 'number' && value > 0);
        this.systemPause = {
            kind: 'disk_pressure',
            reason: latest?.reason || '磁盘空间保护',
            autoResume: true,
            recheckMs: recheckValues.length > 0 ? Math.min(...recheckValues) : undefined,
            blockerCount: blockers.length,
        };
    }

    private isGloballyPaused(): boolean {
        return this.userPaused || Boolean(this.systemPause);
    }

    private getPauseReason(): string | undefined {
        if (this.systemPause) return this.systemPause.reason;
        if (this.userPaused) return '用户已暂停下载队列';
        return undefined;
    }

    private notifyGroup(group: DownloadTaskGroupRecord): void {
        if (!this.onGroupChanged) return;
        const snapshot = this.snapshotGroup(group);
        const previous = this.notificationChains.get(group.id) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => this.onGroupChanged!(snapshot))
            .catch(error => {
                console.error(`[Queue] persist group failed: ${group.id}`, error);
            })
            .finally(() => {
                if (this.notificationChains.get(group.id) === next) this.notificationChains.delete(group.id);
            });
        this.notificationChains.set(group.id, next);
    }

    private notifyGroups(scope: DownloadTaskScope = {}): void {
        for (const group of this.groups.values()) {
            if (this.matchesScope(group, scope)) {
                group.updatedAt = this.nextGroupVersion(group);
                this.notifyGroup(group);
            }
        }
    }

    private snapshotGroup(group: DownloadTaskGroupRecord): DownloadTaskGroupSnapshot {
        const activeTasks = this.active.filter(task => task.groupId === group.id);
        const pendingTasks = this.queue.filter(task => task.groupId === group.id);
        const settled = group.completed + group.failed + group.cancelled;
        const total = Math.max(group.expectedTotal, activeTasks.length + pendingTasks.length + settled);
        let state: DownloadTaskGroupState;
        if (group.stateOverride === 'cancelled' || group.stateOverride === 'cancelling') {
            state = group.stateOverride;
        } else if (settled > 0 && settled >= total && activeTasks.length === 0 && pendingTasks.length === 0) {
            state = 'completed';
        } else if (group.stateOverride) {
            state = group.stateOverride;
        } else if (activeTasks.length > 0) {
            state = 'running';
        } else if (pendingTasks.length > 0 || settled < total) {
            state = 'waiting';
        } else {
            state = settled > 0 ? 'completed' : 'waiting';
        }
        const scopedPause = this.getScopedUserPause(group);
        const downloading = activeTasks.filter(task => task.phase === 'downloading');
        const retrying = activeTasks.filter(task => task.phase === 'retrying');
        const uploading = activeTasks.filter(task => task.phase === 'uploading');
        const waitingUpload = activeTasks.filter(task => task.phase === 'waiting_upload' || task.phase === 'waiting_storage');
        if ((this.isGloballyPaused() || scopedPause) && ['running', 'waiting', 'pausing'].includes(state)) {
            state = 'paused';
        }
        return {
            id: group.id,
            kind: group.kind,
            title: group.title,
            chatId: group.chatId,
            userId: group.userId,
            source: group.source,
            targetProvider: group.targetProvider,
            targetAccountId: group.targetAccountId,
            targetFolder: group.targetFolder,
            expectedTotal: group.expectedTotal,
            hidden: group.hidden,
            state,
            total,
            active: activeTasks.length,
            downloading: downloading.length,
            uploading: uploading.length,
            waitingUpload: waitingUpload.length,
            retrying: retrying.length,
            stage: downloading.length + retrying.length > 0 ? 'downloading' : uploading.length + waitingUpload.length > 0 ? 'uploading' : 'waiting',
            pending: pendingTasks.length,
            completed: group.completed,
            failed: group.failed,
            cancelled: group.cancelled,
            completedBytes: (group.settledBytes || 0) + activeTasks.reduce((sum, task) => sum + validBytes(task.downloadedSize), 0),
            totalBytes: (group.settledTotalBytes || 0) + [...activeTasks, ...pendingTasks].reduce((sum, task) => sum + validBytes(task.totalSize), 0),
            byteProgressKnown: total > 0 && (group.settledKnown || 0) + [...activeTasks, ...pendingTasks].filter(task => validBytes(task.totalSize) > 0).length === total,
            speedBytesPerSecond: ['running', 'pausing'].includes(state) ? activeTasks.reduce((sum, task) => sum + (task.speedSampler?.speed(Date.now()) || 0), 0) : 0,
            speedUpdatedAt: Date.now(),
            currentFileName: downloading[0]?.fileName || retrying[0]?.fileName || activeTasks[0]?.fileName,
            reason: !['completed', 'cancelled'].includes(state)
                ? this.systemPause?.reason || activeTasks.find(task => task.reason)?.reason || (state === 'paused' && (scopedPause || this.userPaused)
                    ? scopedPause?.reason || '用户已暂停下载队列' : undefined)
                : undefined,
            systemPause: ['completed', 'cancelled'].includes(state) ? undefined : this.systemPause,
            createdAt: group.createdAt,
            updatedAt: group.updatedAt,
        };
    }

    private findGroup(selector: string): DownloadTaskGroupRecord | undefined {
        const exact = this.groups.get(selector);
        if (exact) return exact;
        const matches = this.findGroupMatches(selector);
        return matches.length === 1 ? matches[0] : undefined;
    }

    private findGroupMatches(selector: string): DownloadTaskGroupRecord[] {
        return Array.from(this.groups.values()).filter(group => group.id.startsWith(selector));
    }

    private matchesScope(group: DownloadTaskGroupRecord, scope: DownloadTaskScope): boolean {
        if (scope.chatId !== undefined && group.chatId !== scope.chatId) return false;
        if (scope.userId !== undefined && group.userId !== scope.userId) return false;
        return true;
    }

    private scopePauseKey(scope: DownloadTaskScope): string {
        if (scope.chatId === undefined && scope.userId === undefined) {
            throw new Error('作用域暂停必须包含 chatId 或 userId');
        }
        return `${scope.userId ?? '*'}:${scope.chatId ?? '*'}`;
    }

    private getScopedUserPause(scope: DownloadTaskScope): { scope: DownloadTaskScope; reason: string } | undefined {
        if ('id' in scope && this.scopeResumeOverrides.has(String(scope.id))) return undefined;
        for (const pause of this.scopedUserPauses.values()) {
            const chatMatches = pause.scope.chatId === undefined || pause.scope.chatId === scope.chatId;
            const userMatches = pause.scope.userId === undefined || pause.scope.userId === scope.userId;
            if (chatMatches && userMatches) return pause;
        }
        return undefined;
    }

    private isGroupScopePaused(group: DownloadTaskGroupRecord): boolean {
        return Boolean(this.getScopedUserPause(group));
    }

    private resolveGroupForControl(
        groupId: string,
        scope: DownloadTaskScope,
        includeHidden = false,
    ): { status: DownloadTaskGroupControlStatus; record?: DownloadTaskGroupRecord } {
        const exact = this.groups.get(groupId);
        const visibleCandidates = (exact ? [exact] : this.findGroupMatches(groupId))
            .filter(group => includeHidden || !group.hidden);
        if (visibleCandidates.length === 0) return { status: 'not_found' };
        const candidates = visibleCandidates.filter(group => this.matchesScope(group, scope));
        if (candidates.length === 0) return { status: 'forbidden', record: visibleCandidates.length === 1 ? visibleCandidates[0] : undefined };
        if (candidates.length !== 1) return { status: 'not_found' };
        const group = candidates[0];
        const state = this.snapshotGroup(group).state;
        if (state === 'completed' || state === 'cancelled') {
            return { status: 'terminal', record: group };
        }
        return { status: 'ok', record: group };
    }

    private controlResult(
        status: DownloadTaskGroupControlStatus,
        group?: DownloadTaskGroupRecord,
    ): DownloadTaskGroupControlResult {
        return {
            status,
            group: group ? this.snapshotGroup(group) : undefined,
            active: group ? this.active.filter(task => task.groupId === group.id).length : 0,
            pending: group ? this.queue.filter(task => task.groupId === group.id).length : 0,
        };
    }
}
