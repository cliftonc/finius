// Light/dark theme state for the dashboard.
//
// HeroUI/Tailwind read the active theme from the `dark`/`light` class on <html> (darkMode: "class").
// We mirror the choice into localStorage so it persists across reloads, and an inline script in
// index.html applies the same class *before* React mounts to avoid a flash of the wrong theme.
// Keep the storage key and resolution logic in sync with that inline bootstrap snippet.

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "finius-theme";

function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  // Tells the browser which native control palette to use (scrollbars, form widgets).
  root.style.colorScheme = theme;
}

type ThemeContextValue = { theme: Theme; toggle: () => void; setTheme: (theme: Theme) => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((prev) => (prev === "dark" ? "light" : "dark")), []);

  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
