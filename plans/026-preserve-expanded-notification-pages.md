# 计划 026 · 在自动刷新时保留已展开的通知分页

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- packages/workbench/src/Workbench.tsx packages/workbench/src/Workbench.test.tsx`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S–M
- **修复风险** 低，需保留未读角标与错误反馈
- **类别** 正确性
- **基线** `21b2052`，2026-11-21，审计发现 A21
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

定时刷新始终把通知切回第一页，多次展开或切筛选时迟到响应会覆盖当前列表。

## 当前实现

- `packages/workbench/src/Workbench.tsx:146` 中，`loadNotifications(filter, offset = 0)`。
- `packages/workbench/src/Workbench.tsx:150` 中，`offset 0 时用新列表覆盖`。
- `packages/workbench/src/Workbench.tsx:178,209` 中，`定时 refresh 调用默认 loadNotifications`。
- `packages/workbench/src/Workbench.tsx:578` 中，`加载更多追加当前筛选下一页`。

沿用 `loadUnread`、已有通知筛选、`workspaceRequest` 代次。保持后端的 offset 协议与账户刷新。

## 范围

允许修改以下文件或指定路径。

- `packages/workbench/src/{Workbench.tsx,Workbench.test.tsx}`

相关后续工作可单独处理，包括服务端通知读取（014）、SSE、项目详情错误隔离（上一轮 #13），以及新分页协议。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/workbench test` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |

## 实施步骤

### 1. 把角标自动刷新和展开列表分离

到达定时周期时继续同步角标，已展开多页的列表保持可读。首次打开、主动刷新、确认已读或更换筛选按既有界面语义加载必要页面。

验证 `pnpm --filter @rescene/workbench test`。假计时器跨一个自动刷新周期。

### 2. 绑定读取到当前筛选和会话

使用请求代次保护过时响应和 loading 状态，追加页去重。对加载更多失败保留已读页面与重试入口。

验证 `pnpm --filter @rescene/workbench test`。筛选快速切换时只提交当前请求。

## 回归场景

打开两页跨过 15 秒仍保留。快切全部/未读与乱序响应。已读操作重新计算角标。切换账户没有旧结果。同页加载按钮不会重复追加。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/preserve-expanded-notification-pages` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若工作区刷新依赖通知列表作为身份探测，改为保留原来的认证失效处理再拆列表请求，不能吞掉 401。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

继续复用相同会话代次。后端通知可见范围变化时检查分页已展开和未读角标。
