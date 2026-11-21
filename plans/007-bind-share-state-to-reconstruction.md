# 计划 007 · 将分享状态绑定到当前重建

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- packages/workbench/src/Workbench.tsx packages/workbench/src/Workbench.test.tsx apps/miniapp/src/pages/project/index.tsx apps/miniapp/src/pages/project/share-state.ts scripts/check-miniapp-login.mjs`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P1
- **工作量** M
- **修复风险** 中，涉及两个客户端的异步行为
- **类别** 正确性
- **基线** `21b2052`，2026-11-21，审计发现 A02
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

切换已完成任务后，旧二维码和旧分享响应会混进新场景，用户可能分享或撤销不同场景。

## 当前实现

- `packages/workbench/src/Workbench.tsx:321` 中，`setShares([]); setCreatedLink("");`。
- `packages/workbench/src/Workbench.tsx:847` 中，`setCreatedLink(link); setCreatedShareToken(share.token);`。
- `apps/miniapp/src/pages/project/index.tsx:252` 中，`try { setShares(await client.listShares(reconstructionId)); }`。

参考 Workbench `activeReconstruction` 与 `getManifest` 的过期响应检查。共享 Web／桌面逻辑继续位于 Workbench，微信沿用页面内 `loadShares`、原生复制和二维码控件。

## 范围

允许修改以下文件或指定路径。

- `packages/workbench/src/Workbench.tsx`
- `packages/workbench/src/Workbench.test.tsx`
- `apps/miniapp/src/pages/project/index.tsx`
- `apps/miniapp/src/pages/project/share-state.ts`（仅在需要独立可测辅助逻辑时新增）
- `scripts/check-miniapp-login.mjs`（仅扩展编译产物回归）

相关后续工作可单独处理，包括REST 签发格式、公开分享凭证日志、Viewer 下载与任务权限。上一轮 001、005 的页面修改需保留。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。在 PowerShell 用同名 `$env:` 变量设置表中的三个示例值后执行构建。示例 AppID 只用于编译测试。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/workbench test` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |
| `TARO_APP_API_URL=https://api.example.com TARO_APP_WEB_URL=https://app.example.com TARO_APP_WECHAT_APP_ID=wx0123456789abcdef pnpm --filter @rescene/miniapp build:weapp` | Taro 微信生产模式编译成功 |
| `node scripts/check-miniapp-login.mjs` | 本地编译产物回归通过 |

运行 Web、桌面前端和微信生产构建。在 Web 与微信编译产物或 DevTools 用两个合成重建验证场景切换。按测试夹具分别延迟 A 的创建、撤销及列表响应。

## 实施步骤

### 1. 让渲染按重建 ID 取值

链接、token 和分享列表的结果都带重建 ID。当前 ID 不匹配时当作空内容。用一个值保存本次创建返回的链接和 token。选择 B 的同一帧就隐藏 A 的二维码。

验证 `pnpm --filter @rescene/workbench test`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 约束列表和写操作的响应

创建、撤销和列表加载在调用时记录重建 ID、当前会话和必要的请求代次。只有当前上下文才能更新状态、显示错误或触发后续列表。保留当前场景的撤销确认和服务端授权。

按验证表编译微信小程序，再执行 `node scripts/check-miniapp-login.mjs`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

A 成功创建后切换 B。A 创建中切换 B。两次列表乱序。A 撤销返回时 B 链接仍可用。403/401 沿用原有处理。Web／桌面样式和微信复制可操作。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/bind-share-state-to-reconstruction` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

新集成头已改变分享状态生命周期，或微信构建无法提供对应页面入口时，先核对并报告实际覆盖，不用测试 API 成功推断 UI 正确。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增分享入口时必须从同一个选中重建读取。检查 await 前捕获 ID、await 后验证当前 ID。
