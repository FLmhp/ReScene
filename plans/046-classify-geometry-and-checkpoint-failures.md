# 046 · 几何重试分类与损坏 checkpoint 回退

## 现状

1. `src/rescene/pipeline.py:536-556`：COLMAP 的任意 `Exception` 都进入 `matcher_retry`，清空 `database.db/sparse/dense` 并用相反 matcher 重跑整套。`src/rescene/colmap_runner.py:203-204` 的注册率 <70% 和 `:223-224` 的空融合也在同一 stage 内抛出，matcher 交换无法修复。
2. `src/rescene_worker/main.py:495-502` 只把 `NoSuchKey/tarfile.ReadError/EOFError/IncompleteCheckpoint` 当干净重启；`restore_archive` 还会对 unsafe member 抛 `RuntimeError`（`:189-193`），gzip/CRC 的 `OSError/BadGzipFile` 从 `extractall`（`:194`）逃出。
3. `src/rescene/benchmark.py:399-402` 只检查 `metrics.json` 存在就跳过 trial；`pipeline.py:43`/`evaluation.py:365` 的写入不是原子写，截断文件会被当成完成，最终排行榜 `:436-441` 在 trial try 之外崩掉。

## 变更范围

- `src/rescene/pipeline.py` 的 COLMAP 失败分类/清空条件。
- `src/rescene_worker/main.py` 的 `restore_archive` 异常边界。
- `src/rescene/benchmark.py` 的完成判定与 metrics 原子写。
- `tests/test_pipeline.py`、`tests/test_worker.py`、`tests/test_benchmark.py`。

## 步骤

1. 在 COLMAP 执行中标记阶段：只有“未生成 sparse 模型/匹配阶段失败”才允许 matcher 重试；如果 `sparse/0` 已存在、失败来自 dense/MVS/注册率/空融合，则记录 `reason: "geometry_dense_failed"` 之类的独立原因并直接抛出，不清空已成功的 sparse。
2. 保留视频 sequential→exhaustive 的合法重试（这是已有成功路径）；为它单独写测试。
3. 扩大 checkpoint 干净重启的异常集合：`tarfile.TarError`、`OSError`/`BadGzipFile`、unsafe-member `RuntimeError`、`IncompleteCheckpoint*`；明确排除磁盘满/凭据/配额错误，避免把可恢复的本地问题当坏归档。
4. 重启时清理输出目录并清空 `resume_artifact_key`，避免下一次 attempt 再下载同一坏对象。
5. 校准 trial 完成判定改为：`metrics.json` 能解析且含 `schema_version`/`total_seconds`；失败视为未完成并重跑。
6. 把 trial metrics/report 写入改为 `_write_json_atomic`（`pipeline.py:47` 已有 helper）。

## 验证

- `pytest tests/test_pipeline.py tests/test_worker.py tests/test_benchmark.py -q`。
- 夹具：sparse 成功、dense 失败，断言不触发 matcher 重试；匹配失败仍重试。
- 夹具：CRC/unsafe member 归档，断言干净重启而非 `INFRASTRUCTURE_ERROR` 重试同一 key。
- 夹具：截断 `metrics.json`，断言 trial 重跑，排行榜不崩。

## 验收

- 几何失败只在 matcher 可能修复时重试。
- 所有结构性损坏的 checkpoint 都回到干净重建。
- 校准不会把截断 metrics 当完成。

## 风险与回退

- 区分“匹配失败”和“稠密失败”需要可靠标记；若标记不明确，宁可只重试一次并记录原因，也不要再次无条件清空。原子写 helper 必须保留相同 JSON 格式。
