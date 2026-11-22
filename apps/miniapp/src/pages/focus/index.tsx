import { Button, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import { hasToken } from "../../api";
import { Screen, WorkspaceEntry, AppearancePage } from "../../screen";
import { ConfigureForm, type ConfigureState } from "./configure";
import { JobFocus } from "./job";
import { LibraryFocus } from "./library";
import { ManagementFocus } from "./management";

const VIEWS = ["new-project", "claim-invite", "notifications", "settings", "appearance", "account", "password", "project-management", "configure", "job", "job-logs", "result", "shares"] as const;
type FocusView = (typeof VIEWS)[number];
const LIBRARY_VIEWS: FocusView[] = ["new-project", "claim-invite", "notifications", "settings", "account", "password"];
const TITLES: Record<FocusView, string> = {
  "new-project": "新建项目",
  "claim-invite": "领取邀请",
  notifications: "通知",
  settings: "设置",
  appearance: "外观",
  account: "账户",
  password: "修改密码",
  "project-management": "项目管理",
  configure: "配置重建",
  job: "任务详情",
  "job-logs": "运行日志",
  result: "成果详情",
  shares: "分享管理",
};

type FocusEventChannel = { emit(name: string, ...args: unknown[]): void; on(name: string, callback: (payload: ConfigureState) => void): void; off(name: string, callback: (payload: ConfigureState) => void): void };

function focusView(value: string | undefined): FocusView | null {
  return VIEWS.find((view) => view === value) ?? null;
}

export default function FocusPage() {
  const params = useRouter()?.params ?? {};
  const view = focusView(params.view);
  const projectId = params.id ?? "";
  const jobId = params.job ?? "";
  const needsProject = view === "project-management" || view === "configure" || view === "job" || view === "job-logs" || view === "result" || view === "shares";
  const needsJob = view === "job" || view === "job-logs" || view === "result" || view === "shares";
  useEffect(() => { if (view) void Taro.setNavigationBarTitle({ title: TITLES[view] }).catch(() => undefined); }, [view]);
  if (view === "appearance") return <Screen><AppearancePage /></Screen>;
  if (view === "settings" && !hasToken()) return <Screen><Button className="button ghost" onClick={() => void Taro.navigateTo({ url: "/pages/focus/index?view=appearance" }).catch(() => undefined)}>外观</Button></Screen>;
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
