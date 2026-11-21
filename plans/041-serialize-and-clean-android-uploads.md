# 041 · Android 串行上传与缓存清理

## 现状

- `apps/mobile/src/screens/Project.tsx:181-198`：选择多个文件后，对每个 id `void runUpload(owner, id)`，50 张图会同时启动 50 个上传。
- `apps/mobile/src/upload.ts:106-136`：每个上传把整个文件写进 `Paths.cache/<boundary>.post` 再发 OSS；同时持有管理副本、picker 缓存副本和 body 副本。
- `Project.tsx:167` 使用 `copyToCacheDirectory: true`，picker 会再复制一份；`upload.ts:44` 又复制到 `documentDirectory/rescene-media`，picker URI 之后不再使用，也没有删除。
- `apps/miniapp/src/pages/project/index.tsx:284-308` 已经用 `uploadLock` 串行化，Android 行为与之不一致。
- `upload.ts:146` 只在正常路径删除 `.post`；进程被杀/异常会留下大文件。

## 变更范围

- `apps/mobile/src/screens/Project.tsx` 的上传循环/重试入口。
- `apps/mobile/src/upload.ts` 的 body 创建与清理。
- 可能新增 `apps/mobile` 的 vitest 或现有 `scripts/check-mobile-viewer.cjs` 夹具。

## 步骤

1. 把“每个 id 立即 runUpload”改为单个顺序 worker：一个 batch 内 `for` 循环 `await runUpload`，失败后继续下一个；保留单文件重试按钮。
2. 上传前检查可用空间（`Paths.availableDiskSpace` 或 `expo-file-system` 等价 API），不足时在进入 body 写入前报“设备存储不足”，不要把队列项留在不可成功的重试状态。
3. `persistPickedFile` 成功后 best-effort 删除 picker 缓存 URI；`content://` 删除失败不能影响上传。
4. `postToOss` 的 `.post` 写入/发送放入 `try/finally`，异常路径删除；应用启动时清理 `Paths.cache/*.post` 的孤儿文件。
5. 成功/放弃上传后仍只删除管理副本；不要删除用户原始文件。
6. 回归夹具覆盖：两文件串行、第二文件失败后第一文件进度保留、磁盘不足不写 body、picker 副本删除失败不阻断。

## 验证

- 在 Android 模拟器/真机选 8 张图，观察同一时刻只有一个 `.post`/OSS 请求，进度按文件推进。
- 用测试夹具注入 ENOSPC/异常，确认 body 被清理且队列项可重试。
- 上传完成后检查 `Paths.cache` 中没有对应 `.post` 和 picker 副本。

## 验收

- 多选上传的峰值磁盘不再随文件数线性叠加。
- 中断上传不留下大 body/缓存副本。
- 串行化不改变断网排队、账户隔离和单文件重试语义。

## 风险与回退

- 串行会降低大批量吞吐；这是单设备/单网络的预期取舍。若用户明确选择并发，可后续加“最多 N 个并发”的显式上限，而不是无界 `void`。
