import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cloud, CheckCircle, Info, XCircle, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

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
        loading: <Loader2 className="h-5 w-5 text-primary animate-spin" />
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
                    className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] pointer-events-none"
                >
                    <div className={cn(
                        "flex items-center gap-3 px-6 py-4 rounded-2xl border shadow-2xl backdrop-blur-xl pointer-events-auto w-max max-w-[90vw]",
                        bgColors[type]
                    )}>
                        <div className="flex-shrink-0">
                            {type === 'info' && message.includes('OneDrive') ? <Cloud className="h-5 w-5 text-blue-500 animate-pulse" /> : icons[type]}
                        </div>
                        <p className="text-sm font-medium text-foreground pr-2">
                            {message}
                        </p>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
