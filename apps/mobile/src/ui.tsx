import type { ReactNode } from "react";
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

import { fontSize, glow, radii, spacing, theme } from "./theme";

export function Screen({
  children,
  title,
  scroll = false,
}: {
  children: ReactNode;
  title: string;
  scroll?: boolean;
}) {
  const header = (
    <>
      <Text accessibilityRole="header" style={styles.eyebrow}>
        RESCENE / MOBILE
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
    </>
  );
  const glows = (
    <>
      <View pointerEvents="none" style={styles.glowA} />
      <View pointerEvents="none" style={styles.glowB} />
    </>
  );
  if (scroll) {
    return (
      <View style={styles.stage}>
        {glows}
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
      {glows}
      <View style={styles.screen}>
        {header}
        {children}
      </View>
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
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
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
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
        secureTextEntry={secureTextEntry}
        style={multiline ? [styles.input, styles.inputMultiline] : styles.input}
        textContentType={textContentType}
        value={value}
      />
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
  return (
    <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={textStyles.error}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: theme.bg },
  glowA: {
    position: "absolute",
    top: -140,
    left: -110,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: glow.a,
  },
  glowB: {
    position: "absolute",
    top: -80,
    right: -130,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: glow.b,
  },
  scroll: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },
  screen: { flex: 1, padding: spacing.lg, gap: spacing.md },
  eyebrow: { color: theme.accent, fontSize: fontSize.eyebrow, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: theme.fg, fontSize: 30, fontWeight: "800", letterSpacing: -1 },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.divider,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 6,
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
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
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

export const textStyles = StyleSheet.create({
  body: { color: theme.fg, fontSize: fontSize.body },
  muted: { color: theme.muted, fontSize: fontSize.body },
  error: { color: theme.danger, fontSize: fontSize.body },
});
