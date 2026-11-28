import { useState } from "react";
import { View } from "react-native";

import { Screen, Segmented } from "../ui";

import { AdminAnnouncementSection } from "./AdminAnnouncementSection";
import { AdminAuditSection } from "./AdminAuditSection";
import { AdminUserSection } from "./AdminUserSection";

type AdminTab = "users" | "announcements" | "logs";

const TABS: { value: AdminTab; label: string }[] = [
  { value: "users", label: "用户管理" },
  { value: "announcements", label: "公告管理" },
  { value: "logs", label: "审计日志" },
];

export function AdminScreen({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<AdminTab>("users");
  return (
    <Screen scroll title="管理控制台" onBack={onBack}>
      <Segmented value={tab} onChange={setTab} options={TABS} />
      <View style={{ display: tab === "users" ? "flex" : "none" }}>
        <AdminUserSection />
      </View>
      <View style={{ display: tab === "announcements" ? "flex" : "none" }}>
        <AdminAnnouncementSection />
      </View>
      <View style={{ display: tab === "logs" ? "flex" : "none" }}>
        <AdminAuditSection />
      </View>
    </Screen>
  );
}
