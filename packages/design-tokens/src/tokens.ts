/**
 * Shared design variables for Web, Desktop, Mobile, and the Mini Program.
 *
 * Keep these literals in sync with web.css and apps/miniapp/src/app.css.
 */

export const darkColors = {
  bg: "#101A1B",
  bgDeep: "#0A1213",
  bgSoft: "#142122",
  panel: "#192728",
  panelAlt: "#142021",
  surface: "rgba(234,245,241,0.055)",
  surfaceStrong: "rgba(234,245,241,0.09)",
  border: "#5C7873",
  borderSoft: "rgba(234,245,241,0.14)",
  divider: "rgba(234,245,241,0.08)",
  fg: "#EAF5F1",
  muted: "#AAC5BE",
  accent: "#62D9CA",
  accentStrong: "#7FE6D8",
  accentAlt: "#4FB8C9",
  onAccent: "#062B26",
  danger: "#FFA1A6",
  success: "#86E0AE",
  overlay: "rgba(6,12,13,0.78)",
} as const;

export type Palette = { [Key in keyof typeof darkColors]: string };

export const lightColors: Palette = {
  bg: "#F1F5F4", bgDeep: "#E4ECE9", bgSoft: "#F8FBFA",
  panel: "#FFFFFF", panelAlt: "#F4F8F7", surface: "#FFFFFF",
  surfaceStrong: "#E3F3EF", border: "#6E8580", borderSoft: "#D3E0DC",
  divider: "#E2EAE7", fg: "#142C29", muted: "#45615B",
  accent: "#00665D", accentStrong: "#00524B", accentAlt: "#0A6F86",
  onAccent: "#FFFFFF", danger: "#A4243B", success: "#14654A",
  overlay: "rgba(9,28,26,0.45)",
};

const ultramarine = {
  light: {
    ...lightColors,
    bg: "#EEF2FC", bgDeep: "#DDE6FA", bgSoft: "#F8FAFF", panelAlt: "#F3F6FE",
    surfaceStrong: "#E0E8FE", border: "#6D80AF", borderSoft: "#CCD7F0", divider: "#DEE5F6",
    fg: "#17254A", muted: "#435680", accent: "#274A9C", accentStrong: "#203C84", accentAlt: "#355AAE",
    overlay: "rgba(19,29,58,0.54)",
  },
  dark: {
    ...darkColors,
    bg: "#10182D", bgDeep: "#0A1021", bgSoft: "#253563", panel: "#1C2847", panelAlt: "#17213A",
    surface: "rgba(231,238,255,0.06)", surfaceStrong: "rgba(174,192,255,0.16)",
    border: "#6E82B7", borderSoft: "rgba(188,204,255,0.24)", divider: "rgba(188,204,255,0.12)",
    fg: "#EEF2FF", muted: "#BBC8E9", accent: "#AEC0FF", accentStrong: "#C4D0FF", accentAlt: "#A9C8FA",
    onAccent: "#152655", overlay: "rgba(6,11,25,0.80)",
  },
} satisfies Record<"light" | "dark", Palette>;

const ink = {
  light: {
    ...lightColors,
    bg: "#F0F1F3", bgDeep: "#DBDEE3", bgSoft: "#FBFBFC", panelAlt: "#F5F6F7",
    surfaceStrong: "#E1E4E9", border: "#737B88", borderSoft: "#D2D6DD", divider: "#E0E3E8",
    fg: "#22262D", muted: "#505967", accent: "#3B4657", accentStrong: "#2B3442", accentAlt: "#4C5C73",
    overlay: "rgba(25,29,37,0.51)",
  },
  dark: {
    ...darkColors,
    bg: "#16181D", bgDeep: "#0D0E12", bgSoft: "#303540", panel: "#232730", panelAlt: "#1B1E25",
    surface: "rgba(237,240,245,0.06)", surfaceStrong: "rgba(213,220,233,0.15)",
    border: "#737D90", borderSoft: "rgba(220,227,240,0.22)", divider: "rgba(220,227,240,0.12)",
    fg: "#F1F3F7", muted: "#BCC4D0", accent: "#CFD6E3", accentStrong: "#E0E5ED", accentAlt: "#BFCDE6",
    onAccent: "#202631", overlay: "rgba(6,8,12,0.79)",
  },
} satisfies Record<"light" | "dark", Palette>;

export const COLORWAY_OPTIONS = [
  { value: "jade", label: "青瓷" },
  { value: "ultramarine", label: "群青" },
  { value: "ink", label: "墨染" },
] as const;
export type Colorway = (typeof COLORWAY_OPTIONS)[number]["value"];
export const COLORWAY_STORAGE_KEY = "rescene-colorway";

const palettes = { jade: { light: lightColors, dark: darkColors }, ultramarine, ink };

export function colorwayPreference(value: unknown): Colorway {
  return value === "ultramarine" || value === "ink" ? value : "jade";
}

export function resolvePalette(colorway: Colorway, dark: boolean): Palette {
  return palettes[colorway][dark ? "dark" : "light"];
}

export const colors = darkColors;
export type ThemePreference = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "rescene-theme";
export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
export function themePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export const spacing = {
  xs: 4,
  sm: 7,
  md: 14,
  lg: 22,
  xl: 42,
} as const;

export const radius = {
  none: 0,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  full: 999,
} as const;

export const fontSize = {
  eyebrow: 11,
  body: 14,
  title: 18,
  display: 40,
} as const;

export type Colors = typeof colors;
export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type FontSize = typeof fontSize;
