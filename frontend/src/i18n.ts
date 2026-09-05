import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, FALLBACK_LOCALE, localeRegistry, normalizeLocale, persistLocale, readInitialLocale } from './i18n/registry';

const resources = Object.fromEntries(await Promise.all(localeRegistry.map(async locale => [locale.code, { translation: await locale.load() }])));

await i18n.use(initReactI18next).init({
  resources,
  lng: readInitialLocale(),
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: localeRegistry.map(locale => locale.code),
  nonExplicitSupportedLngs: false,
  load: 'currentOnly',
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
});

const syncDocumentLanguage = (language?: string) => {
  if (typeof document === 'undefined') return;
  const locale = localeRegistry.find(item => item.code === normalizeLocale(language)) ?? localeRegistry.find(item => item.code === DEFAULT_LOCALE)!;
  document.documentElement.lang = locale.code;
  document.documentElement.dir = locale.direction;
};
syncDocumentLanguage(i18n.resolvedLanguage || i18n.language);
i18n.on('languageChanged', language => {
  const locale = normalizeLocale(language);
  syncDocumentLanguage(locale);
  persistLocale(locale);
});

export default i18n;
