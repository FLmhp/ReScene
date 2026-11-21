# 047 · 契约绑定、Rust 测试与镜像启动冒烟

## 现状

- `packages/schemas/src/index.ts:1-5` 声称逐字段镜像 FastAPI，但没有自动比对；`packages/api-client/src/index.ts:250-253` 对每个响应 `schema.parse`。
- `src/rescene_api/main.py` 没有 `response_model`；`tests/test_api_contract.py:17-60` 只断言服务端自己的 JSON；`.github/workflows/check.yml:34-35` 的 schema 检查只覆盖请求模型的 mypy。
- `.github/workflows/check.yml:120-121` 只跑 `cargo fmt`/`clippy`，没有 `cargo test`；`apps/desktop/src-tauri/src/lib.rs:243,258,322` 有 025 的缓存并发测试。
- `.github/workflows/check.yml:92-102` 只 `docker build`，不启动 API/Web 镜像；`infra/api/Dockerfile:11` 的 uvicorn 参数、`infra/web/Dockerfile:20-25` 的 standalone 布局错误只能在停写窗口暴露。

## 变更范围

- Python 测试/导出脚本、Node 契约校验脚本。
- `.github/workflows/check.yml`。
- 不修改业务响应形状。

## 步骤

1. 为每个客户端消费的端点生成/捕获一份 golden JSON（`TestClient` 或 `app.openapi()` + 示例），存到 `tests/contracts/`。
2. 增加一个 Node 校验脚本：用对应 zod schema 解析每份 golden；未知/缺失键、类型变化即失败。
3. 在 Python job 中生成 golden，在 workspace job 中运行 Node 校验；把两步放在同一 PR 检查，避免只在 main 上跑。
4. 在 `desktop-shell` 的 Windows job 加 `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`（紧跟 clippy）。
5. 扩展 `images` job：对 API 镜像用 postgres:16 service 启动，轮询 `/health/live`、`/health/ready`；对 Web 镜像启动后 `wget --spider /`；失败即 job 失败。
6. 为 `/health/live`、`/health/ready` 增加 pytest，覆盖 DB 正常/不可用。

## 验证

- 在 PR 上故意改一个响应字段（不改 zod），契约 job 必须失败；恢复后通过。
- `cargo test` 在 CI 通过。
- 镜像启动 job 在 API/Web 健康检查通过后成功；故意改错 uvicorn 参数时失败。

## 验收

- 服务端响应与四端 zod 契约的漂移会在 CI 失败，而不是运行时 parse 错误。
- 025 的 Rust 缓存行为有 CI 回归。
- 镜像至少能启动并通过健康检查。

## 风险与回退

- Golden JSON 需要维护；用脚本生成而不是手写，避免第二份契约。镜像启动需要 secret-free 环境变量，不能把生产凭据注入 CI。
