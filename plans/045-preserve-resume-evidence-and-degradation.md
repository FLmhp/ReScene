# 045 · 恢复时保留评估证据与 OOM 降级

## 现状

- `src/rescene/pipeline.py:717-721` 的 `run_pipeline` 用新 `collect_metrics` 直接写 `metrics.json`，不调用 `merge_evaluation_evidence`；只有 `report_run`（`:738-741`）会合并。
- `src/rescene/metrics.py:328-347` 已实现按产物 SHA-256 合并评估证据；`run_pipeline` 的写回会删除 ATE、F1、阈值、evaluator 哈希，并让 `timings` 只包含本次进程的阶段。
- `pipeline.py:691-706` 的恢复训练总是用原始 `config` 调 `gsplat_command`；`config.degraded()` 只在当前 attempt 的 OOM except 中计算。`pipeline.py:507-508` 虽读取 `degradation.json`，但只传给 `collect_metrics`，不用于训练命令。
- Worker 只在 stage `success` 时上传 checkpoint（`src/rescene_worker/main.py:342-343`），因此“降级后再次失败”的决定不会进入下一次恢复。

## 变更范围

- `src/rescene/pipeline.py` 的 metrics 写回与训练配置选择。
- `src/rescene_worker/main.py` 的 checkpoint 内容/阶段状态（如需要）。
- `tests/test_pipeline.py`、`tests/test_worker.py`。

## 步骤

1. 抽出 `load_and_merge_metrics(run_dir, metrics)`：读取旧 `metrics.json`，合并 `timings` 和 `evaluation_evidence`，校验失败/损坏时按现有语义标记 `evaluation_needs_recompute`。
2. 在 `run_pipeline` 写 `metrics.json` 前调用它；`report_run` 复用同一函数，避免两条路径分叉。
3. 恢复训练时读取 `degradation.json`：如果 `stage == "training"` 且记录的是可用的 fallback 配置，就用该配置生成 `gsplat_command`；否则用原始 config。
4. 在 stage state/`degradation.json` 中记录“effective config”或明确的 fallback 标记，确保下一次 Worker 能知道已降级；不要让恢复再次尝试已 OOM 的全内存配置。
5. 增加测试：
   - 预置带 `evaluation_evidence` 的 metrics，`run_pipeline(resume=True)` 后证据仍在；
   - mock `run_command` 在 attempt 1 OOM、attempt 2 恢复，断言第二次命令使用降级参数；
   - 损坏/过期 evidence 触发 `evaluation_needs_recompute`，不复制旧指标。

## 验证

- `pytest tests/test_pipeline.py tests/test_worker.py -q`。
- 合成一个带评估证据的 run，执行一次 resume，比较 `metrics.json` 的 evidence/ATE/F1。
- 合成 OOM 降级目录，执行 resume，检查训练命令参数。

## 验收

- resume 不再删除 GPU 评估证据。
- OOM 降级随 checkpoint/运行目录恢复，下一次 attempt 不重复全内存训练。
- 既有 benchmark 对比仍能区分原始配置和降级配置。

## 风险与回退

- 必须保留 `evaluation_needs_recompute` 的产物哈希校验，不能为了“保留证据”而复制过期指标。降级配置只对记录中同一 stage 生效；几何/导出阶段仍用原始配置。
