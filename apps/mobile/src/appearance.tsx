import { darkColors, lightColors, THEME_STORAGE_KEY, themePreference, type Palette, type ThemePreference } from "@rescene/design-tokens";
import * as FileSystem from "expo-file-system/legacy";
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";

const preferenceFile = `${FileSystem.documentDirectory}${THEME_STORAGE_KEY}.json`;
const AppearanceContext = createContext<{
  theme: Palette; dark: boolean; preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}>({ theme: lightColors, dark: false, preference: "system", setPreference: () => undefined });

export function AppearanceProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [preference, updatePreference] = useState<ThemePreference>("system");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void FileSystem.readAsStringAsync(preferenceFile)
      .then((value) => { if (active) updatePreference(themePreference(JSON.parse(value))); })
      .catch(() => undefined)
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const setPreference = (value: ThemePreference) => {
    updatePreference(value);
    void FileSystem.writeAsStringAsync(preferenceFile, JSON.stringify(value)).catch(() => undefined);
  };
  if (!ready) return null;
  return <AppearanceContext.Provider value={{ theme: dark ? darkColors : lightColors, dark, preference, setPreference }}>{children}</AppearanceContext.Provider>;
}

export const useAppearance = () => useContext(AppearanceContext);
