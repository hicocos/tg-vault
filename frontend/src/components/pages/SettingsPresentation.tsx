import { useId, type ElementType, type ReactNode } from 'react';
import { ChevronRight } from '../ui/icons';
import { cn } from '../../lib/utils';
import './settings.css';

/** Presentation only: settings state, drafts and effects stay in their owner. */
export function SettingsSection({ title, children, sectionId, className, actions }: {
    title: string;
    children: ReactNode;
    sectionId?: string;
    className?: string;
    actions?: ReactNode;
}) {
    const headingId = useId();
    return (
        <section className={cn('tv-panel settings-section', className)} data-settings-section={sectionId} aria-labelledby={headingId}>
            <header className={cn('settings-section__header', actions && 'settings-section__header--actions')}><h3 id={headingId}>{title}</h3>{actions}</header>
            <div className="settings-section__body">{children}</div>
        </section>
    );
}

export function SettingsRow({ icon: Icon, label, value, action, onClick, description, stackActionOnMobile = true, className }: {
    icon: ElementType;
    label: string;
    value?: string;
    action?: ReactNode;
    onClick?: () => void;
    description?: string;
    stackActionOnMobile?: boolean;
    className?: string;
}) {
    const labelId = useId();
    return (
        <div
            className={cn('settings-row', !description && 'settings-row--compact', !stackActionOnMobile && 'settings-row--inline', onClick && 'settings-row--clickable', className)}
            onClick={onClick}
            role={onClick ? 'button' : 'group'}
            aria-labelledby={labelId}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={onClick ? event => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onClick();
                }
            } : undefined}
        >
            <div className="settings-row__copy">
                <span className="settings-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span>
                <div className="min-w-0">
                    <span id={labelId} className="settings-row__label">{label}</span>
                    {description && <p className="settings-help">{description}</p>}
                </div>
            </div>
            <div className="settings-row__action">
                {value && <span className="tv-muted settings-row__value">{value}</span>}
                {action}
                {!action && onClick && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            </div>
        </div>
    );
}

/** A wrapping label gives existing controls an accessible name, without state. */
export function SettingsField({ label, children, className }: {
    label: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return <label className={cn('tv-field settings-field', className)}><span className="settings-field__label">{label}</span>{children}</label>;
}

export function SettingsGuide({ title, icon: Icon, children }: {
    title: string;
    icon?: ElementType;
    children: ReactNode;
}) {
    return <aside className="tv-panel settings-guide">
        {Icon && <span className="settings-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span>}
        <h3>{title}</h3>
        <div className="settings-guide__copy">{children}</div>
    </aside>;
}

export function SettingsWorkspace({ children, guide, className }: {
    children: ReactNode;
    guide: ReactNode;
    className?: string;
}) {
    return <div className={cn('settings-workspace', !guide && 'settings-workspace--no-guide', className)}>
        <div className="settings-workspace__main">{children}</div>
        {guide}
    </div>;
}

/** Provider credentials and their existing setup instructions share a layout. */
export function SettingsFormLayout({ children, guide }: { children: ReactNode; guide: ReactNode }) {
    return <div className="settings-form-layout">
        <aside className="settings-form-layout__guide">{guide}</aside>
        <div className="settings-form-layout__fields">{children}</div>
    </div>;
}

export function SettingsMetric({ label, children, tone }: {
    label: string;
    children: ReactNode;
    tone?: 'success' | 'warning';
}) {
    return <div className="settings-metric">
        <p className="settings-metric__label">{label}</p>
        <div className={cn('settings-metric__value', tone && `settings-text-${tone}`)}>{children}</div>
    </div>;
}
