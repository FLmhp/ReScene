# 002 按账户隔离 Android 与微信离线队列

> 基线为 `21b2052`，日期 2026-11-20。先运行 `git diff --stat 21b2052..HEAD -- apps/mobile/src apps/miniapp/src packages/uploader/src`。如果其他计划已修改相同页面，对照函数级锚点复核。验收完成后更新索引。

**优先级 P1 · 安全与正确性 · 工作量 M · 修复风险中 · 无前置计划**

## 目标与现状

离线草稿和待上传文件只能由记录所属账户重放。弱网时仍允许已有可信绑定的当前账户入队，账户切换保留旧账户的本地队列，外观偏好仍按设备保存。

- `apps/mobile/src/queue.ts:7` 写 `rescene-queue.json`，`apps/miniapp/src/queue.ts:13` 写 `rescene-queue`。两者以设备为范围。`packages/uploader/src/queue.ts:20` 的项目草稿只有 `kind, id, name, createdAt`。
- `packages/uploader/src/queue.ts:79` 通过 `handlers.createProject(entry.name)` 重建离线草稿。两个平台都传入会更新认证状态的共享客户端。 `packages/api-client/src/index.ts:232` 从实例当前 token 构造请求头。
- `apps/mobile/src/api.ts:78` 已经在恢复时调用 `client.getMe()`。`apps/miniapp/src/pages/index/index.tsx:94`、141 和 181 也在恢复、登录和注册后读取用户。`src/rescene_api/main.py:347` 的用户 ID 是服务端稳定标识。
- 参考 `apps/miniapp/src/api.ts:60` 的逻辑，它用触发失败的认证头与当前 token 比较，防止迟到的 401 清除后续会话。

## 范围与 Git

修改 `apps/mobile/src/{api,queue,upload}.ts`、`apps/mobile/src/AppRoot.tsx`、`apps/mobile/src/screens/{Login,Project,Projects}.tsx`、`apps/miniapp/src/{api,polyfill,queue,upload}.ts`、`apps/miniapp/src/pages/{index,project}/index.tsx`、`scripts/check-miniapp-login.mjs`，以及在两端可复用时修改 `packages/uploader/src/{queue,queue.test,index}.ts`。Android 的 Login 调用真实登录入口，登录后的账户确认与保存一并受会话代次约束。微信在 API 模块按发起请求的会话代次处理 401，polyfill 只保留传输职责，构建后登录检查调用实际认证适配器。保持 API 路由、上传资产契约及队列条目结构兼容。存储并发由 005 实施，本计划建立账户、存储键和会话边界。使用 `codex/isolate-native-offline-queues`，提交如 `fix(uploader): isolate native queues by account`。平台发布走独立授权。

## 命令与预期

| 用途 | 命令 | 预期 |
|---|---|---|
| 回归 | `pnpm --filter @rescene/uploader test` | 现有和新增测试全过 |
| 类型 | `pnpm -r typecheck` | 退出 0 |
| Android | `pnpm --filter @rescene/mobile export` | 退出 0 |
| 小程序 | 按 `.github/workflows/check.yml:83` 设置三个 Taro 生产构建测试变量，运行 `pnpm --filter @rescene/miniapp build:weapp` 和 `node scripts/check-miniapp-login.mjs` | 均退出 0 |
| 格式与范围 | `git diff --check` 和 `git diff --name-only` | 无格式错误，文件在范围内 |

Node 22、pnpm 10.18.3，已有锁定依赖。真机或隔离设备环境使用两个测试账户，记录客户端版本和运行环境。

## 步骤

1. **建立会话绑定。** 以成功的 `getMe().id` 建立队列 owner，复用登录、注册和恢复的现有调用。需要跨冷启动离线时，和该会话的 token 一起存储已经验证的 ID，在 token 刷新时保持同一账户绑定。旧 token 首次离线恢复、网络不足以确认身份或绑定破损时暂停队列操作并提供简短状态反馈。登录切换、清理和 401 失效时立即使旧会话代次失效。根据请求发起时的代次拒绝迟到的 `getMe` 响应。验证 `pnpm -r typecheck` 和 uploader 会话测试。
2. **隔离存储。** 让每个队列入口显式接收捕获的当前账户上下文，文件名/键使用编码后的稳定 ID。读取、写入、回放、持久化 assetId、项目草稿入队都满足同一约束。把旧键存在视作待用户处理的数据。保留其原始内容，显示通用状态和重新添加所需素材的指引。界面不显示未确认属主条目的名称、路径和项目 ID。已绑定队列退出后保留。验证 uploader 序列化往返测试及两个账户在本机环境的存储断言。
3. **限制异步任务的身份。** 绑定重放启动时的账户、会话代次及请求认证上下文。可在当前平台 API 模块内使用其已有 `ResceneClient` 构造方式做该次操作的认证快照，微信沿用 `miniappFetch`。新的网络阶段启动前校验代次，发送中的请求仍使用原账户凭证，后续过期采用既有重试处理。失效时不继续上传或发送 complete。已得到的 assetId 只可归档到捕获的账户队列，失败条目保留以供原账户恢复。屏蔽旧会话的进度和 UI 提示。Android 进行中的恢复去重按会话边界处理，微信首页在确认当前账户之后重放。验证 uploader 测试、两个平台构建及真机切换。
4. **对照所有调用点。** 逐个检查两个平台的 `loadQueue`、`saveQueue`、`enqueue`、`replayQueued`、`uploadFile` 调用。运行 `rg -n 'loadQueue\(|saveQueue\(|enqueue\(|replayQueued\(' apps/mobile/src apps/miniapp/src`，每个使用共享队列的入口从已绑定会话取 owner。过期会话期间新界面只显示新账户的数据和进度。

## 测试与交付标准

- [ ] 在 `packages/uploader/src/queue.test.ts` 现有 Vitest 模式覆盖无属主队列、A/B 键稳定且不同、会话代次失效、同一账户刷新、迟到的账户响应和恢复。共享逻辑留在既有队列模块。平台桥接行为用设备验证。
- [ ] Android 和微信各完成 A 离线创建和入队、立即切换 B、B 联网且本地和服务端没有 A 的条目、A 重新登录后正常恢复。单独验证重放延迟时切号、冷启动离线、旧存储保持和同一账户刷新。
- [ ] 命令表全过，设备记录包含提交和结果，索引状态更新。

## 停止条件与维护

现有 WeChat 或 Android 接口若无法在不延长失效会话的前提下关联身份，保留暂停能力并报告受影响恢复路径。发现旧格式有可信属主元数据时先报告并重新评估迁移方式。后续引入其他离线动作时先约束账户归属。服务端已接收、客户端尚未收到响应的请求仍有重试歧义，若需服务端严格去重，另立 API 幂等计划。
