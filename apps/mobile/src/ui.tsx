import { COLORWAY_OPTIONS, THEME_OPTIONS, type Palette } from "@rescene/design-tokens";
import { BlurTargetView as ExpoBlurTargetView, BlurView as ExpoBlurView, type BlurTargetViewProps, type BlurViewProps } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useRef, useState, type ComponentRef, type ComponentType, type ReactNode, type RefAttributes, type RefObject } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { useAppearance } from "./appearance";
import { fontSize, radii, spacing } from "./theme";

type TargetView = ComponentRef<typeof View>;
type AcrylicTarget = RefObject<TargetView | null>;
// Expo Blur's declarations resolve their React Native ref to never with React 19.3.
const BlurTargetView = ExpoBlurTargetView as unknown as ComponentType<Omit<BlurTargetViewProps, "ref"> & RefAttributes<TargetView>>;
const BlurView = ExpoBlurView as unknown as ComponentType<Omit<BlurViewProps, "blurTarget"> & { blurTarget: AcrylicTarget }>;

export function Screen({
  children,
  title,
  scroll = false,
  footer,
  contentPaddingBottom,
}: {
  children: ReactNode;
  title: string;
  scroll?: boolean;
  footer?: ReactNode;
  contentPaddingBottom?: number;
}) {
  const { theme, preference, colorway, setPreference, setColorway } = useAppearance();
  const styles = makeStyles(theme);
  const backdrop = useRef<TargetView>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const content = <>
    <AcrylicSurface backdrop={backdrop}>
      <View style={styles.header}>
        <Image accessible={false} source={require("../assets/icon.png")} style={styles.brand} />
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="外观主题"
          accessibilityState={{ expanded: appearanceOpen }}
          onPress={() => setAppearanceOpen((open) => !open)}
          style={styles.appearanceButton}
        >
          <View style={styles.colorSwatch} />
          <Text style={styles.appearanceLabel}>{THEME_OPTIONS.find((item) => item.value === preference)?.label} ▾</Text>
        </Pressable>
      </View>
      {appearanceOpen ? <View style={styles.appearanceSettings}>
        <Text accessibilityRole="header" style={styles.label}>明暗</Text>
        <Segmented value={preference} options={THEME_OPTIONS} onChange={(value) => { setPreference(value); setAppearanceOpen(false); }} />
        <Text accessibilityRole="header" style={styles.label}>配色</Text>
        <Segmented value={colorway} options={COLORWAY_OPTIONS} onChange={(value) => { setColorway(value); setAppearanceOpen(false); }} />
      </View> : null}
    </AcrylicSurface>
    {children}
  </>;
  return (
    <View style={styles.stage}>
      <BlurTargetView ref={backdrop} pointerEvents="none" style={StyleSheet.absoluteFill}>
        <LinearGradient
          colors={[theme.bgSoft, theme.bgDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </BlurTargetView>
      {scroll ? <ScrollView
        contentContainerStyle={[styles.scrollContent, contentPaddingBottom !== undefined && { paddingBottom: contentPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
      >{content}</ScrollView> : <View style={styles.screen}>{content}</View>}
      {scroll && footer ? <AcrylicSurface backdrop={backdrop} edge>{footer}</AcrylicSurface> : null}
    </View>
  );
}

function AcrylicSurface({ backdrop, children, edge = false }: { backdrop: AcrylicTarget; children: ReactNode; edge?: boolean }) {
  const { theme, dark } = useAppearance();
  return <View style={{
    borderColor: theme.borderSoft,
    borderWidth: edge ? 0 : 1,
    borderTopWidth: 1,
    borderRadius: edge ? 0 : radii.md,
    overflow: "hidden",
  }}>
    <BlurView
      pointerEvents="none"
      blurTarget={backdrop}
      blurMethod="dimezisBlurViewSdk31Plus"
      tint={dark ? "dark" : "light"}
      intensity={28}
      style={StyleSheet.absoluteFill}
    />
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.panel + (dark ? "C0" : "DC") }]} />
    {children}
  </View>;
}

export function Card({ children }: { children: ReactNode }) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return <View style={styles.card}>{children}</View>;
}

export function Field({
  label,
  value,
  onChangeText,
  secureTextEntry,
  autoComplete,
  keyboardType,
  textContentType,
  returnKeyType,
  onSubmitEditing,
  placeholder,
  autoFocus,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  multiline?: boolean;
  autoComplete?: TextInputProps["autoComplete"];
  keyboardType?: TextInputProps["keyboardType"];
  textContentType?: TextInputProps["textContentType"];
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  const [passwordVisible, setPasswordVisible] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoComplete={autoComplete}
        autoCorrect={false}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        returnKeyType={returnKeyType}
        secureTextEntry={secureTextEntry && !passwordVisible}
        style={[styles.input, multiline && styles.inputMultiline, secureTextEntry && { paddingRight: 64 }]}
        textContentType={textContentType}
        value={value}
      />
      {secureTextEntry ? <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? `隐藏${label}` : `显示${label}`} onPress={() => setPasswordVisible(!passwordVisible)} style={{ position: "absolute", right: 4, top: 2, minHeight: 44, minWidth: 52, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.accent }}>{passwordVisible ? "隐藏" : "显示"}</Text>
      </Pressable> : null}
      </View>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  tone = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost";
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true, busy: false }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === "primary" ? styles.primary : styles.ghost,
        (disabled || pressed) && styles.buttonPressed,
      ]}
    >
      <Text style={tone === "primary" ? styles.primaryText : styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

export function Busy({ label }: { label: string }) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return (
    <View accessibilityLabel={label} accessibilityLiveRegion="polite" accessibilityRole="progressbar" style={styles.busy}>
      <ActivityIndicator color={theme.accentStrong} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return (
    <View accessibilityRole="tablist" style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && styles.segmentActive]}
          >
            <Text style={selected ? styles.segmentTextActive : styles.segmentText}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const textStyles = useTextStyles();
  return (
    <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={textStyles.error}>
      {children}
    </Text>
  );
}

const makeStyles = (theme: Palette) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md },
  appearanceButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center" },
  appearanceLabel: { color: theme.accent, fontSize: 13 },
  colorSwatch: { width: 8, height: 8, backgroundColor: theme.accent, borderRadius: 4 },
  appearanceSettings: { gap: spacing.sm, borderTopColor: theme.divider, borderTopWidth: 1, padding: spacing.md },
  brand: { width: 32, height: 32, flexShrink: 0 },
  stage: { flex: 1, backgroundColor: theme.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },
  screen: { flex: 1, padding: spacing.lg, gap: spacing.md },
  title: { flex: 1, minWidth: 0, color: theme.fg, fontSize: 28, fontWeight: "700", lineHeight: 34 },
  card: {
    backgroundColor: theme.panel,
    borderColor: theme.divider,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  field: { gap: spacing.xs },
  label: { color: theme.muted, fontSize: fontSize.body },
  input: {
    backgroundColor: theme.bgSoft,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: theme.fg,
    fontSize: fontSize.body,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  inputMultiline: { minHeight: 108, paddingTop: 12, textAlignVertical: "top" },
  button: {
    borderRadius: radii.md,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: spacing.md,
  },
  primary: { backgroundColor: theme.accentStrong },
  ghost: { borderColor: theme.border, borderWidth: 1, backgroundColor: theme.surface },
  primaryText: { color: theme.onAccent, fontSize: fontSize.body, fontWeight: "700" },
  ghostText: { color: theme.fg, fontSize: fontSize.body, fontWeight: "600" },
  buttonPressed: { opacity: 0.6 },
  muted: { color: theme.muted },
  busy: { flexDirection: "row", gap: 10, alignItems: "center", paddingVertical: spacing.md },
  segmented: {
    flexDirection: "row",
    gap: 6,
    padding: 6,
    borderWidth: 1,
    borderColor: theme.divider,
    borderRadius: radii.md,
    backgroundColor: theme.panelAlt,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: radii.sm,
  },
  segmentActive: { backgroundColor: theme.surfaceStrong, borderColor: theme.borderSoft },
  segmentText: { color: theme.muted, fontWeight: "700" },
  segmentTextActive: { color: theme.fg, fontWeight: "700" },
});

const makeTextStyles = (theme: Palette) => StyleSheet.create({
  heading: { color: theme.fg, fontSize: 18, fontWeight: "700" },
  body: { color: theme.fg, fontSize: fontSize.body },
  muted: { color: theme.muted, fontSize: fontSize.body },
  error: { color: theme.danger, fontSize: fontSize.body },
});

export function useTextStyles() {
  const { theme } = useAppearance();
  return makeTextStyles(theme);
}


