import type { McpContext } from './contracts.js';
import type { TaskActionBlocks } from '../services/taskControl.js';
export type { TaskAction, TaskActionBlocks } from '../services/taskControl.js';

export const taskActions = ['pause', 'resume', 'retry', 'cancel'] as const;

export function taskActionAvailability(context: McpContext, stateBlocks: TaskActionBlocks) {
    const blockedActions = { ...stateBlocks };
    if (!context.client.permissions.includes('tasks:control')) {
        for (const action of taskActions) blockedActions[action] = 'FORBIDDEN';
    }
    return { allowedActions: taskActions.filter(action => !blockedActions[action]), blockedActions };
}
