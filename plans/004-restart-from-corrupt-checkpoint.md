# 004 损坏的 checkpoint 回退到干净重建

> 基线为 `21b2052`，日期 2026-11-20。先运行 `git diff --stat 21b2052..HEAD -- src/rescene/preprocess.py src/rescene_worker/main.py tests/test_preprocess.py tests/test_worker.py`。有相关差异时按锚点核对异常边界。通过全部门禁后更新索引。

**优先级 P1 · 正确性 · 工作量 S–M · 修复风险低 · 无前置计划**

## 目标与现状

checkpoint 中的输入清单损坏时，Worker 使用已下载的输入从头执行同一个租约尝试。该损坏不应终止 Worker 的轮询。保留现有归档安全检查、租约栅栏及外部失败策略。

- `src/rescene/preprocess.py:412` 的 `relocate_selected_images` 执行 `manifest = json.loads(manifest_path.read_text(encoding="utf-8"))`，迭代 `manifest["frames"]` 并重写已有的图片路径。
- `src/rescene_worker/main.py:152` 的 `restore_archive` 解包前检查成员类型和目标路径，之后仅把 `relocate_selected_images` 的 FileNotFoundError 转成 `IncompleteCheckpoint`（第 171 行）。截断 JSON 会传播到运行循环，现有异常列表未覆盖该错误。
- `execute_attempt`（第 454 行）已处理缺失对象、不可读 tar 和 `IncompleteCheckpoint`。调用 `safe_cleanup(output_dir, job_dir)`，重建 output 目录，清除本次调用的 resume key，然后检查租约。
- `tests/test_worker.py:135` 附近有归档安全测试，159 行使用 tmp_path 与 fake bucket 构造合法归档来验证缺失文件及路径重定位。

## 范围与 Git

修改 `src/rescene/preprocess.py`、`src/rescene_worker/main.py`、`tests/test_preprocess.py` 和 `tests/test_worker.py`。仅处理恢复阶段的输入清单解析、所需结构和临时归档清理。沿用现有引擎选择、评分、产物格式和 OSS API。使用 `codex/restart-from-corrupt-checkpoint`，例如 `fix(worker): recover from invalid checkpoint manifests`。无需 GPU 即可执行回归。

## 命令与预期

| 用途 | 命令 | 预期 |
|---|---|---|
| 聚焦验证 | `python -m pytest -q tests/test_preprocess.py tests/test_worker.py` | 含新增失败回退测试，零失败 |
| 完整回归 | `python -m pytest -q` | 零失败 |
| Python 门禁 | `python -m ruff check src tests scripts`、`python -m ruff format --check src tests scripts` | 退出 0 |
| 格式与范围 | `git diff --check`、`git diff --name-only` | 退出 0，变更路径符合范围 |

Python 采用项目的 3.11 环境，安装方式见 `CONTRIBUTING.md:5`。使用既有 mock 和 pytest tmp_path，测试数据留在默认临时目录。

## 步骤

1. **在明确的解析边界分类。** 在 `relocate_selected_images` 读取时处理 JSON/编码异常，并检查根是对象、`frames` 是列表、每项是对象、选中图片的 `file` 为非空字符串。确保已有可用选帧清单仍可重定位。使用明确的解析异常或只在调用该函数的窄 try 块内把已知输入错误转为 `IncompleteCheckpoint`，沿用缺文件处理。保留文件系统写入错误、OSS 连接问题与违规归档成员的原处理方式。测试合法 tar 内的截断清单、格式正确但结构错误以及合法历史清单。运行聚焦验证。
2. **沿用现有回退分支。** 在 `restore_archive` 对局部下载文件做好清理，保留租约尝试目录边界与现有成员验证。让新错误自然进入 `execute_attempt` 的 `IncompleteCheckpoint` 回退，确保保留 input、清理半恢复的 output、从头启动引擎。测试以 mock bucket、输入下载和引擎启动，断言进入训练前的 spec 中恢复标志清除、残留文件消失、取消或租约失效时引擎不启动。断言合法 checkpoint 仍走 resume。运行聚焦验证并记录每类用例。
3. **验证恢复分支。** 对临时归档下载失败和非法成员保留现有处理与错误分类。用合成清单断言受损尝试后还能执行后续尝试，通常可直接在函数入口用 stub，保持测试离线。运行完整回归、Ruff 和 diff 检查。

## 测试与交付标准

- [ ] `tests/test_worker.py` 使用现有 fake bucket 夹具覆盖截断 JSON、错误数据结构、正常恢复及完整的重新执行分支。
- [ ] 保留归档安全测试，并证明不将取消、失去租约、真实 IO 问题归类成清单损坏。
- [ ] 命令表通过，索引状态已更新。真实 OSS/GPU 验证只在已批准的隔离任务中记录，区分本机测试与新 5090 的结果。

## 停止条件与维护

如果正式历史清单存在不同结构，先记录差异并增加兼容样例。发现现有失效并非 checkpoint 内容导致时，报告解包后阶段恢复的具体边界。后续将新的 JSON 写入恢复包时，同步增加解析兼容测试。阶段上报去重属于独立改动。
