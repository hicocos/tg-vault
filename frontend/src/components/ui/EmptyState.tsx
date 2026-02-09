import { motion } from "framer-motion";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

export const EmptyState = () => {
    const { t } = useTranslation();
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 text-center"
        >
            <div className="bg-muted/30 p-6 rounded-full mb-4">
                <FolderOpen className="h-12 w-12 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">{t("empty.title")}</h3>
            <p className="text-muted-foreground mt-1 max-w-sm">{t("empty.description")}</p>
        </motion.div>
    )
}
