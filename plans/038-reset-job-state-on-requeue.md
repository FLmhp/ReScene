# 038 · 重新排队时重置进度与阶段

## 现状

- `src/rescene_api/main.py:1508` 的 `retry_job` 把任务置为 `QUEUED`、清错误字段，但不改 `progress` / `current_stage`。
- `main.py:1627` 的 `recover_expired_leases` 在租约耗尽/重新排队时同样保留旧进度。
- `main.py:1919` 的 `fail_job` 可重试分支也只改状态。
- `progress`/`current_stage` 只在 `heartbeat`、`update_stage`、`complete_job` 写入；客户端无条件显示：`packages/workbench/src/Workbench.tsx:973`、`apps/miniapp/src/pages/project/index.tsx:668`。

## 变更范围

- `src/rescene_api/main.py` 的三个入队转换。
- `tests/test_api_contract.py` / `tests/test_api_postgres.py`。
- 如客户端对 `error_code` 有状态假设，补对应断言。

## 步骤

1. 抽出 `requeue_job(job)` 辅助函数：设置 `status = QUEUED`、`progress = 0.0`、`current_stage = None`、`leased_by = None`、`lease_expires_at = None`、`heartbeat_at = None`，保留 `resume_artifact_key` 和历史阶段。
2. `retry_job`、`recover_expired_leases` 的 requeue 分支、`fail_job` 的可重试分支统一调用它。
3. 明确错误字段语义：
   - 用户主动 retry 清空 `error_code/error_message`；
   - Worker 可重试失败可以保留错误码供诊断，但客户端在 `QUEUED` 时不显示旧错误文案；或统一清空，二者选一并写测试。
4. 扩展契约测试：构造 `progress=0.9, current_stage="export"` 的任务，分别走用户 retry、租约过期 requeue、Worker retryable fail，断言响应为 `progress=0.0`、`current_stage=None`。
5. 检查 Web/小程序在 `QUEUED` 下的渲染，不再把旧百分比/阶段当作当前状态。

## 验证

- `pytest tests/test_api_contract.py tests/test_api_postgres.py -q`。
- 在隔离 API 中创建任务、heartbeat 到 0.9，再 retry，读取 `/v1/jobs/{id}` 与项目页。
- 确认 `resume_artifact_key` 未被清空，恢复训练仍可复用。

## 验收

- 任务进入 `QUEUED` 后显示 0%、无当前阶段，不再出现“99% 导出中但排队”的状态。
- 三种入队路径行为一致。
- 既有重试/租约恢复和 checkpoint 复用不受影响。

## 风险与回退

- 旧客户端可能依赖错误码在 QUEUED 时展示原因；若保留错误码，必须同时改 UI 的显示条件。回退只需恢复字段写入，不改数据模型。
