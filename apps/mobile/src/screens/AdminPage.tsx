import type { ReactNode } from "react";
import { Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppearance } from "../appearance";
import { Screen } from "../ui";

export function AdminPage({ title, busy = false, onBack, children }: {
  title: string; busy?: boolean; onBack: () => void; children: ReactNode;
}) {
  const { theme } = useAppearance();
  const back = () => { if (!busy) onBack(); };
  return (
    <Modal presentationStyle="fullScreen" onRequestClose={back}>
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bgDeep }}>
        <Screen title={title} onBack={back} scroll>{children}</Screen>
      </SafeAreaView>
    </Modal>
  );
}
