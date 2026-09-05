import { ApiActionError } from './apiActionError';
import { tr } from '../i18n/runtime';

export function parseXhrError(status: number, body: string): Error {
    if (status === 401 || status === 428) return new ApiActionError({ kind: 'unauthorized', status, message: tr('errors.services.generic.sessionExpired') });
  let parsed: { error?: unknown; message?: unknown; code?: unknown } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    return new ApiActionError({
      kind: 'unavailable',
      status,
      message: status >= 500 ? tr('errors.services.generic.serverStatus', { status }) : tr('errors.services.upload.statusFailed', { status }),
    });
  }
  const detail = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : null;
  return new ApiActionError({
    kind: status >= 500 ? 'unavailable' : 'generic',
    status,
    code: typeof parsed.code === 'string' ? parsed.code : undefined,
    message: detail || (status >= 500 ? tr('errors.services.generic.serverStatus', { status }) : tr('errors.services.upload.statusFailed', { status })),
  });
}
