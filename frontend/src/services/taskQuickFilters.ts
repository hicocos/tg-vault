export type TaskQuickFilter = 'all' | 'active' | 'attention' | 'completed';

const FILTER_STATUSES: Record<Exclude<TaskQuickFilter, 'all'>, readonly string[]> = {
    active: ['scheduled', 'pending', 'running', 'pausing', 'paused', 'waiting', 'awaiting_selection', 'completing'],
    attention: ['failed', 'interrupted', 'retry_required'],
    completed: ['completed'],
};

export interface TaskScopeInput {
    sourceType: string;
    status: string;
    dismissible?: boolean;
    target?: { accountId?: string | null };
    id?: string;
}

export interface TaskScopeFilters {
    source?: string;
    status?: string;
    accountId?: string | null;
    quickFilter?: TaskQuickFilter;
}

export function taskQuickFilter(filter: TaskQuickFilter): (task: { status: string }) => boolean {
    if (filter === 'all') return () => true;
    const statuses = FILTER_STATUSES[filter];
    return task => statuses.includes(task.status);
}

export function taskScopeFilter(filters: TaskScopeFilters): (task: TaskScopeInput) => boolean {
    const quickPredicate = taskQuickFilter(filters.quickFilter ?? 'all');
    return task => (!filters.source || task.sourceType === filters.source)
        && (!filters.status || task.status === filters.status)
        && (!filters.accountId || task.target?.accountId === filters.accountId)
        && quickPredicate(task);
}

export function scopeTasks<T extends TaskScopeInput>(tasks: T[], filters: TaskScopeFilters): T[] {
    return tasks.filter(taskScopeFilter(filters));
}

export function dismissibleTaskSnapshot<T extends TaskScopeInput>(tasks: T[], filters: TaskScopeFilters): T[] {
    return scopeTasks(tasks, filters).filter(task => task.dismissible);
}

export function pruneSelectedTaskKeys<T extends TaskScopeInput>(
    selected: string[],
    tasks: T[],
    filters: TaskScopeFilters,
    keyForTask: (task: T) => string,
): string[] {
    const allowed = new Set(dismissibleTaskSnapshot(tasks, filters).map(keyForTask));
    return selected.filter(key => allowed.has(key));
}

export function summarizeTaskStatuses(tasks: Array<{ status: string }>) {
    return {
        active: tasks.filter(taskQuickFilter('active')).length,
        attention: tasks.filter(taskQuickFilter('attention')).length,
        completed: tasks.filter(taskQuickFilter('completed')).length,
    };
}
