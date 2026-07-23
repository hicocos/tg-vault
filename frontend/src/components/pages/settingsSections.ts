export const SETTINGS_SECTIONS = [
    { id: 'general', labelKey: 'settings.nav.general' },
    { id: 'security', labelKey: 'settings.nav.security' },
    { id: 'telegram', labelKey: 'settings.nav.telegram' },
    { id: 'storage', labelKey: 'settings.nav.storage' },
    { id: 'maintenance', labelKey: 'settings.nav.maintenance' },
] as const;

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

export function normalizeSettingsSection(value: string | null): SettingsSectionId {
    return SETTINGS_SECTIONS.some(section => section.id === value) ? value as SettingsSectionId : 'general';
}
