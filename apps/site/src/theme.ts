import { THEME_STORAGE_KEY } from "@rescene/design-tokens";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

/** `startViewTransition` is still typed as experimental in some TS DOM builds. */
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

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
  const doc = document as ViewTransitionDocument;
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
    const toggleTheme = (event: MouseEvent) => {
      const next = root.dataset.siteTheme === "dark" ? "light" : "dark";
      const updateTheme = () => {
        apply(next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // The current page still switches; only the stored preference is lost.
        }
      };

      // Reveal the new theme from the control with a circular wipe when the
      // browser can animate it; every other case switches instantly.
      if (reducedMotionQuery.matches || typeof doc.startViewTransition !== "function") {
        updateTheme();
        return;
      }

      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

      try {
        const transition = doc.startViewTransition(updateTheme);
        transition.ready
          .then(() => {
            root
              .animate(
                { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
                {
                  duration: 450,
                  easing: "cubic-bezier(.22, 1, .36, 1)",
                  pseudoElement: "::view-transition-new(root)",
                } as KeyframeAnimationOptions,
              )
              .finished.catch(() => {});
          })
          .catch(() => {});
      } catch {
        // A transition that cannot start must never block the theme change.
        updateTheme();
      }
    };
    button.addEventListener("click", toggleTheme);
  }

  darkQuery.addEventListener("change", (event) => {
    if (readSaved()) return;
    apply(event.matches ? "dark" : "light");
  });
}
