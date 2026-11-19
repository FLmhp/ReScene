import type { Asset, Job, JobStatus, Profile } from "./index";

export const RECONSTRUCTION_PROFILES = {
  fast: { title: "快速预览", frames: 80, description: "先检查取景与视角覆盖" },
  balanced: { title: "均衡重建", frames: 80, description: "校正相机位姿，适合多数场景" },
  quality: { title: "精细重建", frames: 250, description: "生成稠密几何，耗时较长" },
} satisfies Record<Profile, { title: string; frames: number; description: string }>;

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: "排队中",
  LEASED: "正在准备",
  RUNNING: "重建中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

export const ASSET_STATUS_LABELS: Record<Asset["status"], string> = {
  UPLOADING: "上传中",
  READY: "可选",
  FAILED: "上传失败",
};

const STAGE_LABELS: Record<string, string> = {
  queued: "排队",
  download: "下载素材",
  preprocess: "筛选素材",
  geometry: "估计相机与几何",
  training: "训练 3D 场景",
  export: "导出模型",
  publishing: "发布产物",
  complete: "交付完成",
};

export function stageLabel(stage: string | null | undefined): string {
  return stage ? (STAGE_LABELS[stage] ?? stage) : "等待计算节点";
}

export function jobErrorHint(code: string | null | undefined): string {
  if (code === "INVALID_INPUT") return "检查素材格式、文件完整性和视角覆盖。更换无效素材后创建新任务。";
  if (code === "WORKER_LEASE_EXPIRED") return "计算节点失联，原执行已结束。";
  if (code === "INFRASTRUCTURE_ERROR") return "计算或存储暂时不可用，请稍后重试。";
  return "";
}

export function queuedJobHint(online: boolean | null | undefined): string {
  if (online === true) return "已排队，等待计算节点领取任务。";
  if (online === false) return "计算节点离线，任务将在节点上线后执行。";
  return "已排队，暂无法确认计算节点状态。";
}

export function canRetryJob(job: Pick<Job, "status" | "error_code">): boolean {
  return job.error_code !== "INVALID_INPUT" && (job.status === "FAILED" || job.status === "CANCELLED");
}

export function selectionBytes(items: Asset[]): number {
  return items.reduce((size, item) => size + item.size, 0);
}

export function selectWorkspaceAssets(current: Asset[], offered: Asset[], imagesOnly = false): Asset[] {
  if (!imagesOnly && offered.length === 1 && current.some((item) => item.id === offered[0]?.id)) {
    return current.filter((item) => item.id !== offered[0]?.id);
  }
  const image = (item: Asset) => /\.(jpe?g|png)$/i.test(item.filename);
  const additions = offered.filter((item) => item.status === "READY" && (!imagesOnly || image(item)));
  const selected = [...new Map([...current, ...additions].map((item) => [item.id, item])).values()];
  if (selected.length && !selected.every(image) && !(selected.length === 1 && /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(selected[0]!.filename))) {
    throw new Error("请选择一组图片或一个视频。选取其他类型前请清空选择。");
  }
  if (selected.length > 500 || selectionBytes(selected) > 8 * 1024 ** 3) {
    throw new Error("单个任务最多 500 个素材，合计不超过 8 GiB。");
  }
  return selected;
}

export function reconcileWorkspaceSelection(current: Asset[], page: Asset[]): Asset[] {
  const byId = new Map(page.map((item) => [item.id, item]));
  return current.map((item) => byId.get(item.id) ?? item).filter((item) => item.status === "READY");
}
