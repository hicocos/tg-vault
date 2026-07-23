import { cn } from '../../lib/utils';

type SpinnerSize = 'sm' | 'md' | 'lg';
type SpinnerTone = 'blue' | 'current' | 'inverse';

interface IndeterminateSpinnerProps {
    label: string;
    size?: SpinnerSize;
    tone?: SpinnerTone;
    className?: string;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-10 w-10',
};

const COLORS: Record<SpinnerTone, { track: string; arc: string }> = {
    blue: { track: '#D9E9FA', arc: '#4DA3FF' },
    current: { track: 'color-mix(in srgb, currentColor 22%, transparent)', arc: 'currentColor' },
    inverse: { track: '#29425F', arc: '#55A7FF' },
};

export const IndeterminateSpinner = ({
    label,
    size = 'md',
    tone = 'blue',
    className,
}: IndeterminateSpinnerProps) => {
    const colors = COLORS[tone];
    return (
        <span
            role="progressbar"
            aria-label={label}
            className={cn('inline-flex shrink-0 items-center justify-center', className)}
        >
            <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className={cn('indeterminate-spinner', SIZE_CLASSES[size])}
            >
                <circle
                    className="indeterminate-spinner__track"
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke={colors.track}
                    strokeWidth="2.5"
                />
                <circle
                    className="indeterminate-spinner__arc"
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke={colors.arc}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    pathLength="100"
                    strokeDasharray="28 72"
                />
            </svg>
        </span>
    );
};
