import { useTranslation } from 'react-i18next';
import type { TelegramBotPublicConfig } from '../../services/apiTypes';
import { botErrorKey, botFaultPresentation } from '../../services/botFaultPresentation';
import { formatDateTime, formatNumber } from '../../i18n/format';

export function BotFaultDetails({ config }: { config: TelegramBotPublicConfig }) {
    const { t, i18n } = useTranslation();
    const fault = botFaultPresentation(config);
    const language = i18n.resolvedLanguage || i18n.language;
    const errorText = (error: string) => {
        const key = botErrorKey(error);
        return key ? t(`settings.botConnection.faultErrors.${key}`) : error;
    };
    const dates = [['lastFailureAt', config.lastFailureAt], ['lastConnectedAt', config.lastConnectedAt],
        ['lastRecoveredAt', config.lastRecoveredAt]] as const;
    return <div className="space-y-1 text-[12px] leading-5 [overflow-wrap:anywhere]" data-testid="bot-fault-details">
        {dates.map(([key, value]) => value && <p key={key}>{t(`settings.botConnection.${key}`)}: {formatDateTime(value, language)}</p>)}
        {config.reconnectCount != null && <p>{t('settings.botConnection.reconnectCount')}: {formatNumber(config.reconnectCount, language)}</p>}
        {fault.startupError && <p className="text-destructive">{t('settings.botConnection.startupError')}: {errorText(fault.startupError)}</p>}
        {fault.cleanupError && <p className="text-destructive">{t('settings.botConnection.cleanupError')}: {errorText(fault.cleanupError)}</p>}
        {fault.action && <p className="text-muted-foreground">{t(`settings.botConnection.${fault.action}`)}</p>}
    </div>;
}
