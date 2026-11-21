# 049 · 项目摘要、任务日志与环境哈希热点

## 现状

1. `packages/workbench/src/ProjectCard.tsx:13,21`：每个项目卡片单独 `getProjectSummary` + 封面 preview；`Workbench.tsx:824` 为每个项目渲染卡片。`src/rescene_api/main.py:606` 的摘要包含两次角色查询和五个独立查询。20 个项目约 40 个 HTTP、160–200 次 DB 查询和 20 次 STS。
2. `src/rescene_api/models.py:203` 的 `JobLog` 只有单列索引；`main.py:1371` 的 tail 和 `:1851` 的保留计算按 `id` 排序，默认上限 2,000；Worker 每 2 秒、每个查看者每 3 秒触发。
3. `src/rescene/pipeline.py:84,462` 每次 run 对 VGGT-1B、VGGSfM、DINOv2 和四个 vendored 树做 `sha256_file`；`metrics.py:11` 逐字节读取。`scripts/quality_study.py:346` 已用 `environment-lock.json` 缓存同样结果。
4. `src/rescene_worker/main.py:216-238` 的 `stage_files` 从 `geometry` 开始包含整个 `dense` 目录，training/export checkpoint 又重复打包；实际恢复只消费 `dense/fused.ply`。

## 变更范围

- `src/rescene_api/main.py`、`models.py`、新增迁移。
- `packages/workbench/src/ProjectCard.tsx`、`Workbench.tsx`。
- `src/rescene/pipeline.py`、`src/rescene_worker/main.py`。
- 对应测试/迁移测试。

## 步骤

1. **项目列表聚合**：在 `/v1/projects` 或 `summaries` 变体中用一条聚合查询返回 `asset_count`、`job_count`、`has_active_jobs`、`cover`、`latest_job`，保持 `ProjectSummary` 形状不变；删除 `ProjectCard` 的逐卡摘要 effect，封面 preview 只对可见卡片按需获取。
2. **JobLog 索引**：新增 `Index("ix_job_logs_job_id_id", "job_id", "id")`；保留计算改成索引上的 `OFFSET keep-1 LIMIT 1` 或子查询删除，避免每次物化 2,000 行。
3. **环境哈希缓存**：以 `(path,size,mtime)` 为键写 sidecar/lock；命中时只校验大小/mtime，缺失或显式 `--rehash` 时重新计算；把缓存摘要复制进 `environment.json`，保持 provenance 可审计。
4. **Checkpoint 内容**：把 `dense` 目录改为精确文件集合（至少 `dense/fused.ply`，如 meshing 需要再加 `meshed-poisson.ply`）；测试归档成员，确保不再包含 `dense/stereo`、`dense/images`。
5. 保持响应/归档格式兼容，先加索引和缓存，再移除逐卡请求。

## 验证

- 用 20 个项目夹具统计列表请求/DB 查询数量，确认从约 40/160–200 降到个位数。
- 对 `JobLog` tail/retention 运行 `EXPLAIN`，确认使用 `(job_id, id)` 复合索引。
- 同一模型连续两次 run 的 `environment.json` 哈希只读取一次；删除缓存/改 mtime 后能重新计算。
- 检查 training/export checkpoint 归档成员，确认不含重复的 `dense/stereo`、`dense/images`、`dense/sparse`。
- 运行 `pytest tests/test_api.py tests/test_worker.py -q` 和迁移测试。

## 验收

- 项目库打开不再按项目数放大请求/STS。
- 日志 tail/保留不随 2,000 行上限排序。
- 任务启动不再重复读取数 GB 权重。
- checkpoint 不再重复上传整个 dense 树。

## 风险与回退

- 列表聚合会增大单次响应，需保留分页/字段可选；迁移索引为加法，可安全回退。环境缓存必须带 mtime/size 和强制重算开关，避免陈旧摘要污染证据。checkpoint 成员变更需保留 `fused.ply`，否则恢复失败。
