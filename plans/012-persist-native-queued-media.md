# 计划 012 · 让原生离线上传保存素材字节

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- apps/mobile/src/queue.ts apps/mobile/src/upload.ts apps/mobile/src/screens/Project.tsx apps/miniapp/src/queue.ts apps/miniapp/src/upload.ts apps/miniapp/src/pages/project/index.tsx packages/uploader/src/queue.ts packages/uploader/src/queue.test.ts scripts/check-miniapp-login.mjs`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** L
- **修复风险** 中，跨平台文件生命周期与空间配额
- **类别** 原生／数据完整性
- **基线** `21b2052`，2026-11-21，审计发现 A07
- **依赖** [005](005-make-native-replay-concurrency-safe.md) 已在独立分支 `cced25e` 交付。原生项目重放或素材队列验收须在保留其账户隔离与队列事务语义的集成头执行。

## 影响

仅将临时文件 URI 存到队列并不能保证重启后可读。系统回收微信临时文件或 Android 缓存后，重放失去素材且仍可能提示已保存。

## 当前实现

- `apps/mobile/src/screens/Project.tsx:147,162` 中，`copyToCacheDirectory: true，文件 URI 直接 enqueue`。
- `apps/miniapp/src/upload.ts:144,182` 中，`path: file.tempFilePath，上传时 hashOf(file.path)`。
- `packages/uploader/src/queue.ts:86` 中，`非冲突失败保留队列供重试`。

基于 005 的账户队列键、并发控制和每条队列项的处理权。Android 使用现有 Expo 文件系统，微信使用 Taro 文件系统与应用用户目录。保存文件先于对外承诺持久化。

## 范围

允许修改以下文件或指定路径。

- `apps/mobile/src/{queue.ts,upload.ts,screens/Project.tsx}`
- `apps/miniapp/src/{queue.ts,upload.ts,pages/project/index.tsx}`
- `packages/uploader/src/{queue.ts,queue.test.ts}`
- `scripts/check-miniapp-login.mjs`

相关后续工作可单独处理，包括桌面缓存、删除用户原始文件、云端素材保留策略、跨设备同步。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。在 PowerShell 用同名 `$env:` 变量设置表中的三个示例值后执行构建。示例 AppID 只用于编译测试。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/uploader test` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter @rescene/mobile export` | Android bundle 导出成功 |
| `TARO_APP_API_URL=https://api.example.com TARO_APP_WEB_URL=https://app.example.com TARO_APP_WECHAT_APP_ID=wx0123456789abcdef pnpm --filter @rescene/miniapp build:weapp` | Taro 微信生产模式编译成功 |
| `node scripts/check-miniapp-login.mjs` | 本地编译产物回归通过 |

在 Android 和真实微信应用上下文各做一次合成素材验证，首轮断网入队后结束并重启客户端，仅移除验收夹具创建的临时文件，恢复网络并断言应用管理副本仍可上传。记录模拟器、DevTools 与真机来源。

## 实施步骤

### 1. 管理账户所属素材文件

为队列拥有的副本选择稳定且隔离的路径，复制、验证大小再提交队列引用。配额、失败回滚与重试保留按平台现有限制执行。只删除由该队列拥有的确定路径，不处理原始文件。

验证 `pnpm --filter @rescene/uploader test`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 处理旧条目与结束清理

兼容旧缓存路径，可读时迁移，丢失时显示重新选择或取消入口而不是重复哈希。成功或明确取消后清理副本。暂时失败和跨账户退出保留。替换文件按既有元数据与 assetId 规则校验，不混用素材。

按验证表编译微信小程序，再执行 `node scripts/check-miniapp-login.mjs`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

复制失败无残留队列、缺失旧文件提示、完成清理、失败续传保留、账户 A/B 路径隔离、存储不足、大视频文件和 005 并发更新。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/persist-native-queued-media` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

集成头缺 005 的账户隔离或设备平台配额不足以稳妥复制大文件时，记录平台上限并提供缺文件恢复路径，不能承诺无法持久化的条目已保存。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增原生挑选入口须沿用托管文件入队流程，并定期核对平台路径和配额。
