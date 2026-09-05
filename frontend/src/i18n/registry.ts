export type AppLocale = 'zh-CN' | 'en' | 'ru';

export interface LocaleDefinition {
  code: AppLocale;
  nativeName: string;
  aliases: readonly string[];
  direction: 'ltr' | 'rtl';
  intlLocale: string;
  load: () => Promise<Record<string, unknown>>;
}

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';
export const FALLBACK_LOCALE: AppLocale = 'zh-CN';
export const LOCALE_STORAGE_KEY = 'tg-vault.locale';

export const localeRegistry: readonly LocaleDefinition[] = [
  {
    code: 'zh-CN',
    nativeName: '简体中文',
    aliases: ['zh', 'zh-cn', 'zh-sg', 'zh-hans'],
    direction: 'ltr',
    intlLocale: 'zh-CN',
    load: async () => (await import('../locales/zh-CN/index.ts')).default,
  },
  {
    code: 'en',
    nativeName: 'English',
    aliases: ['en', 'en-us', 'en-gb', 'en-au', 'en-ca'],
    direction: 'ltr',
    intlLocale: 'en-US',
    load: async () => (await import('../locales/en/index.ts')).default,
  },
  {
    code: 'ru',
    nativeName: 'Русский',
    aliases: ['ru', 'ru-ru'],
    direction: 'ltr',
    intlLocale: 'ru-RU',
    load: async () => (await import('../locales/ru/index.ts')).default,
  },
] as const;

const normalizedAliases = new Map<string, AppLocale>();
for (const locale of localeRegistry) {
  normalizedAliases.set(locale.code.toLowerCase(), locale.code);
  for (const alias of locale.aliases) normalizedAliases.set(alias.toLowerCase(), locale.code);
}

const matchLocale = (value?: string | null): AppLocale | null => {
  if (!value) return null;
  const candidate = value.trim().replaceAll('_', '-').toLowerCase();
  if (candidate === 'zh-hant' || candidate.startsWith('zh-hant-') || candidate === 'zh-tw' || candidate === 'zh-hk' || candidate === 'zh-mo') return null;
  const exact = normalizedAliases.get(candidate);
  if (exact) return exact;
  // Match regional browser preferences through their primary language alias.
  return candidate.includes('-') ? normalizedAliases.get(candidate.split('-')[0]) ?? null : null;
};

export const normalizeLocale = (value?: string | null): AppLocale => matchLocale(value) ?? FALLBACK_LOCALE;

export const resolveInitialLocale = (explicitChoice?: string | null, browserLanguages: readonly string[] = []): AppLocale => {
  const explicit = matchLocale(explicitChoice);
  if (explicit) return explicit;
  for (const browserLanguage of browserLanguages) {
    const supported = matchLocale(browserLanguage);
    if (supported) return supported;
  }
  return DEFAULT_LOCALE;
};

export const localeDefinition = (locale?: string | null) => localeRegistry.find(item => item.code === normalizeLocale(locale)) ?? localeRegistry[0];

export const readInitialLocale = (): AppLocale => {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  let explicit: string | null = null;
  try {
    explicit = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!explicit) {
      const legacy = window.localStorage.getItem('i18nextLng');
      // Only migrate an old explicit Chinese value. Earlier automatic detector
      // caches are intentionally not treated as consent to change existing users.
      if (legacy === 'zh' || legacy === 'zh-CN') {
        explicit = 'zh-CN';
        window.localStorage.setItem(LOCALE_STORAGE_KEY, explicit);
      }
    }
  } catch { /* storage can be disabled */ }
  return resolveInitialLocale(explicit, explicit ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]));
};

export const persistLocale = (locale: AppLocale) => {
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* memory-only preference */ }
};
