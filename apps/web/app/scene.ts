import { ResceneApiError } from "@rescene/api-client";

export type SceneArtifact = { kind: string; url: string };

/** Prefer SPZ, fall back to legacy PLY exports. */
export function pickScene(artifacts: SceneArtifact[]): string {
  return (
    artifacts.find((item) => item.kind === "spz")?.url ??
    artifacts.find((item) => item.kind === "ply")?.url ??
    ""
  );
}

export function messageOf(reason: unknown): string {
  if (reason instanceof ResceneApiError) {
    if (reason.status === 401) return "登录已过期，请重新登录。";
    if (reason.status === 403) return "当前账号没有查看该重建的权限。";
    if (reason.status === 404) return "重建不存在，或链接已失效。";
    if (reason.status === 410) return "分享链接已失效。";
  }
  return reason instanceof Error ? reason.message : "加载失败";
}
