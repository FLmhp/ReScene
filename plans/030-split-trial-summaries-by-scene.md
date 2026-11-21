# 计划 030 · 按数据集和场景分组试验汇总

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- scripts/route_experiments_v3.py tests/test_offline_experiments.py docs/RESCENE_5090_DELIVERY_OPTIMIZATION.md`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** S–M
- **修复风险** 中，汇总格式有历史消费者
- **类别** 试验工具／指标
- **基线** `21b2052`，2026-11-21，审计发现 A25
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

v3 汇总只按 candidate_id 聚合。仓库两个场景都用 f2-5k，当前会把不同场景当成重复试验，得到无可比意义的中位数。

## 当前实现

- `scripts/route_experiments_v3.py:178` 中，`grouped.setdefault(candidate, ...)`。
- `scripts/route_experiments_v3.py:188` 中，`以 bucket.runs 数量计算 repeats`。
- `configs/calibration/route-experiments-v3/fast/f2-5k-fern.json:3` 中，`candidate_id 为 f2-5k`。
- `configs/calibration/route-experiments-v3/fast/f2-5k-flower.json:5` 中，`dataset 为 vggt-flower`。

扩展现有 `test_summary_records_a_failure_without_metrics`，保留 run 元数据、失败记录及原子输出机制。保留冻结实验划分。不同验证组独立。

## 范围

允许修改以下文件或指定路径。

- `scripts/route_experiments_v3.py`
- `tests/test_offline_experiments.py`
- `docs/RESCENE_5090_DELIVERY_OPTIMIZATION.md`（仅汇总接口提示）

相关后续工作可单独处理，包括重跑 GPU 或改历史报告、修改候选命名与参数、合并不同冻结验证集。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_offline_experiments.py tests/test_quality_study.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 锚定每次运行的统计身份

从原有运行快照读取数据集、场景和候选属性，必要时加入冻结验证集或实验族身份。数据缺失时报告无法归组，避免把未知样本混进已知组。

验证 `python -m pytest -q tests/test_offline_experiments.py tests/test_quality_study.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 输出可解释的分组

在保留现有可用字段的前提下提供明确数据集和场景。只有无法不歧义兼容时增加汇总格式版本，并核查打印、受控实验脚本及文档消费者。

验证 `python -m pytest -q tests/test_offline_experiments.py tests/test_quality_study.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

fern 与 flower 共用候选只产生各自一组。同场景多个合法重复汇总。验证集不同另行统计。失败和缺证据 run 按现有语义记录。旧单组输出消费者可读或有明确版本。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/split-trial-summaries-by-scene` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

缺少可信数据集或场景身份时保留原始 run 记录并标未知，不靠候选名称猜测分组。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

加入新的校准模板需保留其统计身份，并区分筛选集与冻结确认集。
