# 034 · 请求体上限与邮箱边界校验

## 现状

- `infra/caddy/rescene.caddy:10-13` 的 API 站点没有请求体大小限制；`src/rescene_api/main.py:274-281` 只有 CORS 中间件。
- `src/rescene_api/schemas.py:10-12` 的 `LoginRequest.email/password` 没有 `max_length`；`CreateUserRequest`（:44）与 `AddMemberRequest`（:58）也没有邮箱约束。
- `main.py:364` 的管理员建号只做 `payload.email.lower()`，不 `strip()`；注册/登录在 `:298/:339` 会 `strip()`。
- 模型列 `project_invitations.email` 为 `String(320)`（`models.py:218`）。

## 变更范围

- `infra/caddy/rescene.caddy`（可选但优先）与一个小型 ASGI body-limit 中间件。
- `src/rescene_api/schemas.py`、`src/rescene_api/main.py` 的邮箱规范化。
- `tests/test_api.py` / `tests/test_api_contract.py`。

## 步骤

1. 在 API 站点增加 `request_body { max_size 2MB }`；若目标 Caddy 版本不支持，使用 ASGI 中间件在读取请求体前按 `Content-Length` 和流式累计拒绝。
2. 新增共享 `Email` 类型：`strip_whitespace=True`、`max_length=320`、与 `RegisterRequest` 相同的格式约束；`RegisterRequest`、`CreateUserRequest`、`AddMemberRequest` 全部复用。
3. 删除 `create_user` 中手写的 `lower()`，统一在 schema 层 `lower()` + `strip()`；保留现有大小写不敏感查询行为。
4. 给 `LoginRequest.password` 设一个远高于正常值的上限（例如 1024），避免超长密码反复触发 scrypt。
5. 增加测试：未认证大请求返回 413；超长/带空格/非法邮箱在管理员建号和邀请接口返回 422；正常大小写邮箱仍可登录。

## 验证

- `pytest tests/test_api.py tests/test_api_contract.py -q`。
- 在隔离 Compose 中用 `curl --data-binary @large` 请求 `/v1/auth/login`，断言 413 且 API 容器未重启。
- 建号、邀请、注册三条路径的邮箱规范化用例。

## 验收

- 单个未认证请求不能把 API 容器推到 OOM。
- 新账号/邀请的邮箱在存储前已 `strip`、`lower` 并受长度/格式约束。
- 既有合法邮箱和登录行为不变。

## 风险与回退

- 2 MB 上限高于所有正常 API 请求；若未来有更大的同步请求，必须先改成流式/对象存储上传。Caddy 限制是部署层变更，可在回退时单独移除。
