import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DatePickerProps {
    selectedDate: Date | null;
    onChange: (date: Date) => void;
    onClose: () => void;
    minDate?: Date;
}

export const DatePicker: React.FC<DatePickerProps> = ({
    selectedDate,
    onChange,
    onClose,
    minDate = new Date()
}) => {
    const { t, i18n } = useTranslation();
    const [viewDate, setViewDate] = useState(selectedDate || new Date());
    const [showYearPicker, setShowYearPicker] = useState(false);
    const calendarRef = useRef<HTMLDivElement>(null);

    const currentYear = new Date().getFullYear();
    const availableYears = [currentYear, currentYear + 1, currentYear + 2];

    // Close when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
    const firstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

    const handlePrevMonth = () => {
        setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
    };

    const handleNextMonth = () => {
        setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
    };

    const handleYearSelect = (year: number) => {
        setViewDate(new Date(year, viewDate.getMonth(), 1));
        setShowYearPicker(false);
    };

    const handleDateClick = (day: number) => {
        const newDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), day);
        onChange(newDate);
    };

    const renderDays = () => {
        const days = [];
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();
        const totalDays = daysInMonth(year, month);
        const startDay = firstDayOfMonth(year, month);

        // Fill empty days for previous month
        for (let i = 0; i < startDay; i++) {
            days.push(<div key={`empty-${i}`} className="h-9 w-9" />);
        }

        // Fill actual days
        for (let day = 1; day <= totalDays; day++) {
            const date = new Date(year, month, day);
            const isSelected = selectedDate &&
                date.getDate() === selectedDate.getDate() &&
                date.getMonth() === selectedDate.getMonth() &&
                date.getFullYear() === selectedDate.getFullYear();

            const isToday = (() => {
                const today = new Date();
                return date.getDate() === today.getDate() &&
                    date.getMonth() === today.getMonth() &&
                    date.getFullYear() === today.getFullYear();
            })();

            const isPast = date < new Date(minDate.setHours(0, 0, 0, 0)) && !isToday;

            days.push(
                <button
                    key={day}
                    onClick={() => !isPast && handleDateClick(day)}
                    disabled={isPast}
                    className={`h-9 w-9 flex items-center justify-center rounded-full text-sm transition-all
                        ${isSelected ? 'bg-primary text-primary-foreground font-bold scale-110 shadow-lg shadow-primary/20' :
                            isToday ? 'border border-primary/50 text-primary font-medium' :
                                isPast ? 'text-muted-foreground/30 cursor-not-allowed' :
                                    'hover:bg-muted text-foreground'}`}
                >
                    {day}
                </button>
            );
        }

        return days;
    };

    const weekDaysValue = t('files.ui.datePicker.weekdays', { returnObjects: true });
    const weekDays = Array.isArray(weekDaysValue) ? weekDaysValue as string[] : [];

    return (
        <motion.div
            ref={calendarRef}
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            className="absolute z-50 mt-2 w-[320px] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <button
                    onClick={() => setShowYearPicker(!showYearPicker)}
                    className="flex items-center gap-1.5 font-semibold text-lg hover:bg-muted py-0.5 px-2 rounded-lg transition-colors group"
                >
                    <span>{new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { month: 'long', year: 'numeric' }).format(viewDate)}</span>
                    <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${showYearPicker ? 'rotate-90' : ''}`} />
                </button>
                <div className="flex items-center gap-1">
                    {!showYearPicker && (
                        <>
                            <button onClick={handlePrevMonth} aria-label={t('files.ui.datePicker.previousMonth')} title={t('files.ui.datePicker.previousMonth')} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors">
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <button onClick={handleNextMonth} aria-label={t('files.ui.datePicker.nextMonth')} title={t('files.ui.datePicker.nextMonth')} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors">
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </>
                    )}
                    <button onClick={onClose} aria-label={t('files.ui.datePicker.close')} title={t('files.ui.datePicker.close')} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors ml-1">
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {showYearPicker ? (
                <div className="py-4">
                    <div className="text-xs text-muted-foreground mb-3 px-1 text-center font-medium">{t('files.ui.datePicker.selectYear')}</div>
                    <div className="grid grid-cols-1 gap-2 max-h-[220px] overflow-y-auto pr-1">
                        {availableYears.map(year => (
                            <button
                                key={year}
                                onClick={() => handleYearSelect(year)}
                                className={`py-3 px-4 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${viewDate.getFullYear() === year
                                    ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                                    : 'bg-muted hover:bg-muted/80'
                                    }`}
                            >
                                {year}
                                {viewDate.getFullYear() === year && <div className="h-1.5 w-1.5 rounded-full bg-current" />}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <>
                    {/* Weekdays */}
                    <div className="grid grid-cols-7 mb-2">
                        {weekDays.map(day => (
                            <div key={day} className="h-9 w-9 flex items-center justify-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                                {day}
                            </div>
                        ))}
                    </div>

                    {/* Grid */}
                    <div className="grid grid-cols-7 gap-y-1">
                        {renderDays()}
                    </div>
                </>
            )}

            <div className="mt-4 pt-3 border-t border-border flex justify-between items-center">
                <button
                    onClick={() => {
                        const today = new Date();
                        setViewDate(today);
                        if (showYearPicker) setShowYearPicker(false);
                    }}
                    className="text-xs text-primary hover:underline font-medium"
                >
                    {t('files.ui.datePicker.today')}
                </button>
                <div className="text-[10px] text-muted-foreground">
                    {showYearPicker ? t('files.ui.datePicker.yearHint') : t('files.ui.datePicker.expirationHint')}
                </div>
            </div>
        </motion.div>
    );
};
