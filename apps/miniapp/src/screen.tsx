import { COLORWAY_OPTIONS, COLORWAY_STORAGE_KEY, DEFAULT_COLORWAY, DISPLAY_STORAGE_KEY, FONT_SIZE_SCALES, colorwayPrimary, displayPreferences, normalizePrimary, paletteCssVariables, resolvePalette, THEME_OPTIONS, THEME_STORAGE_KEY, themePreference, type DisplayPreferences, type Palette, type ThemePreference } from "@rescene/design-tokens";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { hasToken, hasVerifiedSession, onSessionChange, verifySession } from "./api";
import { openHome } from "./navigation";

const ScreenPaletteContext = createContext<Palette>(resolvePalette(DEFAULT_COLORWAY, false));

export function useScreenPalette(): Palette {
  return useContext(ScreenPaletteContext);
}

function systemTheme(): "light" | "dark" | undefined {
  try { return Taro.getAppBaseInfo().theme; }
  catch { return undefined; }
}

type AppearanceState = {
  preference: ThemePreference;
  display: DisplayPreferences;
  setPreference: (value: ThemePreference) => void;
  setDisplay: (value: DisplayPreferences) => void;
  saveError: boolean;
};
const AppearanceContext = createContext<AppearanceState | null>(null);

// Device appearance is cached for the rest of this JS process, but only a
// verified owner may render it. Pages read this snapshot on show instead of
// re-reading storage that may fail between pages.
let activeTheme: ThemePreference | undefined;
let activeDisplay: DisplayPreferences | undefined;
// Keep unsaved changes alive across page-stack transitions when device storage fails.
let unsavedTheme: ThemePreference | undefined;
let unsavedDisplay: DisplayPreferences | undefined;
const ANONYMOUS_DISPLAY = displayPreferences(null);

type Appearance = { preference: ThemePreference; display: DisplayPreferences };

function savedAppearance(): Appearance {
  let preference: ThemePreference;
  if (unsavedTheme) preference = unsavedTheme;
  else if (activeTheme) preference = activeTheme;
  else {
    try { preference = activeTheme = themePreference(Taro.getStorageSync(THEME_STORAGE_KEY)); }
    catch { preference = "system"; }
  }
  let display: DisplayPreferences;
  if (unsavedDisplay) display = unsavedDisplay;
  else if (activeDisplay) display = activeDisplay;
  else {
    try { display = activeDisplay = displayPreferences(Taro.getStorageSync(DISPLAY_STORAGE_KEY), Taro.getStorageSync(COLORWAY_STORAGE_KEY)); }
    catch { display = ANONYMOUS_DISPLAY; }
  }
  return { preference, display };
}

function effectiveAppearance(): Appearance {
  return hasVerifiedSession()
    ? savedAppearance()
    : { preference: "system", display: ANONYMOUS_DISPLAY };
}

// Unsaved appearance belongs to the verified session that produced it. Drop it
// even if no Screen happens to be mounted when that session ends.
onSessionChange(() => {
  if (hasVerifiedSession()) return;
  unsavedTheme = undefined;
  unsavedDisplay = undefined;
});

function applyChrome(isDark: boolean, background: string): void {
  const run = (action: () => Promise<unknown>) => {
    try { void Promise.resolve(action()).catch(() => undefined); } catch { /* Native chrome is unavailable before the page is ready. */ }
  };
  run(() => Taro.setNavigationBarColor({ frontColor: isDark ? "#ffffff" : "#000000", backgroundColor: background }));
  run(() => Taro.setBackgroundColor({ backgroundColor: background, backgroundColorTop: background, backgroundColorBottom: background }));
  run(() => Taro.setBackgroundTextStyle({ textStyle: isDark ? "light" : "dark" }));
}

export function Screen({ children }: PropsWithChildren) {
  const [appearance, setAppearance] = useState<Appearance>(effectiveAppearance);
  const [saveError, setSaveError] = useState(() => hasVerifiedSession() && (!!unsavedTheme || !!unsavedDisplay));
  const [system, setSystem] = useState(systemTheme);
  const { preference, display } = appearance;
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const palette = resolvePalette(display.colorway, dark, display.primary);
  // Re-derive every entry point from the same verified-session snapshot so the
  // initial render, useDidShow, and onThemeChange cannot disagree.
  const syncAppearance = useCallback((systemOverride?: "light" | "dark") => {
    const verified = hasVerifiedSession();
    if (!verified) {
      // Unsaved edits belong to the session that made them and never survive
      // sign-out, expiry, or a failed restore.
      unsavedTheme = undefined;
      unsavedDisplay = undefined;
    }
    const next = verified ? savedAppearance() : { preference: "system" as const, display: ANONYMOUS_DISPLAY };
    setAppearance(next);
    setSaveError(verified && (!!unsavedTheme || !!unsavedDisplay));
    const nextSystem = systemOverride ?? systemTheme();
    setSystem(nextSystem);
    const nextDark = next.preference === "dark" || (next.preference === "system" && nextSystem === "dark");
    applyChrome(nextDark, resolvePalette(next.display.colorway, nextDark, next.display.primary).bg);
  }, []);
  const setPreference = (value: ThemePreference) => {
    if (!hasVerifiedSession()) return;
    setAppearance(current => ({ ...current, preference: value }));
    try { Taro.setStorageSync(THEME_STORAGE_KEY, value); activeTheme = value; unsavedTheme = undefined; }
    catch { unsavedTheme = value; }
    setSaveError(!!unsavedTheme || !!unsavedDisplay);
  };
  const setDisplay = (value: DisplayPreferences) => {
    if (!hasVerifiedSession()) return;
    setAppearance(current => ({ ...current, display: value }));
    try { Taro.setStorageSync(DISPLAY_STORAGE_KEY, value); activeDisplay = value; unsavedDisplay = undefined; }
    catch { unsavedDisplay = value; }
    setSaveError(!!unsavedTheme || !!unsavedDisplay);
  };
  useDidShow(() => {
    syncAppearance();
  });
  useEffect(() => {
    applyChrome(dark, palette.bg);
  }, [dark, palette.bg]);
  useEffect(() => onSessionChange(() => syncAppearance()), [syncAppearance]);
  useEffect(() => {
    const change = (event: { theme: "light" | "dark" }) => syncAppearance(event.theme);
    Taro.onThemeChange?.(change);
    return () => Taro.offThemeChange?.(change);
  }, [syncAppearance]);
  const scale = FONT_SIZE_SCALES[display.fontSize];
  const variables = Object.entries(paletteCssVariables(palette)).map(([key, value]) => `${key}:${value}`);
  for (const base of [22, 24, 26, 28, 30, 32, 34, 36, 44, 56]) variables.push(`--mini-font-${base}:${Math.round(base * scale)}rpx`);
  const panelChannels = [1, 3, 5].map(index => parseInt(palette.panel.slice(index, index + 2), 16));
  if (panelChannels.every(Number.isFinite)) variables.push(`--chrome-tint:rgba(${panelChannels.join(",")},${display.surface === "solid" ? 1 : 0.94})`);
  return <View className={`screen theme-${dark ? "dark" : "light"} palette-${display.colorway} surface-${display.surface}`} style={variables.join(";")}>
    <ScreenPaletteContext.Provider value={palette}>
      <AppearanceContext.Provider value={{ preference, display, setPreference, setDisplay, saveError }}>{children}</AppearanceContext.Provider>
    </ScreenPaletteContext.Provider>
  </View>;
}

export function AppearancePage() {
  // Only the protected settings route renders this, inside a workspace Screen.
  return <AppearanceForm />;
}

function AppearanceForm() {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error("AppearanceForm requires Screen");
  const { preference, display, setPreference, setDisplay, saveError } = appearance;
  const [primaryDraft, setPrimaryDraft] = useState(display.primary);
  const [primaryError, setPrimaryError] = useState(false);
  const themeIndex = THEME_OPTIONS.findIndex(item => item.value === preference);
  const sizes: { value: DisplayPreferences["fontSize"]; label: string }[] = [
    { value: "standard", label: "标准 100%" }, { value: "large", label: "较大 115%" }, { value: "extra-large", label: "特大 130%" },
  ];
  const surfaces: { value: DisplayPreferences["surface"]; label: string }[] = [
    { value: "auto", label: "跟随设备" }, { value: "solid", label: "实色" },
  ];
  const applyPrimary = () => {
    const primary = normalizePrimary(primaryDraft);
    if (!primary) { setPrimaryError(true); return; }
    setPrimaryDraft(primary);
    setPrimaryError(false);
    setDisplay({ ...display, primary });
  };
  const lightPreview = resolvePalette("custom", false, display.primary);
  const darkPreview = resolvePalette("custom", true, display.primary);
  const draftColor = normalizePrimary(primaryDraft) ?? display.primary;
  return <View className="appearance-page">
    <View className="appearance-field"><Text className="label">外观主题</Text>
      <Picker mode="selector" range={THEME_OPTIONS.map(item => item.label)} value={themeIndex} onChange={event => {
        const option = THEME_OPTIONS[Number(event.detail.value)]; if (option) setPreference(option.value);
      }}><View className="appearance-picker" aria-label={`外观主题：${THEME_OPTIONS[themeIndex]?.label}`}>{THEME_OPTIONS[themeIndex]?.label} ▾</View></Picker>
    </View>
    <View className="appearance-field"><Text className="label">配色</Text>
      <View className="colorway-grid" role="radiogroup" aria-label="配色">
        {COLORWAY_OPTIONS.map(option => {
          const selected = option.value === display.colorway;
          return <View key={option.value} className={`colorway-option${selected ? " active" : ""}`} role="radio" aria-checked={selected}
            aria-label={`配色：${option.label}`} onClick={() => setDisplay({ ...display, colorway: option.value })}>
            <View className="colorway-chip" style={`background:${colorwayPrimary(option.value, display.primary)}`} />
            <Text>{option.label}</Text>
          </View>;
        })}
      </View>
    </View>
    {display.colorway === "custom" && <View className="appearance-field">
      <Text className="label">主色调</Text>
      <View className="appearance-primary"><View className="appearance-swatch" style={`background:${draftColor}`} /><Input className="input" value={primaryDraft} maxlength={7} onInput={event => { setPrimaryDraft(event.detail.value); setPrimaryError(false); }} onConfirm={applyPrimary} aria-label="主色调 HEX" /></View>
      {primaryError && <Text className="error">请输入 6 位十六进制颜色，例如 #28536B。</Text>}
      <Button className="button ghost" onClick={applyPrimary}>应用主色</Button>
      <View className="appearance-preview"><Text>浅色</Text><View className="appearance-preview-swatch" style={`background:linear-gradient(155deg,${lightPreview.bgSoft},${lightPreview.bgDeep})`} /></View>
      <View className="appearance-preview"><Text>深色</Text><View className="appearance-preview-swatch" style={`background:linear-gradient(155deg,${darkPreview.bgSoft},${darkPreview.bgDeep})`} /></View>
    </View>}
    <View className="appearance-field"><Text className="label">字体大小</Text>
      <Picker mode="selector" range={sizes.map(item => item.label)} value={sizes.findIndex(item => item.value === display.fontSize)} onChange={event => {
        const option = sizes[Number(event.detail.value)]; if (option) setDisplay({ ...display, fontSize: option.value });
      }}><View className="appearance-picker" aria-label={`字体大小：${sizes.find(item => item.value === display.fontSize)?.label}`}>{sizes.find(item => item.value === display.fontSize)?.label} ▾</View></Picker>
    </View>
    <View className="appearance-field"><Text className="label">面板效果</Text>
      <Picker mode="selector" range={surfaces.map(item => item.label)} value={surfaces.findIndex(item => item.value === display.surface)} onChange={event => {
        const option = surfaces[Number(event.detail.value)]; if (option) setDisplay({ ...display, surface: option.value });
      }}><View className="appearance-picker" aria-label={`面板效果：${surfaces.find(item => item.value === display.surface)?.label}`}>{surfaces.find(item => item.value === display.surface)?.label} ▾</View></Picker>
    </View>
    {saveError && <View className="error" role="status"><Text>未能保存到此设备</Text></View>}
    <Button className="button ghost" onClick={() => { setPreference("system"); const defaults = displayPreferences(null); setDisplay(defaults); setPrimaryDraft(defaults.primary); setPrimaryError(false); }}>恢复默认外观</Button>
  </View>;
}

export function WorkspaceEntry({ children, hasTarget = true }: PropsWithChildren<{ hasTarget?: boolean }>) {
  const [allowed, setAllowed] = useState(() => hasTarget && hasVerifiedSession());
  const [checking, setChecking] = useState(() => hasTarget && !hasVerifiedSession() && hasToken());
  const [error, setError] = useState("");
  const pending = useRef(false);
  const shown = useRef(true);
  const goHome = () => { void openHome().catch(() => undefined); };
  const verify = useCallback(async () => {
    if (pending.current) return;
    if (!hasTarget) { goHome(); return; }
    if (hasVerifiedSession()) {
      setAllowed(true);
      setChecking(false);
      setError("");
      return;
    }
    if (!hasToken()) {
      setAllowed(false);
      setChecking(false);
      goHome();
      return;
    }
    if (!shown.current) return;
    pending.current = true;
    setChecking(true);
    setError("");
    try {
      const user = await verifySession();
      if (!shown.current) return;
      if (user && hasVerifiedSession()) {
        setAllowed(true);
        setError("");
        return;
      }
      setAllowed(false);
      if (!hasToken()) goHome();
      else setError("登录状态已变化，请重试。");
    } catch {
      if (!shown.current) return;
      setAllowed(false);
      // A failed network check keeps the stored credential and this page so the
      // user can retry instead of being sent home as if signed out.
      setError("无法验证登录状态，请检查网络后重试。");
    } finally {
      pending.current = false;
      if (shown.current) setChecking(false);
    }
  }, [hasTarget]);
  useDidShow(() => { shown.current = true; void verify(); });
  useDidHide(() => { shown.current = false; });
  useEffect(() => () => { shown.current = false; }, []);
  useEffect(() => onSessionChange(() => {
    if (!hasVerifiedSession()) {
      setAllowed(false);
      setChecking(false);
    }
  }), []);
  if (allowed && hasTarget) return children;
  return (
    <Screen>
      <Text className="title">{checking ? "正在恢复登录…" : error ? "无法确认登录状态" : "请先登录"}</Text>
      {!checking && error ? <Text className="error">{error}</Text> : null}
      {!checking && error && hasToken() ? <Button className="button" onClick={() => void verify()}>重试</Button> : null}
      <Button className="button ghost" onClick={goHome}>返回首页</Button>
    </Screen>
  );
}
