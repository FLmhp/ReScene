# ReScene 5090 质量优先标定（2026-11-10）

> 执行勘误：本文件保留历史过程和数值，不是本轮新基线。旧验证/holdout 表中冻结帧 total=0，源路径的 symlink/canonical 匹配失效；此外，源图冻结名单并未显式控制 gsplat 的注册图排序分割，因此“跨候选同一批渲染验证帧”未经证明。缺少 trainer→COLMAP 变换的历史高斯 PLY 不得直接套 COLMAP→GT 变换解释几何成绩；dense/sparse/高斯产物须按真实来源和坐标系分别复核。点数、网格顶点数不是几何质量证据。courtyard/office 已经用于历史观察，不能再作为本轮全新 holdout。修复统计和坐标口径不计为算法收益，历史产物不覆盖。

## 1. 目标

在单张 RTX 5090 上把三条生产路线（FAST / BALANCED / QUALITY）的参数做一次可复现的标定：

1. 复现三条路线的基线，确认计时与质量指标稳定；
2. 在 golden-kitchen 上筛候选参数（只改一个维度），按"质量优先"规则选出每档的候选；
3. 用冻结验证帧在 fern / flower / playground 上复核，至少两个场景有改进才算通过；
4. 在从未参与筛选的 ETH3D courtyard / office 上做 holdout，只要求不劣化；
5. 用 ETH3D 官方 evaluator 给出点云 accuracy / completeness / F1，作为对外可比的量化证据。

所有阶段都由 `scripts/route_calibration.sh` 驱动，产物落在 `calibration/`，选型结果写回 `configs/calibration/selected-v2.json`。

## 2. 环境与数据

| 项 | 实际值 |
|---|---|
| GPU | NVIDIA GeForce RTX 5090，32 GB，驱动 580.105.08 |
| CPU / 内存 | 208 vCPU / 754 GB |
| Python | 3.11.18（`/root/ReScene/.venv`） |
| 关键库 | pycolmap 4.2.1、torch 2.12.0+cu130、gsplat 1.6.0 |
| 系统盘 | 30 GB overlay（`/`，只放代码与 venv 链接） |
| 数据盘 | 50 GB（`/root/autodl-tmp`，`data`、`.cache`、`.venv` 指到这里；benchmark 的 `runs/` 在 overlay，见部署文档 12.1） |

数据集（`data/` 指向数据盘）：

| 用途 | 场景 | 规模 |
|---|---|---|
| 筛选 | golden-kitchen（VGGT 示例） | 25 张 |
| 验证 | vggt-fern / vggt-flower | 24 / 25 张 |
| 验证 | eth3d-playground（去畸变 DSLR） | 38 张 |
| holdout | eth3d-courtyard / eth3d-office | 38 / 26 张 |

冻结验证帧由 `scripts/freeze_validation_frames.py` 生成，每 8 帧取 1 帧，五个场景各 3 帧（`configs/calibration/validation-frames-v2.json`），跨候选保持同一批图像，避免"选图"污染对比。

## 3. 与原始计划的偏差

计划里的若干前提与机器实际状态不符，按实际情况调整并记录：

| 计划假设 | 实际 | 处理 |
|---|---|---|
| 5090 已有 Kitchen/Fern/Flower/ETH3D playground 数据 | `data/` 与 `runs/` 为空 | 重新下载 VGGT 示例与 ETH3D 三个场景 |
| 数据盘约 136 GB 可用 | 系统 overlay 30 GB，数据盘 50 GB | 大文件全部软链到数据盘；不再下载 Mip-NeRF 360 garden |
| 30 vCPU | 208 vCPU | 仍按 12 线程上限跑流水线，避免与其它任务抢核 |
| 验证集含 garden | garden 压缩包 12.5 GB，解压后超出剩余磁盘 | 验证改用 playground（同样来自 ETH3D，指标可比） |
| 官方 evaluator 在 `ETH3D/dataset-pipeline` 里 | 该仓库没有评测目标；实际程序在 `ETH3D/multi-view-evaluation` | 改构建源，并把写死的 `-std=c++11` 提到 `c++17`（PCL 1.12 要求） |
| QUALITY 可独立记录 BA 前后 | COLMAP 的 BA 在增量建图内部完成，没有独立的 BA 前模型 | 该路线以最终模型平均重投影误差为几何证据 |
| BA 快照与最终模型同分辨率 | VGGT 快照是 1024² 工作画布，最终模型回到源图尺寸 | 误差按焦距归一化后换算到同一参考焦距再比较 |

## 4. 候选矩阵

筛选只改单一维度，保证"改进"可归因：

| 档位 | 候选 | 覆盖参数 |
|---|---|---|
| FAST | baseline / steps5k | gsplat 步数 7000 → 5000 |
| BALANCED | baseline / appearance / steps30k | 外观优化、gsplat 步数 20000 → 30000 |
| QUALITY | baseline / depth-appearance / steps30k / mvs1200 / poisson12 | 深度损失+外观优化、步数、MVS 边长 1200、Poisson 深度 12 |

## 5. 判定规则

`src/rescene/selection.py` 实现判定，全部基于 leaderboard 行。`compare()` 先按容差判定指标是否改进/劣化（PSNR +0.20 dB、SSIM +0.01、LPIPS −0.01，反向即劣化），再给出耗时比 `time_ratio = candidate_seconds / baseline_seconds`：

| 档位 | 屏幕集规则 (select_profile) |
|---|---|
| FAST | 速度优先：不能有指标劣化，且 `time_ratio ≤ 0.90` |
| BALANCED | 质量优先：至少 2 个指标改进、无劣化、`time_ratio ≤ 1.60`；否则退回速度优先（≤ 0.90） |
| QUALITY | 质量优先：至少 2 个指标改进、无劣化、`time_ratio ≤ 2.00`；若指标与基线持平，则允许几何增益（稠密点/网格顶点均 ≥ 0.9 倍且 `_geometry_pass` 通过） |

候选通过屏幕集后进入两段复核（`check_stage`）：

- validation：FAST 只要求每个场景无指标劣化且耗时 ≤1.60 倍（速度档的目标是延迟，不要求画质提升）；BALANCED/QUALITY 要求至少 2 个场景有改进且各场景不劣化，质量档耗时上限 1.70 倍、其余 1.60 倍；
- holdout：不允许任何指标劣化（`required_improvements=0`），耗时上限 1.80 倍。

两段都通过才写进 `selected-v2.json` 并标记 `promoted-<候选>`，否则回落到 baseline；几何增益单独记为 `geometry_recommendation`，不会被静默提升为默认值。

## 6. 生产配置更新

标定结果落到三个地方，保证"记录"和"运行时"一致：

1. `configs/calibration/selected-v2.json`：与候选文件同构（每个档位一条 `{id, estimated_minutes, overrides}`），可直接当作 `--candidates` 复跑；
2. `src/rescene/config.py` 的 `PROFILES`：把晋级候选的 overrides 写进基础配置，`profile_config()` 才是生产真正读到的值；
3. `tests/test_config.py`：把断言改到新值，防止后续改动悄悄把标定结果改回去。

本轮没有候选通过两段复核，`selected-v2.json` 三条路线都是 baseline，因此 `PROFILES` 与 `tests/test_config.py` 保持原值，不需要改代码。配置只影响之后创建的 Job；在跑的 Job 使用启动时读到的 profile，不会中途换参数。worker 需要重启才能加载新代码：

```bash
./workerctl drain      # 等待在跑 Job 结束
./workerctl stop
./workerctl start
./workerctl smoke      # CUDA + gsplat 内核自检，确认 5090 / CC 12.0 / ≥31 GiB
./workerctl status
```

## 7. 结果

### 7.1 屏幕集（golden-kitchen，单次重复）

| 档位 | 候选 | 耗时 s | 相对基线 | PSNR | SSIM | LPIPS | 稠密点 | 网格顶点 | 判定 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| FAST | baseline | 149 | 1.00x | 14.39 | 0.34 | 0.51 | - | - | - |
| FAST | steps5k | 112 | 0.75x | 14.39 | 0.35 | 0.45 | - | - | 通过（无劣化、≤0.90x） |
| BALANCED | baseline | 377 | 1.00x | 15.65 | 0.50 | 0.40 | - | - | - |
| BALANCED | appearance | 591 | 1.57x | 14.20 | 0.47 | 0.53 | - | - | PSNR/SSIM/LPIPS 退化 |
| BALANCED | steps30k | 537 | 1.43x | 15.25 | 0.48 | 0.45 | - | - | PSNR/LPIPS 退化 |
| QUALITY | baseline | 571 | 1.00x | 19.49 | 0.66 | 0.25 | 156,864 | 64,853 | - |
| QUALITY | depth-appearance | 827 | 1.45x | 19.37 | 0.66 | 0.25 | 155,866 | 73,721 | 指标持平、网格 +13.7%，几何建议 |
| QUALITY | mvs1200 | 578 | 1.01x | 19.27 | 0.67 | 0.24 | 156,622 | 69,520 | PSNR −0.22 退化 |
| QUALITY | poisson12 | 576 | 1.01x | 19.10 | 0.66 | 0.25 | 156,254 | 320,634 | PSNR −0.39 退化（网格 +394%） |
| QUALITY | steps30k | 748 | 1.31x | 19.57 | 0.64 | 0.27 | 161,487 | 62,699 | SSIM/LPIPS 退化 |

屏幕集结论：FAST 的 steps5k 以同等质量换来 25% 提速；BALANCED 与 QUALITY 的候选都没能在不牺牲渲染指标的前提下改进，按"质量优先"全部保留 baseline。QUALITY 的 depth-appearance 在指标持平下把网格顶点提高 13.7%，记为几何建议，不会静默成为默认值。

### 7.2 BA 前后重投影误差

`compare_bundle_adjustment` 对同一批 `(image_id, point3D_id)` 观测在 BA 前后各算一次误差。由于 VGGT 快照与最终模型的工作分辨率不同，误差先按各自相机焦距归一化，再统一换算到最终模型的中位焦距（801.8 px）：

| 场景 / 路线 | 共同观测 | BA 前 mean / median / p95 (px) | BA 后 mean / median / p95 (px) | 改善比例 |
|---|---:|---|---|---:|
| golden-kitchen / BALANCED | 51,008 | 2.91 / 2.79 / 5.68 | 1.15 / 0.98 / 2.59 | 84.4% |

QUALITY 的 BA 发生在 COLMAP 增量建图内部，没有独立的"BA 前"模型；该路线的几何证据是最终模型的平均重投影误差（0.33 px）与注册率。这一点作为偏差记录，见 §3。

产物与复现命令见 `calibration/` 与 `src/rescene/geometry_metrics.py`。

### 7.3 验证集（fern / flower / playground，冻结帧）

只有 FAST 的 steps5k 通过了屏幕集，需要两段复核；BALANCED、QUALITY 的候选在屏幕集已被否，全部保留 baseline。

| 档位 | 候选 | 场景 | 耗时 s | PSNR | SSIM | LPIPS | 注册率 | 判定 |
|---|---|---|---:|---:|---:|---:|---:|---|
| FAST | baseline | playground | 274 | 14.97 | 0.520 | 0.499 | 0.919 | - |
| FAST | steps5k | playground | 224 | 15.00 | 0.507 | 0.508 | 0.919 | SSIM −0.013，劣化 |
| FAST | baseline | fern | 152 | 19.38 | 0.605 | 0.243 | 1.0 | - |
| FAST | steps5k | fern | 112 | 19.71 | 0.612 | 0.247 | 1.0 | 速度 0.74x，PSNR +0.33 |
| FAST | baseline | flower | 201 | 24.72 | 0.808 | 0.089 | 1.0 | - |
| FAST | steps5k | flower | 162 | 24.74 | 0.806 | 0.092 | 1.0 | 持平 |
| BALANCED | baseline | playground / fern / flower | 653 / 381 / 362 | 14.98 / 23.04 / 25.42 | 0.534 / 0.775 / 0.830 | 0.427 / 0.142 / 0.070 | 1.0 | 仅基线 |
| QUALITY | baseline | playground / fern / flower | 1265 / 516 / 634 | 14.31 / 25.35 / 26.28 | 0.500 / 0.838 / 0.863 | 0.457 / 0.110 / 0.061 | 0.919 / 1.0 / 1.0 | 仅基线 |

FAST steps5k 在三个场景上稳定快 18%–26%，但 playground 的 SSIM 从 0.520 掉到 0.507（超出 0.01 容差），按"无劣化"规则未通过验证，因此不晋级。QUALITY 在 playground 上的渲染指标低于 FAST/BALANCED（14.31 vs 14.97/14.98），说明质量档的优势并非对所有场景成立，这一点在报告里如实记录。

产物见 `calibration/route-validation-v2/leaderboard.json`。

### 7.4 Holdout（courtyard / office，从未参与筛选）

| 档位 | 候选 | 场景 | 耗时 s | PSNR | SSIM | LPIPS | 注册率 | 判定 |
|---|---|---|---:|---:|---:|---:|---:|---|
| FAST | baseline | courtyard | 219 | 14.91 | 0.450 | 0.539 | 1.0 | - |
| FAST | steps5k | courtyard | 167 | 16.16 | 0.468 | 0.541 | 1.0 | 通过 |
| FAST | baseline | office | 205 | 19.29 | 0.834 | 0.336 | 1.0 | - |
| FAST | steps5k | office | 157 | 18.94 | 0.828 | 0.352 | 1.0 | PSNR/LPIPS 劣化 |
| BALANCED | baseline | courtyard / office | 765 / 552 | 19.11 / 18.19 | 0.615 / 0.855 | 0.349 / 0.295 | 1.0 | 仅基线 |
| QUALITY | baseline | courtyard / office | 1444 / 1027 | 21.45 / 19.13 | 0.809 / 0.849 | 0.226 / 0.285 | 1.0 | 仅基线 |

FAST steps5k 在 courtyard 上更好（PSNR +1.25），却在 office 上回退（PSNR −0.35、LPIPS +0.016），两段复核合计不通过。这是"质量优先、场景泛化"规则拦下的典型收益不稳定的候选：只在单场景变快或变好不足以改变默认参数。

第一次 holdout 因 overlay 被 `gsplat/` 中间产物占满而失败（quality 两个场景），清理后仅重跑这两个 trial，指标取自重跑结果。清理命令与磁盘说明见 [单 5090 系统部署与运维](单5090系统部署与运维.md) 第 12.1 节。

产物见 `calibration/route-holdout-v2/leaderboard.json`。

### 7.5 ETH3D 官方点云评测（0.02 m）

`ETH3DMultiViewEvaluation` 对 holdout 的 8 个重建逐一对 `scan_alignment.mlp` 打分。分数含义：Accuracy 是重建点落入 GT 2 cm 内的比例，Completeness 是 GT 被覆盖的比例，F1 是两者的调和平均。VGGT 路线输出的是稀疏点云，Completeness 天然很低；QUALITY 的 COLMAP 稠密重建才是这条指标的主要对象。

| 档位 | 场景 | Accuracy | Completeness | F1 |
|---|---|---:|---:|---:|
| FAST baseline | courtyard | 0.0049 | 0.0004 | 0.0008 |
| FAST baseline | office | 0.0458 | 0.0083 | 0.0140 |
| FAST steps5k | courtyard | 0.0049 | 0.0004 | 0.0007 |
| FAST steps5k | office | 0.0483 | 0.0082 | 0.0141 |
| BALANCED baseline | courtyard | 0.0059 | 0.0011 | 0.0019 |
| BALANCED baseline | office | 0.0654 | 0.0050 | 0.0093 |
| QUALITY baseline | courtyard | 0.7684 | 0.1828 | 0.2953 |
| QUALITY baseline | office | 0.2309 | 0.0554 | 0.0893 |

QUALITY 在 courtyard 上有 76.8% 的重建点落在 2 cm 内、覆盖 18.3% 的真值表面，F1 0.295；office 场景更难（F1 0.089）。FAST/BALANCED 的 F1 在千分位，符合"稀疏几何 + 3DGS 渲染"的定位，不应拿这条指标横向比较三条路线。

这里给出的是同机、同数据、同评测器下的可复现数值，不与 A100 历史成绩或外部榜单直接对比。

产物见 `calibration/route-holdout-v2/official.json`，每个 run 的 `evaluation/eth3d-official.log` 保留原始输出。
