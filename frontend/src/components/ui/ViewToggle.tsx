import { motion } from "framer-motion";
import { LayoutGrid, List as ListIcon } from "lucide-react";
import { cn } from "../../lib/utils";

interface ViewToggleProps {
    viewMode: "grid" | "list";
    setViewMode: (mode: "grid" | "list") => void;
}

export const ViewToggle = ({ viewMode, setViewMode }: ViewToggleProps) => {
    return (
        <div className="bg-muted p-1 rounded-lg border border-border/50 flex relative isolation-auto">
            <button
                onClick={() => setViewMode("grid")}
                className={cn(
                    "relative z-10 flex items-center justify-center p-1.5 rounded-md transition-colors duration-200 focus:outline-none",
                    viewMode === "grid" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
            >
                <LayoutGrid className="h-4 w-4" />
                {viewMode === "grid" && (
                    <motion.div
                        layoutId="active-view-bg"
                        className="absolute inset-0 bg-background shadow-sm rounded-md border border-border/10 -z-10"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    />
                )}
            </button>

            <button
                onClick={() => setViewMode("list")}
                className={cn(
                    "relative z-10 flex items-center justify-center p-1.5 rounded-md transition-colors duration-200 focus:outline-none",
                    viewMode === "list" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
            >
                <ListIcon className="h-4 w-4" />
                {viewMode === "list" && (
                    <motion.div
                        layoutId="active-view-bg"
                        className="absolute inset-0 bg-background shadow-sm rounded-md border border-border/10 -z-10"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    />
                )}
            </button>
        </div>
    );
};
