// Colour theme: "dark", "light" or "auto" (follow the system). The resolved
// theme is set as data-theme on <html>; index.html applies it before the app
// loads so the page never flashes the wrong theme.

const KEY = "wosate:theme";
const media = () => window.matchMedia?.("(prefers-color-scheme: light)");

export const THEMES = ["light", "dark", "auto"];

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : "light";
  } catch {
    return "light";
  }
}

export const resolveTheme = (pref) => (pref === "auto" ? (media()?.matches ? "light" : "dark") : pref);

/** Apply and remember a preference; returns a function that stops following the system. */
export function applyTheme(pref, onSystemChange) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
  document.documentElement.dataset.theme = resolveTheme(pref);
  if (pref !== "auto") return () => {};
  const mq = media();
  const listener = () => {
    document.documentElement.dataset.theme = resolveTheme("auto");
    onSystemChange?.();
  };
  mq?.addEventListener("change", listener);
  return () => mq?.removeEventListener("change", listener);
}
