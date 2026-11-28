import { Button, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import { openHome } from "../../navigation";
import { Screen, WorkspaceEntry } from "../../screen";
import { ConfigureForm, type ConfigureState } from "./configure";
import { JobFocus } from "./job";
import { LibraryFocus } from "./library";
import { ManagementFocus } from "./management";

const VIEWS = ["new-project", "claim-invite", "notifications", "project-management", "configure", "job", "job-logs", "result", "shares"] as const;
type FocusView = (typeof VIEWS)[number];
const LIBRARY_VIEWS: FocusView[] = ["new-project", "claim-invite", "notifications"];
const TITLES: Record<FocusView, string> = {
  "new-project": "新建项目",
  "claim-invite": "领取邀请",
  notifications: "通知",
  "project-management": "项目管理",
  configure: "配置重建",
  job: "任务详情",
  "job-logs": "运行日志",
  result: "成果详情",
  shares: "分享管理",
};

type FocusEventChannel = { emit(name: string, ...args: unknown[]): void; on(name: string, callback: (payload: ConfigureState) => void): void; off(name: string, callback: (payload: ConfigureState) => void): void };

const LEGACY_SETTINGS: Record<string, { title: string; section: string | null }> = {
  settings: { title: "设置", section: null },
  appearance: { title: "外观", section: "appearance" },
  account: { title: "账户与安全", section: "account" },
  password: { title: "修改密码", section: "password" },
};

function focusView(value: string | undefined): FocusView | null {
  return VIEWS.find((view) => view === value) ?? null;
}

export default function FocusPage() {
  const params = useRouter()?.params ?? {};
  const view = focusView(params.view);
  const legacy = params.view && Object.prototype.hasOwnProperty.call(LEGACY_SETTINGS, params.view) ? LEGACY_SETTINGS[params.view] : null;
  const projectId = params.id ?? "";
  const jobId = params.job ?? "";
  const needsProject = view === "project-management" || view === "configure" || view === "job" || view === "job-logs" || view === "result" || view === "shares";
  const needsJob = view === "job" || view === "job-logs" || view === "result" || view === "shares";
  useEffect(() => {
    const title = view ? TITLES[view] : legacy?.title;
    if (title) void Taro.setNavigationBarTitle({ title }).catch(() => undefined);
  }, [view, legacy?.title]);
  if (legacy) {
    return <WorkspaceEntry><SettingsRedirect section={legacy.section} /></WorkspaceEntry>;
  }
  return <WorkspaceEntry hasTarget={Boolean(view)}>
    <Screen>
      {!view ? <View className="card"><Text className="error">页面参数无效，请返回后重新打开。</Text></View> : null}
      {view && ((needsProject && !projectId) || (needsJob && !jobId)) ? <View className="card">
        {needsProject && !projectId ? <Text className="error">缺少项目参数，请返回项目重新打开。</Text> : null}
        {needsJob && !jobId ? <Text className="error">缺少任务参数，请返回任务列表重新打开。</Text> : null}
      </View> : null}
      {view && LIBRARY_VIEWS.includes(view) ? <LibraryFocus view={view} /> : null}
      {view === "project-management" && projectId ? <ManagementFocus projectId={projectId} /> : null}
      {view === "configure" && projectId ? <ConfigureFocus projectId={projectId} /> : null}
      {view && needsJob && projectId && jobId ? <JobFocus projectId={projectId} jobId={jobId} view={view} /> : null}
    </Screen>
  </WorkspaceEntry>;
}

function SettingsRedirect({ section }: { section: string | null }) {
  const [failed, setFailed] = useState(false);
  const target = section ? `/pages/settings/index?section=${section}` : "/pages/settings/index";
  useEffect(() => {
    let active = true;
    void Taro.redirectTo({ url: target }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [target]);
  return <Screen>
    <Text className={failed ? "error" : "muted"}>{failed ? "无法打开设置，请返回首页后重试。" : "正在打开设置…"}</Text>
    <Button className="button ghost" onClick={() => void openHome().catch(() => undefined)}>返回首页</Button>
  </Screen>;
}

function openerChannel(): FocusEventChannel | undefined {
  return (Taro.getCurrentInstance().page as unknown as { getOpenerEventChannel?: () => FocusEventChannel } | undefined)?.getOpenerEventChannel?.();
}

function ConfigureFocus({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ConfigureState | null>(null);
  const [waiting, setWaiting] = useState(true);
  const channel = useRef<FocusEventChannel | null>(null);
  useEffect(() => {
    const found = openerChannel() ?? null;
    channel.current = found;
    if (!found) { setWaiting(false); return; }
    const onState = (next: ConfigureState) => { setState(next); setWaiting(false); };
    found.on("configure-state", onState);
    found.emit("configure-ready");
    const timer = setTimeout(() => setWaiting(false), 2500);
    return () => { clearTimeout(timer); found.off("configure-state", onState); found.emit("configure-close"); if (channel.current === found) channel.current = null; };
  }, []);
  const jobUrl = state?.jobId ? `/pages/focus/index?view=job&id=${encodeURIComponent(projectId)}&job=${encodeURIComponent(state.jobId)}` : "";
  useEffect(() => {
    if (jobUrl) void Taro.redirectTo({ url: jobUrl }).catch(() => undefined);
  }, [jobUrl]);
  return <ConfigureForm
    state={state}
    onPick={(profile) => channel.current?.emit("configure-pick", { profile })}
    onSubmit={(profile) => channel.current?.emit("configure-submit", { profile })}
    onOpenJob={() => { if (jobUrl) void Taro.redirectTo({ url: jobUrl }).catch(() => undefined); }}
    showTitle={false}
    waiting={waiting}
  />;
}
