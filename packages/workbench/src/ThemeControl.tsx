"use client";

import { COLORWAY_OPTIONS, COLORWAY_STORAGE_KEY, THEME_OPTIONS, THEME_STORAGE_KEY, colorwayPreference, themePreference, type Colorway, type ThemePreference } from "@rescene/design-tokens";
import { useEffect, useState } from "react";

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [colorway, setColorway] = useState<Colorway>("jade");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setPreference(themePreference(localStorage.getItem(THEME_STORAGE_KEY)));
      const storedColorway = colorwayPreference(localStorage.getItem(COLORWAY_STORAGE_KEY));
      setColorway(storedColorway);
      document.documentElement.dataset.colorway = storedColorway;
    } catch { /* Private mode uses the defaults. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference, ready]);
  return <div className="appearance-controls">
    <label className="theme-control">外观
      <select aria-label="外观主题" value={preference} onChange={(event) => {
        const next = themePreference(event.target.value);
        try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Apply without persistence. */ }
        setPreference(next);
      }}>{THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </label>
    <label className="theme-control">配色
      <select aria-label="配色" value={colorway} onChange={(event) => {
        const next = colorwayPreference(event.target.value);
        try { localStorage.setItem(COLORWAY_STORAGE_KEY, next); } catch { /* Apply without persistence. */ }
        document.documentElement.dataset.colorway = next;
        setColorway(next);
      }}>{COLORWAY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </label>
  </div>;
}
