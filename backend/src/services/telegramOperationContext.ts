import { AsyncLocalStorage } from 'node:async_hooks';

const operations = new AsyncLocalStorage<AbortSignal>();
export function telegramOperationSignal() { return operations.getStore(); }
export function withTelegramOperationSignal<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return signal ? operations.run(signal, operation) : operation();
}
