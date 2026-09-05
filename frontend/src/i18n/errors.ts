import type { AppLocale } from './registry';
import { formatDuration } from './format';

export interface ErrorPayload { code?: string; params?: Record<string, unknown>; message?: string; requestId?: string }
export const messages: Record<string, Record<AppLocale, string>> = {
  UNAUTHORIZED: { 'zh-CN': '登录会话已失效，请重新登录', en: 'Your session has expired. Sign in again.', ru: 'Сессия истекла. Войдите снова.' },
  RATE_LIMITED: { 'zh-CN': '请求过于频繁，请稍后重试', en: 'Too many requests. Try again later.', ru: 'Слишком много запросов. Повторите попытку позже.' },
  MEDIA_SOURCE_MISSING: { 'zh-CN': '源文件已删除或已移入回收站，无法继续操作', en: 'The source file was deleted or moved to trash.', ru: 'Исходный файл удалён или перемещён в корзину.' },
  SERVICE_UNAVAILABLE: { 'zh-CN': '服务暂时不可用，请稍后重试', en: 'The service is temporarily unavailable. Try again later.', ru: 'Сервис временно недоступен. Повторите попытку позже.' },
  VALIDATION_ERROR: { 'zh-CN': '提交的信息无效，请检查后重试', en: 'The submitted information is invalid. Check it and try again.', ru: 'Отправленные данные недействительны. Проверьте их и повторите попытку.' },
  CONFLICT: { 'zh-CN': '操作与当前状态冲突，请刷新后重试', en: 'The action conflicts with the current state. Refresh and try again.', ru: 'Действие конфликтует с текущим состоянием. Обновите страницу и повторите попытку.' },
  UNKNOWN: { 'zh-CN': '操作失败，请稍后重试', en: 'The action failed. Try again later.', ru: 'Не удалось выполнить действие. Повторите попытку позже.' },
};
export const localizedApiError = (error: ErrorPayload, locale: AppLocale): string => {
  const code = error.code && messages[error.code] ? error.code : 'UNKNOWN';
  let message = messages[code][locale];
  const retryAfter = Number(error.params?.retryAfter ?? error.params?.retry_after);
  if (code === 'RATE_LIMITED' && Number.isFinite(retryAfter) && retryAfter > 0) {
    message = locale === 'en'
      ? `Too many requests. Try again in ${formatDuration(retryAfter, locale)}.`
      : locale === 'ru'
        ? `Слишком много запросов. Повторите попытку через ${formatDuration(retryAfter, locale)}.`
        : `请求过于频繁，请在 ${formatDuration(retryAfter, locale)}后重试。`;
  }
  const requestIdLabel = locale === 'en' ? 'Request ID' : locale === 'ru' ? 'ID запроса' : '请求 ID';
  return error.requestId ? `${message} (${requestIdLabel}: ${error.requestId})` : message;
};
