# 044 · 工作台异步响应与分页围栏

## 现状

本计划合并四个同源的 Workbench 状态围栏缺口；它们都不改变 API 契约。

1. `Workbench.tsx:647-656` 的“加载更早”捕获 `latest?.id` 和 `logs[0]`，await 后直接 prepend 到当前 `logs`；`:365` 在切换任务时清空日志，因此旧任务的分页会混入新任务。
2. `Workbench.tsx:333-357` 的阶段时间线在每次重订阅时用新的 `live-*` key 追加服务端重放的全部阶段；订阅依赖的 `refresh` 会随 `assetPages/jobPages/token` 变化，导致重复。
3. `Workbench.tsx:298` 切换项目时清空 `uploads`，但 `:604` 的批次仍持有旧索引，`:577` 把进度写进已空数组；`:86/:609` 的全局 `uploading` 继续禁用新项目选择器。
4. `packages/workbench/src/AdminConsole.tsx:54-67,71,94` 的管理员搜索没有请求代次/防抖，旧响应可覆盖新查询；`:120/:122` 会基于这个快照停用/重置账号。

## 变更范围

- `packages/workbench/src/Workbench.tsx`、`AdminConsole.tsx`。
- `packages/workbench/src/Workbench.test.tsx`、`AdminConsole` 测试（若存在）。
- 不修改 API/共享 schema。

## 步骤

1. **日志分页**：捕获 `jobId` 和当前 `logs` 代次；await 后只有 `jobId` 仍等于 `latestRef.current?.id` 时才 prepend，并禁用重复点击的“加载更早”。
2. **阶段重放**：把 `refresh` 放入 ref，订阅 effect 只依赖 `activeJobId`；按事件完整内容（`stage/status/progress/message/metrics`）去重，而不是按 `live-*` 追加。不要只按 `stage` 合并，否则会隐藏合法的同阶段重跑。
3. **上传范围**：上传状态改为按 `projectId` 的 `{items,busy}`，或保留单个队列但显示所属项目并提供取消；只有当前项目的批次能禁用当前选择器。
4. **管理员搜索**：增加 `requestId`/`AbortController`，只应用最新响应；输入防抖 200–300 ms；请求中显示 busy，空结果与未加载区分。
5. 测试：
   - 日志请求中途切换任务，旧页不落入新任务；
   - 重订阅后阶段行数不翻倍；
   - 上传中切项目，新项目选择器不被禁用；
   - 两次 admin 搜索乱序返回，旧结果不覆盖新结果。

## 验证

- `pnpm --filter @rescene/workbench test`。
- 在 Web 夹具中模拟慢请求（延迟/乱序），逐项复现上述状态。
- 键盘操作日志按钮、管理员搜索输入。

## 验收

- 切换任务/项目后不显示错任务的日志、进度或搜索快照。
- 阶段时间线在重连后保持去重。
- 管理员只能对当前屏幕展示的用户执行停用/重置。

## 风险与回退

- 上传状态按项目保存会增加少量内存；项目数量有限。若时间线去重规则与服务端顺序冲突，以服务端 `stage` 字段为唯一键并保留首次出现顺序。回退按缺口逐项恢复，不涉及数据。
