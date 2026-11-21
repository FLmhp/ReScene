# 计划 031 · 仅按当前引擎子进程日志分类失败

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene/backends.py src/rescene/pipeline.py tests/test_backends.py tests/test_pipeline.py`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P3
- **工作量** S
- **修复风险** 低，需覆盖真实 OOM 与 BA 回退
- **类别** 引擎／重试
- **基线** `21b2052`，2026-11-21，审计发现 A26
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

子进程日志采用追加模式。读取整份日志末尾会混入之前的 OOM 或 BA 错误，使本次普通错误被误判降级。

## 当前实现

- `src/rescene/backends.py:21` 中，`log_path.open("a", encoding="utf-8")`。
- `src/rescene/backends.py:178,186` 中，`is_cuda_oom 和 is_vggt_ba_failure 都读取日志尾部`。
- `src/rescene/pipeline.py:627` 中，`run_command 失败后使用对应分类`。

继续保留追加日志和运营可读的失败记录。参考已经单独命名 BA 重试日志的做法，也可给本次执行保留精确字节区间。所有分类仍先考虑真实异常文本。

## 范围

允许修改以下文件或指定路径。

- `src/rescene/backends.py`
- `src/rescene/pipeline.py`
- `tests/test_backends.py`
- `tests/test_pipeline.py`

相关后续工作可单独处理，包括更改降级阈值、优化训练参数、覆写历史日志或真实 GPU 标定。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。命令在仓库根目录执行，沿用 `CONTRIBUTING.md` 的工作环境。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_backends.py tests/test_pipeline.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |

## 实施步骤

### 1. 把失败诊断绑定实际执行

记录本次子进程开始前的字节偏移，失败时仅读取其追加区间的有界尾部。或写独立尝试日志并保留既有汇总入口。复核所有 OOM/BA 分类调用方，使默认或旧调用保持兼容。

验证 `python -m pytest -q tests/test_backends.py tests/test_pipeline.py`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 验证旧日志不会改变重试决定

以合成日志保留旧 OOM 或 BA 文本，当前执行仅写普通错误，断言不降级。真正当次的同类失败仍触发既有一次回退。

验证 `python -m pytest -q tests/test_backends.py tests/test_pipeline.py`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

旧 OOM/BA 当前无关错误、当次文本 OOM/BA、当前空日志、长日志截断、训练的再次执行有独立范围、失败阶段与报告匹配。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/classify-only-current-backend-attempt` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若某个调用方不能确定当前执行范围，只使用它可证实的本次错误，保留诊断并报告该调用方。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

新后端失败分类必须指定执行上下文，不使用旧尝试的所有尾部文本。
