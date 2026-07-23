import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';

export function ConfirmDialog({
    isOpen,
    title,
    description,
    confirmLabel = '确认',
    onClose,
    onConfirm,
}: {
    isOpen: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={onClose}>
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
                aria-describedby="confirm-dialog-description"
                className="w-full max-w-md rounded-xl border border-border bg-background shadow-2xl"
                onMouseDown={event => event.stopPropagation()}
            >
                <div className="flex items-start gap-3 border-b border-border px-6 py-5">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                    <div>
                        <h3 id="confirm-dialog-title" className="font-semibold">{title}</h3>
                        <p id="confirm-dialog-description" className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4">
                    <Button variant="outline" onClick={onClose}>取消</Button>
                    <Button className="bg-red-600 text-white hover:bg-red-700" onClick={onConfirm}>{confirmLabel}</Button>
                </div>
            </div>
        </div>
    );
}
