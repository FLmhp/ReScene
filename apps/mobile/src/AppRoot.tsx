import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Text,
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
import { LoginScreen } from "./screens/Login";
import { ProjectScreen, type ProjectDraft } from "./screens/Project";
import { ProjectsScreen } from "./screens/Projects";
import { ViewerScreen } from "./screens/ViewerScreen";
import { useAppearance } from "./appearance";
import { Busy, Button, ErrorText, Screen } from "./ui";

type Route =
  | { name: "projects" }
  | { name: "project"; id: string; label: string; draft?: ProjectDraft }
  | { name: "job"; id: string }
  | { name: "viewer"; reconstructionId: string }
  | { name: "admin" };

type Session = "loading" | "signed-in" | "signed-out" | "offline";

const RETRY_AFTER_MS = 5 * 60_000;
const MAX_WAIT_MS = 6 * 60 * 60_000;

function routeTitle(route: Route): string {
  if (route.name === "project") return route.label;
  if (route.name === "job") return "重建任务";
  if (route.name === "viewer") return "三维场景";
  if (route.name === "admin") return "管理";
  return "项目";
}

export function AppRoot() {
  const { theme, dark } = useAppearance();
  const [session, setSession] = useState<Session>("loading");
  const [routes, setRoutes] = useState<Route[]>([{ name: "projects" }]);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const route = routes[routes.length - 1]!;

  const push = (next: Route) => setRoutes((current) => [...current, next]);
  const back = useCallback(
    () => setRoutes((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    [],
  );
  const resetToLogin = useCallback((message: string) => {
    setRoutes([{ name: "projects" }]);
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
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, RETRY_AFTER_MS);
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
      if (session !== "signed-in" || routes.length <= 1) return false;
      back();
      return true;
    });
    return () => subscription.remove();
  }, [back, routes.length, session]);

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
      <Screen title="无法验证会话">
        <ErrorText>{notice || "无法连接服务器，请检查网络后重试。"}</ErrorText>
        <Text style={{ color: theme.muted }}>服务器地址：{apiBaseUrl}</Text>
        <Button label="重试" onPress={() => void bootstrap()} />
        <Button label="清除本地会话" onPress={() => void forgetLocalSession()} tone="ghost" />
      </Screen>
    );
  } else if (session === "signed-out") {
    content = (
      <LoginScreen
        notice={notice}
        onSignedIn={() => {
          setNotice("");
          setRoutes([{ name: "projects" }]);
          setSession("signed-in");
        }}
      />
    );
  } else if (route.name === "admin") {
    content = <AdminScreen onBack={back} />;
  } else if (route.name === "viewer") {
    content = <ViewerScreen onBack={back} reconstructionId={route.reconstructionId} />;
  } else if (route.name === "job") {
    content = (
      <JobScreen
        jobId={route.id}
        onBack={back}
        onReplaceAssets={(project) => setRoutes((current) => {
          const parent = current.at(-2);
          if (parent?.name === "project" && parent.id === project.id) return current.slice(0, -1);
          return [...current.slice(0, -1), { name: "project", id: project.id, label: project.name }];
        })}
        onOpenScene={(reconstructionId) => push({ name: "viewer", reconstructionId })}
      />
    );
  } else if (route.name === "project") {
    content = (
      <ProjectScreen
        key={route.id}
        onBack={back}
        onJob={(id, draft) => setRoutes((current) => current.at(-1) === route
          ? [...current.slice(0, -1), { ...route, draft }, { name: "job", id }]
          : current)}
        project={{ id: route.id, name: route.label }}
        draft={route.draft}
      />
    );
  } else {
    content = (
      <ProjectsScreen
        onAdmin={() => push({ name: "admin" })}
        onJob={(id) => push({ name: "job", id })}
        onOpen={(project) => push({ name: "project", id: project.id, label: project.name })}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={{ backgroundColor: theme.bg, flex: 1 }}>{content}</View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
