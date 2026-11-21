# 计划 019 · 取消或失租后停止后续产物上传

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_worker/main.py tests/test_worker.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S–M
- **修复风险** 低–中，需保留发布与租约栅栏
- **类别** Worker／取消
- **基线** `21b2052`，2026-11-21，审计发现 A14
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

一组产物和 manifest 上传全部结束后才调用 `check_lease`。取消后，后续大文件仍可能启动上传并占用唯一任务槽。

## 当前实现

- `src/rescene_worker/main.py:259` 中，`check_lease 同时检查 lost 和 cancelled`。
- `src/rescene_worker/main.py:341` 中，`循环上传 artifacts`。
- `src/rescene_worker/main.py:515` 中，`artifacts() 返回后才检查租约`。

复用 `check_lease(events)` 与现有 Worker 对 `LeaseLost`、`JobCancelled` 的分类，保持 attempt 的输出前缀与服务端完成栅栏。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_worker/main.py`
- `tests/test_worker.py`

相关后续工作可单独处理，包括删除已写入的任意 OSS 前缀、替换 OSS SDK、真实 5090 与生产演练。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_worker.py tests/test_api.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 在上传边界传播取消信号

给产物上传函数传入既有事件或窄的检查回调。每个对象前、manifest 前及最终完成前验证，不再启动后续网络动作。保留现有 manifest 索引、哈希与必备产物验证。

验证 `python -m pytest -q tests/test_worker.py tests/test_api.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 验证大文件边界

用现有 Worker bucket 替身模拟第一个文件写完前取消与失租，并记录第二个文件和 manifest 均未开始。再评估当前 OSS SDK 是否通过可验证的公开接口支持中断在途分片，若没有则明确记录延迟上界的待确认点。

验证 `python -m pytest -q tests/test_worker.py tests/test_api.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

首件前取消零上传。首件中取消只允许已在途上传结束。失租无 complete。无取消时产物与 manifest 顺序正常。checkpoint 保持原有策略。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/stop-worker-between-artifact-uploads` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

SDK 不支持安全中断时只承诺文件之间响应。无法验证半上传与 attempt 归属时不得清理对象。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增长时 OSS 动作时在开始和提交前均检查租约，区分控制面结果和 bucket 中未发布对象。
