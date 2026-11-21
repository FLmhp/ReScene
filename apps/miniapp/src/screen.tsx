import { COLORWAY_OPTIONS, COLORWAY_STORAGE_KEY, colorwayPreference, resolvePalette, THEME_OPTIONS, THEME_STORAGE_KEY, themePreference, type Palette } from "@rescene/design-tokens";
import { Button, Image, Picker, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import brandIcon from "./assets/brand-icon.png";
import { hasToken } from "./api";
import { openHome } from "./navigation";

const ScreenPaletteContext = createContext<Palette>(resolvePalette("jade", false));

export function useScreenPalette(): Palette {
  return useContext(ScreenPaletteContext);
}

function systemTheme(): "light" | "dark" | undefined {
  try { return Taro.getAppBaseInfo().theme; }
  catch { return undefined; }
}

export function Screen({ children }: PropsWithChildren) {
  const [preference, setPreference] = useState(() => {
    try { return themePreference(Taro.getStorageSync(THEME_STORAGE_KEY)); } catch { return "system"; }
  });
  const [colorway, setColorway] = useState(() => {
    try { return colorwayPreference(Taro.getStorageSync(COLORWAY_STORAGE_KEY)); } catch { return "jade"; }
  });
  const [system, setSystem] = useState(systemTheme);
  const themeIndex = THEME_OPTIONS.findIndex((item) => item.value === preference);
  const colorwayIndex = COLORWAY_OPTIONS.findIndex((item) => item.value === colorway);
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const palette = resolvePalette(colorway, dark);
  const apply = (isDark: boolean, background: string) => {
    void Promise.resolve().then(() => Taro.setNavigationBarColor({
      frontColor: isDark ? "#ffffff" : "#000000", backgroundColor: background,
    })).catch(() => undefined);
    void Promise.resolve().then(() => Taro.setBackgroundColor({
      backgroundColor: background, backgroundColorTop: background, backgroundColorBottom: background,
    })).catch(() => undefined);
    void Promise.resolve().then(() => Taro.setBackgroundTextStyle({ textStyle: isDark ? "light" : "dark" })).catch(() => undefined);
  };
  useDidShow(() => {
    let nextPreference = preference;
    let nextColorway = colorway;
    try { nextPreference = themePreference(Taro.getStorageSync(THEME_STORAGE_KEY)); setPreference(nextPreference); } catch { /* Use current preference. */ }
    try { nextColorway = colorwayPreference(Taro.getStorageSync(COLORWAY_STORAGE_KEY)); setColorway(nextColorway); } catch { /* Use current colorway. */ }
    const nextSystem = systemTheme();
    setSystem(nextSystem);
    const nextDark = nextPreference === "dark" || (nextPreference === "system" && nextSystem === "dark");
    apply(nextDark, resolvePalette(nextColorway, nextDark).bg);
  });
  useEffect(() => { apply(dark, palette.bg); }, [dark, palette.bg]);
  useEffect(() => {
    const change = (event: { theme: "light" | "dark" }) => setSystem(event.theme);
    Taro.onThemeChange?.(change);
    return () => Taro.offThemeChange?.(change);
  }, []);
  return <View className={`screen theme-${dark ? "dark" : "light"} palette-${colorway}`}>
    <View className="appearance-bar">
      <View className="brand">
        <Image className="brand-icon" src={brandIcon} mode="aspectFit" aria-hidden="true" />
        <Text className="brand-wordmark">ReScene</Text>
      </View>
      <View className="appearance-controls">
      <Picker mode="selector" range={THEME_OPTIONS.map((item) => item.label)} value={themeIndex} onChange={(event) => {
        const selected = THEME_OPTIONS[Number(event.detail.value)];
        if (!selected) return;
        setPreference(selected.value);
        try { Taro.setStorageSync(THEME_STORAGE_KEY, selected.value); } catch { /* Apply for this session. */ }
      }}>
        <View className="button ghost compact theme-trigger" aria-label={`外观主题：${THEME_OPTIONS[themeIndex]?.label}`}>
          <Text>{THEME_OPTIONS[themeIndex]?.label}</Text><Text aria-hidden="true">▾</Text>
        </View>
      </Picker>
      <Picker mode="selector" range={COLORWAY_OPTIONS.map((item) => item.label)} value={colorwayIndex} onChange={(event) => {
        const selected = COLORWAY_OPTIONS[Number(event.detail.value)];
        if (!selected) return;
        setColorway(selected.value);
        try { Taro.setStorageSync(COLORWAY_STORAGE_KEY, selected.value); } catch { /* Apply for this session. */ }
      }}>
        <View className="button ghost compact colorway-trigger" aria-label={`配色：${COLORWAY_OPTIONS[colorwayIndex]?.label}`}>
          <Text>{COLORWAY_OPTIONS[colorwayIndex]?.label}</Text><Text aria-hidden="true">▾</Text>
        </View>
      </Picker>
      </View>
    </View>
    <ScreenPaletteContext.Provider value={palette}>{children}</ScreenPaletteContext.Provider>
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
