import { darkColors, lightColors, THEME_OPTIONS, THEME_STORAGE_KEY, themePreference } from "@rescene/design-tokens";
import { Image, Picker, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useEffect, useState, type PropsWithChildren } from "react";
import brandIcon from "./assets/brand-icon.png";

export function Screen({ children }: PropsWithChildren) {
  const [preference, setPreference] = useState(() => {
    try { return themePreference(Taro.getStorageSync(THEME_STORAGE_KEY)); } catch { return "system"; }
  });
  const [system, setSystem] = useState(() => Taro.getAppBaseInfo().theme);
  const themeIndex = THEME_OPTIONS.findIndex((item) => item.value === preference);
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const palette = dark ? darkColors : lightColors;
  const apply = () => {
    void Taro.setNavigationBarColor({ frontColor: dark ? "#ffffff" : "#000000", backgroundColor: palette.bg }).catch(() => undefined);
    void Taro.setBackgroundColor({ backgroundColor: palette.bg, backgroundColorTop: palette.bg, backgroundColorBottom: palette.bg }).catch(() => undefined);
    void Taro.setBackgroundTextStyle({ textStyle: dark ? "light" : "dark" }).catch(() => undefined);
  };
  useDidShow(() => {
    try { setPreference(themePreference(Taro.getStorageSync(THEME_STORAGE_KEY))); } catch { /* Use current preference. */ }
    setSystem(Taro.getAppBaseInfo().theme);
    apply();
  });
  useEffect(apply, [dark]);
  useEffect(() => {
    const change = (event: { theme: "light" | "dark" }) => setSystem(event.theme);
    Taro.onThemeChange(change);
    return () => Taro.offThemeChange(change);
  }, []);
  return <View className={`screen theme-${dark ? "dark" : "light"}`}>
    <View className="appearance-bar">
      <View className="brand">
        <Image className="brand-icon" src={brandIcon} mode="aspectFit" aria-hidden="true" />
        <Text className="brand-wordmark">ReScene</Text>
      </View>
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
    </View>
    {children}
  </View>;
}
