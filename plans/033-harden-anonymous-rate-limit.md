# 033 · 固定可信代理并清理匿名限流键

## 现状

- `infra/api/Dockerfile:11` 用 `--proxy-headers --forwarded-allow-ips "*"` 启动 Uvicorn。Uvicorn 0.54 在可信主机为 `*` 时取 `X-Forwarded-For` 最左值作为 `request.client.host`。
- `src/rescene_api/main.py:93-97` 用 `f"{request.client.host}:{request.url.path}"` 作为登录/注册限流键。
- Caddy 是 API 的唯一入口（`infra/caddy/rescene.caddy:10-12`；`infra/compose.yaml` 未映射 API 端口），但 Caddy 会保留请求自带的 XFF 链，因此最左值可由客户端控制。
- `src/rescene_api/ratelimit.py:17-29` 只更新当前键的窗口，从不删除已过期键；每个伪造键永久留在 `_hits`。

## 变更范围

- `infra/api/Dockerfile`、`infra/compose.yaml` 或 Caddy 网络配置中的可信代理声明。
- `src/rescene_api/ratelimit.py`、`src/rescene_api/main.py` 的键构造。
- `tests/test_api.py` 或新增限流单测。

## 步骤

1. 把 `--forwarded-allow-ips` 从 `*` 收窄到 Caddy 在 Compose 网络中的固定地址/网段；若无法稳定固定，移除该参数，改由一个只信任 Caddy 连接的小中间件读取代理头。
2. 限流键只使用“最右一个不可信跳”的客户端地址，而不是最左 XFF；端口、路径继续作为第二维。
3. 在 `SlidingWindowLimiter` 中加入过期键清理：每次 `allow` 定期扫描并删除窗口内无命中的键，或使用按窗口分桶并在桶空时删除的结构。
4. 保留现有 `RESCENE_AUTH_RATE_LIMIT` 默认值和 429 `Retry-After` 语义；不要改成账号维度，避免账号枚举。
5. 增加测试：
   - 同一真实连接轮换不同 `X-Forwarded-For` 仍落在同一限流桶。
   - 不同真实地址仍各自计桶。
   - 窗口过期后 `_hits` 中不再保留旧键。

## 验证

- `pytest tests/test_api.py -q`（认证限流相关用例）。
- 在隔离 Compose 中从同一客户端发送带伪造 XFF 的多次登录请求，断言第 11 次返回 429。
- 运行一个短生命周期脚本检查 `limiter._hits` 在窗口过期后大小回落。

## 验收

- 轮换 XFF 不能绕过登录/注册限流。
- 正常经 Caddy 的请求仍解析到真实客户端地址。
- 限流器内存随活跃键数量有界，不随攻击请求数无限增长。

## 风险与回退

- 若线上 Caddy 地址不稳定，收窄 `forwarded-allow-ips` 可能让所有请求被识别为同一代理地址；部署前先确认 Compose 网络地址，必要时用固定 network alias。回退只恢复 Dockerfile 参数，不改数据。
