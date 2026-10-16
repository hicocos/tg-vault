import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const child = spawn(process.execPath, ['dist/index.js'], { stdio: 'inherit', detached: true });
let stopping = false;
let exited = false;
const started = Date.now();
let failures = 0;
let forceTimer;
function terminate(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    try { process.kill(-child.pid, signal); } catch { /* already exited */ }
    forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 30_000);
}
process.once('SIGTERM', () => terminate());
process.once('SIGINT', () => terminate('SIGINT'));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code, signal) => {
    exited = true;
    clearTimeout(forceTimer);
    // A failed backend must also release its descendant download workers.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no remaining workers */ }
    process.exit(code ?? (signal ? 1 : 0));
});
while (!exited && !stopping) {
    await delay(10_000);
    if (stopping || exited) break;
    if (Date.now() - started < 120_000) continue;
    try {
        const response = await fetch(`http://127.0.0.1:${process.env.PORT || '51947'}/livez`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error('LIVENESS_FAILED');
        failures = 0;
    } catch {
        if (++failures < 3) continue;
        console.error(JSON.stringify({ event: 'backend_watchdog_unresponsive', failures }));
        terminate();
    }
}
