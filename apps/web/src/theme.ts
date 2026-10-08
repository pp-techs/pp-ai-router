import { useSyncExternalStore } from "react";

/** shadcn themes switch on a `.dark` class; "system" follows the OS preference live. */
export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

const STORAGE_KEY = "theme";
const query = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);
  return THEMES.find((t) => t === value) ?? "system";
}

function apply() {
  const theme = stored();
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && query.matches),
  );
}

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, theme);
  apply();
  listeners.forEach((l) => l());
}

export function syncColorScheme() {
  apply();
  query.addEventListener("change", apply);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useTheme = () => useSyncExternalStore(subscribe, stored);
