import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  themePreference,
  type ThemePreference,
} from "@rescene/design-tokens";

/**
 * Applies the saved appearance before first paint of any interactive element.
 *
 * The palette itself comes from CSS, so a failed read still paints the system
 * theme. A failed write keeps this page correct and only loses the preference.
 */
export function initSiteTheme(): void {
  const root = document.documentElement;
  const apply = (preference: ThemePreference) => {
    root.dataset.siteTheme = preference;
  };
  const read = (): ThemePreference => {
    try {
      return themePreference(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return "system";
    }
  };

  apply(read());

  const control = document.querySelector<HTMLElement>("[data-site-theme-control]");
  const select = control?.querySelector<HTMLSelectElement>("select");
  if (!control || !select) return;
  select.replaceChildren(...THEME_OPTIONS.map(({ label, value }) => new Option(label, value)));
  select.value = root.dataset.siteTheme ?? "system";
  control.hidden = false;
  select.addEventListener("change", () => {
    const preference = themePreference(select.value);
    apply(preference);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // The page still switches; only the stored preference is lost.
    }
  });
}
