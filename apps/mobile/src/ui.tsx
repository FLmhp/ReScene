import { COLORWAY_OPTIONS, DEFAULT_PRIMARY, THEME_OPTIONS, colorwayPrimary, normalizePrimary, resolvePalette, type DisplayPreferences, type Palette } from "@rescene/design-tokens";
import { BlurTargetView as ExpoBlurTargetView, BlurView as ExpoBlurView, type BlurTargetViewProps, type BlurViewProps } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useState, type ComponentRef, type ComponentType, type ReactNode, type RefAttributes, type RefObject } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  TextInput,
  View,
  type ScrollViewInstance,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from "react-native";

import { useAppearance } from "./appearance";
import { radii, spacing } from "./theme";

type TargetView = ComponentRef<typeof View>;
type AcrylicTarget = RefObject<TargetView | null>;
// Expo Blur's declarations resolve their React Native ref to never with React 19.3.
const BlurTargetView = ExpoBlurTargetView as unknown as ComponentType<Omit<BlurTargetViewProps, "ref"> & RefAttributes<TargetView>>;
const BlurView = ExpoBlurView as unknown as ComponentType<Omit<BlurViewProps, "blurTarget"> & { blurTarget: AcrylicTarget }>;

const FONT_SIZE_OPTIONS: { value: DisplayPreferences["fontSize"]; label: string }[] = [
  { value: "standard", label: "标准 100%" },
  { value: "large", label: "较大 115%" },
  { value: "extra-large", label: "特大 130%" },
];
const SURFACE_OPTIONS: { value: DisplayPreferences["surface"]; label: string }[] = [
  { value: "auto", label: "跟随设备" },
  { value: "solid", label: "实色" },
];

export function ScaledText({ style, ...props }: TextProps) {
  const { scale } = useAppearance();
  const flattened = StyleSheet.flatten(style);
  return <NativeText {...props} style={[style, { fontSize: (flattened?.fontSize ?? 14) * scale, ...(flattened?.lineHeight === undefined ? {} : { lineHeight: flattened.lineHeight * scale }) }]} />;
}
const Text = ScaledText;

export function Screen({
  children, title, scroll = false, footer, onBack, backLabel = "返回", navigation, toolbar, scrollReset,
}: {
  children: ReactNode;
  title: string;
  scroll?: boolean;
  footer?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  navigation?: ReactNode;
  toolbar?: ReactNode;
  scrollReset?: number;
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  const backdrop = useRef<TargetView>(null);
  const scroller = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    if (scrollReset === undefined) return;
    scroller.current?.scrollTo({ y: 0, animated: false });
  }, [scrollReset]);
  const header = <AcrylicSurface backdrop={backdrop}>
    <View style={styles.header}>
      {onBack ? <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={styles.backButton}><Text style={{ color: theme.accent, fontSize: 16 }}>{backLabel}</Text></Pressable> : <Image accessible={false} source={require("../assets/icon.png")} style={styles.brand} />}
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    </View>
    {navigation}
    {toolbar}
  </AcrylicSurface>;
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
      {header}
      {scroll ? <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        ref={scroller}
        style={styles.scroll}
      >{children}</ScrollView> : <View style={styles.screen}>{children}</View>}
      {footer ? <AcrylicSurface backdrop={backdrop} edge>{footer}</AcrylicSurface> : null}
    </View>
  );
}

function AcrylicSurface({ backdrop, children, edge = false }: { backdrop: AcrylicTarget; children: ReactNode; edge?: boolean }) {
  const { theme, dark, display } = useAppearance();
  return <View style={{
    backgroundColor: display.surface === "solid" ? theme.panel : undefined,
    borderColor: theme.borderSoft,
    borderWidth: edge ? 0 : 1,
    borderTopWidth: 1,
    borderRadius: edge ? 0 : radii.md,
    overflow: "hidden",
  }}>
    {display.surface !== "solid" ? <>
      <BlurView
        pointerEvents="none"
        blurTarget={backdrop}
        blurMethod="dimezisBlurViewSdk31Plus"
        tint={dark ? "dark" : "light"}
        intensity={28}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.panel + (dark ? "C0" : "DC") }]} />
    </> : null}
    {children}
  </View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return <View style={[styles.card, style]}>{children}</View>;
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
  const { theme, scale } = useAppearance();
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
        style={[styles.input, { fontSize: 16 * scale, lineHeight: 22 * scale }, multiline && styles.inputMultiline, secureTextEntry && { paddingRight: 64 }]}
        textContentType={textContentType}
        value={value}
      />
      {secureTextEntry ? <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? `隐藏${label}` : `显示${label}`} onPress={() => setPasswordVisible(!passwordVisible)} style={{ position: "absolute", right: 4, top: 2, minHeight: 44, minWidth: 52, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.accent, fontSize: 16, lineHeight: 22 }}>{passwordVisible ? "隐藏" : "显示"}</Text>
      </Pressable> : null}
      </View>
    </View>
  );
}

export function Button({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  tone = "primary",
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost";
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
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

export function AppearanceScreen({ onBack, backLabel = "返回" }: { onBack: () => void; backLabel?: string }) {
  const { theme, dark, preference, display, saveError, setPreference, setDisplay, resetAppearance } = useAppearance();
  const [draft, setDraft] = useState(display.primary);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(display.primary), [display.primary]);
  const applyPrimary = () => {
    const primary = normalizePrimary(draft);
    if (!primary) { setInvalid(true); return; }
    setInvalid(false);
    setDraft(primary);
    setDisplay({ primary });
  };
  const preview = normalizePrimary(draft) ?? display.primary;
  const lightPreview = resolvePalette("custom", false, preview);
  const darkPreview = resolvePalette("custom", true, preview);
  return <Screen title="外观" scroll onBack={onBack} backLabel={backLabel}>
    <View style={{ width: "100%", maxWidth: 560, alignSelf: "center", gap: spacing.lg }}>
      <Text style={{ color: theme.muted, fontSize: 14, lineHeight: 20 }}>仅此设备 · 外观不会同步到其他设备。</Text>
      {saveError ? <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ color: theme.danger, fontSize: 16 }}>{saveError}</Text> : null}
      <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 18, fontWeight: "600" }}>外观主题</Text>
        <Segmented value={preference} options={THEME_OPTIONS} onChange={setPreference} />
      </View>
      <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 18, fontWeight: "600" }}>配色</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {COLORWAY_OPTIONS.map((option) => {
            const selected = option.value === display.colorway;
            return <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`配色：${option.label}`}
              accessibilityState={{ checked: selected }}
              onPress={() => setDisplay({ colorway: option.value })}
              style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: radii.sm, borderColor: selected ? theme.accent : theme.borderSoft, backgroundColor: selected ? theme.surfaceStrong : theme.panel }}
            >
              <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: theme.borderSoft, backgroundColor: colorwayPrimary(option.value, display.primary) }} />
              <Text style={{ color: theme.fg, fontSize: 16, fontWeight: selected ? "600" : "400" }}>{option.label}</Text>
            </Pressable>;
          })}
        </View>
      </View>
      {display.colorway === "custom" ? <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 18, fontWeight: "600" }}>主色调</Text>
        <Field label="HEX" value={draft} onChangeText={(value) => { setDraft(value); setInvalid(false); }} onSubmitEditing={applyPrimary} returnKeyType="done" />
        {invalid ? <ErrorText>请输入 6 位十六进制颜色，例如 #28536B。</ErrorText> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View accessible accessibilityLabel={`主色预览 ${preview}`} style={{ width: 28, height: 28, backgroundColor: preview, borderWidth: 1, borderColor: theme.border }} /><Text style={{ color: theme.fg }}>{display.primary}</Text>{preview !== display.primary ? <Text style={{ color: theme.muted }}>预览 {preview}</Text> : null}</View>
        <Button label="应用主色" onPress={applyPrimary} />
        {[{ label: "浅色", palette: lightPreview }, { label: "深色", palette: darkPreview }].map(({ label, palette }) => <View key={label} style={{ gap: 4 }}><Text style={{ color: theme.fg }}>{label}</Text><LinearGradient accessible accessibilityLabel={`${label}渐变预览`} colors={[palette.bgSoft, palette.bgDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ height: 36, borderWidth: 1, borderColor: theme.border }} /></View>)}
      </View> : null}
      <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 18, fontWeight: "600" }}>字体大小</Text>
        <Segmented value={display.fontSize} options={FONT_SIZE_OPTIONS} onChange={(fontSize) => setDisplay({ fontSize })} />
      </View>
      <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="header" style={{ color: theme.fg, fontSize: 18, fontWeight: "600" }}>面板效果</Text>
        <Segmented value={display.surface} options={SURFACE_OPTIONS} onChange={(surface) => setDisplay({ surface })} />
      </View>
      <Button label="恢复默认外观" tone="ghost" onPress={() => { resetAppearance(); setDraft(DEFAULT_PRIMARY); setInvalid(false); }} />
    </View>
  </Screen>;
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
  backButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", paddingHorizontal: 2, flexShrink: 0 },
  brand: { width: 32, height: 32, flexShrink: 0 },
  stage: { flex: 1, backgroundColor: theme.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, width: "100%", maxWidth: 1120, alignSelf: "center", padding: spacing.lg, gap: spacing.md },
  screen: { flex: 1, width: "100%", maxWidth: 1120, alignSelf: "center", padding: spacing.lg, gap: spacing.md },
  title: { flex: 1, minWidth: 0, color: theme.fg, fontSize: 28, fontWeight: "600", lineHeight: 34 },
  card: {
    backgroundColor: theme.panel,
    borderColor: theme.divider,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  field: { gap: spacing.xs },
  label: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  input: {
    backgroundColor: theme.bgSoft,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: theme.fg,
    fontSize: 16,
    lineHeight: 22,
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
  primaryText: { color: theme.onAccent, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  ghostText: { color: theme.fg, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  buttonPressed: { opacity: 0.6 },
  muted: { color: theme.muted, fontSize: 14, lineHeight: 20 },
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
  segmentText: { color: theme.muted, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  segmentTextActive: { color: theme.fg, fontSize: 16, lineHeight: 22, fontWeight: "600" },
});

const makeTextStyles = (theme: Palette) => StyleSheet.create({
  heading: { color: theme.fg, fontSize: 18, lineHeight: 24, fontWeight: "600" },
  body: { color: theme.fg, fontSize: 16, lineHeight: 22 },
  muted: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  error: { color: theme.danger, fontSize: 16, lineHeight: 22 },
  numeric: { fontVariant: ["tabular-nums"] },
});

export function useTextStyles() {
  const { theme } = useAppearance();
  return makeTextStyles(theme);
}


