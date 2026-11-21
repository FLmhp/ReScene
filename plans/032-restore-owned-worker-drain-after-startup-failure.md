# 计划 032 · 试验启动失败后恢复本次设置的 Worker drain

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- scripts/supervise_route_experiments.py tests/test_offline_experiments.py docs/单5090系统部署与运维.md`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** M
- **修复风险** 中，需保留人工 drain 及进程归属
- **类别** GPU 工具／交付
- **基线** `21b2052`，2026-11-21，审计发现 A27
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

监督脚本先 drain 和 stop，之后才安装恢复逻辑。若 stop 超时或启动在两步之间中断，Worker 可一直拒领队列。

## 当前实现

- `scripts/supervise_route_experiments.py:420` 中，`require_idle_worker、drain、stop 早于 try`。
- `scripts/supervise_route_experiments.py:447` 中，`启动子进程后才安装 SIGTERM/SIGHUP 处理`。
- `scripts/workerctl:49` 中，`停止时设 drain，等锁失败立即退出`。
- `scripts/run_quality_study.sh:26` 中，`启动器在 drain 前登记只归属本次的退出清理`。

维持现有外部 GPU 计算保护、`flock --close`、隔离运行目录和不抢占活跃任务原则。必须确认本次变更对 drain 和 Worker 实例的归属。

## 范围

允许修改以下文件或指定路径。

- `scripts/supervise_route_experiments.py`
- `tests/test_offline_experiments.py`
- `docs/单5090系统部署与运维.md`（仅监督故障处理）

相关后续工作可单独处理，包括生产 Worker 立即重启、改变远程实例连接、更新真实密钥、人工处理外部进程。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。进程组行为在 Linux 环境以替身及独立会话验证。合成命令夹具不获取 GPU、不会访问远端。记录本机 CPU 结果与 GPU 设备验收的差别。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_offline_experiments.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 让恢复覆盖所有首次变更

记录启动前 Worker 状态及是否已 drain。进入可恢复边界后执行 drain、stop 与子进程启动，信号处理也覆盖这些阶段。区分用户原已 drain、仍运行但本次 drain、已停止且本次负责恢复三种结果。

验证 `python -m pytest -q tests/test_offline_experiments.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 条件化恢复并保存结果

只清除本次设置且仍可确认归属的标记。确认自有试验退出、GPU 不受外部作业占用、Worker 状态允许时才调用 start。失败时记录明确恢复状态并保持非零，保留其他操作者的状态。

验证 `python -m pytest -q tests/test_offline_experiments.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

stop 超时、设置 drain 后中断、Popen 失败、正常完成、已有人工 drain、外部进程存在、018 的进程组未退出，均记录准确的恢复及下一步状态。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/restore-owned-worker-drain-after-startup-failure` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

归属不能确认、active job 未结束、锁被其他作业占用时停止自动恢复并报告，禁止清理非本次标记。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

可与 018 共用隔离验证，但各自可单独实施。新试验入口必须在首次服务状态变更之前登记恢复语义。
