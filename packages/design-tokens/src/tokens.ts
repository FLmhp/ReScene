/**
 * Shared design variables for Web, Desktop, Mobile, and the Mini Program.
 *
 * Dark glassmorphism: a fixed near-black stage, translucent white surfaces that
 * sit on top of it, and one blue→violet accent gradient for actions. Border
 * tokens stay at >=3:1 against `bg` for control boundaries; text uses `fg` and
 * `muted` at >=7:1. Mobile and the Mini Program import the TypeScript values
 * directly, so every value here must be a plain RN/wxss-compatible literal.
 */

export const colors = {
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
