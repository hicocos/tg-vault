import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileApi, type TelegramBotPublicConfig } from '../../services/api';
import { BOT_STATUS_EVENT, botFaultPresentation } from '../../services/botFaultPresentation';
import { appRouteHref, routeForSettings } from '../../services/appRoute';

// One GET per 30 seconds while visible; Settings owns its own polling. No toast or mutation.
export function BotOfflineNotice({ settingsPolling, onOpenSettings }: {
    settingsPolling: boolean; onOpenSettings: () => void;
}) {
    const { t } = useTranslation();
    const [config, setConfig] = useState<TelegramBotPublicConfig | null>(null);
    const [stale, setStale] = useState(false);
    useEffect(() => {
        const receive = (event: Event) => {
            setConfig((event as CustomEvent<TelegramBotPublicConfig>).detail);
            setStale(false);
        };
        window.addEventListener(BOT_STATUS_EVENT, receive);
        return () => window.removeEventListener(BOT_STATUS_EVENT, receive);
    }, []);
    useEffect(() => {
        if (settingsPolling) return;
        let disposed = false;
        let timer: number | undefined;
        let request: AbortController | null = null;
        let nextPollAt = 0;
        const poll = async () => {
            if (disposed || document.visibilityState !== 'visible' || request) return;
            if (Date.now() < nextPollAt) {
                timer = window.setTimeout(() => void poll(), nextPollAt - Date.now());
                return;
            }
            nextPollAt = Date.now() + 30_000;
            const controller = new AbortController();
            request = controller;
            const timeout = window.setTimeout(() => controller.abort(), 15_000);
            try {
                const data = await fileApi.getTelegramBotConfig(controller.signal);
                if (!disposed && !controller.signal.aborted) { setConfig(data); setStale(false); }
            } catch {
                if (!disposed) setStale(true);
            } finally {
                window.clearTimeout(timeout);
                if (request === controller) request = null;
                if (!disposed && document.visibilityState === 'visible')
                    timer = window.setTimeout(() => void poll(), Math.max(0, nextPollAt - Date.now()));
            }
        };
        const visibilityChanged = () => {
            window.clearTimeout(timer);
            if (document.visibilityState !== 'visible') request?.abort();
            else void poll();
        };
        void poll();
        document.addEventListener('visibilitychange', visibilityChanged);
        return () => {
            disposed = true;
            window.clearTimeout(timer);
            request?.abort();
            document.removeEventListener('visibilitychange', visibilityChanged);
        };
    }, [settingsPolling]);
    const fault = config && botFaultPresentation(config);
    if (!fault?.offline) return null;
    return <aside className="mb-4 rounded-[7px] border border-border bg-muted/30 px-4 py-3 text-sm" role="status" data-testid="bot-offline-notice">
        <p className="font-medium">{t(`settings.botConnection.${fault.quarantined ? 'quarantined' : 'offlineNotice'}`)}</p>
        <p className="mt-1 text-muted-foreground">{t(`settings.botConnection.${fault.quarantined ? 'cleanupBlocked' : 'offlineHelp'}`)}</p>
        {stale && <p className="mt-1 text-muted-foreground">{t('settings.botConnection.refreshFailed')}</p>}
        <a className="mt-2 inline-block text-primary underline" href={appRouteHref(routeForSettings('telegram'))}
            onClick={event => {
                if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    event.preventDefault(); onOpenSettings();
                }
            }}>{t('settings.botConnection.openSettings')}</a>
    </aside>;
}
