# 037 · 原生队列区分可重试 409

## 现状

- `packages/uploader/src/queue.ts:157-170`：任何 `status === 409` 的 upload 错误都返回 `"dropped"`，队列项随后被删除。
- `src/rescene_api/main.py:1115-1119` 的 `complete_asset` 用 409 表示四种完全不同的情况：
  1. `Upload is not complete`（对象还没到齐，可重试）；
  2. `Uploaded object size does not match`（分片中断/截断，可重试或重传）；
  3. `Uploaded object hash does not match`（本地文件变了，应重新建会话，不应静默丢弃）；
  4. `Asset is not awaiting upload`（服务端已 READY，属于真正重复，可丢弃）。
- 只有第 4 种走 `fail(..., "asset.not_awaiting_upload")`（`main.py:1137`）；前三种是裸 `HTTPException(409)`，没有 `X-Error-Code`。
- `packages/uploader/src/web.ts:150,174,221` 也把任意 409 当成“旧 checkpoint”并丢弃；原生队列则直接删条目。
- `apps/miniapp/src/upload.ts:76-88,291-297` 的 `UploadError` 只保留 `status`，丢失 `ResceneApiError.code`。

## 变更范围

- `src/rescene_api/main.py`：`complete_asset` 的 409 错误码。
- `packages/uploader/src/queue.ts`、`web.ts`、`apps/miniapp/src/upload.ts`、`apps/mobile/src/upload.ts`。
- `packages/api-client` 错误类型（已有 `code`，确认透传）。
- `packages/uploader/src/queue.test.ts`、API 契约测试。

## 步骤

1. 把 `complete_asset` 的 409 改成 `fail(status.HTTP_409_CONFLICT, detail, code)`：
   - `asset.upload_incomplete`
   - `asset.upload_size_mismatch`
   - `asset.upload_hash_mismatch`
   - 保留 `asset.not_awaiting_upload`
2. 上传器不再按 HTTP 状态丢弃，而按 `error.code` 判断：
   - 仅 `asset.not_awaiting_upload` 丢弃；
   - `asset.upload_incomplete` / `size_mismatch` 保留队列项并重试（必要时重建会话）；
   - `asset.upload_hash_mismatch` 标记为需要重新选择/重算哈希，不要无声删除。
3. `UploadError` 增加 `code?: string`；小程序在包装 `ResceneApiError` 时保留 `reason.code`；Android 直接把 `ResceneApiError` 交给队列，确认 `code` 不被吞掉。
4. Web 上传器只在 `asset.not_awaiting_upload` 时丢弃 checkpoint；其他 409 保留 checkpoint 并抛出可重试错误。
5. 更新 `queue.test.ts`：409+`asset.not_awaiting_upload` 仍 dropped；409+`asset.upload_incomplete` 必须 remaining；没有 code 的旧服务端 409 保持保守重试（不丢数据）。
6. API 契约测试断言四个 409 的 `X-Error-Code`。

## 验证

- `pytest tests/test_api_contract.py -q`（complete 的四个分支）。
- `pnpm --filter @rescene/uploader test`。
- 合成一个“上传对象只写一半”的夹具，调用 complete 得到 incomplete，确认原生队列 remaining 且下一次重试成功。
- 夹具模拟 READY 后重复 complete，确认只在该 code 下 dropped。

## 验收

- 网络截断、对象大小/哈希不匹配不会再静默删除用户队列项。
- 真正重复的 upload 仍只丢弃一次，不反复重传。
- Web/Android/微信三端对同一个错误码做出相同分派。

## 风险与回退

- 旧服务端没有 `X-Error-Code`；客户端必须把“无 code 的 409”视为可重试而不是丢弃，否则滚动升级期间仍会丢数据。该保守策略可能让真正的重复项多保留一轮，但不会丢文件。
