/**
 * Shared design variables for Web, Desktop, Mobile, and the Mini Program.
 *
 * Dark glassmorphism: a fixed near-black stage, translucent white surfaces that
 * sit on top of it, and one blue→violet accent gradient for actions. Border
 * tokens stay at >=3:1 against `bg` for control boundaries; text uses `fg` and
 * `muted` at >=7:1. Mobile and the Mini Program import the TypeScript values
 * directly, so every value here must be a plain RN/wxss-compatible literal.
 */

export const darkColors = {
  bg: "#0B0D12",
  bgDeep: "#07080C",
  bgSoft: "#0F1219",
  panel: "#151A23",
  panelAlt: "#0F131A",
  surface: "rgba(255, 255, 255, 0.055)",
  surfaceStrong: "rgba(255, 255, 255, 0.09)",
  border: "#5A6274",
  borderSoft: "rgba(255, 255, 255, 0.14)",
  divider: "rgba(255, 255, 255, 0.08)",
  fg: "#F2F4F8",
  muted: "#B9C0CE",
  accent: "#8AA4FF",
  accentStrong: "#7C9BFF",
  accentAlt: "#A78BFA",
  onAccent: "#080A10",
  danger: "#FF9EA3",
  success: "#7FE3B0",
  overlay: "rgba(7, 8, 12, 0.78)",
} as const;

export type Palette = { [Key in keyof typeof darkColors]: string };

export const lightColors: Palette = {
  bg: "#F3F5F9", bgDeep: "#E9EDF4", bgSoft: "#F8FAFC",
  panel: "#FFFFFF", panelAlt: "#F5F7FB", surface: "#FFFFFF",
  surfaceStrong: "#EAF0FE", border: "#7C889C", borderSoft: "#D5DCE8",
  divider: "#E3E8F0", fg: "#17243A", muted: "#526178",
  accent: "#2859C5", accentStrong: "#2859C5", accentAlt: "#6354C7",
  onAccent: "#FFFFFF", danger: "#B4233C", success: "#146C43",
  overlay: "rgba(20, 32, 52, 0.45)",
};

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
