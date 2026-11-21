# 计划 014 · 按当前项目访问权限筛选任务通知

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py tests/test_api.py tests/test_api_postgres.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 低–中，需保留公告和计数一致
- **类别** 安全／权限
- **基线** `21b2052`，2026-11-21，审计发现 A09
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

原任务提交者退出项目后仍可能收到后续完成或失败消息。通知列表当前只看收件人，响应包含项目名称或失败详情。

## 当前实现

- `src/rescene_api/main.py:1225` 中，`select(Notification).where(Notification.user_id == user.id)`。
- `src/rescene_api/main.py:1256` 中，`未读计数仅通过 user_id 与 read_at`。
- `src/rescene_api/main.py:1680` 中，`通知投递给 job.created_by 和项目 owner`。

角色约定沿用 `project_for_user` 与 `effective_role`。未绑定项目的公告面向原收件人。以 SQL 子查询或连接在分页前完成范围检查。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/main.py`
- `tests/test_api.py`
- `tests/test_api_postgres.py`

相关后续工作可单独处理，包括SSE 权限重查（上一轮 #9）、客户端通知页闪烁（027）、通知系统重写、真实用户的账号与通知数据。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。PostgreSQL 用隔离服务，按 `.github/workflows/check.yml` 的 `RESCENE_TEST_POSTGRES_URL` 提供测试连接，不能指向生产。验证必须实际执行 `tests/test_api_postgres.py` 中新增并发或迁移用例。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api.py tests/test_api_postgres.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |

## 实施步骤

### 1. 统一列表、角标和已读范围

构造基于当前角色、项目存在且未软删的项目通知条件，保留全局公告类通知。列表、未读计数和相关已读更新使用同一可见范围。投递端能容易判断当前授权时可减少无用记录，但读端仍必须权威校验。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 验证移除和保留场景

以普通授权的项目成员、所有者、管理员和另一个公告收件人构建夹具。项目成员移除后再用常规任务结果触发通知，断言自己的可见列表、计数和已读行为。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

成员被移除及项目软删除时，旧新项目通知均不可见。保留 owner/admin/current member 可见性。公告仍可读。混合分页、筛选和可见条数一致。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/scope-project-notifications-to-current-access` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果仓库有明确要求历史项目通知在退出后仍显示，先核对产品契约并确定可展示的最小字段，不默默保留项目细节。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新类型定义当前项目范围或全局范围并补测试，计数和分页使用同一授权条件。
