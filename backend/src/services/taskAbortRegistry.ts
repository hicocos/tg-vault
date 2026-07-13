interface TaskAbortEntry {
    controller: AbortController;
    references: number;
}

export class TaskAbortRegistry {
    private readonly controllers = new Map<string, TaskAbortEntry>();

    acquire(taskId: string): AbortController {
        const current = this.controllers.get(taskId);
        if (current && !current.controller.signal.aborted) {
            current.references += 1;
            return current.controller;
        }
        const controller = new AbortController();
        this.controllers.set(taskId, { controller, references: 1 });
        return controller;
    }

    get(taskId: string): AbortController | undefined {
        return this.controllers.get(taskId)?.controller;
    }

    cancel(taskId: string, reason = '任务已取消'): boolean {
        const entry = this.controllers.get(taskId);
        if (!entry || entry.controller.signal.aborted) return false;
        entry.controller.abort(reason);
        this.controllers.delete(taskId);
        return true;
    }

    release(taskId: string, controller: AbortController): void {
        const entry = this.controllers.get(taskId);
        if (!entry || entry.controller !== controller) return;
        entry.references -= 1;
        if (entry.references <= 0) this.controllers.delete(taskId);
    }
}
