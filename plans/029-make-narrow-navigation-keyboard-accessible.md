# 计划 029 · 让窄屏工作台抽屉遵循键盘焦点顺序

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- packages/workbench/src/Workbench.tsx packages/workbench/src/workbench.css packages/workbench/src/Workbench.test.tsx`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** S–M
- **修复风险** 低，需验证宽窄屏切换
- **类别** 无障碍
- **基线** `21b2052`，2026-11-21，审计发现 A24
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

窄屏抽屉关闭时只是移出屏幕，里面的按钮仍能按 Tab 聚焦。打开后键盘可跑到被遮住的主区，关闭时也没有把焦点送回操作入口。

## 当前实现

- `packages/workbench/src/workbench.css:1159` 中，`max-width: 1024px`。
- `packages/workbench/src/workbench.css:1180` 中，`transform: translateX(-102%)`。
- `packages/workbench/src/Workbench.tsx:130` 中，`Escape 只 setNavOpen(false)`。
- `packages/workbench/src/Workbench.tsx:533` 中，`已有 aria-expanded 导航入口`。

沿用响应式抽屉、设计变量、主题和文字标签。复用 DOM 条件或 `inert` 管理交互，协调媒体查询断点。

## 范围

允许修改以下文件或指定路径。

- `packages/workbench/src/{Workbench.tsx,workbench.css,Workbench.test.tsx}`

相关后续工作可单独处理，包括改版导航视觉、调整品牌样式、整个工作台的菜单工程。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `pnpm --filter @rescene/workbench test` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |

## 实施步骤

### 1. 定义窄屏开关的交互状态

关闭时把抽屉控件移出焦点和辅助技术树。打开时焦点进入抽屉并约束后台操作。对 Escape、遮罩和选项目的关闭路径处理合理的焦点恢复。宽屏保持可见、可聚焦。越过断点撤销此前限制。

验证 `pnpm --filter @rescene/workbench test`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 测试行为并实看布局

扩展测试切换 aria-expanded、恢复焦点和背景交互。使用实际浏览器窄宽两套尺寸进行 Tab、Shift+Tab、Escape，检查深浅主题与触屏交互。

验证 `pnpm --filter @rescene/workbench test`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

初始关闭 Tab 跳过抽屉。打开聚焦已标记控件。键盘不会进入被遮盖区。关闭恢复焦点。选择项目后进入适当主区域。宽屏恢复导航交互。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/make-narrow-navigation-keyboard-accessible` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果只在 DOM 模拟里验证，记录浏览器实测待完成，不用 className 断言替代真实 Tab 行为。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

维护 CSS 和 focus 逻辑的同一个断点，新增抽屉关闭入口需走相同焦点处理。
