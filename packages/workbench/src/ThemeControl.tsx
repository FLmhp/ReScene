"use client";

import {
  COLORWAY_OPTIONS, DISPLAY_STORAGE_KEY, THEME_OPTIONS, THEME_STORAGE_KEY,
  applyDisplayToRoot, colorwayPreference, colorwayPrimary, displayPreferences, normalizePrimary, resolvePalette,
  themePreference, type DisplayPreferences, type ThemePreference,
} from "@rescene/design-tokens";
import { useEffect, useState } from "react";

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [display, setDisplay] = useState<DisplayPreferences>(() => displayPreferences(null));
  const [primaryInput, setPrimaryInput] = useState(display.primary);
  const [invalidPrimary, setInvalidPrimary] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    // The bootstrap has already resolved query parameters, storage and system theme.
    setPreference(themePreference(root.dataset.themePreference));
    const initialized = displayPreferences({
      colorway: root.dataset.colorway, primary: root.dataset.primary,
      fontSize: root.dataset.fontSize, surface: root.dataset.surface,
    });
    setDisplay(initialized);
    setPrimaryInput(initialized.primary);
  }, []);

  const apply = (nextPreference: ThemePreference, nextDisplay: DisplayPreferences) => {
    const root = document.documentElement;
    root.dataset.themePreference = nextPreference;
    const dark = nextPreference === "dark" || (nextPreference === "system" &&
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    applyDisplayToRoot(root, dark, nextDisplay);
    setPreference(nextPreference);
    setDisplay(nextDisplay);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
      localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(nextDisplay));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };

  const previewPrimary = normalizePrimary(primaryInput);
  return <div className="appearance-controls">
    <label className="theme-control">外观主题
      <select aria-label="外观主题" value={preference} onChange={(event) => apply(themePreference(event.target.value), display)}>
        {THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <fieldset className="colorway-field">
      <legend>配色</legend>
      <div className="colorway-options">
        {COLORWAY_OPTIONS.map((option) => (
          <label key={option.value} className="colorway-option">
            <input
              type="radio"
              name="colorway"
              value={option.value}
              aria-label={option.label}
              checked={display.colorway === option.value}
              onChange={() => apply(preference, { ...display, colorway: colorwayPreference(option.value) })}
            />
            <span className="colorway-chip" aria-hidden="true" style={{ background: colorwayPrimary(option.value, display.primary) }} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
    {display.colorway === "custom" && <div style={{ display: "grid", gap: 8 }}>
      <label>自定义主色
        <input aria-label="自定义主色" aria-invalid={invalidPrimary} aria-describedby={invalidPrimary ? "appearance-primary-error" : undefined}
          value={primaryInput} onChange={(event) => { setPrimaryInput(event.target.value); setInvalidPrimary(false); }} placeholder="#28536B" />
      </label>
      <button type="button" onClick={() => {
        const primary = normalizePrimary(primaryInput);
        if (!primary) { setInvalidPrimary(true); return; }
        setPrimaryInput(primary);
        setInvalidPrimary(false);
        apply(preference, { ...display, primary });
      }}>应用主色</button>
      {invalidPrimary && <span id="appearance-primary-error" role="alert">请输入 6 位十六进制颜色，例如 #28536B。</span>}
      {previewPrimary && <div aria-label="主色预览" style={{ display: "flex", gap: 8 }}>
        {[false, true].map((dark) => {
          const palette = resolvePalette("custom", dark, previewPrimary);
          return <div key={String(dark)} style={{ flex: 1, padding: 10, borderRadius: 8, background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}` }}>
            <span>{dark ? "深色预览" : "浅色预览"}</span>{" "}
            <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: palette.accent, color: palette.onAccent }}>强调色</span>
          </div>;
        })}
      </div>}
    </div>}
    <label className="theme-control">字体大小
      <select aria-label="字体大小" value={display.fontSize} onChange={(event) => apply(preference, displayPreferences({ ...display, fontSize: event.target.value }))}>
        <option value="standard">标准 100%</option><option value="large">较大 115%</option><option value="extra-large">特大 130%</option>
      </select>
    </label>
    <label className="theme-control">面板效果
      <select aria-label="面板效果" value={display.surface} onChange={(event) => apply(preference, displayPreferences({ ...display, surface: event.target.value }))}>
        <option value="auto">跟随设备</option><option value="solid">实色</option>
      </select>
    </label>
    <button type="button" className="text-action" onClick={() => {
      const defaults = displayPreferences(null);
      setPrimaryInput(defaults.primary);
      setInvalidPrimary(false);
      apply("system", defaults);
    }}>恢复默认外观</button>
    {storageError && <span role="status">未能保存到此设备；本次运行中的外观仍然有效。</span>}
  </div>;
}
