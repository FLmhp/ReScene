# 计划 011 · 重生成报告时保留匹配产物的评估证据

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene/pipeline.py src/rescene/evaluation.py src/rescene/metrics.py tests/test_pipeline.py tests/test_evaluation.py tests/test_metrics.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S–M
- **修复风险** 低–中，需拒绝过期评测与新产物组合
- **类别** 引擎／数据完整性
- **基线** `21b2052`，2026-11-21，审计发现 A06
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

`rescene report` 重写 `metrics.json`，已有 ATE、官方 F1、阈值、评估器哈希和变换可能被清空，昂贵的结果失去证据。

## 当前实现

- `src/rescene/pipeline.py:662` 中，`metrics = collect_metrics(run_dir, degradation)`。
- `src/rescene/pipeline.py:666` 中，`旧 metrics 只读取 timings`。
- `src/rescene/evaluation.py:266,316` 中，`evaluate_run 向指标写位姿、点云、阈值与评估器摘要`。

参考 `tests/test_evaluation.py` 的合成相机和官方评估器替身。保持 `metrics.json` 当前字段供历史实验、路由筛选和报告使用，复用阶段原子写入方式。

## 范围

允许修改以下文件或指定路径。

- `src/rescene/pipeline.py`
- `src/rescene/evaluation.py`
- `src/rescene/metrics.py`（仅评估字段与数据边界）
- `tests/test_pipeline.py`
- `tests/test_evaluation.py`
- `tests/test_metrics.py`

相关后续工作可单独处理，包括重新跑 GPU 训练、修改 ETH3D 输入或分数公式、重新计算历史数据。退化配准由 028 单独处理。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_pipeline.py tests/test_evaluation.py tests/test_metrics.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 明确评估归属

列出 `evaluate_run` 修改的位姿、点云、阈值、方法及 provenance 字段。通过已有输入与产物身份或独立小型评估记录绑定评估。只读取需要的字段。保留旧格式可识别、可验证的历史数据。

验证 `python -m pytest -q tests/test_pipeline.py tests/test_evaluation.py tests/test_metrics.py`。评估夹具保存真值评估和产物标记。

### 2. 让报告复用经核对的评估

重新计算现有实时指标后合并匹配的评估，再生成报告。产物变化、记录缺或损坏时保留需要重评的状态，不伪造旧分数。保留降级、耗时和比较运行复用语义。

验证 `python -m pytest -q tests/test_pipeline.py tests/test_evaluation.py tests/test_metrics.py`。同一产物两次 report 保持结果不变。

## 回归场景

建立一次合成官方评估与位姿结果后连续生成两次报告，确认字段和 markdown 均保持。替换产物后旧评估不再跟随。旧 metrics 无评估、proxy 模式和损坏历史字段仍可报告。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/preserve-evaluation-in-regenerated-reports` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

无法证明历史评估与本轮产物同一身份时，先将其作为旧记录保存并报告，不以重新生成的新分数替代证据。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新增 `evaluate_run` 输出需更新持久化映射与报告回归。保留对应运行源、产物及评估器身份。
