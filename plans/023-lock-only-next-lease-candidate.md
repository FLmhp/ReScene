# 计划 023 · 领取任务时仅锁一个候选

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py tests/test_api_postgres.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S
- **修复风险** 低，需要实际 PostgreSQL 验证
- **类别** 性能／并发
- **基线** `21b2052`，2026-11-21，审计发现 A18
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

锁定队列 SQL 没有 LIMIT，导致一次领取把其他行锁住直到 STS 调用完成。用户取消无关排队任务可能因此等待。

## 当前实现

- `src/rescene_api/main.py:1433` 中，`pg_advisory_xact_lock 在租约恢复函数中取得`。
- `src/rescene_api/main.py:1482` 中，`order_by(...).with_for_update(skip_locked=True)`。
- `src/rescene_api/main.py:1506` 中，`同事务获取 worker_credentials`。

单 GPU 和全局单活跃任务是既有设计。继续用 advisory lock 覆盖状态检查、领取和提交。保持优先级与创建时间排序。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/main.py`
- `tests/test_api_postgres.py`

相关后续工作可单独处理，包括调整单卡约束、多 worker 调度架构、重构 STS 请求边界或改数据库隔离级别。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。PostgreSQL 用隔离服务，按 `.github/workflows/check.yml` 的 `RESCENE_TEST_POSTGRES_URL` 提供测试连接，不能指向生产。验证必须实际执行 `tests/test_api_postgres.py` 中新增并发或迁移用例。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api_postgres.py tests/test_api.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |

## 实施步骤

### 1. 将候选查询限制为一行

在原查询明确设置 `LIMIT 1`，保留 SKIP LOCKED、排序与 advisory lock。相同优先级和时间的稳定性应保持，必要时用已有 ID 作稳定排序。

验证 `python -m pytest -q tests/test_api_postgres.py tests/test_api.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 测试一个队列操作不会阻塞另一条任务

模拟 STS 调用保持第一个任务的事务，用独立客户端取消另一条排队任务，确认取消能在 STS 释放前完成。另测两个轮询并发只领取一条。

验证 `python -m pytest -q tests/test_api_postgres.py tests/test_api.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

领取顺序、空队列、任务取消、STS 失败后状态一致、两个并发 worker 不得同时持有有效租约。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/lock-only-next-lease-candidate` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

当前分支若移除了全局 advisory lock 或变更事务隔离设置，先核对单租约约束。不要单独拣选 LIMIT 修改。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

其他领域的队列锁不要复用此 advisory lock，保留全局状态检查与领取事务。
