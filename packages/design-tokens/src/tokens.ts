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
  { value: "rouge", label: "胭脂" },
  { value: "cinnabar", label: "朱砂" },
  { value: "ochre", label: "赭石" },
  { value: "indigo", label: "靛青" },
  { value: "custom", label: "自定义" },
] as const;
export type Colorway = (typeof COLORWAY_OPTIONS)[number]["value"];
export const COLORWAY_STORAGE_KEY = "rescene-colorway";

const palettes = { jade: { light: lightColors, dark: darkColors }, ultramarine, ink };
const primaryColors = { rouge: "#9E3150", cinnabar: "#B3483D", ochre: "#915A35", indigo: "#28536B" } as const;
export const DEFAULT_PRIMARY = "#28536B";
export const DISPLAY_STORAGE_KEY = "rescene-display";
export const FONT_SIZE_SCALES = { standard: 1, large: 1.15, "extra-large": 1.3 } as const;
export type DisplayPreferences = {
  colorway: Colorway;
  primary: string;
  fontSize: "standard" | "large" | "extra-large";
  surface: "auto" | "solid";
};

export function normalizePrimary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

export function colorwayPreference(value: unknown): Colorway {
  return COLORWAY_OPTIONS.some(option => option.value === value) ? value as Colorway : "jade";
}

export function displayPreferences(value: unknown, legacyColorway?: unknown): DisplayPreferences {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    colorway: COLORWAY_OPTIONS.some(option => option.value === data.colorway)
      ? data.colorway as Colorway : colorwayPreference(legacyColorway),
    primary: normalizePrimary(data.primary) ?? DEFAULT_PRIMARY,
    fontSize: data.fontSize === "large" || data.fontSize === "extra-large" ? data.fontSize : "standard",
    surface: data.surface === "solid" ? "solid" : "auto",
  };
}

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const hex = (channels: RGB): string => `#${channels.map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const mix = (from: RGB, to: RGB, amount: number): RGB => from.map((c, i) => Math.round(c * (1 - amount) + to[i] * amount)) as RGB;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
function luminance(color: RGB): number {
  const linear = color.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: RGB, b: RGB): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function legible(base: RGB, direction: RGB, backgrounds: RGB[]): RGB {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(base, direction, step / 100);
    if (backgrounds.every(background => contrast(candidate, background) >= 4.5)) return candidate;
  }
  return direction;
}

export function deriveMonochromePalette(primary: string, dark: boolean): Palette {
  const source = rgb(normalizePrimary(primary) ?? DEFAULT_PRIMARY);
  const w = (p: number) => mix(WHITE, source, p / 100);
  const b = (p: number) => mix(BLACK, source, p / 100);
  const bg = dark ? b(13) : w(4);
  let bgDeep = dark ? b(7) : w(15);
  let bgSoft = dark ? b(28) : w(2);
  if (Math.max(...bgSoft.map((channel, i) => Math.abs(channel - bgDeep[i]))) < 8) {
    if (dark) bgSoft = mix(bgSoft, WHITE, 0.08);
    else bgDeep = mix(bgDeep, BLACK, 0.08);
  }
  const panel = dark ? b(18) : w(1);
  const panelAlt = dark ? b(13) : w(5);
  const surface = dark ? b(17) : w(3);
  const surfaceStrong = dark ? b(25) : w(14);
  const backgrounds = [bg, bgDeep, bgSoft, panel, panelAlt, surface, surfaceStrong];
  const direction = dark ? WHITE : BLACK;
  const text = (base: RGB) => hex(legible(base, direction, backgrounds));
  const onAccent = dark ? BLACK : WHITE;
  const accent = (base: RGB) => hex(legible(base, direction, [...backgrounds, onAccent]));
  return {
    ...(dark ? darkColors : lightColors),
    bg: hex(bg), bgDeep: hex(bgDeep), bgSoft: hex(bgSoft), panel: hex(panel),
    panelAlt: hex(panelAlt), surface: hex(surface), surfaceStrong: hex(surfaceStrong),
    border: hex(dark ? b(62) : b(45)), borderSoft: hex(dark ? b(38) : w(23)),
    divider: hex(dark ? b(25) : w(11)), fg: text(dark ? w(8) : b(20)),
    muted: text(dark ? w(26) : b(34)), accent: accent(dark ? w(28) : b(52)),
    accentStrong: accent(dark ? w(20) : b(42)), accentAlt: accent(dark ? w(24) : b(46)),
    onAccent: hex(onAccent),
  };
}

export function resolvePalette(colorway: Colorway, dark: boolean, customPrimary?: string): Palette {
  if (colorway === "jade" || colorway === "ultramarine" || colorway === "ink") {
    return palettes[colorway][dark ? "dark" : "light"];
  }
  return deriveMonochromePalette(colorway === "custom" ? customPrimary ?? DEFAULT_PRIMARY : primaryColors[colorway], dark);
}

export function paletteCssVariables(palette: Palette): Record<`--${string}`, string> {
  const result: Record<`--${string}`, string> = {};
  for (const key of Object.keys(darkColors) as (keyof Palette)[]) {
    const name = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    result[`--${name}`] = palette[key];
  }
  return result;
}

export function applyDisplayToRoot(root: HTMLElement, dark: boolean, display: DisplayPreferences): void {
  const normalized = displayPreferences(display);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.colorway = normalized.colorway;
  root.dataset.primary = normalized.primary;
  root.dataset.fontSize = normalized.fontSize;
  root.dataset.surface = normalized.surface;
  for (const [name, value] of Object.entries(paletteCssVariables(resolvePalette(normalized.colorway, dark, normalized.primary)))) {
    root.style.setProperty(name, value);
  }
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
