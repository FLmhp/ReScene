import { useState, type ReactNode } from "react";
import type { Palette } from "@rescene/design-tokens";
import { THEME_OPTIONS } from "@rescene/design-tokens";
import { useAppearance } from "./appearance";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { fontSize, radii, spacing } from "./theme";

export function Screen({
  children,
  title,
  scroll = false,
}: {
  children: ReactNode;
  title: string;
  scroll?: boolean;
}) {
  const { theme } = useAppearance();
  const styles = makeStyles(theme);
  const header = <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, { flex: 1 }]}>{title}</Text><AppearancePicker /></View>;
  if (scroll) {
    return (
      <View style={styles.stage}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          style={styles.scroll}
        >
          {header}
          {children}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={styles.stage}>
      <View style={styles.screen}>
        {header}
        {children}
      </View>
    </View>
  );
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
  options: { value: T; label: string }[];
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
  header: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  stage: { flex: 1, backgroundColor: theme.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },
  screen: { flex: 1, padding: spacing.lg, gap: spacing.md },
  title: { color: theme.fg, fontSize: 30, fontWeight: "800", letterSpacing: -1 },
  card: {
    backgroundColor: theme.panel,
    borderColor: theme.divider,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 16 },
    elevation: 1,
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
  primary: {
    backgroundColor: theme.accentStrong,
    shadowColor: theme.accentStrong,
    shadowOpacity: 0.04,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 0,
  },
  ghost: { borderColor: theme.borderSoft, borderWidth: 1, backgroundColor: theme.surface },
  primaryText: { color: theme.onAccent, fontWeight: "800" },
  ghostText: { color: theme.fg, fontWeight: "600" },
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

function AppearancePicker() {
  const { preference, setPreference, theme } = useAppearance();
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel="外观主题" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}>
      <Text style={{ color: theme.accent }}>{THEME_OPTIONS.find((item) => item.value === preference)?.label} ▾</Text>
    </Pressable>
    {open ? <View style={{ backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.borderSoft, borderRadius: 10 }}>
      {THEME_OPTIONS.map((item) => <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: preference === item.value }} onPress={() => { setPreference(item.value); setOpen(false); }} style={{ minHeight: 44, padding: 10, justifyContent: "center" }}>
        <Text style={{ color: preference === item.value ? theme.accent : theme.fg }}>{item.label}</Text>
      </Pressable>)}
    </View> : null}
  </View>;
}
