import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { useTranslation } from 'react-i18next';

export function ConfirmDialog({ isOpen, title, description, confirmLabel, onClose, onConfirm }: {
    isOpen: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const resolvedConfirmLabel = confirmLabel ?? t('common.actions.confirm');
    return (
        <Dialog open={isOpen} onClose={onClose} labelledBy="confirm-dialog-title" describedBy="confirm-dialog-description" alert className="w-full max-w-md rounded-xl border border-border bg-background shadow-2xl">
            <div className="flex items-start gap-3 border-b border-border px-6 py-5">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
                <div><h3 id="confirm-dialog-title" className="font-semibold">{title}</h3><p id="confirm-dialog-description" className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p></div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4"><Button variant="outline" onClick={onClose}>{t('common.actions.cancel')}</Button><Button className="bg-red-600 text-white hover:bg-red-700" onClick={onConfirm}>{resolvedConfirmLabel}</Button></div>
        </Dialog>
    );
}
