# 计划 015 · 同步任务主状态并给 SSE 加空闲回退

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- packages/workbench/src/Workbench.tsx packages/workbench/src/Workbench.test.tsx packages/api-client/src/index.ts packages/api-client/src/index.test.ts`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 中，需保持游标和终态顺序
- **类别** 正确性
- **基线** `21b2052`，2026-11-21，审计发现 A10
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

启动任务时缓存 QUEUED。阶段事件只更新阶段，实时缓存又遮住定时取到的 RUNNING 快照。连接不结束却停止送数据时，轮询兜底也不启动。

## 当前实现

- `packages/workbench/src/Workbench.tsx:231` 中，`latest 优先取同 ID 的 liveJob`。
- `packages/workbench/src/Workbench.tsx:258` 中，`阶段事件只写 progress 与 current_stage`。
- `packages/api-client/src/index.ts:648` 中，`循环等待 reader.read()`。
- `src/rescene_api/main.py:1377` 中，`完整 job_view 以 final 事件发送`。

`subscribeJob` 现有 lastEventId、退避、终态停止和 401 处理保留。原生使用现有 polling 选项。Workbench 已有按工作区和任务 ID 隔离响应的惯例。

## 范围

允许修改以下文件或指定路径。

- `packages/workbench/src/{Workbench.tsx,Workbench.test.tsx}`
- `packages/api-client/src/{index.ts,index.test.ts}`

相关后续工作可单独处理，包括事件流服务端授权与推送协议改造、切换消息中间件、日志分页。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/workbench test && pnpm --filter @rescene/api-client test` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |

## 实施步骤

### 1. 用新快照驱动任务状态

保持 SSE 阶段历史和进度提示，用匹配当前项目和任务的更新快照推进队列状态。防止旧请求覆盖终态。切换任务后丢弃旧响应。把快照接口返回当前任务作为权威状态，阶段事件仅更新其允许覆盖的字段。

验证 `pnpm --filter @rescene/workbench test && pnpm --filter @rescene/api-client test`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 为空闲流加受控回退

对连接建立和无字节间隔设置可清理的有界计时器，每次有效网络活动重置。超时释放 reader 和 abort 对应请求，沿用现有重连次数及轮询。不为主动 stop 或终态触发回退。

验证 `pnpm --filter @rescene/workbench test && pnpm --filter @rescene/api-client test`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

创建后收到 RUNNING 显示执行中。SSE 阶段继续出现。迟到 QUEUED 不覆盖终态。合成 ReadableStream 停止送数据最终轮询出 SUCCEEDED。恢复游标、401、停止订阅和原生 polling 不变。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/reconcile-job-status-with-sse` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果加入定时器后无法在卸载或终态确认没有残余订阅，先缩小回退到已有取消语义并报告。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增中间状态时检查快照、SSE、轮询的排序和终态规则。
