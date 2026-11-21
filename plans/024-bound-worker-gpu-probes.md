# 计划 024 · 为 Worker GPU 探测设置超时

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_worker/main.py tests/test_worker.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S
- **修复风险** 低，超时状态需保守
- **类别** Worker／运维
- **基线** `21b2052`，2026-11-21，审计发现 A19
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

计算进程探测运行在 GPU 锁内，调用没有时限。驱动探测不返回时，Worker 和依赖同一锁的维护都会卡住。

## 当前实现

- `src/rescene_worker/main.py:89` 中，`gpu_name() 使用 subprocess.run(..., check=False)`。
- `src/rescene_worker/main.py:99` 中，`gpu_has_compute_process() 使用 subprocess.run`。
- `src/rescene_worker/main.py:568` 中，`持有 lock_fd 后判断计算进程`。
- `scripts/supervise_route_experiments.py:106` 中，`GPU 探测使用 timeout=10`。

参考监督脚本的有界 nvidia-smi 调用。保留已有非零返回码视为繁忙和 GPU 名称回退行为。错误消息走 Worker 既有日志。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_worker/main.py`
- `tests/test_worker.py`

相关后续工作可单独处理，包括驱动安装与调优、GPU 不受控进程清理、改变 Worker 全局并发或部署生产。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_worker.py tests/test_offline_experiments.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 按两类探测分别回退

使用有限探测时限。设备名超时返回 unknown。计算进程超时沿用 GPU 状态不可确认时的保守判断，跳过领取、释放锁并按现有节奏重试。日志应可定位且不会在正常循环无限刷屏。

验证 `python -m pytest -q tests/test_worker.py tests/test_offline_experiments.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 补探测与释放锁用例

以 subprocess 替身依次返回超时、运行中、空闲和非零结果。断言超时轮次不发送领取请求，下一次空闲检查可继续。

验证 `python -m pytest -q tests/test_worker.py tests/test_offline_experiments.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

gpu_name 超时、gpu compute 超时与非零、空闲恢复、已有计算进程保护、退出仍可释放锁。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/bound-worker-gpu-probes` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如 Worker 当前部署在其他探测实现上，核对调用实际路径再记录覆盖，不用 CPU 验证宣称已确认 5090 驱动恢复。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增在 GPU 锁内运行的系统命令时检查时限及下一轮释放。
