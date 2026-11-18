import type { Asset, JobStatus, Profile } from "./index";

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
