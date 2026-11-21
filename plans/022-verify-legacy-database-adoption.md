# 计划 022 · 按固定基线接管无版本标记的旧数据库

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/db.py src/rescene_api/migrations/legacy_0001.py tests/test_api_migrations.py docs/单5090系统部署与运维.md`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 中，必须避免误标库结构
- **类别** 迁移／验证
- **基线** `21b2052`，2026-11-21，审计发现 A17
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

未标记的真实 0001 库被拿去和 HEAD 比较，缺后续字段会被拒绝，无法按文档自动升级。需要用固定历史结构作唯一识别条件。

## 当前实现

- `src/rescene_api/db.py:43` 中，`compare_metadata(..., Base.metadata) 后仅允许缺 token_version`。
- `src/rescene_api/migrations/versions/v0005.py:12` 中，`后续新增 notifications 等表`。
- `tests/test_api_postgres.py:39` 中，`以 Base.metadata.create_all 建立测试 schema`。

保留启动时的事务级 advisory lock 和 Alembic 单连接工作方式。`v0001.py` 迁移事实保持不可变，迁移状态未知时停止并以具体结构差异诊断。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/db.py`
- `src/rescene_api/migrations/legacy_0001.py`（按需新增固定基线定义）
- `tests/test_api_migrations.py`（新增）
- `docs/单5090系统部署与运维.md`（仅升级说明）

相关后续工作可单独处理，包括生产库戳记、修改历史 revision、将测试库当生产恢复的证据。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。PostgreSQL 用隔离服务，按 `.github/workflows/check.yml` 的 `RESCENE_TEST_POSTGRES_URL` 提供测试连接，不能指向生产。验证必须实际执行 `tests/test_api_postgres.py` 中新增并发或迁移用例。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api_migrations.py tests/test_api_postgres.py tests/test_api.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |

## 实施步骤

### 1. 定义固定历史比对

以 `v0001.py` 核对旧库列及必要约束、索引，以项目自有表为边界。避免用 HEAD metadata 或仅存在表名判定匹配。处理额外非项目表， 保留含版本标记库的正常 Alembic 升级路径。

验证 `python -m pytest -q tests/test_api_migrations.py tests/test_api_postgres.py tests/test_api.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 补充从真实历史 revision 到 HEAD 的升级夹具

创建独立 schema 或 SQLite 内存库，从迁移生成 0001 并插入合成数据，再移除测试库标记表。调用正常 `init_db`，断言完整升级与数据保留。另测缺真实约束的旧库被拒绝且不写标记。

验证 `python -m pytest -q tests/test_api_migrations.py tests/test_api_postgres.py tests/test_api.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

新库、已有 alembic_version、无版本且精确 0001、接近但不匹配的库、升级重复执行、保全历史数据。PostgreSQL 用独立 schema，SQLite 内存作为轻量覆盖。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/verify-legacy-database-adoption` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

遇到已经存在的未标记近 HEAD 型库，保持原地不动，提供诊断并让维护者核对来源。不猜测 revision。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增迁移时不改 0001 比对定义。以真实迁移夹具校验历史入口。
