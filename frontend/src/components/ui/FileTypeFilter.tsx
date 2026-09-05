import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FileText, Filter, Image as ImageIcon, Music, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type FileTypeCategory = "all" | "image" | "video" | "audio" | "document";

interface FileTypeFilterProps {
    value: string;
    onChange: (category: FileTypeCategory) => void;
}

export const FileTypeFilter = ({ value, onChange }: FileTypeFilterProps) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const options = [
        { id: "all" as const, label: t("app.fileTypes.all"), shortLabel: t("app.fileTypes.allShort"), icon: Filter },
        { id: "image" as const, label: t("app.fileTypes.images"), shortLabel: t("app.fileTypes.images"), icon: ImageIcon },
        { id: "video" as const, label: t("app.fileTypes.videos"), shortLabel: t("app.fileTypes.videos"), icon: Video },
        { id: "audio" as const, label: t("app.fileTypes.audio"), shortLabel: t("app.fileTypes.audio"), icon: Music },
        { id: "document" as const, label: t("app.fileTypes.other"), shortLabel: t("app.fileTypes.other"), icon: FileText },
    ];
    const activeOption = options.find(option => option.id === value) ?? options[0];
    const ActiveIcon = activeOption.icon;
    const hasActiveFilter = value !== "all";

    useEffect(() => {
        if (!isOpen) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setIsOpen(false);
        };
        document.addEventListener("mousedown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("mousedown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [isOpen]);

    return (
        <>
            <div className="grid w-full grid-cols-5 gap-1 rounded-xl bg-muted/50 p-1 md:hidden" role="group" aria-label={t("app.fileTypes.filter")}>
                {options.map(option => {
                    const Icon = option.icon;
                    const selected = option.id === activeOption.id;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            aria-pressed={selected}
                            className={cn(
                                "flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-0.5 py-2 text-center text-[11px] font-medium leading-tight break-words whitespace-normal transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                                selected
                                    ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                            )}
                            onClick={() => onChange(option.id)}
                        >
                            <Icon className={cn("h-4 w-4 shrink-0", selected && "text-primary")} />
                            <span className="min-w-0 max-w-full break-words whitespace-normal">{option.shortLabel}</span>
                        </button>
                    );
                })}
            </div>

            <div ref={containerRef} className="relative hidden md:block">
                <button
                    type="button"
                    className={cn(
                        "flex h-10 min-w-[92px] items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                        hasActiveFilter
                            ? "border-primary/30 bg-primary/10 text-primary"
                            : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() => setIsOpen(open => !open)}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    aria-label={`${t("app.fileTypes.filter")}: ${activeOption.label}`}
                    title={`${t("app.fileTypes.filter")}: ${activeOption.label}`}
                >
                    <ActiveIcon className="h-4 w-4 shrink-0" />
                    <span>{activeOption.label}</span>
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")} />
                </button>

                {isOpen && (
                    <div
                        className="absolute left-0 top-12 z-50 w-44 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
                        role="menu"
                        aria-label={t("app.fileTypes.filter")}
                    >
                        {options.map(option => {
                            const Icon = option.icon;
                            const selected = option.id === activeOption.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={selected}
                                    className={cn(
                                        "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                                        selected && "bg-muted font-medium text-foreground",
                                    )}
                                    onClick={() => {
                                        onChange(option.id);
                                        setIsOpen(false);
                                    }}
                                >
                                    <Icon className={cn("h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                                    <span className="flex-1">{option.label}</span>
                                    {selected && <Check className="h-4 w-4 text-primary" />}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );
};
