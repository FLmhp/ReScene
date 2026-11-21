# 计划 028 · 拒绝退化的相机位姿对齐

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene/evaluation.py tests/test_evaluation.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** S
- **修复风险** 低–中，需保留正常平面采集
- **类别** 研究指标
- **基线** `21b2052`，2026-11-21，审计发现 A23
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

只检查预测中心的方差可能让重复真值中心产生零缩放和零 ATE，再把退化变换应用到点云。指标会误导路线比较。

## 当前实现

- `src/rescene/evaluation.py:16` 中，`similarity_alignment(source, target)`。
- `src/rescene/evaluation.py:29` 中，`只检查 source_centered 方差，再返回 scale`。
- `src/rescene/evaluation.py:273` 中，`位姿相似变换用于预测点云`。

沿用 NumPy float64 和当前 SVD 相似变换。保留合法共面相机布局及原有参考坐标系。

## 范围

允许修改以下文件或指定路径。

- `src/rescene/evaluation.py`
- `tests/test_evaluation.py`

相关后续工作可单独处理，包括ETH3D 打分公式、相机匹配映射、历史分数重写、真实数据集下载。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_evaluation.py tests/test_geometry_metrics.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 验证输入和相似变换

在 SVD 前校验形状匹配、有限值和两侧足够的独立空间方向。对当前公式要求的相对容差和正有限缩放做检查。保留共面合法的 rank 2。明确标识输入退化，阻止写入误导性点云指标。

验证 `python -m pytest -q tests/test_evaluation.py tests/test_geometry_metrics.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 扩展既有合成相机回归

沿用 `test_similarity_alignment_recovers_transform`，加重合、共线、含非有限值、正常共面与随单位缩放的情况。

验证 `python -m pytest -q tests/test_evaluation.py tests/test_geometry_metrics.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

至少两独立方向的布局正常。重复、共线、非有限值或零缩放报明确失败。新失败未覆盖旧 metrics 文件。正常已测旋转平移指标不退化。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/reject-degenerate-pose-alignment` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

如果发现有效的产品输入确为共线且依赖 1D 对齐，先定义该情况的可解释结果，禁止伪造确定转角或点云变换。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

公开新的位姿指标时记录配准有效性与实际对应视角数。
