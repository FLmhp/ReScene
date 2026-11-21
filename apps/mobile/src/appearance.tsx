import {
  COLORWAY_STORAGE_KEY, THEME_STORAGE_KEY, colorwayPreference, lightColors, resolvePalette, themePreference,
  type Colorway, type Palette, type ThemePreference,
} from "@rescene/design-tokens";
import * as FileSystem from "expo-file-system/legacy";
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";

const preferenceFile = `${FileSystem.documentDirectory}${THEME_STORAGE_KEY}.json`;
const colorwayFile = `${FileSystem.documentDirectory}${COLORWAY_STORAGE_KEY}.json`;
const AppearanceContext = createContext<{
  theme: Palette; dark: boolean; preference: ThemePreference; colorway: Colorway;
  setPreference: (value: ThemePreference) => void;
  setColorway: (value: Colorway) => void;
}>({ theme: lightColors, dark: false, preference: "system", colorway: "jade", setPreference: () => undefined, setColorway: () => undefined });

export function AppearanceProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [preference, updatePreference] = useState<ThemePreference>("system");
  const [colorway, updateColorway] = useState<Colorway>("jade");
  const changed = useRef({ theme: false, colorway: false });
  const pendingWrite = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    void FileSystem.readAsStringAsync(preferenceFile)
      .then((value) => { if (active && !changed.current.theme) updatePreference(themePreference(JSON.parse(value))); })
      .catch(() => undefined);
    void FileSystem.readAsStringAsync(colorwayFile)
      .then((value) => { if (active && !changed.current.colorway) updateColorway(colorwayPreference(JSON.parse(value))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const store = (file: string, value: string) => {
    pendingWrite.current = pendingWrite.current
      .then(() => FileSystem.writeAsStringAsync(file, JSON.stringify(value)))
      .catch(() => undefined);
  };
  const setPreference = (value: ThemePreference) => {
    changed.current.theme = true;
    updatePreference(value);
    store(preferenceFile, value);
  };
  const setColorway = (value: Colorway) => {
    changed.current.colorway = true;
    updateColorway(value);
    store(colorwayFile, value);
  };
  const theme = resolvePalette(colorway, dark);
  return <AppearanceContext.Provider value={{ theme, dark, preference, colorway, setPreference, setColorway }}>{children}</AppearanceContext.Provider>;
}

export const useAppearance = () => useContext(AppearanceContext);
