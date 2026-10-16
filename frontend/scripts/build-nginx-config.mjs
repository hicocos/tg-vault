import { readFileSync, writeFileSync } from 'node:fs';

const api = process.env.VITE_API_URL?.trim() || '';
let origin = '';
// Match the frontend's relative-path fallback for the default development URL.
if (api && api !== 'http://localhost:51947') {
    const url = new URL(api);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) {
        throw new Error('VITE_API_URL must be an HTTP(S) API origin');
    }
    origin = url.origin;
}

const template = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
writeFileSync('/tmp/default.conf.template', template.replaceAll('__API_ORIGIN__', origin));
