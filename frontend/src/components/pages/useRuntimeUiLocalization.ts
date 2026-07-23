import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeChineseText } from '../../locales/runtimeUiLocalization';

export function useRuntimeUiLocalization(ref: React.RefObject<HTMLElement | null>): void {
    const { i18n } = useTranslation();
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        const apply = () => localizeChineseText(root, i18n.resolvedLanguage || i18n.language);
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
        return () => observer.disconnect();
    }, [i18n.language, i18n.resolvedLanguage, ref]);
}
