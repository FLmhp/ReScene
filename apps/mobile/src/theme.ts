import {
  colors,
  fontSize as fontSizeTokens,
  radius as radiusTokens,
  spacing as spacingTokens,
} from "@rescene/design-tokens";

/** Re-exported shared tokens for React Native components. */
export const theme = colors;
export const spacing = spacingTokens;
export const radii = radiusTokens;
export const fontSize = fontSizeTokens;

/**
 * Accent ramp for the glassmorphism look. React Native has no native gradient,
 * so gradient surfaces are approximated with `accentStrong` fills plus `glow`.
 */
export const gradients = { accent: ["#7C9BFF", "#A78BFA"] as const };

/** Ambient light painted behind a screen (top-left and top-right washes). */
export const glow = { a: "rgba(124,155,255,0.22)", b: "rgba(167,139,250,0.18)" };

