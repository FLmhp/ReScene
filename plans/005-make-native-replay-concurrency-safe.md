# 005 防止离线重放覆盖新入队项

> 基线为 `21b2052`，日期 2026-11-20。先运行 `git diff --stat 21b2052..HEAD -- packages/uploader/src apps/mobile/src apps/miniapp/src`。预期 002 已修改这些文件。按本计划锚点核对其队列归属和会话契约。执行后更新索引。

**优先级 P1 · 正确性 · 工作量 M · 修复风险中 · 依赖 002**

## 目标与现状

后台重放、前台上传和入队同时发生时，任一成功完成只改变自己的队列条目。一个条目只允许一个本地上传或项目重放请求，同一素材继续使用原 assetId。

- `apps/mobile/src/queue.ts:40` 对读入的数组进行重放并在第 63 行 `saveQueue(result.remaining)`。`apps/miniapp/src/queue.ts:37` 和 61 行采用相同方式，第 55 行还把创建后的 assetId 通过未等待的全量写回持久化。
- Android 项目页 `apps/mobile/src/screens/Project.tsx:119` 用页面 ref 去重，随后直接读写完整数组。微信项目页 `apps/miniapp/src/pages/project/index.tsx:274` 同样直接修改数组。微信首页（第 119 行）和项目页（第 166 行）都触发重放。
- `packages/uploader/src/queue.ts:72` 提供现有顺序、失败保留和上传 409 处理规则。Vitest 样例在 `packages/uploader/src/queue.test.ts:21`。
- Android 上传实现（`apps/mobile/src/upload.ts:114`）已在发送 OSS 字节前等待 `onAsset`。微信上传实现（`apps/miniapp/src/upload.ts:210`）目前没有等待回调。

## 范围与 Git

修改 `packages/uploader/src/{queue,queue.test,index}.ts`、`apps/mobile/src/queue.ts`、`apps/mobile/src/screens/Project.tsx`、`apps/miniapp/src/queue.ts`、`apps/miniapp/src/upload.ts` 和 `apps/miniapp/src/pages/project/index.tsx`。只在调用签名实际变化时改 `apps/mobile/src/screens/Projects.tsx` 及 `apps/miniapp/src/pages/index/index.tsx`。编译检查 `scripts/check-miniapp-login.mjs` 通过新的重放入口继续验证账户隔离。使用 002 的已确认账户上下文与旧队列处理。保持 Web uploader、API、上传协议和用户原文件的行为范围。使用 `codex/make-native-replay-concurrency-safe`，例如 `fix(uploader): preserve entries queued during native replay`。

## 命令与预期

| 用途 | 命令 | 预期 |
|---|---|---|
| 回归 | `pnpm --filter @rescene/uploader test` | 现有测试和受控并发新增用例通过 |
| 类型 | `pnpm -r typecheck` | 退出 0 |
| Android | `pnpm --filter @rescene/mobile export` | 退出 0 |
| 小程序 | 配置 `.github/workflows/check.yml:83` 中三个 Taro 测试变量，运行 `pnpm --filter @rescene/miniapp build:weapp` 和 `node scripts/check-miniapp-login.mjs` | 均退出 0 |
| 范围 | `git diff --check` 和 `git diff --name-only` | 无错误，变更在范围内 |

依赖安装方式见 `CONTRIBUTING.md:5`。测试使用 Node 22、pnpm 10.18.3 和 uploader 现有 Vitest，避免给原生端新增测试框架。

## 步骤

1. **按条目串行化持久化。** 复用共享队列模块，每账户一条本地读改写串行链。入口为追加或去重添加、按 ID 写 assetId、按 ID 删除。每个写操作读取完成时的最新持久化状态。失败对调用方可见，链上后续写入仍能执行。网络操作发生在该写链之外。原生页面通过平台队列模块调用这些操作，移除 UI 层的整份数组写入。验证 `pnpm --filter @rescene/uploader test`，使用可控制的 Promise 注入并行的两个追加及状态修改，最终记录完整且顺序符合串行规则。
2. **让前台和后台共用条目占用。** 在平台队列实例维护按账户和条目 ID 的运行占用，前台主动上传也经过同一占用入口。按队列快照读取候选 ID，开始处理前读取最新条目。参考现有 `replayQueue`，复用单条或扩展现有结果提交机制，只更新当前条目并在释放占用之前完成持久化。一个完成的请求保留追加进来的 ID，使用旧快照的任务不会覆盖不同条目的变更。释放占用使用 `finally`。保持同账户重放入口 single-flight，002 的会话边界继续约束网络调用。验证两个重放和一次前台重试交错时，每次实际启动的网络上传计数为一。
3. **持久化续传 ID。** Android 和微信均在开始传输前等待保存 assetId 完成。微信将 `onAsset` 允许返回 Promise，然后沿用 Android 的 `await options?.onAsset?.(grant.asset_id)`。条目存储失败时报告失败、保留原条目，已经创建的上传会话沿用现有过期清理。保持已完成与上传 409 的现有收敛方式，重试类网络失败保留条目。测试传输失败、页面切换后重试复用同一 assetId、存储写入失败时不打开 OSS 传输和后续写链可继续。运行完整命令表。
4. **验收实际入口。** 在 Android 和微信隔离环境各进行离线入队、恢复联网启动重放、上传中新增项目或素材，以及同一条前台重试。记录最终队列、项目和素材计数、复用 ID、版本和设备。用装置可控网络或测试 API 暂停第一条请求，避免以定时睡眠代替可复现时序。

## 测试与交付标准

- [ ] 在 `packages/uploader/src/queue.test.ts` 增加重放中追加、不同条目同时更新、同一条竞争、失败后的锁释放和 assetId 持久化测试，使用手动 resolve 的 Promise 或现有 mock。
- [ ] 前台与后台共享占用，旧版本孤立队列行为符合 002。运行 `rg -n 'saveQueue\(|writeAsStringAsync|setStorageSync' apps/mobile/src apps/miniapp/src`，队列的整份写操作只位于相应存储适配器，且都受同一个账户写链约束。
- [ ] 命令表全过，两个平台验收通过，索引状态更新。

## 停止条件与维护

如果 002 的账户隔离尚未完成，先完成它再验证这份计划。当一个运行环境有多个进程同时写同一队列时，需要重新评估平台级锁。本计划覆盖单个客户端 JavaScript 运行环境中的并发。请求已到服务端而响应丢失时的项目重建严格幂等需要独立协议，保持为后续事项。
