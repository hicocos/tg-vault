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

export interface DownloadTaskGroupSnapshot extends DownloadTaskGroupInput {
    state: DownloadTaskGroupState;
    total: number;
    active: number;
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
    idFactory?: () => string;
}

export type DownloadFileTaskState = 'pending' | 'active' | 'success' | 'failed' | 'cancelled';

export interface DownloadTaskExecutionResult {
    status: 'success' | 'failed';
    error?: string;
}

interface DownloadTaskGroupRecord extends DownloadTaskGroupInput {
    expectedTotal: number;
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
    startTime?: number;
    endTime?: number;
    totalSize?: number;
    downloadedSize?: number;
}

interface DownloadFileTask extends DownloadFileTaskSnapshot {
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
    private readonly idFactory: () => string;
    private userPaused = false;
    private readonly scopedUserPauses = new Map<string, { scope: DownloadTaskScope; reason: string }>();
    private systemPause?: DownloadTaskSystemPause;
    private readonly diskPressureBlockers = new Map<string, { reason: string; recheckMs?: number }>();

    constructor(options: DownloadTaskQueueOptions = {}) {
        this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent || 1));
        this.idFactory = options.idFactory || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    }

    ensureGroup(input: DownloadTaskGroupInput): DownloadTaskGroupSnapshot {
        if (this.userPaused && this.active.length === 0 && this.queue.length === 0) this.userPaused = false;
        const id = input.id.trim();
        if (!id) throw new Error('下载任务组 ID 不能为空');
        const now = Date.now();
        const existing = this.groups.get(id);
        if (existing && ['completed', 'cancelled'].includes(this.snapshotGroup(existing).state)) {
            this.groups.delete(id);
        }
        const current = this.groups.get(id);
        if (current) {
            current.kind = input.kind;
            current.title = input.title || current.title;
            current.chatId = input.chatId || current.chatId;
            current.userId = input.userId ?? current.userId;
            current.source = input.source ?? current.source;
            current.targetFolder = input.targetFolder ?? current.targetFolder;
            current.hidden = input.hidden ?? current.hidden;
            current.expectedTotal = Math.max(current.expectedTotal, Math.max(0, input.expectedTotal || 0));
            current.updatedAt = now;
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
            updatedAt: now,
        };
        this.groups.set(id, record);
        return this.snapshotGroup(record);
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
        group.updatedAt = Date.now();

        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const id = this.idFactory();
            const task: DownloadFileTask = {
                id,
                groupId,
                fileName,
                status: 'pending',
                abortController,
                totalSize,
                downloadedSize: 0,
                rawExecute: execute,
                settleCancelled: resolve,
                onPendingCancelled,
                execute: async () => {
                    task.status = 'active';
                    task.startTime = Date.now();
                    group.updatedAt = task.startTime;
                    this.active.push(task);
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
                        task.endTime = Date.now();
                        group.updatedAt = task.endTime;
                        const activeIndex = this.active.findIndex(item => item.id === task.id);
                        if (activeIndex >= 0) this.active.splice(activeIndex, 1);
                        if (group.stateOverride === 'pausing' && !this.hasActiveGroupTask(group.id)) {
                            group.stateOverride = this.queue.some(item => item.groupId === group.id) ? 'paused' : undefined;
                        } else if (group.stateOverride === 'cancelling' && !this.hasActiveGroupTask(group.id)) {
                            group.stateOverride = 'cancelled';
                        }
                        this.pushHistory(task);
                        this.processNext();
                    }
                },
            };
            this.queue.push(task);
            if (queuedBehindPausedGroup && group.stateOverride === 'pausing' && !this.hasActiveGroupTask(group.id)) {
                group.stateOverride = 'paused';
            }
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
            .map(group => this.snapshotForDisplay(group))
            .filter(group => !['completed', 'cancelled'].includes(group.state))
            .sort((a, b) => a.createdAt - b.createdAt);
        return {
            groups,
            active: this.active.length,
            pending: this.queue.length,
            paused: this.isGloballyPaused(),
            pauseReason: this.getPauseReason(),
            userPaused: this.userPaused,
            systemPause: this.systemPause,
        };
    }

    getGroupForControl(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupSnapshot | undefined {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status !== 'ok' || !access.record) return undefined;
        return this.snapshotGroup(access.record);
    }

    getGroup(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupSnapshot | undefined {
        const matches = Array.from(this.groups.values())
            .filter(group => includeHidden || !group.hidden)
            .filter(group => this.matchesScope(group, scope))
            .filter(group => group.id === groupId || group.id.startsWith(groupId))
            .map(group => this.snapshotForDisplay(group))
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
        const groupPaused = groups.some(group => group.state === 'paused');
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

    updateProgress(taskId: string, downloaded: number, total?: number): void {
        const task = this.active.find(item => item.id === taskId);
        if (task) {
            task.downloadedSize = Math.max(0, downloaded);
            if (total !== undefined && total > 0) task.totalSize = total;
            const group = this.groups.get(task.groupId);
            if (group) group.updatedAt = Date.now();
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
        group.updatedAt = Date.now();
        this.processNext();
        return this.controlResult('ok', group);
    }

    pauseGroup(groupId: string, scope: DownloadTaskScope = {}, includeHidden = false): DownloadTaskGroupControlResult {
        const access = this.resolveGroupForControl(groupId, scope, includeHidden);
        if (access.status !== 'ok' || !access.record) return this.controlResult(access.status, access.record);
        const group = access.record;
        if (group.stateOverride === 'paused' || group.stateOverride === 'pausing') {
            return this.controlResult('ok', group);
        }
        group.stateOverride = this.hasActiveGroupTask(group.id) ? 'pausing' : 'paused';
        group.updatedAt = Date.now();
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
        group.stateOverride = undefined;
        group.updatedAt = Date.now();
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

        group.stateOverride = 'cancelling';
        group.updatedAt = Date.now();
        const removed: DownloadFileTask[] = [];
        this.queue = this.queue.filter(task => {
            if (task.groupId !== group.id) return true;
            removed.push(task);
            return false;
        });
        for (const task of removed) this.settlePendingCancellation(task, reason);
        for (const task of this.active) {
            if (task.groupId === group.id && !task.abortController.signal.aborted) {
                task.error = reason;
                task.abortController.abort(reason);
            }
        }
        if (!this.hasActiveGroupTask(group.id)) group.stateOverride = 'cancelled';
        this.processNext();
        return this.controlResult('ok', group);
    }

    pauseAll(reason = '用户已暂停下载队列', origin: DownloadTaskPauseOrigin = 'user'): { active: number; pending: number; total: number } {
        if (origin === 'system') {
            return this.pauseForDiskPressure(reason);
        } else {
            this.userPaused = true;
        }
        return this.counts();
    }

    resumeAll(origin: DownloadTaskPauseOrigin = 'user'): { active: number; pending: number; total: number } {
        if (origin === 'system') {
            return this.resumeFromDiskPressure();
        } else {
            this.userPaused = false;
        }
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
        return this.countsForScope(scope);
    }

    resumeScope(scope: DownloadTaskScope): { active: number; pending: number; total: number } {
        this.scopedUserPauses.delete(this.scopePauseKey(scope));
        this.processNext();
        return this.countsForScope(scope);
    }

    acquireDiskPressureBlocker(blockerId: string, reason: string, recheckMs?: number): { active: number; pending: number; total: number } {
        const id = blockerId.trim();
        if (!id) throw new Error('磁盘保护 blocker ID 不能为空');
        this.diskPressureBlockers.set(id, { reason, recheckMs });
        this.refreshDiskPressurePause();
        return this.counts();
    }

    releaseDiskPressureBlocker(blockerId: string): { active: number; pending: number; total: number } {
        this.diskPressureBlockers.delete(blockerId.trim());
        this.refreshDiskPressurePause();
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
            this.removeHistoryTask(task);
            void this.add(task.groupId, task.fileName, task.rawExecute, task.totalSize || 0, task.onPendingCancelled)
                .catch(error => console.error(`[Queue] retry failed: ${task.fileName}`, error));
            retried += 1;
        }
        return { retried };
    }

    cancelScope(scope: DownloadTaskScope, reason = '用户取消当前聊天任务'): { active: number; pending: number; total: number } {
        let active = 0;
        let pending = 0;
        const groupIds = Array.from(this.groups.values())
            .filter(group => this.matchesScope(group, scope))
            .map(group => group.id);
        for (const groupId of groupIds) {
            const result = this.cancelGroup(groupId, scope, reason, true);
            if (result.status !== 'ok') continue;
            active += result.active;
            pending += result.pending;
        }
        this.scopedUserPauses.delete(this.scopePauseKey(scope));
        this.processNext();
        return { active, pending, total: active + pending };
    }

    forceStopAll(reason = '用户强制停止'): { active: number; pending: number; total: number } {
        const active = this.active.length;
        const pending = this.queue.length;
        const touchedGroups = new Set([...this.active, ...this.queue].map(task => task.groupId));
        const removed = this.queue.splice(0);
        for (const task of removed) this.settlePendingCancellation(task, reason);
        for (const task of this.active) {
            task.error = reason;
            if (!task.abortController.signal.aborted) task.abortController.abort(reason);
        }
        for (const groupId of touchedGroups) {
            const group = this.groups.get(groupId);
            if (!group) continue;
            group.stateOverride = this.hasActiveGroupTask(groupId) ? 'cancelling' : 'cancelled';
            group.updatedAt = Date.now();
        }
        return { active, pending, total: active + pending };
    }

    private processNext(): void {
        while (!this.isGloballyPaused() && this.active.length < this.maxConcurrent && this.queue.length > 0) {
            const runnableIndex = this.queue.findIndex(task => {
                const group = this.groups.get(task.groupId);
                return group
                    && !this.isGroupScopePaused(group)
                    && !['pausing', 'paused', 'cancelling', 'cancelled'].includes(group.stateOverride || '');
            });
            if (runnableIndex < 0) break;
            const [task] = this.queue.splice(runnableIndex, 1);
            if (!task) break;
            void task.execute();
        }
    }

    private settlePendingCancellation(task: DownloadFileTask, reason: string): void {
        task.status = 'cancelled';
        task.error = reason;
        task.endTime = Date.now();
        const group = this.groups.get(task.groupId);
        if (group) {
            group.cancelled += 1;
            group.updatedAt = task.endTime;
        }
        task.settleCancelled?.();
        if (task.onPendingCancelled) {
            void Promise.resolve(task.onPendingCancelled()).catch(error => {
                console.error(`[Queue] pending cancellation callback failed: ${task.fileName}`, error);
            });
        }
        this.pushHistory(task);
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
        }
    }

    private pushHistory(task: DownloadFileTask): void {
        this.removeHistoryTask(task);
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

    private snapshotForDisplay(group: DownloadTaskGroupRecord): DownloadTaskGroupSnapshot {
        const snapshot = this.snapshotGroup(group);
        const scopedPause = this.getScopedUserPause(group);
        if ((this.isGloballyPaused() || scopedPause) && snapshot.state === 'waiting') snapshot.state = 'paused';
        snapshot.reason = this.systemPause
            ? this.systemPause.reason
            : scopedPause?.reason || (this.userPaused ? '用户已暂停下载队列' : snapshot.reason);
        snapshot.systemPause = this.systemPause;
        return snapshot;
    }

    private snapshotGroup(group: DownloadTaskGroupRecord): DownloadTaskGroupSnapshot {
        const activeTasks = this.active.filter(task => task.groupId === group.id);
        const pendingTasks = this.queue.filter(task => task.groupId === group.id);
        const settled = group.completed + group.failed + group.cancelled;
        const total = Math.max(group.expectedTotal, activeTasks.length + pendingTasks.length + settled);
        let state: DownloadTaskGroupState;
        if (group.stateOverride) {
            state = group.stateOverride;
        } else if (activeTasks.length > 0) {
            state = 'running';
        } else if (pendingTasks.length > 0 || settled < total) {
            state = 'waiting';
        } else {
            state = 'completed';
        }
        const scopedPause = this.getScopedUserPause(group);
        if ((this.isGloballyPaused() || scopedPause) && state === 'waiting' && pendingTasks.length > 0) {
            state = 'paused';
        }
        return {
            id: group.id,
            kind: group.kind,
            title: group.title,
            chatId: group.chatId,
            userId: group.userId,
            source: group.source,
            targetFolder: group.targetFolder,
            expectedTotal: group.expectedTotal,
            hidden: group.hidden,
            state,
            total,
            active: activeTasks.length,
            pending: pendingTasks.length,
            completed: group.completed,
            failed: group.failed,
            cancelled: group.cancelled,
            currentFileName: activeTasks[0]?.fileName,
            reason: this.systemPause
                ? this.systemPause.reason
                : state === 'paused' && (scopedPause || this.userPaused)
                    ? scopedPause?.reason || '用户已暂停下载队列'
                    : undefined,
            systemPause: this.systemPause,
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
            if (!this.history.some(task => task.groupId === group.id && task.status === 'failed')) this.groups.delete(group.id);
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
