import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(() => {
        // Check localStorage first
        if (typeof window !== "undefined" && window.localStorage) {
            const stored = window.localStorage.getItem("theme") as Theme;
            if (stored) return stored;
        }
        return "system";
    });

    useEffect(() => {
        const root = window.document.documentElement;

        root.classList.remove("light", "dark");

        if (theme === "system") {
            const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
                .matches
                ? "dark"
                : "light";

            root.classList.add(systemTheme);
            return;
        }

        root.classList.add(theme);
    }, [theme]);

    const setThemeAndStore = (t: Theme) => {
        setTheme(t);
        window.localStorage.setItem("theme", t);
    };

    return { theme, setTheme: setThemeAndStore };
}
