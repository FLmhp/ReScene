# 计划 020 · 通过原生桥加载 Android 私有场景

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- apps/mobile/src/screens/ViewerScreen.tsx apps/web/app/viewer/page.tsx`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S–M
- **修复风险** 中，需处理旧原生客户端和 Viewer 混版
- **类别** 安全／隐私
- **基线** `21b2052`，2026-11-21，审计发现 A15
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

Android 将临时 OSS 私有地址放入 Viewer 导航查询，请求文档时该地址会进入 Web 服务。现有原生 JSON 桥足以提供首次下载和续签地址。

## 当前实现

- `apps/mobile/src/screens/ViewerScreen.tsx:41` 中，`导航 URL 拼接 &src= 后的产物地址`。
- `apps/mobile/src/screens/ViewerScreen.tsx:61` 中，`原生桥已验证 reconstructionId 与 requestId`。
- `apps/web/app/viewer/page.tsx:72,93` 中，`检测原生桥后请求 manifest`。

延用现有 `RESCENE_MANIFEST_REQUEST`／`RESPONSE` 消息契约、受信 origin 和 requestId，保留 Web 工作台普通 BrowserView 路径。原生令牌由原生容器持有。

## 范围

允许修改以下文件或指定路径。

- `apps/mobile/src/screens/ViewerScreen.tsx`
- `apps/web/app/viewer/page.tsx`（兼容和必要的回归锚点）

相关后续工作可单独处理，包括公开分享凭证日志（006）、覆盖线上 Web、修改外部日志系统或浏览器历史。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/mobile typecheck` | Android 类型检查通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/mobile export` | Android bundle 导出成功 |

Android 模拟器或设备针对隔离服务验证普通首载、URL 到期重试、页面关闭再进入，检查 Web 文档请求不包含合成签名参数。先用本地 Web 构建和合成桥消息验证，最终由 Android 模拟器或真机确认。

## 实施步骤

### 1. 避免原生首载把签名送入导航

直接用当前重建 ID 与主题组装 Viewer 文档地址，由当前页发起桥请求，原生验证该活跃实例后签取地址。限制注入当前文档，禁止迟到请求落入下一场景。

验证 `pnpm --filter @rescene/mobile typecheck`。按下方回归场景，用隔离站点核对当步行为。

### 2. 验证 Web 与 Android 兼容

沿用可桥接页面的首载、续签和超时路径。旧原生版本的现有入口保留在兼容范围。Web 部署优先于依赖新首载行为的发行包。测试夹具只使用合成链接和合成场景。

验证 `pnpm --filter @rescene/mobile typecheck`。按本计划的本地 WebView 夹具复核回归场景并记录结果。

## 回归场景

新原生首载能显示、桥请求为当前重建、旧实例迟到响应被忽略、续签正常、普通 Web 分享不受影响、旧原生版本可打开相同候选 Web。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/request-initial-viewer-url-over-native-bridge` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果目前部署的 Web 尚无首次桥请求能力，保持 Web 先发布的兼容前置，不令原生静默失败。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

保持桥消息 schema 的向后兼容。021 的错误与重试调整应在同一 Android 流程连续验收。
