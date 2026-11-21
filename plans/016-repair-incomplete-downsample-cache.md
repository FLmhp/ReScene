# 计划 016 · 拒绝复用中断留下的不完整降采样目录

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene/pipeline.py tests/test_preprocess.py tests/test_pipeline.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** S
- **修复风险** 低，需保留历史缓存目录
- **类别** 引擎／恢复
- **基线** `21b2052`，2026-11-21，审计发现 A11
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

降采样图片逐一写入。处理中止后只要目录内存在任意一张，恢复就会直接返回，训练器持续读不到其余图片。

## 当前实现

- `src/rescene/pipeline.py:120` 中，`if destination.exists() and any(destination.iterdir()): return`。
- `src/rescene/pipeline.py:625,635` 中，`常规训练与 OOM 降级均调用 _ensure_downsampled_images`。
- `tests/test_preprocess.py:84` 中，`现有测试检查一张图的缩小尺寸`。

保持 `images_<factor>` 位置和使用的 Pillow LANCZOS 逻辑。复用已有运行目录和阶段恢复规则。只操作本次运行的派生缓存。

## 范围

允许修改以下文件或指定路径。

- `src/rescene/pipeline.py`
- `tests/test_preprocess.py`
- `tests/test_pipeline.py`

相关后续工作可单独处理，包括源素材、正式拍摄数据、训练器与验证集规则、清理其他运行目录。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_preprocess.py tests/test_pipeline.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 核验有效缓存并补齐缺失

使用输入 jpg 名单、因子及必要的身份或完成记录识别缓存与当前输入是否一致。对历史目录可验证复用，若缺图、坏图、过期或混有多余输入才重建。

验证 `python -m pytest -q tests/test_preprocess.py tests/test_pipeline.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 原子写入避免坏缓存

先写派生图片临时文件，再原子发布。完整后写完成标记，或用等价的可验证完整记录。不同因子的派生缓存独立，factor 1 继续直通。

验证 `python -m pytest -q tests/test_preprocess.py tests/test_pipeline.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

两张合成图只生成一张即模拟中断，恢复补齐且下一次稳定复用。截断缓存、源文件更新、降级使用另一个因子、因子为 1。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/repair-incomplete-downsample-cache` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

无法确认目的目录属于本次运行或包含用户手动提供的不可替换数据时，保留目录并报告冲突。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

训练器输入名称改变时，同步更新缓存完整性规则。
