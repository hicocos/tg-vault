import { query } from '../db/index.js';

export interface TaskCenterIdentity {
    sourceType: string;
    id: string;
    status: string;
    updatedAt: string;
}

export interface TaskCenterDismissal {
    sourceType: string;
    taskId: string;
    taskUpdatedAt: Date | string;
}

const DISMISSIBLE_STATES = new Set(['completed', 'failed', 'cancelled', 'disabled', 'interrupted', 'retry_required']);

export function isTaskDismissible(task: Pick<TaskCenterIdentity, 'status'>): boolean {
    return DISMISSIBLE_STATES.has(task.status);
}

function version(value: Date | string): number {
    return new Date(value).getTime();
}

export function filterDismissedTasks<T extends TaskCenterIdentity>(tasks: T[], dismissals: TaskCenterDismissal[]): T[] {
    const hidden = new Set(dismissals.map(item => `${item.sourceType}:${item.taskId}:${version(item.taskUpdatedAt)}`));
    return tasks.filter(task => !hidden.has(`${task.sourceType}:${task.id}:${version(task.updatedAt)}`));
}

export async function loadTaskCenterDismissals(): Promise<TaskCenterDismissal[]> {
    const result = await query('SELECT source_type, task_id, task_updated_at FROM task_center_dismissals');
    return result.rows.map(row => ({ sourceType: String(row.source_type), taskId: String(row.task_id), taskUpdatedAt: row.task_updated_at }));
}

export async function saveTaskCenterDismissals(items: TaskCenterIdentity[]): Promise<void> {
    for (const item of items) {
        await query(
            `INSERT INTO task_center_dismissals (source_type, task_id, task_updated_at, dismissed_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (source_type, task_id) DO UPDATE
             SET task_updated_at = EXCLUDED.task_updated_at, dismissed_at = NOW()`,
            [item.sourceType, item.id, item.updatedAt],
        );
    }
}
