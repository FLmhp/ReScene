# 计划 018 · 试验退出时确认所属进程组停止

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- scripts/supervise_route_experiments.py tests/test_offline_experiments.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 中，信号范围必须精确
- **类别** GPU 工具／恢复
- **基线** `21b2052`，2026-11-21，审计发现 A13
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

监督脚本等的是试验主进程。主进程先退出时，持有 GPU 的同组进程可能继续运行，妨碍后续试验和 Worker 切换。

## 当前实现

- `scripts/supervise_route_experiments.py:212` 中，`start_new_session=True`。
- `scripts/supervise_route_experiments.py:298` 中，`killpg(... SIGTERM) 后只以 process.wait 判断`。
- `src/rescene_worker/main.py:268` 中，`Worker 已使用针对自建组的 SIGTERM 和 SIGKILL`。

遵守 `docs/单5090系统部署与运维.md` 的归属原则。以 `start_new_session` 启动时捕获的标识和进程组归属为边界，保留 GPU 锁与现有退出证据。

## 范围

允许修改以下文件或指定路径。

- `scripts/supervise_route_experiments.py`
- `tests/test_offline_experiments.py`

相关后续工作可单独处理，包括自动清理外部计算进程、生产 Worker 停启语义（032）、运行真实 GPU 实验。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。进程组行为在 Linux 环境以替身及独立会话验证。合成命令夹具不获取 GPU、不会访问远端。记录本机 CPU 结果与 GPU 设备验收的差别。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_offline_experiments.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 让终止函数确认进程组状态

记录本次启动的进程组身份，不以父进程回收代替同组退出。只向可确认属于本次试验的组发送有界 TERM 和必要的 KILL。进程组消失正常结束。无法确认时记录异常，禁止继续下一试验。

验证 `python -m pytest -q tests/test_offline_experiments.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 覆盖试验生命周期

deadline、卡住、代理中断和异常退出使用同一终止路径。处理信号后不覆盖原始失败原因。用受控替身记录目标组和作用顺序。

验证 `python -m pytest -q tests/test_offline_experiments.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

主进程先退出、组成员仍存活。初次 TERM 即全部退出。POSIX 进程组已消失。归属未知拒绝后续试验。外部 GPU 作业不发送信号。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/verify-experiment-process-group-exit` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若无法依据已有进程组信息确认身份，保留现场与记录并停止该批次，禁止按进程名或 GPU 列表批量发送信号。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

032 处理 drain 恢复。集成后用同一夹具核对监控退出和 Worker 恢复次序。
