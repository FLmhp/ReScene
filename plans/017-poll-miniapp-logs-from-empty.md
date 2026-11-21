# 计划 017 · 微信任务日志从空列表开始追踪

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- apps/miniapp/src/pages/project/index.tsx scripts/check-miniapp-login.mjs apps/miniapp/src/pages/project/job-logs.ts`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S
- **修复风险** 低，需处理后台暂停与响应乱序
- **类别** 正确性
- **基线** `21b2052`，2026-11-21，审计发现 A12
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

第一次日志请求为空时，定时器没有 last.id 直接返回。排队任务开始输出后，用户仍看不到实时日志。

## 当前实现

- `apps/miniapp/src/pages/project/index.tsx:225` 中，`选择 jobId 和 logLevel 后首次加载`。
- `apps/miniapp/src/pages/project/index.tsx:235` 中，`if (!last) return;`。
- `apps/miniapp/src/pages/project/index.tsx:247` 中，`离开 active 时清除定时器`。

沿用 `useDidHide`、`jobActive`、现有 `listJobLogs` 和增量 `afterId`。编译产物测试复用现有 Taro API 假实现。

## 范围

允许修改以下文件或指定路径。

- `apps/miniapp/src/pages/project/index.tsx`
- `scripts/check-miniapp-login.mjs`（扩展编译产物日志夹具）
- `apps/miniapp/src/pages/project/job-logs.ts`（仅在复用同一有状态读取函数需要时新增）

相关后续工作可单独处理，包括服务端保留策略、跨端日志重构、历史日志格式、Web／Android 上的单独分页问题。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。在 PowerShell 用同名 `$env:` 变量设置表中的三个示例值后执行构建。示例 AppID 只用于编译测试。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `node scripts/check-miniapp-login.mjs` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `TARO_APP_API_URL=https://api.example.com TARO_APP_WEB_URL=https://app.example.com TARO_APP_WECHAT_APP_ID=wx0123456789abcdef pnpm --filter @rescene/miniapp build:weapp` | Taro 微信生产模式编译成功 |
| `node scripts/check-miniapp-login.mjs` | 本地编译产物回归通过 |

## 实施步骤

### 1. 统一首批和增量轮询

无当前游标时发送不带 afterId 的请求，收到首批后再转增量。限制同一任务与级别的在途请求数，按日志 ID 去重。错误保留当前日志并继续提供重试。

验证 `node scripts/check-miniapp-login.mjs`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 栅栏旧请求并验证成品

在请求及结果时捕获任务 ID、筛选和页面可见代次。按已有行为退后台暂停，重新进入可拉取尾部。增加从空、返回首条、下一批增量的编译产物回归。

按验证表编译微信小程序，再执行 `node scripts/check-miniapp-login.mjs`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

首次空，下一次产生日志。筛选先空后有。切换任务与级别时旧响应丢弃。重复 ID 不重复。隐藏页面不轮询，表单和当前任务保持。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/poll-miniapp-logs-from-empty` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

编译产物夹具无法稳定挂接任务页时，以同一页面逻辑的小型夹具验证并明确补充 DevTools 手工操作。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

改变日志游标或过滤方式时，保留空游标和复位后的验证。
