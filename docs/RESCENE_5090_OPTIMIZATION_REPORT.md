# ReScene 5090 训练与质量标定报告

> 日期：2026-11-10  
> 机器：AutoDL RTX 5090 单卡（32 GB）  
> 范围：三条生产路线（FAST / BALANCED / QUALITY）的参数标定、ETH3D 官方评测、工程化改造与实跑缺陷修复  
> 关系：本报告是 5090 的正式标定记录；A100 历史实验见 [A100_OPTIMIZATION_REPORT.md](A100_OPTIMIZATION_REPORT.md)。两者不同机、不同 CUDA/gsplat 版本，分数不可直接横向比较。执行细节与逐条判定见 [5090_QUALITY_CALIBRATION.md](5090_QUALITY_CALIBRATION.md)。

## 执行勘误

本文是历史记录，保留原始数值与判定。本轮不能据此晋级候选：旧冻结帧注册统计因 symlink 路径匹配失效出现 total=0；实际 gsplat 渲染验证仍由注册图排序位置划分，尚未证明等于源图冻结名单。历史高斯 PLY 若缺少 trainer→COLMAP 变换，其 COLMAP→GT 几何评分不得沿用；COLMAP dense、sparse 与高斯产物必须分列，并核实来源、尺度和坐标系。网格顶点增加不是几何质量改善，`depth-appearance` 的历史“几何建议”不作为本轮推荐。courtyard/office 已经过多轮观察，不再是新 holdout。口径修复不算算法进步，新结果另记，历史证据不覆盖。

## 1. 结论

**本轮没有候选参数晋级生产。** 三个档位继续使用 `baseline`：

| 档位 | 默认配置 | 耗时（golden-kitchen，3 次中位数） | PSNR | SSIM | LPIPS |
|---|---|---:|---:|---:|---:|
| FAST | baseline（7,000 步） | 147 s | 14.60 | 0.342 | 0.471 |
| BALANCED | baseline（20k 步） | 370 s | 15.42 | 0.486 | 0.465 |
| QUALITY | baseline（COLMAP + 20k 步） | 580 s | 19.03 | 0.650 | 0.260 |

唯一保留的非默认项是**几何建议**：QUALITY 的 `depth-appearance`（深度损失 + 外观优化）在渲染指标持平的情况下把网格顶点提高 13.7%，记录为 `geometry_recommendation`，不静默改变默认参数。

被否掉的候选：

- **FAST `steps5k`**：屏幕集 25% 提速；验证集稳定快 18%–26%，但 playground SSIM 0.520 → 0.507，超出 0.01 容差；holdout 上 courtyard 更好、office 回退（PSNR −0.35、LPIPS +0.016）。属于“收益随场景反转”，按质量优先规则不晋级。
- **BALANCED `appearance` / `steps30k`**：屏幕集 PSNR/SSIM/LPIPS 均出现退化；`steps30k` 还更慢（1.43×）。
- **QUALITY `mvs1200` / `poisson12` / `steps30k`**：单指标退化或耗时增加；`poisson12` 网格点数 +394% 但 PSNR −0.39，判定为无效增益。

## 2. 环境与数据

| 项 | 实际值 |
|---|---|
| GPU | RTX 5090，32 GB，驱动 580.105.08，CUDA 13.0 |
| CPU / 内存 | 208 vCPU / 754 GB |
| Python | 3.11.18（`/root/ReScene/.venv`） |
| 关键库 | torch 2.12.0+cu130、gsplat 1.6.0、pycolmap 4.2.1 |
| 磁盘 | 系统 overlay 30 GB；数据盘 50 GB（`data`、`.cache`、`.venv` 软链） |
| ETH3D 评测器 | 源码构建 `ETH3D/multi-view-evaluation`，PCL 1.12，C++17 |

数据划分：

| 用途 | 场景 | 图像数 | 说明 |
|---|---|---:|---|
| 屏幕集 | golden-kitchen（VGGT 示例） | 25 | 所有候选的初筛，单次重复 |
| 验证集 | vggt-fern / vggt-flower / eth3d-playground | 24 / 25 / 38 | 冻结验证帧（每 8 帧取 1，共 3 帧/场景） |
| Holdout | eth3d-courtyard / eth3d-office | 38 / 26 | 从未参与参数筛选 |
| 官方评测 | ETH3D scan_eval（`scan_alignment.mlp`） | - | 2 cm 阈值点云精度 |

冻结帧清单在 `configs/calibration/validation-frames-v2.json`，由 `scripts/freeze_validation_frames.py` 生成；所有候选使用同一批帧，避免“换图”污染对比。

## 3. 方法与判定规则

标定链路由 `scripts/route_calibration.sh` 驱动，阶段顺序固定：

```text
baseline（3 repeats） → screen（候选矩阵） → select（选型）
  → validation（冻结帧复核） → holdout（未参与筛选场景）
  → evaluate（ETH3D 官方点云） → summarize
```

判定实现在 `src/rescene/selection.py`，只读 leaderboard 行：

- 指标容差：PSNR ±0.20 dB、SSIM ±0.01、LPIPS −0.01；超出即改进/劣化。
- FAST 屏幕集：不允许任何指标劣化，且 `time_ratio ≤ 0.90`。
- BALANCED / QUALITY 屏幕集：至少 2 个指标改进、无劣化、耗时上限 1.60× / 2.00×；QUALITY 指标持平时允许几何增益通道。
- Validation：FAST 每个场景不许劣化且 ≤1.60×；BALANCED/QUALITY 至少 2 个场景改进、各场景不劣化，上限 1.70×。
- Holdout：不允许任何劣化，上限 1.80×。
- 两段复核都通过才写入 `selected-v2.json`；否则回落 baseline。几何增益只写 `geometry_recommendation`。

## 4. 结果

### 4.1 基线复现（3 次，golden-kitchen）

| 档位 | 中位耗时 | PSNR | SSIM | LPIPS | 稠密点 | 注册率 |
|---|---:|---:|---:|---:|---:|---:|
| FAST | 147.1 s | 14.596 | 0.342 | 0.471 | - | 1.0 |
| BALANCED | 370.4 s | 15.420 | 0.486 | 0.465 | - | 1.0 |
| QUALITY | 580.0 s | 19.030 | 0.650 | 0.260 | 155,533 | 1.0 |

计时以 `route-baseline-v2` 的 3 次重复中位数为准；QUALITY 的稠密点数为零质量筛选后的输出。

### 4.2 屏幕集（单次重复）

| 档位 | 候选 | 耗时 s | 相对基线 | PSNR | SSIM | LPIPS | 稠密点 | 网格顶点 | 判定 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| FAST | baseline | 149 | 1.00× | 14.39 | 0.34 | 0.51 | - | - | - |
| FAST | steps5k | 112 | 0.75× | 14.39 | 0.35 | 0.45 | - | - | 通过 |
| BALANCED | baseline | 377 | 1.00× | 15.65 | 0.50 | 0.40 | - | - | - |
| BALANCED | appearance | 591 | 1.57× | 14.20 | 0.47 | 0.53 | - | - | 退化 |
| BALANCED | steps30k | 537 | 1.43× | 15.25 | 0.48 | 0.45 | - | - | PSNR/LPIPS 退化 |
| QUALITY | baseline | 571 | 1.00× | 19.49 | 0.66 | 0.25 | 156,864 | 64,853 | - |
| QUALITY | depth-appearance | 827 | 1.45× | 19.37 | 0.66 | 0.25 | 155,866 | 73,721 | 指标持平、网格 +13.7% |
| QUALITY | mvs1200 | 578 | 1.01× | 19.27 | 0.67 | 0.24 | 156,622 | 69,520 | PSNR −0.22 |
| QUALITY | poisson12 | 576 | 1.01× | 19.10 | 0.66 | 0.25 | 156,254 | 320,634 | PSNR −0.39 |
| QUALITY | steps30k | 748 | 1.31× | 19.57 | 0.64 | 0.27 | 161,487 | 62,699 | SSIM/LPIPS 退化 |

### 4.3 验证集（fern / flower / playground，冻结帧）

| 档位 | 候选 | 场景 | 耗时 s | PSNR | SSIM | LPIPS | 判定 |
|---|---|---|---:|---:|---:|---:|---|
| FAST | baseline | playground | 274 | 14.97 | 0.520 | 0.499 | - |
| FAST | steps5k | playground | 224 | 15.00 | 0.507 | 0.508 | SSIM 劣化 |
| FAST | baseline | fern | 152 | 19.38 | 0.605 | 0.243 | - |
| FAST | steps5k | fern | 112 | 19.71 | 0.612 | 0.247 | 0.74×，PSNR +0.33 |
| FAST | baseline | flower | 201 | 24.72 | 0.808 | 0.089 | - |
| FAST | steps5k | flower | 162 | 24.74 | 0.806 | 0.092 | 持平 |
| BALANCED | baseline | playground / fern / flower | 653 / 381 / 362 | 14.98 / 23.04 / 25.42 | 0.534 / 0.775 / 0.830 | 0.427 / 0.142 / 0.070 | 仅基线 |
| QUALITY | baseline | playground / fern / flower | 1265 / 516 / 634 | 14.31 / 25.35 / 26.28 | 0.500 / 0.838 / 0.863 | 0.457 / 0.110 / 0.061 | 仅基线 |

FAST `steps5k` 在三个场景稳定快 18%–26%，但 playground 的 SSIM 回退超过容差，验证不通过。QUALITY 在 playground 上的渲染指标低于 FAST/BALANCED（14.31 vs 14.97/14.98），说明质量档的优势并非对所有场景成立。

### 4.4 Holdout（courtyard / office）

| 档位 | 候选 | 场景 | 耗时 s | PSNR | SSIM | LPIPS | 判定 |
|---|---|---|---:|---:|---:|---:|---|
| FAST | baseline | courtyard | 219 | 14.91 | 0.450 | 0.539 | - |
| FAST | steps5k | courtyard | 167 | 16.16 | 0.468 | 0.541 | 通过 |
| FAST | baseline | office | 205 | 19.29 | 0.834 | 0.336 | - |
| FAST | steps5k | office | 157 | 18.94 | 0.828 | 0.352 | PSNR/LPIPS 劣化 |
| BALANCED | baseline | courtyard / office | 765 / 552 | 19.11 / 18.19 | 0.615 / 0.855 | 0.349 / 0.295 | 仅基线 |
| QUALITY | baseline | courtyard / office | 1444 / 1027 | 21.45 / 19.13 | 0.809 / 0.849 | 0.226 / 0.285 | 仅基线 |

FAST `steps5k` 在 courtyard 上 PSNR +1.25，却在 office 上回退，两段复核合计不通过：单场景收益不足以改变默认参数。

### 4.5 ETH3D 官方点云评测（2 cm）

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

QUALITY 的 courtyard 有 76.8% 重建点落入 2 cm、覆盖 18.3% 真值表面，F1 0.295；office 更难（F1 0.089）。FAST/BALANCED 输出稀疏点云，Completeness 天然极低，F1 只用于记录，不与 QUALITY 横向比较。

### 4.6 BA 前后重投影误差（BALANCED，golden-kitchen）

| 共同观测 | BA 前 mean / median / p95 (px) | BA 后 mean / median / p95 (px) | 改善 |
|---:|---|---|---:|
| 51,008 | 2.91 / 2.79 / 5.68 | 1.15 / 0.98 / 2.59 | 84.4% |

VGGT 快照在 1024² 工作画布，最终模型回到源图尺寸；误差按各自相机焦距归一化后统一换算到最终模型中位焦距（801.8 px）。QUALITY 的 BA 在 COLMAP 增量建图内部完成，没有独立 BA 前模型，几何证据取最终模型平均重投影误差（0.33 px）与注册率。

### 4.7 阶段耗时（3 次重复中的第 3 次）

| 档位 | 预处理 | 几何 | 训练 | 导出 | 评估 | 合计 |
|---|---:|---:|---:|---:|---:|---:|
| FAST | 0.46 s | 17.5 s | 127.0 s | 2.69 s | 0.20 s | 147.7 s |
| BALANCED | 0.46 s | 25.4 s | 342.3 s | 3.06 s | 0.05 s | 371.2 s |
| QUALITY | 0.47 s | 232.8 s | 344.4 s | 2.39 s | 0.04 s | 580.0 s |

训练（3DGS 优化）是 FAST/BALANCED 的主要成本；QUALITY 的几何（COLMAP 稠密）占 40%。预处理接近零是因为图像已由前序运行准备好，属于缓存命中，不作为冷启动预算。

## 5. 为标定落地的工程改造

实跑需要、并已进入生产代码的改动：

| 能力 | 位置 |
|---|---|
| Profile 新字段 + `with_overrides` 校验 | `src/rescene/config.py` |
| COLMAP / 输入尺寸 / 步数参数透传 | `backends.py`、`colmap_runner.py`、`pipeline.py` |
| CLI `--overrides`、`--input`、`--frames` | `src/rescene/cli.py`、`benchmark.py` |
| 输入哈希与确定性构建 | `preprocess.py`、`vggt_runner.py` |
| 分阶段计时 `timings` | `pipeline.py`、`metrics.py` |
| BA 前后观测诊断（按 `image_id` 对齐） | `geometry_metrics.py` |
| 固定验证帧与注册率指标 | `scripts/freeze_validation_frames.py`、`metrics.py` |
| 选型规则（含几何推荐通道） | `src/rescene/selection.py` |
| Holdout 评测驱动 | `scripts/evaluate_holdout.py` |
| 标定结果汇总 | `scripts/summarize_calibration.py` |
| 单场景 smoke | `scripts/train_smoke.py` |

测试：`ruff` 通过；`pytest` 83 passed / 1 skipped（本机缺 pycolmap 的跳过项）；`tests/test_selection.py` 覆盖选型规则、两段复核与几何推荐。

## 6. 实跑暴露并修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| BA 诊断观测数为 0 | VGGT 快照与最终模型的图像名/分辨率不同（1024² 工作画布 vs 源图） | 改为按 `image_id` 关联观测；误差按焦距归一化；真实运行恢复 51,008 条共同观测 |
| `evaluate_holdout.py` 找不到 `run_id` | leaderboard 行的 runs 是列表，脚本按单值取 | 支持 `runs` 列表，8 个 holdout run 全部评分 |
| `summarize_calibration.py` 崩溃 | `improved_scenes` 是 int，表格拼接按 list 处理 | 类型判断后格式化 |
| 官方 evaluator 无法构建 | 机器上的仓库不含评测目标；PCL 1.12 需要 C++17 | 改用 `ETH3D/multi-view-evaluation`，补 `-std=c++17`，apt 安装 PCL/Boost/Eigen/OpenCV |
| 两次 holdout trial 失败 | 30 GB overlay 被 `gsplat/` 中间产物写满（ENOSPC） | 清理中间产物后仅重跑失败 trial；修正部署文档中“runs 已软链到数据盘”的错误描述 |
| 桌面端 `cargo check` 失败 | `tauri.conf.json` 启用了 `assetProtocol`，未开 `protocol-asset` feature | 启用 feature，`cargo check` 通过（CI 同步生效） |

评测器是单线程（每张 scan 约 20–23 分钟），因此 holdout 评测被拆成 4 组并行执行，再用与驱动脚本同构的 schema 合并为单个 `official.json`；合并后 8 个 run 全部有分数、无 skipped。

## 7. 与 A100 / 原计划的差异

| 项 | A100 / 计划 | 5090 实际 |
|---|---|---|
| 默认参数 | A100 7k / 20k / 20k | 5090 同为 7k / 20k / 20k（标定后未改） |
| 数据 | 计划沿用已有 Kitchen/Fern/Flower/ETH3D | 机器数据为空，重新下载；garden 因磁盘不足未纳入验证，改用 playground |
| 磁盘 | 计划 136 GB 可用 | overlay 30 GB + 数据盘 50 GB，benchmark 工作目录在 overlay，需主动清理 |
| 官方评测 | 计划复用 dataset-pipeline | dataset-pipeline 不含该目标，实际构建 multi-view-evaluation |
| BA 诊断 | 计划记录 BA 前后 | QUALITY 的 BA 内嵌于增量建图，只能给最终模型证据 |

因此本报告不引用 A100 的绝对分数，也不把 5090 的 F1 与 A100 报表横比。

## 8. 复现

```bash
# 远程准备（一次）
ssh rescene-5090 'cd /root/ReScene && bash scripts/build_eth3d_evaluator.sh'
ssh rescene-5090 'cd /root/ReScene && bash scripts/download_calibration_data.sh'

# 完整标定链（后台 + GPU 锁）
ssh rescene-5090 'cd /root/ReScene && nohup setsid bash scripts/route_calibration.sh > /tmp/route-calibration.log 2>&1 < /dev/null'

# 汇总与证据
ssh rescene-5090 'cd /root/ReScene && .venv/bin/python scripts/summarize_calibration.py --selection configs/calibration/selected-v2.json'
```

产物：

- `calibration/route-baseline-v2/leaderboard.json`
- `calibration/route-screen-v2/leaderboard.json`
- `calibration/route-validation-v2/leaderboard.json`
- `calibration/route-holdout-v2/leaderboard.json`
- `calibration/route-holdout-v2/official.json`
- `calibration/route-holdout-v2/geometry-ba.json`
- `configs/calibration/selected-v2.json`
- `configs/calibration/validation-frames-v2.json`

## 9. 已知限制与后续

1. **质量档并非全局占优**：playground 上 QUALITY 的 PSNR/SSIM 低于 FAST/BALANCED，说明“质量档”目前只保证更高成本的稠密几何与整体观感，不保证每个场景的渲染指标都最高。需要按场景类型（室内/室外、纹理强弱）细分推荐。
2. **FAST 的 steps5k 值得再验证**：它在 fern/holdout courtyard 有正收益，只在 office 回退。可尝试按注册率/重叠度自适应决定 5k 或 7k，而不是全局替换。
3. **评测吞吐**：ETH3D evaluator 单线程、每 scan 约 20 分钟，是官方评测的瓶颈；后续可缓存 per-scan 结果或按 CPU 并行。
4. **磁盘模型脆弱**：benchmark 中间产物在 30 GB overlay，必须依赖清理脚本与磁盘告警；长期应把 `runs/` 移到数据盘或独立卷。
5. **单卡串行**：worker 一次只租一个 Job，GPU 独占；多卡/多 worker 需要调度层改进。
