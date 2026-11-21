# 039 · 上传凭据成功后再提交素材行

## 现状

- `src/rescene_api/main.py:1096-1101`：`create_upload_session` 先 `flush`、写审计、`db.commit()`，然后调用 `upload_grant(...)`。
- `upload_grant` 在 `main.py:1053,1063` 调用 `storage()` / `upload_credentials`；`storage.py:59` 的 AssumeRole 可能抛 `ClientException`、`ServerException` 或 503。
- 失败时素材行和 `asset.upload.init` 审计已提交，但客户端收不到 `asset_id`，无法调用 `POST /v1/assets/{id}/upload-session` 恢复；重试会再建一个 `UPLOADING` 行。
- `expire_stale_uploads` 也依赖同一个 STS，STS 故障期间这些行无法被清理。

## 变更范围

- `src/rescene_api/main.py` 的 `create_upload_session`。
- `tests/test_api.py` / `tests/test_api_postgres.py` 的 STS 失败夹具。
- 如选择“错误体返回 asset_id”的替代方案，同步 API client/schema。

## 步骤

1. 首选：`db.add(asset)` → `flush()` 取得 `asset.id`/`object_key` → 调用 `upload_grant` → 成功后写审计并 `commit`；任何存储异常先 `rollback`，返回可重试 503/502。
2. 事务内只保留一次 STS 调用，避免长时间持有行锁；若 STS 延迟明显，评估“先提交 pending 行但错误响应携带 asset_id”的替代方案，确保客户端能 refresh。
3. 失败响应带稳定 `X-Error-Code`（例如 `asset.upload_credentials_unavailable`）和 `Retry-After`。
4. 增加测试：mock `storage` 抛异常，断言没有 `Asset`/audit 行落库，响应可重试；再 mock 成功，断言 asset 与 grant 同时存在。
5. 检查并发：两个相同上传请求仍按现有 idempotency/asset 逻辑处理，不因 flush 顺序产生重复对象键。

## 验证

- `pytest tests/test_api.py -q`（上传会话/审计/失败路径）。
- `pytest tests/test_api_postgres.py -q`（如涉及并发/清理）。
- 隔离 API 注入 STS 失败，确认数据库没有孤立 `UPLOADING` 行；恢复 STS 后同一客户端可重新创建。

## 验收

- STS 失败不再留下不可恢复的素材/审计行。
- 成功路径仍返回原有 `UploadGrant` 结构。
- 客户端在失败后可安全重试，不产生重复素材。

## 风险与回退

- 事务内调用外部服务会延长持锁时间；若 STS 尾延迟大，改用“提交 pending + 错误体携带 asset_id”的方案，但必须保证客户端 refresh 路径可用。不要同时保留两条创建路径。
