export async function withTelegramOperationDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let resolveDeadline: (value: T | PromiseLike<T>) => void;
    let rejectDeadline: (reason?: unknown) => void;
    const deadline = new Promise<T>((resolve, reject) => {
        resolveDeadline = resolve;
        rejectDeadline = reject;
        timer = setTimeout(() => {
            if (!settled) reject(new Error(message));
        }, timeoutMs);
        timer.unref?.();
    });
    operation.then(value => resolveDeadline(value), error => rejectDeadline(error)).catch(() => undefined);
    try {
        return await deadline;
    } finally {
        settled = true;
        if (timer) clearTimeout(timer);
    }
}
