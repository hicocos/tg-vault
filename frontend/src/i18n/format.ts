import { localeDefinition, normalizeLocale, type AppLocale } from './registry';

const intl = (locale?: string | null) => localeDefinition(locale).intlLocale;

export const formatInteger = (value: number, locale?: AppLocale | string) => new Intl.NumberFormat(intl(locale), { maximumFractionDigits: 0 }).format(value);
export const formatNumber = (value: number, locale?: AppLocale | string, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intl(locale), options).format(value);
export const formatDateTime = (value: string | number | Date, locale?: AppLocale | string, options: Intl.DateTimeFormatOptions = {}) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intl(locale), { dateStyle: 'medium', timeStyle: 'short', hour12: false, ...options }).format(date);
};
export const formatDate = (value: string | number | Date, locale?: AppLocale | string, options: Intl.DateTimeFormatOptions = {}) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intl(locale), { dateStyle: 'medium', ...options }).format(date);
};
export const formatBytes = (bytes?: number | null, locale?: AppLocale | string) => {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const absolute = Math.abs(bytes);
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;
  if (absolute < 1000) return `${formatNumber(bytes, locale, { maximumFractionDigits: 0 })} B`;
  const exponent = Math.min(Math.floor(Math.log(absolute) / Math.log(1000)), units.length - 1);
  const value = bytes / (1000 ** exponent);
  return `${formatNumber(value, locale, { maximumFractionDigits: 1 })} ${units[exponent]}`;
};
export const formatDuration = (seconds?: number | null, locale?: AppLocale | string) => {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const language = normalizeLocale(locale);
  const rounded = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  const units = language === 'en'
    ? [[hours, hours === 1 ? 'hour' : 'hours'], [minutes, minutes === 1 ? 'minute' : 'minutes'], [rest, rest === 1 ? 'second' : 'seconds']] as const
    : language === 'ru'
      ? [[hours, 'ч'], [minutes, 'мин'], [rest, 'с']] as const
      : [[hours, '小时'], [minutes, '分钟'], [rest, '秒']] as const;
  const parts = units.filter(([value]) => value > 0).slice(0, 2).map(([value, unit]) => `${formatInteger(value, language)} ${unit}`);
  return parts.join(language === 'zh-CN' ? '' : ' ') || (language === 'en' ? '0 seconds' : language === 'ru' ? '0 с' : '0 秒');
};
