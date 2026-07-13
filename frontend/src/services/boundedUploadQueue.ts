export type UploadStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';

interface PendingTask<TInput, TResult> {
    id: string;
    input: TInput;
    resolve: (value: TResult) => void;
    reject: (reason: unknown) => void;
}

interface StoredTask<TInput, TResult> extends PendingTask<TInput, TResult> {
    state: 'pending' | 'active' | 'settled';
    controller?: AbortController;
}

export class BoundedUploadQueue<TInput, TResult> {
    private readonly tasks = new Map<string, StoredTask<TInput, TResult>>();
    private readonly pending: StoredTask<TInput, TResult>[] = [];
    private active = 0;

    private readonly concurrency: number;
    private readonly worker: (input: TInput, signal: AbortSignal) => Promise<TResult>;

    constructor(concurrency: number, worker: (input: TInput, signal: AbortSignal) => Promise<TResult>) {
        this.concurrency = concurrency;
        this.worker = worker;
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be positive');
    }

    enqueue(id: string, input: TInput): Promise<TResult> {
        if (this.tasks.has(id)) throw new Error(`duplicate upload id: ${id}`);
        return this.add(id, input);
    }

    retry(id: string): Promise<TResult> {
        const prior = this.tasks.get(id);
        if (!prior || prior.state !== 'settled') throw new Error('upload is not retryable');
        return this.add(id, prior.input, true);
    }

    cancel(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task || task.state === 'settled') return false;
        if (task.state === 'active') {
            task.controller?.abort();
        } else {
            const index = this.pending.indexOf(task);
            if (index >= 0) this.pending.splice(index, 1);
            task.state = 'settled';
            task.reject(new DOMException('Upload cancelled', 'AbortError'));
        }
        return true;
    }

    cancelAll(): void {
        for (const id of this.tasks.keys()) this.cancel(id);
    }

    private add(id: string, input: TInput, replacing = false): Promise<TResult> {
        if (replacing) this.tasks.delete(id);
        return new Promise<TResult>((resolve, reject) => {
            const task: StoredTask<TInput, TResult> = { id, input, resolve, reject, state: 'pending' };
            this.tasks.set(id, task);
            this.pending.push(task);
            this.pump();
        });
    }

    private pump(): void {
        while (this.active < this.concurrency && this.pending.length > 0) {
            const task = this.pending.shift()!;
            const controller = new AbortController();
            task.controller = controller;
            task.state = 'active';
            this.active += 1;
            void this.worker(task.input, controller.signal)
                .then(task.resolve, task.reject)
                .finally(() => {
                    task.state = 'settled';
                    this.active -= 1;
                    this.pump();
                });
        }
    }
}

export interface UploadSummary {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    active: number;
    settled: boolean;
}

export function summarizeUploads(items: Array<{ status: UploadStatus }>): UploadSummary {
    const completed = items.filter(item => item.status === 'completed').length;
    const failed = items.filter(item => item.status === 'error').length;
    const cancelled = items.filter(item => item.status === 'cancelled').length;
    const active = items.length - completed - failed - cancelled;
    return {
        total: items.length,
        completed,
        failed,
        cancelled,
        active,
        settled: items.length > 0 && active === 0,
    };
}
