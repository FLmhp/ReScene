# 040 · 限制过期上传清理并移出 GET

## 现状

- `src/rescene_api/main.py:639,683`：项目详情和素材分页的 GET 会调用 `expire_stale_uploads`。
- `main.py:1595-1612`：对每个过期素材加行锁、调用 `storage().delete()`（`storage.py:159` 每次先 AssumeRole）、写审计、逐行 commit；没有 `LIMIT`、没有 attempts/backoff。
- `main.py:1661` 的 `AssetCleanup` 队列已有 `attempts` 和退避，但过期上传没有复用它。
- 一个 300 文件的遗弃上传会让每次项目打开产生约 600 次串行外部调用；OSS/STS 持续失败时每次 GET 都会重试全部行。

## 变更范围

- `src/rescene_api/main.py` 的 `expire_stale_uploads`、GET 调用点、cleanup reaper。
- 可能新增/复用 `asset_cleanups` 字段或记录形状。
- `tests/test_api.py` / `tests/test_api_postgres.py`。

## 步骤

1. 把 `expire_stale_uploads` 改成短事务：
   - 每次只选一小批（例如 20）过期 ID；
   - 在事务内删除/标记素材行并插入 cleanup intent；
   - 不再在 GET 中直接调用 OSS。
2. 复用 `AssetCleanup` 的 attempts/next_attempt/backoff 语义；由现有 reaper 异步删除 OSS 对象。
3. 保留 003 的锁序：完成上传与过期清理仍要共用同一行锁/fence，避免清理已 READY 的素材。
4. GET 只触发/排队，不等待 OSS；若必须同步回收，最多处理固定小批量并设总超时。
5. 对永久失败的清理记录保留 attempts 并停止无限重试；在运维可见处暴露积压数量。
6. 测试：
   - 300 个过期素材的 GET 只产生有界 DB/外部调用；
   - 删除持续失败时下一次 GET 不重复全部行；
   - 完成上传与清理并发仍由 003 测试覆盖。

## 验证

- `pytest tests/test_api.py tests/test_api_postgres.py -q`。
- 隔离 OSS 替身注入持续删除失败，连续打开项目 3 次，记录延迟/调用次数不随素材数线性增长。
- 恢复删除成功后 reaper 清空队列，素材行消失。

## 验收

- 项目 GET 的延迟不再由遗弃上传数量决定。
- OSS 删除失败有退避和上限，不会每次请求重试全部行。
- 已完成素材不会被过期清理误删（003 语义保持）。

## 风险与回退

- 把删除移出 GET 会改变“打开项目即回收”的时序；UI 可能短暂看到过期素材。可保留一个小的同步批次作为过渡，但必须有上限。
