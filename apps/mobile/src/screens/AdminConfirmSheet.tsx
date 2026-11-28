import type { ReactNode } from "react";
import { View } from "react-native";

import { useAppearance } from "../appearance";
import { spacing } from "../theme";
import { Button, Card, ScaledText as Text, useTextStyles } from "../ui";

export function AdminConfirmSheet({
  title,
  consequences,
  actionLabel,
  busy,
  disabled,
  children,
  destructive,
  onCancel,
  onConfirm,
}: {
  title: string;
  consequences: string[];
  actionLabel: string;
  busy?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { theme } = useAppearance();
  const textStyles = useTextStyles();
  return (
    <Card style={{ borderColor: destructive ? theme.danger : theme.accent, borderWidth: 2 }}>
      <Text accessibilityRole="header" style={textStyles.heading}>{title}</Text>
      <View style={{ gap: spacing.xs }}>
        {consequences.map((line, index) => (
          <Text key={index} style={textStyles.body}>• {line}</Text>
        ))}
      </View>
      {children}
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="取消" tone="ghost" disabled={busy} onPress={onCancel} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={busy ? "处理中…" : actionLabel}
            disabled={busy || disabled}
            onPress={onConfirm}
          />
        </View>
      </View>
    </Card>
  );
}
