# 计划 008 · 持久化素材删除意图并重试 OSS 清理

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py src/rescene_api/models.py src/rescene_api/storage.py src/rescene_api/migrations/versions/ tests/test_api.py tests/test_api_postgres.py tests/test_storage.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P1
- **工作量** M
- **修复风险** 中，涉及事务和历史迁移
- **类别** 数据完整性
- **基线** `21b2052`，2026-11-21，审计发现 A03
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

主动删除先移除 OSS 字节。数据库提交失败后原素材仍显示 READY，之后还可被新任务引用。

## 当前实现

- `src/rescene_api/main.py:998` 中，`project_for_user(..., write=True, lock=True)`。
- `src/rescene_api/main.py:1004` 中，`storage().delete(asset.object_key) 后 db.delete(asset) 和 db.commit()`。
- `src/rescene_api/main.py:1032` 中，`按 project_id 和 READY 匹配输入`。
- `src/rescene_api/main.py:1453` 中，`reap_once() 是后台回收入口`。

保留现有 project→asset 锁序、`asset_referenced` 与 `asset.in_use`。优先独立清理记录与删除素材行同事务写入，保持 API 的资源状态枚举和成功响应结构。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/main.py`
- `src/rescene_api/models.py`
- `src/rescene_api/storage.py`（仅明确缺对象错误）
- `src/rescene_api/migrations/versions/ 新增一个 revision`
- `tests/test_api.py`
- `tests/test_api_postgres.py`
- `tests/test_storage.py`

相关后续工作可单独处理，包括历史项目批量清理、对象存储生命周期调整、对生产对象执行删除。004 的 checkpoint 路径不属于素材清理。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。PostgreSQL 用隔离服务，按 `.github/workflows/check.yml` 的 `RESCENE_TEST_POSTGRES_URL` 提供测试连接，不能指向生产。验证必须实际执行 `tests/test_api_postgres.py` 中新增并发或迁移用例。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_storage.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |

## 实施步骤

### 1. 新增持久化清理记录与迁移

持久化对象键及必要的创建时间／下次尝试时间，唯一标识同一对象。保持迁移可在现有 HEAD 执行。若 001 已用 `0007`，在集成头下一个编号迁移。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_storage.py`。验证空库和现有 Alembic head 均可升级。

### 2. 原子删除用户可见记录并处理队列

持锁授权和检查引用，审计、删除行和创建清理记录一起提交，提交前禁止删除 OSS。沿用有界批量后台回收，避免长期抓住项目锁。对象不存在视为已清理，暂时失败保留记录，重复运行不增写审计。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_storage.py`。验证 DB 提交失败时 bucket 替身未收到删除。

### 3. 验证并发和旧上传行为

模拟第一次数据库提交失败与第一次 OSS 清理失败，按下方断言。对活跃上传复核既有授权剩余有效期，保留 003 的清理边界，必要时以现有最长授权时限延迟最终清理。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_storage.py`。验证 PostgreSQL 的真实锁顺序及失败可重试。

## 回归场景

提交回滚时素材仍可读且未删 OSS。提交成功后一律不能加到新任务。OSS 临时失败保留重试记录。成功或真实缺对象清理记录。在用素材保持 409。删除与建任务采用 PostgreSQL 两种先后顺序。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/persist-asset-deletion-intent` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若当前数据库 revision 无法确认或测试触及非隔离 OSS，停止相应步骤。不从生产清单直接回填旧对象。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

回收批量大小、失败重试节奏和 OSS 授权时限需一并评估。监控清理积压，确认逻辑删除完成后才呈现成功。
