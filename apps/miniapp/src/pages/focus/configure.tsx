import { RECONSTRUCTION_PROFILES, type Profile } from "@rescene/schemas";
import { Button, Text, View } from "@tarojs/components";

export type ConfigureState = { chosenCount: number; byteCount: number; profile: Profile; workerOnline: boolean | null; submitting: boolean; canSubmit: boolean; error: string; jobId: string | null };

export function ConfigureForm({ state, onPick, onSubmit, onBack, onOpenJob, showTitle = true, waiting = false }: { state: ConfigureState | null; onPick: (profile: Profile) => void; onSubmit: (profile: Profile) => void; onBack?: () => void; onOpenJob?: () => void; showTitle?: boolean; waiting?: boolean }) {
  if (!state && waiting) return <Text className="muted">正在读取选材…</Text>;
  if (!state || !state.chosenCount) return <View className="card"><Text className="error">无法恢复选材，请返回素材重新选择。</Text>{onBack ? <Button className="button ghost" onClick={onBack}>返回素材</Button> : null}</View>;
  return <View className="card">
    {onBack ? <Button className="button ghost" onClick={onBack}>返回素材</Button> : null}
    {showTitle ? <Text className="title">配置重建</Text> : null}
    <Text>已选 {state.chosenCount} 个 · {(state.byteCount / 1024 ** 2).toFixed(1)} MiB</Text>
    {(["fast", "balanced", "quality"] as Profile[]).map((profile) => <Button key={profile} className={`button route-option${state.profile === profile ? " selected" : ""}`} aria-pressed={state.profile === profile} disabled={state.submitting || Boolean(state.jobId)} onClick={() => onPick(profile)}>
      <Text className="label">{RECONSTRUCTION_PROFILES[profile].title}</Text>
      <Text className="muted">{RECONSTRUCTION_PROFILES[profile].description} · 最多 {RECONSTRUCTION_PROFILES[profile].frames} 帧</Text>
    </Button>)}
    <Text className="muted">{state.workerOnline === null ? "暂无计算节点状态" : state.workerOnline ? "计算节点在线" : "计算节点离线，提交后排队"}</Text>
    {state.error ? <Text className="error">{state.error}</Text> : null}
    {state.jobId ? <Button className="button" onClick={onOpenJob}>查看任务</Button> : <Button className="button" disabled={!state.canSubmit || state.submitting} loading={state.submitting} onClick={() => onSubmit(state.profile)}>开始重建</Button>}
  </View>;
}
