/** Keep a bounded window full without waiting for its slowest item. */
export async function runRollingDownloadWindow<T>(
    windowSize: number,
    load: (limit: number) => Promise<readonly T[]>,
    execute: (item: T) => Promise<void>,
): Promise<void> {
    const active = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;
    let exhausted = false;
    try {
        while (!exhausted || active.size > 0) {
            if (failure) break;
            if (!exhausted && active.size < windowSize) {
                const items = await load(windowSize - active.size);
                if (failure) break;
                exhausted = items.length === 0;
                for (const item of items) {
                    const operation = Promise.resolve().then(() => execute(item)).catch(error => {
                        failure ??= { error };
                    }).finally(() => active.delete(operation));
                    active.add(operation);
                }
            }
            if (active.size > 0) await Promise.race(active);
        }
    } catch (error) {
        failure ??= { error };
    } finally {
        await Promise.all(active);
    }
    if (failure) throw failure.error;
}
