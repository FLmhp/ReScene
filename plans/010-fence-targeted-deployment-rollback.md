# 计划 010 · 确保定向部署可以安全停止与回滚

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- scripts/deploy_targeted.sh tests/test_deploy_targeted.py docs/单5090系统部署与运维.md`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P1
- **工作量** M
- **修复风险** 中，务必用隔离环境演练
- **类别** 交付／可靠性
- **基线** `21b2052`，2026-11-21，审计发现 A05
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

当前脚本在错误处理安装前已改变两个镜像标签并启动 API。随后回滚不区分阶段或数据库兼容性，恢复失败也被掩盖。

## 当前实现

- `scripts/deploy_targeted.sh:49` 中，`更改 latest 标签并 compose up api`。
- `scripts/deploy_targeted.sh:63` 中，`compose up ... api web 的退出失败被忽略`。
- `scripts/deploy_targeted.sh:80` 中，`trap rollback ERR`。
- `docs/单5090系统部署与运维.md:201` 中，`先确认旧镜像与迁移兼容，分服务切换`。

借用官网脚本的阶段化记录惯例，保持定向部署仅影响该项目的 API／Web。备份、配置恢复与数据库回退沿用单 5090 运维手册，记录已发生的变更和最后健康结论。

## 范围

允许修改以下文件或指定路径。

- `scripts/deploy_targeted.sh`
- `tests/test_deploy_targeted.py`（新增）
- `docs/单5090系统部署与运维.md`（仅定向脚本说明和证据）

相关后续工作可单独处理，包括生产数据库恢复、Docker 全局清理、Caddy 与 Worker 服务改动、自动正式发布。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。在 Linux Bash 用独立命令替身和临时目录测试。GitHub CI 的 Python 3.11 作基线，容器演练环境独立于所有生产服务。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_deploy_targeted.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `bash -n scripts/deploy_targeted.sh` | 退出 0 |

在 Linux 或 Git Bash 运行 `bash -n scripts/deploy_targeted.sh`，期望退出 0。之后执行命令替身用例。任何真容器演练使用独立项目命名、隔离数据库与镜像标签。

## 实施步骤

### 1. 增加准备检查和阶段记录

保存原镜像和备份路径，验证压缩镜像传输及装载结果，确认预迁移检查已完成。第一次变更前装好错误捕捉。标签、容器替换、外部健康探测分别记录，不覆盖先前同版本的部署证据。

验证 `bash -n scripts/deploy_targeted.sh`。`bash -n` 检查部署脚本通过。

### 2. 把回滚施加到已变更阶段

健康检查 API 通过后才变更 Web。恢复时仅处理本次已变更的服务。只有旧版兼容性已验证才自动恢复镜像。不明确或 SSH 断线时明确报告停在哪一阶段，按现存记录复核。恢复失败退出非零并保留原错误。

验证 `python -m pytest -q tests/test_deploy_targeted.py`。通过命令替身断言错误只恢复实际已改阶段。

### 3. 用隔离替身演练

复制脚本的命令边界到 pytest 测试夹具，并用 Linux Bash PATH 替身记录 ssh、docker、scp、curl 的顺序。用 [运维手册](../docs/单5090系统部署与运维.md#L98) 补上禁止在状态未知时重跑的流程。

验证 `python -m pytest -q tests/test_deploy_targeted.py`。完整部署替身测试通过。

## 回归场景

装载失败时不改标签。API 启动或健康检查失败时 Web 不启动。Web 启动失败且可回滚时逆序恢复。迁移兼容未确认或回滚失败有非零输出和记录。不访问真实服务器。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/fence-targeted-deployment-rollback` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若无法验证旧镜像对新 schema 的兼容性，保留准确状态，不自动替换当前服务。当前生产服务器用途不明时仅允许替身验证。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

API 会在启动应用迁移。每轮候选需核对运行镜像 ID、恢复证据和 API/Worker 协议兼容。
