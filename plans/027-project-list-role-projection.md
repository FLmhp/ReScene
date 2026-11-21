# 计划 027 · 在项目列表查询中一次取回角色

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py tests/test_api.py tests/test_api_postgres.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** S
- **修复风险** 低，需核对角色优先级与可见范围
- **类别** 性能
- **基线** `21b2052`，2026-11-21，审计发现 A22
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

项目列表先按成员关系筛选，又对每个协作项目查询一次角色。桌面与 Web 定时刷新增加了该查询开销。

## 当前实现

- `src/rescene_api/main.py:448` 中，`list_projects 查询 membership 与 Project`。
- `src/rescene_api/main.py:457` 中，`对每行调用 project_view`。
- `src/rescene_api/main.py:149,180` 中，`effective_role 在协作者分支查询 ProjectMember`。

复用 `project_view` 的响应字段。保留 administrator > owner > member/viewer 行为以及软删除筛选和创建时间排序。列表的预加载角色不改变其他路由。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/main.py`
- `tests/test_api.py`
- `tests/test_api_postgres.py`（仅补查询形态或权限核对需要时）

相关后续工作可单独处理，包括引入缓存、新的分页接口、修改角色权限、按生产数据库数据跑压测。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api.py tests/test_api_postgres.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 先为列表计数查询

使用 SQLAlchemy `before_cursor_execute` 夹具或等价记录，比较 1 与多个协作项目的查询数量，保留身份相关固定查询数。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 投影当次列表角色

用同一查询投影或对当前用户的项目角色做一次批量查询。把预解析角色复用于列表序列化，避免每个项目二次查询。其他鉴权调用维持现状。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

协作者数增长时查询数有固定上界。owner、admin、member、viewer、无权访问和软删除。列表内容、排序与旧 schema 兼容。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/project-list-role-projection` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果现有模型不保证同一用户对单项目的唯一成员关系，先重用既有取角色语义并报告数据形态，禁止用 JOIN 引入重复行。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增列表字段时在现有查询或一次批量读取完成，然后检查查询计数。
