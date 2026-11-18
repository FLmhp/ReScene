"use client";

import { THEME_OPTIONS, THEME_STORAGE_KEY, themePreference } from "@rescene/design-tokens";
import { useEffect, useState } from "react";

export function ThemeControl() {
  const [preference, setPreference] = useState("system");
  useEffect(() => {
    let stored = preference;
    try { stored = themePreference(localStorage.getItem(THEME_STORAGE_KEY)); } catch { /* Private mode uses system appearance. */ }
    setPreference(stored);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = stored === "system" ? (media.matches ? "dark" : "light") : stored; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  return <label className="theme-control">外观
    <select aria-label="外观主题" value={preference} onChange={(event) => {
      const next = themePreference(event.target.value);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Apply without persistence. */ }
      document.documentElement.dataset.theme = next === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : next;
      setPreference(next);
    }}>{THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  </label>;
}
