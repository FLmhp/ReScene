# 003 串行化过期上传清理与完成

> 基线为 `21b2052`，日期 2026-11-20。先运行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py tests/test_api.py tests/test_api_postgres.py`。有相关改动时与下方锚点核对，修复后的计划索引由执行者更新。

**优先级 P1 · 数据完整性 · 工作量 M · 修复风险中 · 无前置计划**

## 目标与现状

过期清理在删除 OSS 对象前必须持有对应素材的数据库行锁并重新确认状态。若完成上传先提交，清理跳过该行。若清理先成功，后续完成请求得到现有缺失响应。OSS 暂时不可用时保留可重试记录。

- `src/rescene_api/main.py:1408` 的 `expire_stale_uploads` 无锁查 `UPLOADING` 行，`with suppress(Exception): store.delete(asset.object_key)` 后照常删除 DB 行。
- `complete_asset`（第 956 行）通过 `db.get(Asset, asset_id, with_for_update=True)` 获取行锁，同事务写 READY 与审计。 `delete_asset`（第 999 行）已使用 `populate_existing=True` 重新读取锁定行，并仅容忍 OSS NotFound。
- 清理调用来自完整项目详情（第 522 行）和素材列表（第 566 行）。摘要路径保持当前行为。阈值来自 `src/rescene_api/config.py:24`，默认 86400 秒。
- `tests/test_api.py:271` 使用 RecordingStore 观察删除，`tests/test_api_postgres.py:21` 使用独立 schema，支持在同一 PostgreSQL 服务上使用两个独立会话测试。

## 范围与 Git

修改 `src/rescene_api/main.py`、`tests/test_api.py`、`tests/test_api_postgres.py`。沿用现有素材状态、TTL、分页、权限及审计名称。保持 OSS IAM、数据库 schema、multipart 会话、客户端契约和计划外回收任务的实现范围。使用 `codex/fence-stale-upload-cleanup`，例如 `fix(api): fence stale asset cleanup against completion`。

## 命令与预期

| 用途 | 命令 | 预期 |
|---|---|---|
| API 回归 | `python -m pytest -q tests/test_api.py tests/test_api_contract.py` | 全过 |
| 并发验证 | 用隔离 PostgreSQL 16 设置 `RESCENE_TEST_POSTGRES_URL` 并运行 `python -m pytest -q tests/test_api_postgres.py` | 含新清理测试，零跳过 |
| Python 门禁 | `python -m ruff check src tests scripts`、`python -m ruff format --check src tests scripts` 和 `python -m pytest -q` | Ruff 退出 0，测试通过 |
| 范围 | `git diff --check` 和 `git diff --name-only` | 仅修改计划所列文件 |

CI 的数据库启动配置见 `.github/workflows/check.yml:10`。本地没有 PostgreSQL 时使用 SSH 之外的独立 CI 测试环境，禁止拿生产数据库 URL 作测试输入。

## 步骤

1. **在删除边界锁定并验证。** 在 `expire_stale_uploads` 先查候选素材 ID，再用带 `project_id, status=UPLOADING, created_at < cutoff` 条件的 `FOR UPDATE SKIP LOCKED` 获取每个候选的当前状态，必要时用 `populate_existing=True` 刷新 ORM 状态。逐个处理候选，每次只持有当前素材行锁，事务结束后继续下一项。这样其他候选无需等待正在调用 OSS 的素材。清理使用素材锁，避免与已有项目写路径形成反向锁序。验证用 PostgreSQL 启动两个同步事务。一个持有完成锁并稍后写入 READY，另一个调用清理后返回且没有存储删除副作用。READY 提交后再调用 GET 路径，素材和对象均保留。
2. **将清理失败作为可重试状态。** 只有 OSS 删除成功或明确 NotFound 时写 `asset.expire` 并删行。存储配置临时不可用或返回 API/OSS 可恢复错误时保留记录，本次素材查询继续。日志只带必要的资产标识和异常类别，使用现有 logger。批次中一个失败保持其行可重试，其余可正常清理。验证用 `python -m pytest -q tests/test_api.py -k 'asset_delete or stale_upload'`，覆盖未写入对象、暂时性失败后再次成功、可授权查询、未过期和 READY 素材。把现有用通用 RuntimeError 假扮 NotFound 的 fixture 改成明确的 OSS 异常类型。
3. **验证清理赢得竞争及幂等。** 基于 PostgreSQL 夹具用线程事件/屏障控制并明确设置超时。让清理先获得素材锁，另一个连接尝试正常完成。提交后确认完成返回 404，清理只写一次审计、行已删除。再跑两次 GET 确认没有二次删除。当 OSS 已删但数据库未提交，恢复后应能处理 NotFound。验证运行命令表。

## 测试与交付标准

- [ ] 在 `tests/test_api_postgres.py` 直接覆盖完成先获取锁及清理先获取锁两种时序，使用不同 DB 会话和可观察的 OSS fake，断言记录和对象状态。
- [ ] 在 `tests/test_api.py` 证明暂时性 OSS 错误保留记录且不会误写删除审计，下一次查询可回收；权限及旧详情/分页接口行为保持。
- [ ] PostgreSQL 而非 SQLite 的并发用例真实运行，相关测试、Ruff、状态索引和 `git diff --check` 验收。

## 停止条件与维护

如果实际锁顺序需要拓展到项目/任务的写事务，先画出锁依赖并报告。计划只保证完成路径与清理之间的一致性，已签发且仍有效的直传授权可能在清理后抵达 OSS，是否需要把续签 TTL 纳入清理资格由后续生命周期工作评估。生产数据修复与加速回收需要单独评审。
