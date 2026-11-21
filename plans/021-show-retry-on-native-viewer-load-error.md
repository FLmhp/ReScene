# 计划 021 · Android Viewer 主页面加载失败时显示重试

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- apps/mobile/src/screens/ViewerScreen.tsx`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S
- **修复风险** 低，确保区分主页面和子资源
- **类别** 正确性／交互
- **基线** `21b2052`，2026-11-21，审计发现 A16
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

WebView 写入错误时通常已有 viewerUrl，错误提示和重试却只在没有 viewerUrl 时渲染。此后用户只能离开页面。

## 当前实现

- `apps/mobile/src/screens/ViewerScreen.tsx:80` 中，`viewerUrl ? <WebView ...> : <View ...>`。
- `apps/mobile/src/screens/ViewerScreen.tsx:94` 中，`onError 和 onHttpError 只调用 setError`。
- `apps/mobile/src/screens/ViewerScreen.tsx:102` 中，`重试按钮位于没有 viewerUrl 的分支`。

沿用 Android 的 `Button`、`accessibilityRole="alert"`、主题色与返回任务。与 020 的原生桥首载保持兼容。

## 范围

允许修改以下文件或指定路径。

- `apps/mobile/src/screens/ViewerScreen.tsx`

相关后续工作可单独处理，包括Web 页面风格、OSS 签名协议、真机发布与生产环境。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/mobile typecheck` | Android 类型检查通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter @rescene/mobile export` | Android bundle 导出成功 |

用 Android 模拟器或真机连接隔离测试站点。令主文档一次合法失败，验证有文字提示和重试按钮，恢复测试站点后重试成功。错误子资源不覆盖正常页面，TalkBack 标签可读。

## 实施步骤

### 1. 把主文档错误转成可操作的状态

在主文档网络失败和主文档 HTTP 错误时展示现有重试入口。主文档依据这一代真实导航事件来识别，遇到图片或其他子资源失败不卸载正常页面。

验证 `pnpm --filter @rescene/mobile typecheck`。按下方回归场景，用隔离站点核对当步行为。

### 2. 刷新来源再重试

重试复用 load 或原生桥首载，清掉已失败实例、更新代次并忽略旧实例回调。保留获取 manifest、场景不存在和返回按钮行为。

验证 `pnpm --filter @rescene/mobile typecheck`。按本计划的本地 WebView 夹具复核回归场景并记录结果。

## 回归场景

manifest失败、主文档网络断开、主文档 HTTP 错误、无关子资源错误、重试成功及旧 WebView 回调。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/show-retry-on-native-viewer-load-error` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

Android 事件类型没有主框架标记时，从请求 URL 和代次识别后再修改。切勿把所有 HTTP 资源错误视为主文档失败。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增 Native Viewer 入口时使用相同错误状态。需要真实设备或模拟器测试记入报告。
