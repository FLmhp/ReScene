# 计划 013 · 保证会话撤销版本单调更新

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py tests/test_api.py tests/test_api_postgres.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 中，需要覆盖不同密码和停用操作的竞争
- **类别** 安全／并发
- **基线** `21b2052`，2026-11-21，审计发现 A08
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

退出已使用数据库原子递增，改密、管理重置和停用仍基于之前读取的 ORM 值。两个事务的写入可互相覆盖，使撤销语义失去单调性。

## 当前实现

- `src/rescene_api/main.py:329` 中，`user.token_version += 1`。
- `src/rescene_api/main.py:356` 中，`update(User)...values(token_version=User.token_version + 1)`。
- `src/rescene_api/main.py:425,439` 中，`停用与管理员重置时递增 ORM 属性`。

复用现有 `current_user` 版本校验和退出的原子更新。认证接口的响应字段与错误码沿用当前约定。密码修改必须验证当前有效哈希。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/main.py`
- `tests/test_api.py`
- `tests/test_api_postgres.py`

相关后续工作可单独处理，包括JWT 格式、令牌有效期、客户端存储、登录或注册流程改版、生产账号及现行会话。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。PostgreSQL 用隔离服务，按 `.github/workflows/check.yml` 的 `RESCENE_TEST_POSTGRES_URL` 提供测试连接，不能指向生产。验证必须实际执行 `tests/test_api_postgres.py` 中新增并发或迁移用例。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api.py tests/test_api_postgres.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |

## 实施步骤

### 1. 统一账户状态写入方式

为修改密码、管理员重置、停用及退出采用同一事务下的原子递增方案。改密时对最新版本与当前密码做一致性校验，避免旧会话事务覆盖新密码。使用此事务取得的版本签发新会话。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 补确定性的 PostgreSQL 竞争测试

沿用 `postgres_sessions` 和并发屏障，验证合法的改密、退出与管理员状态更新对数据库版本单调推进。测试事务成功和拒绝分支，无需公开任何会话值。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

顺序改密、管理员重置和停用仍正常。连续的独立撤销不能回写旧版本。失败或身份过期无更新。改密回执与随后更新的版本不会混淆。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/make-session-version-monotonic` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

候选实现需要数据库专用语法时，保留 SQLite 开发路径或提供有测试的等价行为。未运行 PostgreSQL 时不能将竞争验收标记通过。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

每条撤销路径都要通过相同写入约束。确认登录和改密的返回令牌绑定实际这次操作的事务版本。
