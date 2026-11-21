# 043 · 通知面板刷新与工作区失败提示

## 现状

- `packages/workbench/src/Workbench.tsx:243` 的定时刷新只在 `notifyLoaded` 为 false 时加载通知列表；`:212` 首次成功后把该 latch 置 true，之后只刷新角标计数。
- 通知面板 `<details className="notify">`（`:727`）没有 `onToggle`；新任务完成只增加角标，打开面板看不到新行。
- `:730` 的“全部已读”发送空 id 列表；`src/rescene_api/main.py:1448-1451` 将其解释为“把所有未读标为已读”，包括面板从未展示的通知。
- `Workbench.tsx:256-260` 在 `getWorkspace` 失败时只设置 `detailError`；`:814` 只在 `!detail` 分支渲染它，因此项目打开后刷新失败没有任何提示，旧数据继续显示。

## 变更范围

- `packages/workbench/src/Workbench.tsx` 的通知加载/面板 toggle、工作区错误渲染。
- `packages/workbench/src/Workbench.test.tsx`。
- 如需要，`packages/api-client` 的通知列表方法无需改动。

## 步骤

1. 给通知面板加 `onToggle`：打开时重新加载 page 0（或当 `unreadCount`/page-0 head 变化时合并最新页），复用现有 `notifyRequest` 代次围栏，按通知 id 去重。
2. 保持角标轮询；不要恢复“每 15 秒拉整页”的高频请求。
3. 在项目详情顶部渲染可关闭的“刷新失败，显示的是 HH:MM 的数据”提示，带“重试”；成功刷新后清除。`detailError` 不再只在无详情时显示。
4. “全部已读”保持现有服务端语义，但只在用户明确点击时执行；不要因为面板打开自动标记。
5. 测试：
   - 角标增加后打开面板会发出列表请求并显示新行；
   - 失败刷新后仍保留旧详情但显示错误条；
   - 重试成功后错误条消失。

## 验证

- `pnpm --filter @rescene/workbench test`。
- 在 Web 夹具中创建一条通知，保持页面打开，打开面板确认出现；断网/500 后确认错误条。
- 键盘操作：Tab 到面板 summary、Enter 打开、Escape 关闭。

## 验收

- 新通知不需要切过滤器/刷新页面就能在面板看到。
- 工作区刷新失败不再静默。
- 不引入新的高频请求。

## 风险与回退

- 面板打开时合并新页可能改变滚动位置；只在用户位于顶部时插入，或显示“有 N 条新通知”按钮。回退只移除 toggle 触发器，保留角标。
