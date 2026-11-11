# ReScene

ReScene 将图片或视频重建为 3D Gaussian Splatting 场景，提供团队 Web 工作台、SPZ 浏览与分享，以及独立的重建和评测命令行工具。

[生产工作台](https://app.rescene.xyz) · [API 就绪检查](https://api.rescene.xyz/health/ready) · [项目说明](docs/项目说明.md) · [部署与运维](docs/单5090系统部署与运维.md) · [5090 标定报告](docs/RESCENE_5090_OPTIMIZATION_REPORT.md) · [5090 质量标定](docs/5090_QUALITY_CALIBRATION.md) · [A100 历史实验报告](docs/A100_OPTIMIZATION_REPORT.md)

## 当前项目状态

> 本轮执行勘误：下述历史标定不能作为新候选晋级基线。旧冻结帧统计存在 symlink 路径匹配失效，部分验证/holdout 表的冻结帧总数为 0；gsplat 按注册排序位置划分的验证集也不等于源图冻结名单。历史高斯 PLY 若缺少 trainer→COLMAP 变换，不能直接套用 COLMAP→GT 变换解读几何 F1。原始实验数据保留，v3 实验单独记录修正口径后的结果。

截至 2026-11-10，0.2.1 已部署。公网服务器运行 Caddy、Next.js、FastAPI 和独立 PostgreSQL，AutoDL RTX 5090 Worker 主动领取任务，GPU 并发为 1。浏览器和 Worker 直接读写阿里云北京私有 OSS。Windows 与 Android 安装包、SHA-256 和版本清单见 [0.2.1 发布说明](docs/0.2.1发布说明.md)，下载入口为 <https://app.rescene.xyz/downloads/0.2.1/>。微信小程序工程和契约已完成，但真实 AppID/Secret、业务域名与审核资格仍是正式发布的外部前提。

- **端到端验收**覆盖图片与视频输入、断点上传、租约过期后从 OSS 恢复、运行中取消、历史任务切换、SPZ 解码与 WebGL 渲染、签名下载和分享撤销。
- **产物与恢复**已验证四个验收任务的 PLY、SPZ、指标和报告发布，以及从 OSS 重新加载 checkpoint。5090 离线运行包已在空目录通过校验和 CUDA 冒烟测试。PostgreSQL 备份已在隔离库恢复 8 条任务记录。
- **OSS 生命周期**已从控制台确认开启版本控制，`rescene-retention` 已启用，清理超过 1 天的未完成上传碎片、超过 7 天的历史版本及过期删除标记。据管理员确认，已补齐 PostgreSQL 周备份规则，前缀为 `projects/system/backups/postgresql/weekly/`，当前版本保留 56 天，转为历史版本后沿用全桶 7 天规则。
- **历史质量标定（v2）**在 5090 上重跑了三条基线和 10 个单变量候选，用 fern/flower/playground 的冻结帧复核。FAST 的 steps5k 稳定快 18%–26%，但 playground 的 SSIM 回退 0.013，按"无劣化"规则未晋级；三条路线继续使用现网默认参数。该轮存在冻结帧与渲染分割不一致，仅作历史记录；v3 的重做见 [v3 报告](docs/RESCENE_5090_DELIVERY_OPTIMIZATION.md)。
- **验证与官方评测**：BALANCED 在 golden-kitchen 上把同一批 51,008 个观测的平均重投影误差从 2.91 px 降到 1.15 px；ETH3D 官方评测器（0.02 m）在 courtyard/office 上给出 QUALITY F1 0.295 / 0.089，FAST、BALANCED 的稀疏点云 F1 在千分位。Viewer 已按实际渲染截图核对。A100 历史成绩仅作参照。

### RTX 5090 生产回归

图片使用同一组 Kitchen 25 帧，视频由同一序列编码。耗时只计引擎阶段。

| 输入与路线 | 注册率 | PSNR（dB） | SSIM | LPIPS | 引擎耗时 |
|---|---:|---:|---:|---:|---:|
| 图片 FAST | 100% | 14.672 | 0.342 | 0.495 | 134 s |
| 图片 BALANCED | 100% | 15.977 | 0.514 | 0.374 | 330 s |
| 图片 QUALITY | 96% | 19.118 | 0.671 | 0.248 | 620 s |
| 视频 FAST | 100% | 15.252 | 0.336 | 0.461 | 130 s |

## 算法路线

| Profile | 几何路线 | 默认 3DGS 步数 | 最大输入帧数 |
|---|---|---:|---:|
| `fast` | VGGT 几何估计 | 7,000 | 80 |
| `balanced`（工作台默认） | VGGT + Bundle Adjustment | 20,000 | 80 |
| `quality` | COLMAP SfM、BA 和 MVS | 20,000 | 250 |

VGGT 只做预训练权重推理；“训练”指每个场景的 Gaussian 优化。默认 VGGT-1B 权重仅适用于其许可证允许的学术非商用范围。

## 后续 A100 训练优化计划

以下实验待执行。A100 PCIe 40 GB 通过 `ssh locx.top` 使用独立的 `/home/loch/ReScene` 工作区。每次只运行一个 GPU 实验，最多使用 12 个 CPU 核心。启动前检查 GPU 计算进程和可用磁盘，发现其他 GPU 作业就退出。

1. **复现基线。** 核对 A100 的 `sm_80` 扩展、依赖和模型哈希，先跑 100 步 CUDA 冒烟，再按当前默认参数完成 Kitchen 的三条路线。冻结输入 SHA-256、归一化结果、验证帧和随机种子。逐阶段记录几何、训练、导出耗时，以及训练峰值和全流程 GPU 显存。历史 A100 Kitchen 的 FAST、BALANCED、QUALITY 耗时约为 195、522、848 秒，仅用于定位变化，晋级以本轮同机复跑为基线。
2. **按瓶颈做单变量对照。** FAST 保持 7k 步，测试更小的几何输入帧预算及低纹理场景的回退触发率。BALANCED 从 20k 步和 1,024 查询点出发，分别筛选查询点数和 3DGS 步数。QUALITY 从 20k 步及 `SIMPLE_RADIAL` 出发，先按实际耗时定位 MVS 或网格阶段，再分别筛选深度图分辨率和 Poisson 深度。每次只变一个参数。调整输入帧数时仍使用固定验证图，并报告注册数与共同帧注册率。
3. **验证几何与渲染。** 在 fern、flower 和 ETH3D playground 上比较候选。BALANCED、QUALITY 对同一组有效观测记录 BA 前后的重投影误差，并报告观测数和注册率。ETH3D 使用同版本官方评测器记录位姿 ATE 和 2 cm Accuracy、Completeness、F1。选定候选后，再在事先锁定且未参与筛选的新场景上做一次留出验证。
4. **按门槛晋级。** 要求验证指标有限、同口径 BA 后误差不升、无非预期注册回退，并能重新加载 checkpoint、PLY 和 SPZ。拟以同机复跑的中位数判定收益，至少改善 10% 的耗时或峰值显存，且质量变化在基线的重复测量波动内。记录配置、环境清单、指标、失败和回退原因。候选通过后才安排 5090 回归，再决定是否更新生产默认参数。

A100 开机、数据就绪后，可先在实验目录生成三条默认路线的验证清单。`--dry-run` 只生成试验清单，数据目录和运行环境仍须单独检查。

```bash
ssh locx.top
cd /home/loch/ReScene
.venv/bin/python -m rescene benchmark \
  --manifest configs/datasets/validation-v1.json \
  --candidates configs/calibration/selected-v1.json \
  --profiles fast balanced quality --run-prefix a100-baseline-v2 --dry-run
```

正式批次使用 [GPU 锁与后台运行脚本](scripts/launch_benchmark_remote.sh)。先按上述计划冻结数据和候选配置，使用新的运行标识保留历史基线。参见 [A100 历史实验报告](docs/A100_OPTIMIZATION_REPORT.md)。

## 本地开发

```powershell
py -3.11 -m venv .venv
uv pip install --python .venv\Scripts\python.exe -e ".[dev,api,worker]"
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check src tests scripts

pnpm install
pnpm -r typecheck
pnpm -r test
pnpm --filter rescene-web dev          # Web 工作台 :3000
pnpm --filter @rescene/desktop dev     # Tauri 前端 :1420
pnpm --filter @rescene/mobile start    # Expo
pnpm --filter @rescene/miniapp dev:weapp
```

Web、桌面、移动端和小程序共用 `packages/` 下的契约、客户端、查看器与工作台；结构见 [多端工作台](docs/单5090系统部署与运维.md#11-多端工作台2026-11-10)。

## 引擎命令

```text
python -m rescene preprocess --input <图片目录或视频> --scene <名称>
python -m rescene run --profile fast|balanced|quality --input <路径> --run-id <名称> --resume
python -m rescene benchmark --input <路径> --profiles fast balanced quality
python -m rescene evaluate --run-id <名称> ...
python -m rescene report --run-id <名称>
python -m rescene run-job --job-spec <job.json> --output <目录> --resume
```

## RTX 5090 运维

远端代码位于 `/root/ReScene`，运行时和任务缓存位于 `/root/autodl-tmp/rescene`。远程命令必须显式传入自己的 SSH 主机和远端根目录，不内置机器别名。

```powershell
.\scripts\remote.ps1 sync -Remote <ssh-host> -Root <remote-path>
.\scripts\remote.ps1 bootstrap -Remote <ssh-host> -Root <remote-path>
.\scripts\remote.ps1 model -Remote <ssh-host> -Root <remote-path> -ModelPath C:\path\to\model.safetensors
.\scripts\remote.ps1 smoke -Remote <ssh-host> -Root <remote-path>
.\scripts\remote.ps1 worker-start -Remote <ssh-host> -Root <remote-path>
.\scripts\remote.ps1 worker-status -Remote <ssh-host> -Root <remote-path>
```

Worker 只主动访问 `https://api.rescene.xyz` 和阿里云 OSS，不开放入站端口。任务并发固定为 1；发现其他 GPU compute PID 时等待，不依据虚拟化环境中不可靠的 GPU utilization 百分比。

公网部署使用 [Compose 配置](infra/compose.yaml) 和 [Caddy 站点配置](infra/caddy/rescene.caddy)。部署、备份恢复和回滚步骤见 [单 5090 系统部署与运维](docs/单5090系统部署与运维.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [项目说明](docs/项目说明.md) | 架构、数据模型、API、存储布局、Worker、引擎、多端、部署与验收 |
| [用户手册](docs/用户手册.md) | 登录、上传、路线、Viewer、分享、Windows/Android/小程序限制与 FAQ |
| [开发与发布指南](CONTRIBUTING.md) | 环境、质量门禁、版本、构建、发布、回滚与检查表 |
| [0.2.1 发布说明](docs/0.2.1发布说明.md) | 安装包、SHA-256、已知限制与下载入口 |
| [5090 v3 优化报告](docs/RESCENE_5090_DELIVERY_OPTIMIZATION.md) | 当前三路线基线、候选筛选、holdout 与生产取舍 |
| [单 5090 系统部署与运维](docs/单5090系统部署与运维.md) | 服务器布局、Compose、Caddy、备份恢复、回滚、磁盘维护 |
| [5090 标定报告](docs/RESCENE_5090_OPTIMIZATION_REPORT.md) | 三条路线的参数标定结论、耗时、ETH3D 官方评测、实跑缺陷修复 |
| [5090 质量标定](docs/5090_QUALITY_CALIBRATION.md) | 标定流程、候选矩阵、判定规则与逐项证据 |
| [A100 历史实验](docs/A100_OPTIMIZATION_REPORT.md) | A100 时代的参数筛选与结果 |
| [系统剩余任务与实施路线图](docs/系统剩余任务与实施路线图.md) | V1 产品化的历史规划与范围依据 |
