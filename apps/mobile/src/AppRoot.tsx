import { legalDocuments, type LegalDocumentId } from "@rescene/schemas";
import { useCallback, useEffect, useState, type PropsWithChildren } from "react";
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  apiBaseUrl,
  clearSession,
  client,
  currentQueueOwner,
  discardSession,
  onSessionExpired,
  restoreSession,
  sessionExpiry,
  type RestoredSession,
} from "./api";
import { AdminScreen } from "./screens/Admin";
import { JobScreen } from "./screens/Job";
import { LoginScreen, type AuthMode } from "./screens/Login";
import { ProjectScreen, type ProjectDraft } from "./screens/Project";
import { ProjectsScreen } from "./screens/Projects";
import {
  AccountSettingsScreen,
  LegalDocumentScreen,
  LegalScreen,
  NotificationSettingsScreen,
  PasswordSettingsScreen,
  SettingsScreen,
  type SettingsCategory,
} from "./screens/Settings";
import { ViewerScreen } from "./screens/ViewerScreen";
import { AppearanceProvider, useAppearance } from "./appearance";
import { AppearanceScreen, Busy, Button, ErrorText, ScaledText as Text, Screen, useTextStyles } from "./ui";

type RootPage = "projects" | "new-project" | "claim-invite" | "notifications";
type SettingsPage = "settings" | "settings-account" | "settings-password" | "settings-notifications" | "settings-appearance" | "settings-legal";
type JobPage = "job-logs" | "result" | "downloads" | "shares";
type Route =
  | { name: RootPage | SettingsPage | "configure" | "project-management" | JobPage }
  | { name: "settings-legal-document"; documentId: LegalDocumentId }
  | { name: "project"; id: string; label: string; draft?: ProjectDraft }
  | { name: "job"; id: string; entry: "job" | "result" }
  | { name: "viewer"; reconstructionId: string }
  | { name: "admin" };

type Session = "loading" | "signed-in" | "signed-out" | "offline";

const RETRY_AFTER_MS = 5 * 60_000;
const MAX_WAIT_MS = 6 * 60 * 60_000;

const ROUTE_TITLES: Record<string, string> = {
  projects: "项目列表",
  "new-project": "新建项目",
  "claim-invite": "领取邀请",
  notifications: "通知",
  settings: "设置",
  "settings-account": "账户与安全",
  "settings-password": "修改密码",
  "settings-notifications": "通知偏好",
  "settings-appearance": "外观",
  "settings-legal": "协议与许可",
  configure: "配置重建",
  "project-management": "项目管理",
  job: "任务详情",
  "job-logs": "运行日志",
  result: "成果详情",
  downloads: "下载与校验",
  shares: "分享管理",
  viewer: "三维场景",
  admin: "管理控制台",
};

const SETTINGS_ROUTES: Record<SettingsCategory, SettingsPage> = {
  account: "settings-account",
  notifications: "settings-notifications",
  appearance: "settings-appearance",
  legal: "settings-legal",
};

function routeTitle(route: Route): string {
  if (route.name === "project") return route.label;
  if (route.name === "settings-legal-document") {
    return legalDocuments.find((document) => document.id === route.documentId)?.title ?? "协议与许可";
  }
  return ROUTE_TITLES[route.name] ?? "ReScene";
}

function OfflineSession({ notice, onRetry, onForget }: { notice: string; onRetry: () => void; onForget: () => void }) {
  const textStyles = useTextStyles();
  return (
    <Screen title="无法验证会话">
      <ErrorText>{notice || "无法连接服务器，请检查网络后重试。"}</ErrorText>
      <Text style={textStyles.muted}>服务器地址：{apiBaseUrl}</Text>
      <Button label="重试" onPress={onRetry} />
      <Button label="清除本地会话" onPress={onForget} tone="ghost" />
    </Screen>
  );
}

function AppearanceFrame({ children }: PropsWithChildren) {
  const { theme, dark } = useAppearance();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={{ backgroundColor: theme.bg, flex: 1 }}>{children}</View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function AppRoot() {
  const [session, setSession] = useState<Session>("loading");
  const [routes, setRoutes] = useState<Route[]>([{ name: "projects" }]);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [materialsRequest, setMaterialsRequest] = useState(0);
  const route = routes[routes.length - 1]!;

  const push = (next: Route) => setRoutes((current) => [...current, next]);
  const back = useCallback(
    () => setRoutes((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    [],
  );
  const backToProject = useCallback(() => setRoutes((current) => {
    for (let index = current.length - 1; index >= 0; index -= 1) {
      if (current[index]?.name === "project") return current.slice(0, index + 1);
    }
    return current;
  }), []);
  const resetToLogin = useCallback((message: string) => {
    setRoutes([{ name: "projects" }]);
    setAuthMode("login");
    setNotice(message);
    setSession("signed-out");
  }, []);

  useEffect(() => onSessionExpired(() => resetToLogin("会话已失效，请重新登录。")), [resetToLogin]);

  const bootstrap = useCallback(async () => {
    setSession("loading");
    try {
      const result = await restoreSession();
      if (result === null) return;
      if (result === "offline" && currentQueueOwner()) {
        setSession("signed-in");
        return;
      }
      if (result === "offline") setNotice("无法连接服务器，离线队列已暂停。请联网验证当前账户后重试。");
      setSession(result);
    } catch {
      setNotice("无法访问设备的安全存储。请检查系统设置后重试。");
      setSession("offline");
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Renew shortly before expiry, or end the session once the credential has expired.
  useEffect(() => {
    if (session !== "signed-in") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      const token = client.getToken();
      const expiry = token ? sessionExpiry(token) : null;
      if (expiry === null) return;
      const remaining = expiry - Date.now();
      const delay = Math.min(MAX_WAIT_MS, Math.max(0, remaining > 60_000 ? remaining - 60_000 : 0));
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delay);
    };

    const tick = async () => {
      if (cancelled) return;
      let result: RestoredSession;
      try {
        result = await restoreSession();
      } catch {
        result = "offline";
      }
      if (cancelled || result === null) return;
      if (result === "signed-out") {
        resetToLogin("会话已失效，请重新登录。");
        return;
      }
      if (result === "signed-in") {
        setRevision((value) => value + 1);
        return;
      }
      const token = client.getToken();
      const expiry = token ? sessionExpiry(token) : null;
      if (expiry !== null && expiry <= Date.now()) {
        await discardSession().catch(() => undefined);
        if (!cancelled) resetToLogin("会话已过期，请重新登录。");
        return;
      }
      const retryIn = expiry === null ? RETRY_AFTER_MS : Math.min(RETRY_AFTER_MS, Math.max(0, expiry - Date.now()));
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, retryIn);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [resetToLogin, revision, session]);

  // Returning to the app revalidates silently; a rejected session returns to login.
  useEffect(() => {
    if (session !== "signed-in") return;
    let active = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void restoreSession()
        .then((result) => {
          if (!active) return;
          if (result === "signed-out") resetToLogin("会话已失效，请重新登录。");
          else if (result === "signed-in") setRevision((value) => value + 1);
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [resetToLogin, session]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (routes.length > 1 && (session === "signed-in" || session === "signed-out" || session === "offline")) {
        const top = routes[routes.length - 1];
        const projectBelow = routes.some((item) => item.name === "project");
        if (session === "signed-in" && projectBelow && (top?.name === "settings" || top?.name === "notifications")) {
          backToProject();
        } else {
          back();
        }
        return true;
      }
      if (session === "signed-out" && authMode !== "login") {
        setAuthMode("login");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [authMode, back, backToProject, routes, session]);

  useEffect(() => {
    if (session !== "signed-in") return;
    AccessibilityInfo.announceForAccessibility(routeTitle(route));
  }, [route, session]);

  async function signOut() {
    setSession("loading");
    const { revoked, cleared } = await clearSession();
    if (!cleared) {
      setNotice("无法清除设备上的登录信息。请检查系统安全存储设置后重试。");
      setSession("offline");
      return;
    }
    resetToLogin(
      revoked
        ? "已安全退出登录。"
        : "已在本地退出，但无法确认服务器已撤销会话。请联网后重新登录并退出，或联系管理员。",
    );
  }

  async function forgetLocalSession() {
    try {
      await discardSession();
      resetToLogin("本地登录信息已清除，请重新登录。");
    } catch {
      setNotice("无法访问设备的安全存储，无法清除登录信息。");
    }
  }

  let content;
  if (session === "loading") {
    content = (
      <Screen title="正在恢复会话">
        <Busy label="请稍候…" />
      </Screen>
    );
  } else if (session === "offline") {
    content = (
      <OfflineSession
        notice={notice}
        onForget={() => void forgetLocalSession()}
        onRetry={() => void bootstrap()}
      />
    );
  } else if (session === "signed-out") {
    content = (
      <LoginScreen
        mode={authMode}
        onModeChange={setAuthMode}
        notice={notice}
        onSignedIn={() => {
          setNotice("");
          setRoutes([{ name: "projects" }]);
          setSession("signed-in");
        }}
      />
    );
  } else {
    const project = [...routes].reverse().find((item): item is Extract<Route, { name: "project" }> => item.name === "project");
    const job = [...routes].reverse().find((item): item is Extract<Route, { name: "job" }> => item.name === "job");
    const rootPage: RootPage | null = route.name === "projects" || route.name === "new-project" || route.name === "claim-invite" || route.name === "notifications" ? route.name : null;
    const projectPage = route.name === "project" || route.name === "configure" || route.name === "project-management" ? route.name : null;
    const jobPage = route.name === "job" ? route.entry : route.name === "job-logs" || route.name === "result" || route.name === "downloads" || route.name === "shares" ? route.name : null;
    const previousRoute = routes[routes.length - 2];
    const projectBackLabel = previousRoute?.name === "notifications" ? "返回通知" : "返回项目列表";
    const settingsBackLabel = project ? "返回项目" : previousRoute?.name === "notifications" ? "返回通知" : "返回";
    const viewerBackLabel = previousRoute?.name === "result" ? "返回结果" : previousRoute?.name === "downloads" ? "返回下载" : "返回任务";
    const jobBackLabel = previousRoute === undefined
      ? "返回"
      : previousRoute.name === "job"
        ? "返回任务"
        : previousRoute.name === "result"
          ? "返回结果"
          : previousRoute.name === "project"
            ? job?.entry === "result" ? "返回结果" : "返回项目"
            : previousRoute.name === "notifications" ? "返回通知" : "返回";
    content = <>
      <ProjectsScreen
        page={rootPage}
        returnToProject={Boolean(project)}
        onReturnToProject={backToProject}
        onNavigate={(name) => name === "projects" ? setRoutes([{ name: "projects" }]) : push({ name })}
        onSettings={() => push({ name: "settings" })}
        onBack={back}
        onJob={(id) => push({ name: "job", id, entry: "job" })}
        onOpen={(item) => setRoutes((current) => [...(current.at(-1)?.name === "new-project" ? current.slice(0, -1) : current), { name: "project", id: item.id, label: item.name }])}
      />
      {project && <ProjectScreen
        key={project.id}
        page={projectPage}
        backLabel={projectBackLabel}
        materialsRequest={materialsRequest}
        onBack={back}
        onConfigure={() => push({ name: "configure" })}
        onManagement={() => push({ name: "project-management" })}
        onNavigateRoot={(name) => name === "projects" ? setRoutes([{ name: "projects" }]) : push({ name })}
        onJob={(id, draft, entry) => setRoutes((current) => {
          const index = current.findIndex((item) => item.name === "project" && item.id === project.id);
          if (index < 0) return current;
          const parent = current[index];
          if (parent.name !== "project") return current;
          return [...current.slice(0, index), { ...parent, draft }, { name: "job", id, entry }];
        })}
        project={{ id: project.id, name: project.label }}
        draft={project.draft}
      />}
      {job && <JobScreen
        key={job.id}
        jobId={job.id}
        page={jobPage}
        backLabel={jobBackLabel}
        onNavigate={(name) => push({ name })}
        onBack={back}
        onReplaceAssets={(item) => {
          setMaterialsRequest((value) => value + 1);
          setRoutes((current) => {
            const index = current.findIndex((entry) => entry.name === "project" && entry.id === item.id);
            return index >= 0 ? current.slice(0, index + 1) : [...current.slice(0, 1), { name: "project", id: item.id, label: item.name }];
          });
        }}
        onOpenScene={(reconstructionId) => push({ name: "viewer", reconstructionId })}
      />}
      {route.name === "settings" && <SettingsScreen
        backLabel={settingsBackLabel}
        onBack={project ? backToProject : back}
        onAdmin={() => push({ name: "admin" })}
        onOpen={(page) => push({ name: SETTINGS_ROUTES[page] })}
      />}
      {route.name === "settings-account" && <AccountSettingsScreen
        backLabel="返回设置"
        onBack={back}
        onChangePassword={() => push({ name: "settings-password" })}
        onSignOut={() => void signOut()}
      />}
      {route.name === "settings-password" && <PasswordSettingsScreen backLabel="返回账户与安全" onBack={back} />}
      {route.name === "settings-notifications" && <NotificationSettingsScreen backLabel="返回设置" onBack={back} />}
      {route.name === "settings-appearance" && <AppearanceScreen backLabel="返回设置" onBack={back} />}
      {route.name === "settings-legal" && <LegalScreen
        backLabel="返回设置"
        onBack={back}
        onOpen={(documentId) => push({ name: "settings-legal-document", documentId })}
      />}
      {route.name === "settings-legal-document" && <LegalDocumentScreen
        backLabel="返回协议与许可"
        documentId={route.documentId}
        onBack={back}
      />}
      {route.name === "admin" && <AdminScreen onBack={back} />}
      {route.name === "viewer" && <ViewerScreen backLabel={viewerBackLabel} onBack={back} reconstructionId={route.reconstructionId} />}
    </>;
  }

  return (
    <AppearanceProvider active={session === "signed-in"}>
      <AppearanceFrame>{content}</AppearanceFrame>
    </AppearanceProvider>
  );
}
