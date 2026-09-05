import i18n from '../i18n';
export type TranslationParams = Record<string, unknown>;
export const tr = (key: string, params?: TranslationParams): string => String(i18n.t(key, params as never));
