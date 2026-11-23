import { THEME_STORAGE_KEY } from "@rescene/design-tokens";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function readSaved(): "light" | "dark" | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Applies the saved choice, or the system theme until the visitor chooses.
 * The external pre-paint bootstrap applies the same value before CSS loads;
 * this function wires the control and keeps system changes live only while
 * no manual choice exists.
 */
export function initSiteTheme(): void {
  const root = document.documentElement;
  const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  root.classList.add("js");

  const syncControl = () => {
    if (!button) return;
    const isDark = root.dataset.siteTheme === "dark";
    const label = isDark ? "切换到浅色模式" : "切换到深色模式";
    button.setAttribute("aria-label", label);
    button.title = label;
  };

  const apply = (theme: "light" | "dark") => {
    root.dataset.siteTheme = theme;
    root.style.colorScheme = theme;
    syncControl();
  };

  apply(readSaved() ?? (darkQuery.matches ? "dark" : "light"));

  if (button) {
    button.hidden = false;
    button.addEventListener("click", () => {
      const next = root.dataset.siteTheme === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // The current page still switches; only the stored preference is lost.
      }
    });
  }

  darkQuery.addEventListener("change", (event) => {
    if (readSaved()) return;
    apply(event.matches ? "dark" : "light");
  });
}
