import { darkColors, lightColors, THEME_OPTIONS, THEME_STORAGE_KEY, themePreference } from "@rescene/design-tokens";
import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useEffect, useState, type PropsWithChildren } from "react";

export function Screen({ children }: PropsWithChildren) {
  const [preference, setPreference] = useState(() => {
    try { return themePreference(Taro.getStorageSync(THEME_STORAGE_KEY)); } catch { return "system"; }
  });
  const [system, setSystem] = useState(() => Taro.getAppBaseInfo().theme);
  const [expanded, setExpanded] = useState(false);
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
      <Text className="brand-wordmark">ReScene</Text>
      <Button className="button ghost compact" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {THEME_OPTIONS.find((item) => item.value === preference)?.label} ▾
      </Button>
    </View>
    {expanded ? <View className="segmented">
      {THEME_OPTIONS.map((item) => <Button className={`button ghost ${preference === item.value ? "selected" : ""}`} key={item.value} onClick={() => {
        setPreference(item.value);
        try { Taro.setStorageSync(THEME_STORAGE_KEY, item.value); } catch { /* Apply for this session. */ }
        setExpanded(false);
      }}>{item.label}</Button>)}
    </View> : null}
    {children}
  </View>;
}
