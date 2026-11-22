import {
  COLORWAY_STORAGE_KEY, DEFAULT_COLORWAY, DISPLAY_STORAGE_KEY, FONT_SIZE_SCALES, THEME_STORAGE_KEY,
  displayPreferences, lightColors, resolvePalette, themePreference,
  type Colorway, type DisplayPreferences, type Palette, type ThemePreference,
} from "@rescene/design-tokens";
import * as FileSystem from "expo-file-system/legacy";
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";

const preferenceFile = `${FileSystem.documentDirectory}${THEME_STORAGE_KEY}.json`;
const colorwayFile = `${FileSystem.documentDirectory}${COLORWAY_STORAGE_KEY}.json`;
const displayFile = `${FileSystem.documentDirectory}${DISPLAY_STORAGE_KEY}.json`;
const defaults = displayPreferences(null);
type Appearance = {
  theme: Palette; dark: boolean; preference: ThemePreference; colorway: Colorway;
  display: DisplayPreferences; scale: number; saveError: string;
  setPreference: (value: ThemePreference) => void;
  setColorway: (value: Colorway) => void;
  setDisplay: (value: Partial<DisplayPreferences>) => void;
  resetAppearance: () => void;
};
const AppearanceContext = createContext<Appearance>({
  theme: lightColors, dark: false, preference: "system", colorway: DEFAULT_COLORWAY, display: defaults, scale: 1, saveError: "",
  setPreference: () => undefined, setColorway: () => undefined, setDisplay: () => undefined, resetAppearance: () => undefined,
});

export function AppearanceProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [preference, updatePreference] = useState<ThemePreference>("system");
  const [display, updateDisplay] = useState<DisplayPreferences>(defaults);
  const [saveError, setSaveError] = useState("");
  const currentDisplay = useRef(display);
  const changed = useRef({ theme: false, display: new Set<keyof DisplayPreferences>() });
  const pendingWrite = useRef<Promise<void>>(Promise.resolve());
  const failedFiles = useRef(new Set<string>());
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!ready.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    ready.current = { promise, resolve };
  }
  useEffect(() => {
    let active = true;
    const read = (file: string) => FileSystem.readAsStringAsync(file).catch(() => null);
    void Promise.all([read(preferenceFile), read(colorwayFile), read(displayFile)]).then(([storedTheme, legacy, storedDisplay]) => {
      if (active) {
        if (!changed.current.theme && storedTheme !== null) {
          let stored: unknown = storedTheme;
          try { stored = JSON.parse(storedTheme); } catch { /* keep the raw value */ }
          updatePreference(themePreference(stored));
        }
        let legacyValue: unknown;
        try { legacyValue = legacy === null ? undefined : JSON.parse(legacy); } catch { legacyValue = legacy ?? undefined; }
        const loaded = displayPreferences(storedDisplay, legacyValue);
        for (const key of changed.current.display) Object.assign(loaded, { [key]: currentDisplay.current[key] });
        currentDisplay.current = loaded;
        updateDisplay(loaded);
      }
      ready.current?.resolve();
    });
    return () => { active = false; };
  }, []);
  const store = (file: string, value: () => unknown) => {
    pendingWrite.current = pendingWrite.current.then(async () => {
      await ready.current!.promise;
      try {
        await FileSystem.writeAsStringAsync(file, JSON.stringify(value()));
        failedFiles.current.delete(file);
      } catch {
        failedFiles.current.add(file);
      }
      setSaveError(failedFiles.current.size ? "未能保存到此设备" : "");
    });
  };
  const setPreference = (value: ThemePreference) => {
    changed.current.theme = true;
    updatePreference(value);
    store(preferenceFile, () => value);
  };
  const setDisplay = (value: Partial<DisplayPreferences>) => {
    for (const key of Object.keys(value) as (keyof DisplayPreferences)[]) changed.current.display.add(key);
    currentDisplay.current = { ...currentDisplay.current, ...value };
    updateDisplay(currentDisplay.current);
    store(displayFile, () => currentDisplay.current);
  };
  const setColorway = (value: Colorway) => setDisplay({ colorway: value });
  const resetAppearance = () => { setPreference("system"); setDisplay(defaults); };
  const dark = preference === "dark" || (preference === "system" && system === "dark");
  const theme = resolvePalette(display.colorway, dark, display.primary);
  return <AppearanceContext.Provider value={{ theme, dark, preference, colorway: display.colorway, display, scale: FONT_SIZE_SCALES[display.fontSize], saveError, setPreference, setColorway, setDisplay, resetAppearance }}>{children}</AppearanceContext.Provider>;
}

export const useAppearance = () => useContext(AppearanceContext);
