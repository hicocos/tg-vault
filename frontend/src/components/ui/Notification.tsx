import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cloud, CheckCircle, Info, X, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IndeterminateSpinner } from './IndeterminateSpinner';
import { useTranslation } from 'react-i18next';

export type NotificationType = 'info' | 'success' | 'error' | 'loading';

interface NotificationProps {
    show: boolean;
    message: string;
    type?: NotificationType;
    duration?: number;
    onClose: () => void;
}

export const Notification: React.FC<NotificationProps> = ({
    show,
    message,
    type = 'info',
    duration = 4000,
    onClose
}) => {
    const { t } = useTranslation();
    useEffect(() => {
        if (show && duration > 0 && type !== 'loading') {
            const timer = setTimeout(() => {
                onClose();
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [show, duration, type, onClose]);

    const icons = {
        info: <Info className="h-5 w-5 text-blue-500" />,
        success: <CheckCircle className="h-5 w-5 text-green-500" />,
        error: <XCircle className="h-5 w-5 text-red-500" />,
        loading: <IndeterminateSpinner label={message || t('files.ui.notification.processing')} size="md" />
    };

    const bgColors = {
        info: 'bg-blue-500/10 border-blue-500/20',
        success: 'bg-green-500/10 border-green-500/20',
        error: 'bg-red-500/10 border-red-500/20',
        loading: 'bg-primary/5 border-primary/20'
    };

    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    initial={{ opacity: 0, y: -20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -20, scale: 0.95 }}
                    className="fixed top-12 inset-x-0 z-[100] flex justify-center pointer-events-none px-4"
                >
                    <div
                        role={type === 'error' ? 'alert' : 'status'}
                        aria-live={type === 'error' ? 'assertive' : 'polite'}
                        aria-atomic="true"
                        className={cn(
                        "flex items-center gap-3 px-6 py-4 rounded-2xl border shadow-2xl backdrop-blur-xl pointer-events-auto w-max max-w-[90vw]",
                        bgColors[type]
                    )}>
                        <div className="flex-shrink-0">
                            {type === 'info' && message.includes('OneDrive') ? <Cloud className="h-5 w-5 text-blue-500 animate-pulse" /> : icons[type]}
                        </div>
                        <p className="text-sm font-medium text-foreground pr-2">
                            {message}
                        </p>
                        {type !== 'loading' && (
                            <button type="button" onClick={onClose} className="-mr-2 rounded-md p-2 text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" aria-label={t('files.ui.notification.close')} title={t('files.ui.notification.close')}>
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
