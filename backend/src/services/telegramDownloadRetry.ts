const TRANSIENT_TRANSPORT_CODES: Record<string, true> = {
    USER_CONNECTION_LOST: true, USER_REQUEST_TIMEOUT: true, USER_CONNECT_TIMEOUT: true, USER_CONNECT_FAILED: true,
    USER_SOCKET_CLOSED: true, USER_SOCKET_CONNECT_TIMEOUT: true, USER_DISCONNECTED: true, USER_DC_UNAVAILABLE: true,
    USER_RESOURCE_CIRCUIT_OPEN: true, TELEGRAM_WORKER_EXITED: true, TELEGRAM_WORKER_UNAVAILABLE: true,
    TELEGRAM_WORKER_REQUEST_TIMEOUT: true, ECONNRESET: true, ECONNREFUSED: true, ECONNABORTED: true, EPIPE: true,
    ETIMEDOUT: true, ENETUNREACH: true, EHOSTUNREACH: true, EAI_AGAIN: true, EADDRNOTAVAIL: true, EMFILE: true, ENFILE: true, ENOBUFS: true,
    RPC_CALL_FAIL: true, RPC_MCGET_FAIL: true, TIMEOUT: true, Timeout: true, connection_lost: true,
};
const TRANSIENT_RPC_ERRORS: Record<string, true> = { INTERNAL: true, RPC_CALL_FAIL: true, RPC_MCGET_FAIL: true, TIMEOUT: true, Timeout: true };

/** Only download transport/Telegram server failures are eligible for replay. */
export function isTelegramTransientDownloadError(error: unknown): boolean {
    if (typeof error === 'string') return Object.hasOwn(TRANSIENT_TRANSPORT_CODES, error);
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; errorMessage?: unknown; message?: unknown; name?: unknown };
    // Never infer retryability from an HTTP status, an arbitrary nested cause, or
    // text mentioning a timeout: storage/provider and media errors stay terminal.
    if (value.name === 'AbortError' || value.name === 'CanceledError') return false;
    if (typeof value.errorMessage === 'string' && value.errorMessage) {
        return Object.hasOwn(TRANSIENT_RPC_ERRORS, value.errorMessage);
    }
    if (typeof value.code === 'string') return Object.hasOwn(TRANSIENT_TRANSPORT_CODES, value.code);
    return typeof value.message === 'string' && Object.hasOwn(TRANSIENT_TRANSPORT_CODES, value.message);
}
