import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

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
    const [viewDate, setViewDate] = useState(selectedDate || new Date());
    const calendarRef = useRef<HTMLDivElement>(null);

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

    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

    return (
        <motion.div
            ref={calendarRef}
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            className="absolute z-50 mt-2 p-4 bg-white dark:bg-zinc-900 border border-border shadow-2xl rounded-2xl w-[320px] text-foreground"
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 font-semibold text-lg">
                    <span>{viewDate.getMonth() + 1} 月 {viewDate.getFullYear()}</span>
                </div>
                <div className="flex items-center gap-1">
                    <button onClick={handlePrevMonth} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors">
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button onClick={handleNextMonth} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors">
                        <ChevronRight className="h-4 w-4" />
                    </button>
                    <button onClick={onClose} className="p-1.5 hover:bg-muted dark:hover:bg-zinc-800 rounded-lg transition-colors ml-1">
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {/* Weekdays */}
            <div className="grid grid-cols-7 mb-2">
                {weekDays.map(day => (
                    <div key={day} className="h-9 w-9 flex items-center justify-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                        周{day}
                    </div>
                ))}
            </div>

            {/* Grid */}
            <div className="grid grid-cols-7 gap-y-1">
                {renderDays()}
            </div>

            <div className="mt-4 pt-3 border-t border-border flex justify-between items-center">
                <button
                    onClick={() => onChange(new Date())}
                    className="text-xs text-primary hover:underline font-medium"
                >
                    今天
                </button>
                <div className="text-[10px] text-muted-foreground">
                    请选择过期时间
                </div>
            </div>
        </motion.div>
    );
};
