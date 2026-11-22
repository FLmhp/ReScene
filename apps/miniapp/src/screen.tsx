import { COLORWAY_OPTIONS, COLORWAY_STORAGE_KEY, DEFAULT_COLORWAY, DISPLAY_STORAGE_KEY, FONT_SIZE_SCALES, colorwayPrimary, displayPreferences, normalizePrimary, paletteCssVariables, resolvePalette, THEME_OPTIONS, THEME_STORAGE_KEY, themePreference, type DisplayPreferences, type Palette, type ThemePreference } from "@rescene/design-tokens";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { hasToken } from "./api";
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

// Keep the final appearance for the rest of this JS process. Pages read this
// snapshot on show instead of re-reading storage that may fail between pages.
let activeTheme: ThemePreference | undefined;
let activeDisplay: DisplayPreferences | undefined;
// Keep unsaved changes alive across page-stack transitions when device storage fails.
let unsavedTheme: ThemePreference | undefined;
let unsavedDisplay: DisplayPreferences | undefined;
function readTheme(): ThemePreference {
  if (unsavedTheme) return unsavedTheme;
  if (activeTheme) return activeTheme;
  try { return (activeTheme = themePreference(Taro.getStorageSync(THEME_STORAGE_KEY))); } catch { return "system"; }
}
function readDisplay(): DisplayPreferences {
  if (unsavedDisplay) return unsavedDisplay;
  if (activeDisplay) return activeDisplay;
  try { return (activeDisplay = displayPreferences(Taro.getStorageSync(DISPLAY_STORAGE_KEY), Taro.getStorageSync(COLORWAY_STORAGE_KEY))); }
  catch { return displayPreferences(null); }
}

export function Screen({ children }: PropsWithChildren) {
  const [preference, updatePreference] = useState(readTheme);
  const [display, updateDisplay] = useState(readDisplay);
  const [saveError, setSaveError] = useState(!!unsavedTheme || !!unsavedDisplay);
  const [system, setSystem] = useState(systemTheme);
  const current = useRef({ preference, display });
  current.current = { preference, display };
  const visible = useRef(false);
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const palette = resolvePalette(display.colorway, dark, display.primary);
  const setPreference = (value: ThemePreference) => {
    current.current.preference = value;
    activeTheme = value;
    updatePreference(value);
    try { Taro.setStorageSync(THEME_STORAGE_KEY, value); unsavedTheme = undefined; }
    catch { unsavedTheme = value; }
    setSaveError(!!unsavedTheme || !!unsavedDisplay);
  };
  const setDisplay = (value: DisplayPreferences) => {
    current.current.display = value;
    activeDisplay = value;
    updateDisplay(value);
    try { Taro.setStorageSync(DISPLAY_STORAGE_KEY, value); unsavedDisplay = undefined; }
    catch { unsavedDisplay = value; }
    setSaveError(!!unsavedTheme || !!unsavedDisplay);
  };
  const apply = (isDark: boolean, background: string) => {
    if (!visible.current) return;
    void Promise.resolve().then(() => Taro.setNavigationBarColor({
      frontColor: isDark ? "#ffffff" : "#000000", backgroundColor: background,
    })).catch(() => undefined);
    void Promise.resolve().then(() => Taro.setBackgroundColor({
      backgroundColor: background, backgroundColorTop: background, backgroundColorBottom: background,
    })).catch(() => undefined);
    void Promise.resolve().then(() => Taro.setBackgroundTextStyle({ textStyle: isDark ? "light" : "dark" })).catch(() => undefined);
  };
  useDidShow(() => {
    visible.current = true;
    // Use the process snapshot; a failing storage read must not reset the live page.
    const nextPreference = unsavedTheme ?? activeTheme ?? current.current.preference;
    const nextDisplay = unsavedDisplay ?? activeDisplay ?? current.current.display;
    updatePreference(nextPreference);
    updateDisplay(nextDisplay);
    setSaveError(!!unsavedTheme || !!unsavedDisplay);
    const nextSystem = systemTheme();
    setSystem(nextSystem);
    const nextDark = nextPreference === "dark" || (nextPreference === "system" && nextSystem === "dark");
    apply(nextDark, resolvePalette(nextDisplay.colorway, nextDark, nextDisplay.primary).bg);
  });
  useEffect(() => { apply(dark, palette.bg); }, [dark, palette.bg]);
  useDidHide(() => { visible.current = false; });
  useEffect(() => {
    const change = (event: { theme: "light" | "dark" }) => setSystem(event.theme);
    Taro.onThemeChange?.(change);
    return () => Taro.offThemeChange?.(change);
  }, []);
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
  // Standalone route usage renders its own Screen; inside a workspace it inherits the page shell.
  return useContext(AppearanceContext) ? <AppearanceForm /> : <Screen><AppearanceForm /></Screen>;
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
  const [signedIn, setSignedIn] = useState(hasToken);
  const allowed = signedIn && hasTarget;
  const goHome = () => { void openHome().catch(() => undefined); };
  useDidShow(() => {
    const current = hasToken();
    setSignedIn(current);
    if (!current || !hasTarget) goHome();
  });
  if (allowed) return children;
  return (
    <Screen>
      <Text className="title">{signedIn ? "项目入口已失效" : "请先登录"}</Text>
      <Button className="button" onClick={goHome}>返回首页</Button>
    </Screen>
  );
}
