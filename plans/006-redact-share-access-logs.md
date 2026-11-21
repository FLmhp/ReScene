# 计划 006 · 从 API 访问日志移除分享凭证

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/access_logging.py src/rescene_api/main.py infra/api/uvicorn-log-config.json infra/api/Dockerfile tests/test_access_logging.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P1
- **工作量** S
- **修复风险** 低，需保留常规访问诊断
- **类别** 安全
- **基线** `21b2052`，2026-11-21，审计发现 A01
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

公开场景和二维码地址使用持有者即可访问的分享凭证。容器的 Uvicorn 访问日志记录请求路径，运行人员和日志平台可以因此接收到凭证。

## 当前实现

- `infra/api/Dockerfile:10` 中，`uvicorn ... --proxy-headers`。
- `src/rescene_api/main.py:1795,1823` 中，`@app.get("/v1/public/shares/{token}") 与同一路径的 qr.png 路由`。
- `src/rescene_api/main.py:1846` 中，`uvicorn.run("rescene_api.main:app", ...)`。

维持 Uvicorn 的常规访问日志级别、方法、路由类别及状态码，沿用 `infra/api/Dockerfile` 和 `main.run()` 两个启动入口。保留数据库中现有的分享哈希及授权规则。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/access_logging.py`（新增）
- `src/rescene_api/main.py`
- `infra/api/uvicorn-log-config.json`（新增）
- `infra/api/Dockerfile`
- `tests/test_access_logging.py`（新增）

相关后续工作可单独处理，包括分享路由设计、真实日志系统编辑、线上链接撤销及生产部署。线上日志留存、访问范围与有效链接的轮换另行记录给维护者。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_access_logging.py tests/test_api.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

在 Linux 或 CI 镜像验证环境运行 `docker build -f infra/api/Dockerfile -t rescene-api:audit-006 .`，期望镜像可启动。向隔离容器发送普通合法分享查看、二维码和健康请求，期望保留访问事件且合成凭证从 stdout/stderr 消失。

## 实施步骤

### 1. 在日志边界规范化请求目标

实现小型 `logging.Filter`，只处理 Uvicorn 访问记录，将分享路径的动态值换成固定占位，删除该类目标的查询部分，兼容带路由前缀的目标。使用合成日志记录断言格式化输出，保留普通健康检查和请求状态。

验证 `python -m pytest -q tests/test_access_logging.py tests/test_api.py`。合成日志的测试夹具可使用普通访问记录和虚构路径标识。

### 2. 接通两个运行入口

镜像复制日志配置并使用 `--log-config`，Python CLI 入口从可随包安装的模块装载同一过滤规则。无需从仓库相对路径读取镜像配置。使用同一配置解析或加载方式做回归，避免默认与自定义 handler 同时打印。

验证 `python -m pytest -q tests/test_access_logging.py tests/test_api.py`。镜像及 CLI 分别验证实际载入过滤器。

## 回归场景

两条公开路由、普通路由、404 响应和通用日志格式。测试数据只使用合成凭证。镜像启动配置与 CLI 配置均可解析。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/redact-share-access-logs` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若现用镜像并非该 Dockerfile，应先确认对应启动配置再声明部署覆盖。不要通过实网请求读取生产日志。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增含访问凭证的路由时，沿用相同的访问日志规则。已留存日志的清理与仍有效分享的轮换需要确认环境和授权。
