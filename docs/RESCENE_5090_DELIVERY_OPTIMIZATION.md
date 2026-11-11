# ReScene 5090 三路线优化报告（v3）

本报告只记录本轮在单台 RTX 5090 上真实执行、可复查的实验。未运行的候选不写入结论；未达到的目标如实标注失败。旧实验记录只作为历史参考，不当作本轮基线。

## 1. 范围与原则

- 三条路线保持既有定位：FAST = VGGT 无 BA / 7000 步；BALANCED = VGGT + BA / 20000 步；QUALITY = COLMAP SfM + BA + MVS / 20000 步。
- 先建立可信口径，再做单变量筛选；只对胜者做组合和三次重复。候选冻结后才接触预留 holdout。
- 训练与验证使用显式 source ID；同一 run 内验证集固定，评测只读取最终 `gsplat/stats/val_step{final}.json` 与 `photometric_views.json`，缺失、NaN、步数不符或视图集合不符即判无效。
- 每条证据记录：配置、环境、输入清单与哈希、vendor revision、模型哈希、阶段耗时、最终产物与重载校验。
- 4090/旧 A100 数字、`route-*-v2` 结果与 P0 的 20 步契约诊断均不作为本轮优化基线。

## 2. 运行安全与资源预算

- 实验前对生产 worker 执行 `drain`，等待活动 Job 结束，再 `stop`。
- 所有 GPU 入口使用 `flock --close -w 600 /root/ReScene/.gpu.lock`，lock FD 不传入被启动进程；每次试验前拒绝已存在的外部 compute PID。
- 监督进程每 0.5 s 采样本进程树内的 `nvidia-smi` 进程显存，记录**全流程**自有峰值（含 VGGT/COLMAP 子进程），并以 `peak_owned_gpu_mib_sampled` 与训练阶段 `peak_vram_mb` 分开报告。
- 180 s 无阶段/日志进展发出告警；600 s 无进展且自有 GPU 占用为 0 时终止自有进程组；按路线设置 1800/3600/5400 s 上限。
- 每个 trial 开始前检查数据盘至少 10 GiB；不足则拒绝启动并记录。只清理本 trial 已导出并重载校验后的临时文件；不删除旧证据、vendor 缓存或生产 Job。
- 每个阶段结束（无论成败）在 `finally` 中恢复 worker，并检查 `workerctl status`、heartbeat 与真实小 Job。

## 3. 数据与划分

### 3.1 场景角色（在任何候选试验前冻结）

| 场景 | 角色 | 图像数 | 环境 | 几何 GT |
|---|---|---:|---|---|
| golden-kitchen | 单场景诊断/筛选 | 25 | 室内桌面 | 无 |
| vggt-fern | 跨场景验证 | 20 | 植物/低纹理 | 无 |
| vggt-flower | 跨场景验证 | 25 | 植物/低纹理 | 无 |
| eth3d-playground | 跨场景验证/几何评测 | 38 | 室外 | scan_eval + calibration |
| eth3d-bridge | F3 帧预算（>80 图） | 110 | 室内 | 无（仅光度指标） |
| eth3d-delivery-area | 跨场景验证 | 44 | 室内 | scan_eval + calibration |
| eth3d-facade | 跨场景验证 | 76 | 室外 | scan_eval + calibration |
| eth3d-electro | **预留 holdout（单次）** | 45 | 室外 | scan_eval + calibration |

清单文件：`configs/datasets/route-development-v3.json`、`configs/datasets/route-holdout-v3.json`。courtyard/office 已在历史轮次使用，**不是**新 holdout。ETH3D 数据许可为 CC BY-NC-SA 4.0，来源 <https://www.eth3d.net/datasets>；归档 SHA-256 由远端 `.sha256` 文件校验。

### 3.2 验证帧

- 默认对排序后的源图每 8 张取 1 张作为光度 held-out；F3 使用每 12 张取 1 张，以在 110 图场景上得到跨预算相同的固定验证 source ID。
- 冻结验证源会被强制纳入选择集（至少保留 1 个训练帧），因此 48/64/80 预算使用完全相同的验证 source ID 与分辨率。
- SfM/VGGT 允许使用验证图像估计相机；语义是光度 held-out，不是几何 held-out。几何质量单独用 ETH3D GT 对齐后评测。
- 训练/验证划分写入每个 run 的 `photometric_split.json`、`input_manifest.json` 与 `gsplat/photometric_views.json`，评测前断言实际渲染集合等于冻结集合且与训练集不交。

## 4. 指标定义

- 渲染：最终 step 的逐视图 PSNR/SSIM/LPIPS 均值，另存 per-view 数值与 image/source 映射。
- 注册：注册图像数/选中数；验证帧注册集合同样逐项保存。
- 位姿：与 ETH3D calibration 对齐后的 ATE 与旋转误差（仅有 GT 的场景）。
- 几何：官方 `ETH3DMultiViewEvaluation` 的 Accuracy/Completeness/F1，输入为对齐后的稠密点云；没有 GT 的场景不伪造 F1。点数和顶点数只作规模记录。
- 资源：各阶段墙钟、全流程墙钟、全流程自有 GPU 峰值、训练峰值、PLY/SPZ 字节数。
- 质量容差：PSNR 0.20 dB、SSIM 0.01、LPIPS 0.01；在 3 次原始基线后冻结，候选阶段不再调整。
- 发布门槛（方案第 4.3 节）：FAST 质量不回退且总耗时或全流程峰值显存至少下降 10%；BALANCED 至少两个渲染指标显著改善、其他质量指标与注册率不回退、总耗时不超过 1.6 倍；QUALITY 渲染或几何至少一项实质收益且另一类不回退、总耗时不超过 2 倍。研究目标单独列示，不以“实验完成”替代目标达成。

## 5. 基线结果（同机、同源、三次重复）

所有基线使用 golden-kitchen（25 图，验证 source ID 00/08/16/24），生产默认参数，cold run；`diagnostics` 关闭，主指标与最终产物独立校验。

### 5.1 FAST（VGGT 无 BA，7000 步）

| repeat | PSNR | SSIM | LPIPS | reproj px | 总秒 | PLY MiB | SPZ MiB | 全流程自有峰值 MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| r1 | 13.001 | 0.312 | 0.577 | 0.500 | 144.6 | 189.5 | 18.2 | 9982 |
| r2 | 14.605 | 0.341 | 0.468 | 0.500 | 146.1 | 193.5 | 18.6 | 10388 |
| r3 | 13.886 | 0.336 | 0.558 | 0.500 | 143.2 | 190.7 | 18.4 | 9982 |
| **中位数** | **13.886** | **0.336** | **0.558** | **0.500** | **144.6** | **190.7** | **18.4** | **9982** |

运行间 PSNR 极差 1.60 dB，SSIM 极差 0.029，LPIPS 极差 0.109，均远大于 0.20 dB/0.01/0.01 的判定容差。该噪声水平直接限制了单次筛选的可判定性；候选比较必须使用三次重复中位数，并如实报告区间。

### 5.2 BALANCED（VGGT + BA，20000 步）

| repeat | PSNR | SSIM | LPIPS | reproj px | 总秒 | Gaussian | 全流程自有峰值 MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| r1 | 15.840 | 0.504 | 0.443 | 1.093 | 361.3 | 919341 | 27406 |
| r2 | 15.723 | 0.503 | 0.451 | 1.093 | 364.0 | 897502 | 27406 |
| r3 | 15.203 | 0.479 | 0.507 | 1.093 | 367.4 | 见运行产物 | 27406 |

BALANCED 的位姿诊断重投影误差在 r1/r2 完全一致，训练指标波动约 0.12 dB，显著小于 FAST。

### 5.3 QUALITY（COLMAP SfM + BA + MVS，20000 步）

| repeat | PSNR | SSIM | LPIPS | reproj px | 总秒 | Gaussian | PLY MiB | SPZ MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| c1 | 17.561 | 0.591 | 0.292 | 0.344 | 550.5 | 685799 | 154.4 | 16.5 |
| e2 | 15.739 | 0.517 | 0.393 | 0.344 | 572.8 | 825197 | 185.7 | 19.2 |
| e3 | 16.957 | 0.575 | 0.310 | 0.344 | 564.2 | 689368 | 155.2 | 16.6 |
| **中位数** | **16.957** | **0.575** | **0.310** | **0.344** | **564.2** | **689368** | **155.2** | **16.6** |

QUALITY 三次注册率均为 96%，验证帧注册率均为 100%，位姿诊断重投影误差均为 0.344 px；但 PSNR 极差 1.82 dB、SSIM 极差 0.074、LPIPS 极差 0.101，显著大于判定容差。差异来自 COLMAP/随机初始化的运行间不确定性，而不是参数不同。因此：

- 旧版单次 QUALITY 19.118 dB 不再作为可复现基线，本轮以 16.957 dB 中位数为准。
- 单次 QUALITY 候选实验无法判定小于 1.82 dB 的收益；QUALITY 候选必须在同一源上重复至少三次，以中位数和区间共同判定。
- 三条路线的完整基线均已完成；筛选阶段使用单次结果只做淘汰，不做晋级。

## 6. 单变量候选筛选（golden-kitchen / eth3d-playground）

候选只改一个变量；单次结果只用于淘汰，不用于晋级。golden-kitchen 的 FAST 对照为 5.1 的三次中位数；QUALITY 对照为本轮同源 playground 基线（`quality-playground-original`，一次 1205.245 s，PLY 778.8 MiB，注册率 0.9189）。

| 候选 | 单变量 | PSNR | SSIM | LPIPS | 注册率 | 总秒 | PLY MiB | 结论 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| F1 packed | `gsplat_packed=true`，7000 步 | 13.991 | 0.344 | 0.543 | 1.000 | 151.8 | 187.8 | PSNR 仍低于 FAST 中位数，耗时增加 5%；淘汰 |
| F2 10k | `gsplat_steps=10000` | 14.958 | 0.335 | 0.470 | 1.000 | 201.7 | 208.1 | 质量提高但耗时增加 39%，不满足 FAST 的 10% 资源门槛；淘汰 |
| F2 5k | `gsplat_steps=5000` | 14.540 | 0.338 | 0.483 | 1.000 | 112.8 | 177.3 | 单次相对 FAST 中位数 PSNR +0.65 dB、LPIPS −0.075、总秒 −22%；进入三次重复复核 |
| Q3 dense | `gsplat_init_points=dense`，其余 QUALITY 不变 | 15.987 | 0.576 | 0.363 | 0.9189 | 1254.9 | 1011.6 | SSIM +0.017、LPIPS −0.059，总秒 +4.1%，但 PLY +30%；单次不能越过 QUALITY 1.82 dB 噪声，进入重复复核前不晋级 |
| B2 fine-tracking | `vggt_fine_tracking=true`，其余 BALANCED 不变 | 15.873 | 0.528 | 0.427 | 1.000 | 351.3 | 192.6 | SSIM +0.025、LPIPS −0.024，重投影 1.093→0.961 px，总秒 −3.5%；单次满足 BALANCED 门槛，进入三次重复复核 |

结论：F2-5k 同时改善质量和耗时，B2-fine-tracking 同时改善 BALANCED 渲染与重投影；两者都只完成单次初筛，必须通过三次重复、跨场景和 holdout 后才写入生产默认。Q3-dense 的渲染改善与文件膨胀同时存在，不能凭单次结果替代三次 QUALITY 比较。

### 6.1 F2-5k 三次重复

| repeat | PSNR | SSIM | LPIPS | 总秒 | PLY MiB |
|---|---:|---:|---:|---:|---:|
| r1 | 14.541 | 0.348 | 0.488 | 106.3 | 177.7 |
| r2 | 13.517 | 0.333 | 0.598 | 106.5 | 175.0 |
| r3 | 14.862 | 0.349 | 0.454 | 106.9 | 177.2 |
| **中位数** | **14.541** | **0.348** | **0.488** | **106.5** | **177.2** |

相对 FAST 三次中位数：PSNR +0.66 dB、SSIM +0.012、LPIPS −0.070、总秒 −26.4%，注册率保持 100%。单次 r2 的 PSNR 明显回落，说明运行间噪声仍存在；中位数与三项质量区间共同支持 F2-5k 作为下一版本候选，而不是 0.2.1 的既成默认。跨场景复核仍受冻结验证集选择错误阻塞，未取得可用结果。

## 7. 生产取舍

- **F2-5k**：三次重复中位数满足 FAST 门槛，列为下一版本候选。0.2.1 已签名构建不替换 `gsplat_steps=7000`，避免安装包、源清单和签名版本漂移；下一版本重新构建后才能切换。
- **B2-fine-tracking**：单次 BALANCED 结果满足质量和重投影方向，但没有三次重复，故不冻结、不替换默认。
- **Q3-dense**：单次 SSIM/LPIPS 改善但 PLY 增长 30%，未完成三次同源 QUALITY 复核；不晋级。
- 跨场景 vggt-fern/vggt-flower 运行在冻结验证集阶段被 `Frozen validation contains a duplicate or ineligible source` 拒绝；ETH3D-electro holdout 在 COLMAP 注册名与冻结验证 source ID 不一致时被拒绝。两者都没有产生可用指标，不写成“通过”。
- 实验结束后已清除 worker drain 文件；`workerctl status` 为 `running drain=no`，生产 worker 恢复领取任务。

## 8. 复现入口

- 规范定义：`configs/calibration/route-experiments-v3/`。
- 试验执行：`scripts/route_experiments_v3.py <spec> <run-dir> --repeat N`。
- GPU 监督：`scripts/supervise_route_experiments.py <plan.json>`；计划文件位于 `configs/calibration/route-experiments-v3/plans/`。
- 汇总：`--summarize <runs> --resources <dir> --output-json <file>` 输出每次重复与中位数。
- 证据根目录：`/root/autodl-tmp/rescene/delivery-v3/`（远端仅存运行产物）；仓库内只保留配置、汇总与文档。

---

# ReScene 5090 三路线 v4 激进优化（2026-11-10）

## 9. 范围与环境（先于任何候选）

v4 只在 5090 上执行“质量优先、可判定”的激进优化；0.2.1 安装包、签名和发布清单未改动，v3 运行产物全部保留。

| 项目 | 事实 |
|---|---|
| 远端源码 | 5090 上 `src/rescene/preprocess.py` 曾停留在旧实现（验证源只允许 eligible 帧），本轮按 sha256 校验同步为本地版本 `4025b13d…`；`colmap_runner.py`（含 `PINHOLE`）同步前已与本地一致 `215a1aa6…` |
| 同步方式 | `rsync -a --checksum --delete --exclude __pycache__`，同步后逐文件比对 sha256 |
| 远端测试 | `pytest tests/test_preprocess.py tests/test_config.py tests/test_backends.py -q` → 44 passed（含 `test_frozen_validation_survives_duplicate_filtering`） |
| 编译检查 | `python -m py_compile scripts/supervise_route_experiments.py scripts/route_experiments_v3.py` 通过 |
| 数据盘 | 起跑前把 8.8 G 的 `state/5090-cu130-v1/runtime.tar.gz`（含 `checksums.sha256`，校验通过）迁至 `/root/rescene-archive/5090-cu130-v1`，数据盘由 10.8 G 增至 19.5 G 可用，未删除任何运行产物 |
| 数据盘门槛 | 监督器起跑要求 ≥8 GiB，每次 trial 后 <3 GiB 即停队列；运行器自身仍要求每次 trial ≥10 GiB |
| 监督器变更 | `RUNS` 由 `RESCENE_DELIVERY_ROOT` 决定（默认 `delivery-v4`）；训练命令固定为 `scripts/route_experiments_v3.py`；`GPU_BOUNDS={fast:2400, balanced:5400, quality:9000}`；`STALL_BOUNDS={fast:900, balanced:1800, quality:3600}`；无进展条件为 `now-progress ≥ STALL_BOUNDS[profile] and used == 0`；保留 180 s warning 与 600 s GPU 阶段（`training`）无显存守卫，CPU-only 的 COLMAP geometry 不会被判为 GPU 停滞；起跑前校验 `workerctl status` 为 `running drain=no` 且无外部 compute PID |
| 源码同一性 | 本组全部可比较 trial 的 `environment.json.source_tree_sha256` 均为 `e3418760bf85c6b74c103f6cc5b0a3d3839fc7d6d01b0de72ad0f0297ec34a04` |

## 10. 冻结数据与 holdout 验证源

- 筛选/跨场景沿用 `configs/datasets/route-development-v3.json`，未重新划分。
- 新建 `configs/datasets/route-holdout-v4.json`：只含 eth3d-electro，验证源写为显式索引 `{"sources":[0,8,16,24,40]}`。
- 该索引经 `discover_images` 实测对应 `DSC_9257/DSC_9265/DSC_9273/DSC_9281/DSC_9299`。
- 排除 `DSC_9291.JPG`（原始索引 32、归一化图 `000031.jpg`）：holdout-fast 的 sparse 模型未注册该图，冻结验证 split 无法渲染，排除原因写入 `delivery-v4/summaries/holdout-selection.json`。
- holdout spec：`baselines/holdout-{fast,balanced,quality}-v4.json`，基线 candidate 分别为 `fast-v4-original-holdout`、`balanced-v4-original-holdout`、`quality-v4-original-holdout`（加 `-holdout` 后缀是为了让 `--summarize` 的同名 candidate 分桶不与筛选基线混算）。

## 11. 判定门槛（与冻结计划一致）

单次筛选“通过”＝`trial_validation.json.valid=true`、注册率不低同场景基线 −0.01、至少两项达到 `PSNR ≥ control +0.20` / `SSIM ≥ control +0.010` / `LPIPS ≤ control −0.020`，第三项不超回退容差 `PSNR −0.20` / `SSIM −0.01` / `LPIPS +0.01`，且总耗时满足该候选上限。单次只用于淘汰，任何“通过”都必须补足三次重复。

| 路线 | 三次中位数晋级门槛 | 时间/资源上限 |
|---|---|---|
| FAST | PSNR ≥ 基线 −0.20、SSIM ≥ −0.01、LPIPS ≤ +0.01，注册率不降低，总耗时或峰值显存至少 −20% | `3500` 需 ≤0.65× 基线；`5k-1920` 需 ≤1.25× `5k` 且 PSNR 更高或 LPIPS 更低；bridge 需 ≤0.80× |
| BALANCED | PSNR +0.50 或 SSIM +0.02 或 LPIPS −0.05，另两项不越容差，注册率与验证注册率不降低 | ≤1.8× 基线 |
| QUALITY | PSNR +0.50 或 SSIM +0.02 或 LPIPS −0.10，另两项不越容差 | ≤2.5× 基线、PLY ≤2.5× 基线、点云 F1 不低于基线 5% |

跨场景（不得在任一场景越容差，且至少一个场景达到 PSNR +0.20 / SSIM +0.010 / LPIPS −0.020）与单次 holdout（同口径，另加 QUALITY 的 F1 约束）均为冻结前硬门槛。

### 11.1 同路线多候选的排序规则（本轮补充记录）

冻结计划的表格只定义了“每个候选各自能否通过”，没有定义“多个候选同时通过时谁是胜者”。本轮采用并全程一致的规则：**先剔除未通过者，余下按 PSNR 降序、LPIPS 升序、总耗时升序取第一名**；表格中的时间/资源百分比（如 `3500` ≤0.65×）只是该候选的**上限条件**，不是优待条件。该规则在 FAST 上直接决定了 `3500` 与 `5k-1920` 的取舍，故在此显式记录，避免“谁更快谁优先”的隐含偏好。

## 12. 运行期事件与判废记录

| 事件 | 事实 | 处置 |
|---|---|---|
| `quality-v4-original-r1` 被监督器中止 | 第 699.6 s 报 `external GPU compute PIDs appeared: [439502]`，判定 `valid=false`；此前 `stages/geometry.json` 已在 670.7 s 成功结束。nvidia-smi 报出的 PID 在 `/proc` 中已不存在（COLMAP 子进程刚退出、上下文尚未释放） | 该次 trial 判无效并重跑；产物移到 `delivery-v4/evidence/quality-v4-original-r1-aborted/`、日志移到 `delivery-v4/logs/aborted/`，不参与任何中位数 |
| 监督器归属判定修正 | `owned()` 现在同时接受“与 trial 同一 session”的 PID，忽略 `/proc` 中已消失的 PID，并要求外部 PID 连续 6 次采样（约 3 s）存在才中止 | 用“孙进程被 reparent 到 pid 1”的最小复现验证：`grand owned: True`；不存在的 PID `owned: False`；修正后重跑基线队列 |
| 数据盘回收（不触碰证据） | QUALITY 单次运行约 1.1 G（`gsplat/point_cloud.ply` 约 0.79 G）；已判废的 `runs/quality-v4-original-r1-aborted`、`runs/quality-v4-original-r2-contended` 各约 2.0 G，其 JSON 证据已先复制到 `evidence/`；`cache/uv/archive-v0` 6.4 G 经 `stat -c %h` 抽样确认硬链接数为 1（未与 `.venv` 共享 inode），属可再生成的构建缓存 | 删除上述 4.0 G 判废目录与 6.4 G 构建缓存后，数据盘可用由 15.0 G 升至 26.0 G；未删除任何 v3 运行、数据集、基线或胜者产物 |
| `fast-bridge80-v4-original`（80 视图基线）确定性 OOM | 两次运行都在同一位置失败：VGGT 无 BA 通道先产出 `empty_sparse`，流水线按既有降级路径改跑 BA（`vggt_query_frames=16`），随后在 `grid_sample` 处 `CUDA out of memory`（请求 7.99 GiB、剩余 6.56 GiB，进程峰值 31720 MiB / 31104 MiB 可用） | 该 80 视图基线判无效，FAST bridge 对比不成立；不改 spec、不改帧数与分辨率，bridge 结论记为“未取得指标”，生产 `max_frames` 不变。证据：`evidence/bridge80-fast-baseline-failure/`（两份 `resource.json`、`degradation.json`、`config.json`、`environment.json`、geometry 日志尾部），运行目录改名归档为 `runs/archived-fast-bridge80-v4-original-*`。同批 `fast-v4-5k-bridge80-r1` 以同一位置 OOM 失败（`peak_owned_gpu_mib_sampled=31720`、`returncode=1`、`valid=false`），故 80 视图预算在 v4 中只作为“不可行”记录，不参与任何晋级判断 |
| `nvidia-smi` 采样超时打断一次 QUALITY 试跑 | `quality-v4-dense30k-r1` 在 geometry（PatchMatch）进行到约 350 s 时被 SIGTERM：`plan-status` 记录 `supervisor-error: TimeoutExpired: Command '['nvidia-smi', '--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits']' timed out after 10 seconds`；同期 COLMAP PatchMatch 占满 GPU，`nvidia-smi` 单次查询超过 10 s 超时，监督器把异常当作 trial 失败并结束整条 plan | 该次目录归档为 `runs/archived-quality-v4-dense30k-r1-smi-timeout`，不参与任何比较；重跑前删除同名 trial 日志，并以 `block4g-v4.json` 重新排队（同时把 QUALITY 的 pinhole r2/r3 一起排进去） |
| 磁盘守卫拦下一次 QUALITY 试跑 | `quality-v4-pinhole-r1` 在 0.6 s 内退出：`RuntimeError: Less than 10 GiB free on data volume; refusing trial`（当时可用 10,722,488,320 B ≈ 9.99 GiB，距 10 GiB 阈值差约 15 MB） | 处置：把已判废的 `quality-v4-2400-r1/r2/r3` 的 `gsplat/`（各约 0.9 G）与 `scene.spz`、以及判 degraded 的 `runs/fast-flower-v4-original-r1` 删除（JSON 证据已在 `evidence/`），可用回升到 13.2 GiB 后重跑；被删的 PLY 属于“已判废候选”，不影响任何中位数或证据链 |
| QUALITY 跨场景候选在 delivery-area 注册失败 | `quality-v4-pinhole-delivery-area-r1` 在 geometry 阶段抛 `RuntimeError: COLMAP registration rate is below 70%; dense reconstruction skipped`（`colmap_runner.py:99`），`returncode=1`、`valid=false`、wall≈103 s；同场景基线 `quality-delivery-area-v4-original-r1` 用 `SIMPLE_RADIAL` 顺利完成（20.018 / 0.8226 / 0.3300，1384.0 s） | 该次归档为 `runs/archived-quality-v4-pinhole-delivery-area-r1-registration-fail`；结论记为“`PINHOLE` 在未标定场景注册率跌破 70%”，QUALITY 跨场景门槛不通过，F1 与 holdout 不再执行 |
| 跨场景 spec 的取帧步长不一致被拦截 | 新建的 `quality/quality-v4-pinhole-{delivery-area,facade}.json` 最初写成 `validation.every=4`，而对应基线是 `every=8`，会让两侧帧集合不同、比较失效 | 在排队前把候选 spec 改成 `every=8` 与基线一致，再启动跨场景队列（日志：`logs/supervisor-block5.log`） |
| 队列无法复用同名 trial 日志 | `monitor()` 用 `open(log_path, "xb")` 创建 `logs/<trial>.log`；上一次被手动中断的 trial 留下同名日志后，新队列在第一个 trial 就抛 `FileExistsError`，被外层捕获成 `supervisor-error` 并立即结束（日志里只剩 `Worker stopped`/`Worker started`） | 处置：重跑前删除同名 `logs/<trial>.log`；本轮据此清理 `logs/balanced-delivery-area-v4-original-r1.log` 后重启队列。该事实同时说明“中断 trial 后必须同时清理日志”，已写入操作流程 |
| 跨场景 spec 指向错误被拦截 | 首次排队时 `fast-v4-5k-1920-fern` 复用了筛选 spec `fast/fast-v4-5k-1920.json`（`scene=golden-kitchen`），会把 golden-kitchen 再跑一遍却记成 fern | 在 trial 执行前发现并修掉：新增 `fast/fast-v4-5k-1920-fern.json`（`scene=vggt-fern`、`steps=5000`、`overrides.preprocess_max_side=1920`），被杀掉的那次 `balanced-delivery-area-v4-original-r1` 半成品目录与日志一并删除，随后以 `block4d-v4.json` 重新排队 |
| `balanced-v4-fine-playground-r1`（跨场景候选）判 degraded | VGGT BA 抛 `ValueError: No reconstruction can be built with BA`；降级路径（`query_frame_num=16`、`max_query_pts=2048`、fine tracking）随后 `torch.OutOfMemoryError`（请求 3.54 GiB、剩余 639 MiB，进程 30.72 GiB），最终回退 COLMAP sparse；`valid=false`。该次与 `balanced-playground-v4-original-r1` 用的是同一 `balanced-playground-v4` 帧选择（37 图，区别于筛选阶段的 25 图），两次都降级 | 这两次都不参与比较；playground 的 BALANCED 跨场景结论记为“未取得指标”，跨场景证据只由 `eth3d-delivery-area` 提供，并在结论中注明覆盖不足 |
| `fast-flower-v4-original-r1` 判为 degraded | 四个 stage 全部 `success`（geometry 66.3 s、training 121.7 s、export 1.3 s），但 VGGT 无 BA 通道先产出 `empty_sparse`、流水线改跑 BA（`vggt_query_frames=16`），runner 写入 `trial_validation.json.reason="degraded"`、`valid=false`、`returncode=1`（`RuntimeError: Trial degraded; invalid for comparison`），wall 195.2 s、峰值 24886 MiB | 该次不参与任何中位数；`vggt-flower` 的 FAST 对比记为“未取得指标”（同配置在 flower 上必然走同一降级路径），`fast-v4-3500-flower` 不运行；产物保留在 `runs/fast-flower-v4-original-r1`（含 `metrics.json` 25.292 / 0.8324 / 0.0784，仅作记录） |
| 队列启动前置检查 | `require_idle_worker()` 要求 `workerctl status` 恰为 `running drain=no`；在“手动 `workerctl stop` 后直接起队列”的第一次尝试中，监督器以 `RuntimeError: workerctl status is not 'running drain=no': 'stopped'` 拒绝启动 | 恢复方式为先 `workerctl start` 使状态回到 `running drain=no`，再启动队列；`drain=yes` 与 `stopped` 都被视为非就绪。队列日志：`logs/supervisor-block4.log` |
| 队列遇到判废 trial 即结束 | 监督器把 `valid=false` 的 trial 记为失败并立即结束整条 plan（不是跳过继续）：`block3` 在 `fast-flower-v4-original-r1` 判 degraded 后结束，`block4` 在 `balanced-playground-v4-original-r1` 判 degraded（`ba_failed+colmap_sparse`）后结束，日志末尾都会出现 `Worker started: <pid>`（恢复生产 worker）与 `"valid": false` 的 trial 摘要 | 处置：把剩余 trial 重新写成新 plan（`block4b-v4.json`）再起队列；同时避免把“已知必然降级”的组合留在 plan 内（如 `vggt-flower` 的 FAST 组合） |
| `balanced-playground-v4-original-r1`（跨场景基线）判 degraded | VGGT BA 失败后回退 COLMAP（`degradation.json: stage=geometry, reason=ba_failed+colmap_sparse`），`valid=false`、`returncode=1`、wall 668.0 s；同一 config 的三次基线在筛选阶段均成功，说明该降级不是配置差异而是运行期 | 该次不计入任何比较；playground 的 BALANCED 对照沿用已有三次有效基线（15.310 / 0.4840 / 0.4812 / 342.7 s），不重复消耗 GPU |

除上述判废/降级事件外，基线 6 次（FAST 3、BALANCED 3）均为 `valid=true`，`abort_reason` 为空，`peak_owned_gpu_mib_sampled` 有值。

### 12.1 计时污染与孤儿进程（基线阶段）

| 事件 | 事实 | 处置 |
|---|---|---|
| `quality-v4-original-r2` 首次计时被污染 | 该次 COLMAP geometry 用时 993.5 s，而同配置 `r1` 为 680.9 s；同期 ETH3D 官方评测器（`ETH3DMultiViewEvaluation`，占用 24 核）在为 `quality-v4-original-r1` 评 F1，二者时间窗重叠 | 该次 trial 判废，运行目录移到 `runs/quality-v4-original-r2-contended`、证据复制到 `evidence/quality-v4-original-r2-contended/`，删除其 `resources` 记录后重跑；此后规定：GPU trial 运行期间不启动任何 CPU 密集评测，F1 评分只在队列空闲时执行 |
| 中止 trial 产生孤儿 gsplat 进程 | 只对 trial 主进程发 SIGTERM 后，`rescene.gsplat_runner`（pid 494548，已被 reparent 到 pid 1）仍在写已改名的运行目录 | 新一次队列启动被 `require_idle_worker()` 以 `external GPU compute PIDs present before start: [494548]` 拒绝（守卫按设计生效）；清掉孤儿后重跑，基线队列从 `r2` 继续 |

## 13. v4 基线（冷启动、同源、同机）

v4 全部可比较 trial 的 `source_tree_sha256` 均为 `e3418760…`。基线噪声（三次极差）已单独记录在 `delivery-v4/summaries/baseline-noise.json`。

### 13.1 FAST（golden-kitchen，7000 步，`every:8`）

| repeat | PSNR | SSIM | LPIPS | 总秒 | 峰值 MiB |
|---|---:|---:|---:|---:|---:|
| r1 | 14.181 | 0.3350 | 0.5196 | 135.4 | 10388 |
| r2 | 13.791 | 0.3315 | 0.5069 | 143.2 | 16358 |
| r3 | 14.455 | 0.3395 | 0.4873 | 140.6 | 24954 |
| **中位数** | **14.181** | **0.3350** | **0.5069** | **140.6** | **16358** |

三次极差：PSNR 0.664 dB、SSIM 0.0080、LPIPS 0.0323、总秒 7.8 s；注册率 1.000。

### 13.2 BALANCED（golden-kitchen，20000 步，`every:8`）

| repeat | PSNR | SSIM | LPIPS | 重投影 px | 总秒 | 峰值 MiB |
|---|---:|---:|---:|---:|---:|---:|
| r1 | 15.310 | 0.4840 | 0.4812 | 1.0928 | 352.2 | 16358 |
| r2 | 14.738 | 0.4707 | 0.5050 | 1.0966 | 342.7 | 11468 |
| r3 | 15.647 | 0.4854 | 0.4522 | 1.0995 | 339.8 | 12280 |
| **中位数** | **15.310** | **0.4840** | **0.4812** | **1.0928** | **342.7** | **12280** |

三次极差：PSNR 0.909 dB、SSIM 0.0147、LPIPS 0.0528、总秒 12.4 s。极差已接近或超过 BALANCED 晋级阈值（SSIM +0.02、LPIPS −0.05），因此 BALANCED 的晋级必须同时给出三次中位数与逐次方向一致，不能只看单次。


## 14. v4 候选矩阵与执行顺序

规范位于 `configs/calibration/route-experiments-v4/`（远端 `delivery-v4/specs/` 保持相同相对路径）。候选只改下表字段，其余与同场景基线一致；所有单次筛选只用于淘汰。

### 14.1 FAST（golden-kitchen，`every:8`）

| spec | candidate_id | 变化 | 运行数 | 通过后的动作 |
|---|---|---|---:|---|
| `baselines/fast-original-v4.json` | `fast-v4-original` | 生产默认（7000 步） | 3 | v4 主基线 |
| `fast/fast-v4-5k.json` | `fast-v4-5k` | `steps=5000` | 3 | FAST 主对照 |
| `fast/fast-v4-3500.json` | `fast-v4-3500` | `steps=3500` | 1→3 | 质量不越容差且总耗时 ≤0.65× 基线才补 3 次 |
| `fast/fast-v4-5k-1920.json` | `fast-v4-5k-1920` | `steps=5000` + `preprocess_max_side=1920` | 1→3 | 质量提升且 ≤1.25× `5k` 才补 3 次 |
| `baselines/fast-bridge80-original-v4.json` | `fast-bridge80-v4-original` | bridge，`max_frames=80`，`every:12` | 1 | 80 视图预算基线 |
| `fast/fast-v4-5k-bridge80.json` | `fast-v4-5k-bridge80` | bridge，80 视图 + `steps=5000` | 1→3 | 质量不越界且 ≤0.80× bridge 基线才补 3 次 |

### 14.2 BALANCED（golden-kitchen，`every:8`）

| spec | candidate_id | 变化 | 运行数 | 顺序约束 |
|---|---|---|---:|---|
| `balanced/balanced-v4-fine.json` | `balanced-v4-fine` | `vggt_fine_tracking=true` | 3 | v4 BALANCED 主对照，最先执行 |
| `balanced/balanced-v4-fine-4096.json` | `balanced-v4-fine-4096` | + `vggt_max_query_points=4096` | 1→3 | 需 ≥2 项质量改善且 ≤1.35× fine |
| `balanced/balanced-v4-fine-4096-12q.json` | `balanced-v4-fine-4096-12q` | + `vggt_query_frames=12` | 1→3 | 质量继续改善且 ≤1.6× fine |
| `balanced/balanced-v4-reproj4.json` | `balanced-v4-reproj4` | fine + `vggt_max_reprojection_error=4.0` | 1→3 | 重投影下降且质量不越界 |
| `balanced/balanced-v4-fine-4096-12q-30k.json` | `balanced-v4-fine-4096-12q-30k` | 上者 + `steps=30000` | 1→3 | 仅当 `fine-4096-12q` 通过且 ≤1.8× 基线 |

BALANCED 分支固定为：`fine-4096-12q` 通过则它是唯一晋级候选，不再叠加 `reproj4`；若它不通过而 `reproj4` 通过，则 `reproj4` 作为唯一候选；两者都不通过则 BALANCED 保持默认。

### 14.3 QUALITY（eth3d-playground，`every:8`）

| spec | candidate_id | 变化 | 运行数 | 通过后的动作 |
|---|---|---|---:|---|
| `baselines/quality-playground-v4.json` | `quality-v4-original` | 生产默认 | 3 | v4 主基线 |
| `quality/quality-v4-2400.json` | `quality-v4-2400` | `preprocess_max_side=2400` | 3 | 与基线三次中位数比较 |
| `quality/quality-v4-pinhole.json` | `quality-v4-pinhole` | `colmap_camera_model=PINHOLE` | 1→3 | 质量不越界且 ≤1.8× 基线 |
| `quality/quality-v4-dense30k.json` | `quality-v4-dense30k` | `gsplat_init_points=dense` + `steps=30000` | 1→3 | ≥2 项改善且 PLY ≤2× 基线 |
| `quality/quality-v4-2400-dense30k.json` | `quality-v4-2400-dense30k` | 2400 + dense + 30000 | 1→3 | 仅当 2400 与 dense30k 均通过，PLY ≤2.5×、总耗时 ≤2.5× |

## 15. 候选结果与晋级判定

### 15.1 FAST（golden-kitchen；对照＝`fast-v4-original` 三次中位数 PSNR 14.181 / SSIM 0.3350 / LPIPS 0.5069 / 140.6 s）

| spec / candidate | n | PSNR | SSIM | LPIPS | 总秒 | 峰值 MiB | 结论 |
|---|---:|---:|---:|---:|---:|---:|---|
| `fast-v4-original`（7000 步基线） | 3 | 14.181 | 0.3350 | 0.5069 | 140.6 | 16358 | 对照 |
| `fast-v4-5k` | 3 | 14.365 | 0.3419 | 0.4940 | 105.9 | 12806 | 通过：质量三项均不越界且更好，总秒 −24.7%，峰值 −21.7% |
| `fast-v4-3500` | 3 | 14.452 | 0.3424 | 0.5083 | 83.5 | 16358 | 通过：PSNR/SSIM 高于基线，LPIPS +0.0014 在容差内，总秒 −40.6%＝0.594×，满足 ≤0.65× 上限条件 |
| `fast-v4-5k-1920` | 3 | 14.536 | 0.3398 | 0.5082 | 110.8 | 10388 | 通过 FAST 门槛与 ≤1.25× `5k`（1.046×）；按 11.1 的 PSNR 降序规则它排在 `3500`（14.452）之前，是筛选阶段第一，但两者都未过跨场景门槛（见 15.4） |
| `fast-v4-5k-bridge80`（80 视图） | 1 | — | — | — | — | 31720 | 无效：与基线同位置 CUDA OOM，未取得指标 |

逐次重复：

| candidate | repeat | PSNR | SSIM | LPIPS | 总秒 |
|---|---|---:|---:|---:|---:|
| `fast-v4-5k` | r1 / r2 / r3 | 14.365 / 14.434 / 14.230 | 0.3419 / 0.3470 / 0.3393 | 0.4940 / 0.4918 / 0.4991 | 108.8 / 105.6 / 105.9 |
| `fast-v4-3500` | r1 / r2 / r3 | 14.452 / 13.554 / 14.875 | 0.3424 / 0.3341 / 0.3499 | 0.5083 / 0.5523 / 0.4913 | 80.1 / 83.5 / 84.7 |
| `fast-v4-5k-1920` | r1 / r2 / r3 | 14.536 / 14.048 / 14.553 | 0.3398 / 0.3321 / 0.3434 | 0.4727 / 0.5082 / 0.5135 | 110.8 / 114.1 / 107.4 |

判定：`fast-v4-3500` 为 FAST v4 候选（三次中位数注册率 1.000，`trial_validation.json` 均 `valid=true`，PLY/SPZ 点数一致）。`3500` 的单次极差明显（PSNR 13.554–14.875、LPIPS 0.4913–0.5523），比 `5k` 噪声更大，因此跨场景与 holdout 必须通过后才允许写入默认；`5k` 作为更保守的备选保留记录。

### 15.2 BALANCED（golden-kitchen；对照＝`balanced-v4-original` 三次中位数 PSNR 15.310 / SSIM 0.4840 / LPIPS 0.4812 / 重投影 1.0928 px / 342.7 s）

| repeat | PSNR | SSIM | LPIPS | 重投影 px | 总秒 | 峰值 MiB |
|---|---:|---:|---:|---:|---:|---:|
| `balanced-v4-fine` r1 | 16.061 | 0.5602 | 0.3220 | 0.9611 | 374.8 | 14950 |
| `balanced-v4-fine` r2 | 15.954 | 0.5426 | 0.3472 | 0.9611 | 375.7 | 15144 |
| `balanced-v4-fine` r3 | 16.027 | 0.5242 | 0.4234 | 0.9692 | 373.8 | 24954 |
| **中位数** | **16.027** | **0.5426** | **0.3472** | **0.9611** | **374.8** | **15144** |

- 相对基线：PSNR **+0.717 dB**、SSIM **+0.0586**、LPIPS **−0.134**、重投影 **1.0928 → 0.9611 px（−12.1%）**；注册率与验证注册率均 1.000；总秒 1.094×（≤1.8×）。三项质量门槛（+0.50 / +0.02 / −0.05）全部达成，其余指标不越容差 → `balanced-v4-fine` 满足 BALANCED 晋级条件。
- 目标值（PSNR +1 dB、SSIM +0.03、LPIPS −10%）中 SSIM 与 LPIPS 已超额，PSNR 为 +0.72 dB，仍低于 +1 dB 目标，按计划只作为已晋级候选、不宣称达成激进目标。
- `balanced-v4-fine-4096`（`vggt_max_query_points=4096`）**淘汰**：单次运行 51 s 即在 VGGT 跟踪的 `CorrBlock` 处 `CUDA out of memory`（进程占用 29.66 GiB、可用 31.36 GiB，请求再分配 1.74 GiB），`returncode=1`、`valid=false`。按“前一步淘汰则不启动后续组合”，`fine-4096-12q` 与 `fine-4096-12q-30k` 不运行，BALANCED 分支转入 `balanced-v4-reproj4`。

`balanced-v4-reproj4`（`vggt_max_reprojection_error=4.0`）三次重复：

| run | PSNR | SSIM | LPIPS | 重投影 | 总秒 |
|---|---|---|---|---|---|
| r1 | 15.607 | 0.4831 | 0.3978 | 0.7316 | 371.6 |
| r2 | 15.669 | 0.4752 | 0.4428 | 0.7312 | 385.7 |
| r3 | 15.912 | 0.4758 | 0.4448 | 0.7315 | 378.4 |
| **中位数** | **15.669** | **0.4758** | **0.4428** | **0.7315** | **378.4** |

- 相对基线 15.310 / 0.4840 / 0.4812 / 1.0928 px / 342.7 s：PSNR **+0.359**、SSIM **−0.0082**、LPIPS **−0.0384**、重投影 **−33.1%**。
- 晋级门槛三条支线全部未达：PSNR +0.359 < +0.50、SSIM 反向（−0.0082，仅在 −0.01 容差内）、LPIPS −0.0384 > −0.05 → `balanced-v4-reproj4` **不晋级**。它换来的是明显的重投影下降（1.0928 → 0.7315 px）与 LPIPS 改善，但 PSNR/SSIM 不足以替代 `balanced-v4-fine`；**筛选阶段**的 BALANCED 胜者为 `balanced-v4-fine`（其跨场景结果见 15.5，未过门槛）。

### 15.3 QUALITY：`quality-v4-2400` 三次重复（未晋级）

| run | PSNR | SSIM | LPIPS | PLY | 总秒 |
|---|---|---|---|---|---|
| `quality-v4-original` r1 | 15.949 | 0.5491 | 0.4416 | 769 MB | 1201.2 |
| `quality-v4-original` r2 | 15.557 | 0.5536 | 0.4293 | 802 MB | 1188.8 |
| `quality-v4-original` r3 | 16.167 | 0.5630 | 0.4233 | 772 MB | 1206.3 |
| **`quality-v4-original` 中位数** | **15.949** | **0.5536** | **0.4293** | **772 MB** | **1201.2** |
| `quality-v4-2400` r1 | 16.506 | 0.5894 | 0.4333 | 873 MB | 2214.5 |
| `quality-v4-2400` r2 | 16.155 | 0.5772 | 0.4445 | 870 MB | 2199.8 |
| `quality-v4-2400` r3 | 15.323 | 0.5786 | 0.4548 | 876 MB | 2187.2 |
| **`quality-v4-2400` 中位数** | **16.155** | **0.5786** | **0.4445** | **873 MB** | **2199.8** |

- 相对基线：PSNR **+0.206 dB**、SSIM **+0.0250**、LPIPS **+0.0152**、总秒 **1.83×**、PLY **1.13×**、注册率 1.000（基线 0.9189）。
- 门槛判定：SSIM 越过 +0.02 支线，但 **LPIPS +0.0152 超过 +0.01 回退容差**，未满足“另两项不越容差”，因此 `quality-v4-2400` **不晋级**；不作为 v4 的 QUALITY 默认值。事实是：提高长边到 2400 主要买到 PSNR/SSIM 与稠密注册（1.000），代价是 LPIPS 反向回退 3.5% 与 1.83× 总耗时。

### 15.4 跨场景（FAST / vggt-fern，vggt-flower 未取得指标）

| run | PSNR | SSIM | LPIPS | 总秒 |
|---|---|---|---|---|
| `fast-fern-v4-original-r1` | 20.067 | 0.6100 | 0.2342 | 147.0 |
| `fast-v4-3500-fern-r1` | 19.943 | 0.6130 | 0.2673 | 84.0 |
| 差值 | **−0.124** | **+0.0030** | **+0.0331** | 0.571× |
| `fast-v4-5k-1920-fern-r1` | 19.895 | 0.6084 | 0.2487 | 111.9 |
| 差值 | **−0.172** | **−0.0016** | **+0.0145** | 0.761× |

- fern 上 `3500` 的 PSNR/SSIM 在容差内（−0.124 ≥ −0.20、+0.0030），但 **LPIPS 回退 +0.0331，越过 +0.01 容差**，未达到“不得在任一场景越容差”的硬门槛 → `fast-v4-3500` 不能作为 FAST 默认值晋级。
- `5k-1920` 在 fern 上同样越线：PSNR −0.172（在 −0.20 内）、SSIM −0.0016（在 −0.01 内）、**LPIPS +0.0145 > +0.01**，且没有任何场景达到 PSNR +0.20 / SSIM +0.010 / LPIPS −0.020 的正向支线 → **FAST 整条路线在 v4 不晋级**：`fast-v4-3500` 与 `fast-v4-5k-1920` 都只能作为“筛选阶段通过”的记录，生产 `gsplat_steps=7000`、`preprocess_max_side=1600` 不变。
- `vggt-flower`：`fast-flower-v4-original-r1` 的 VGGT（无 BA）产出 `empty_sparse`，流水线按既有降级路径改跑 BA，runner 据此写入 `trial_validation.json.reason="degraded"`、`valid=false`（`degradation.json: stage=geometry, reason=empty_sparse`）。同一 fast 配置在 flower 上必然走到同一降级，故 flower 侧 FAST 对比**未取得指标**，不参与晋级判断（该次仍有 `metrics.json` 25.292 / 0.8324 / 0.0784，仅作记录，不作证据）。`fast-v4-3500-flower` 因此不运行。

### 15.5 BALANCED 跨场景：两个场景都未取得有效基线

| run | 场景（帧数） | valid | 失败原因 | PSNR / SSIM / LPIPS（仅记录） |
|---|---|---|---|---|
| `balanced-playground-v4-original-r1` | eth3d-playground（37） | false | `ba_failed+colmap_sparse` | 15.469 / 0.5490 / 0.4484（662.6 s） |
| `balanced-v4-fine-playground-r1` | eth3d-playground（37） | false | BA 失败 → 降级路径 OOM → COLMAP sparse | 17.001 / 0.6026 / 0.3722（662.2 s） |
| `balanced-delivery-area-v4-original-r1` | eth3d-delivery-area（43） | false | `ba_failed+colmap_sparse` | 19.759 / 0.8201 / 0.3280（605.0 s） |
| `balanced-v4-fine-delivery-area-r1` | — | 未运行 | 该场景没有有效基线，比较不成立，队列在基线判废后按设计结束 | — |

- 四个 BALANCED 跨场景 trial 里没有一个 `valid=true`：VGGT 带 BA 的几何在两个 ETH3D 场景上都退化成 COLMAP 回退，而回退本身就被 runner 判为 `degraded`。因此 `balanced-v4-fine` 只满足“筛选阶段晋级”，**没有通过跨场景硬门槛**，v4 不据此改动 BALANCED 的生产默认值。
- 这一结论与 `balanced-v4-fine` 在 golden-kitchen 上三次全部成功并不矛盾：同一配置在 25 帧 golden-kitchen 上 BA 成功、在 37/43 帧的 ETH3D 取帧上失败，说明该 BA 路径对场景/帧数敏感，属真实限制，不是本轮代码差异。

### 15.6 QUALITY：`quality-v4-pinhole` 三次重复（筛选通过、跨场景失败）

| run | PSNR | SSIM | LPIPS | PLY | 总秒 |
|---|---|---|---|---|---|
| r1 | 16.622 | 0.5788 | 0.3889 | 1192 MB | 1410.6 |
| r2 | 16.508 | 0.5550 | 0.4082 | 925 MB | 1287.1 |
| r3 | 16.768 | 0.5593 | 0.4003 | 968 MB | 1323.5 |
| **中位数** | **16.622** | **0.5593** | **0.4003** | **968 MB** | **1323.5** |

- 相对基线 15.949 / 0.5536 / 0.4293 / 772 MB / 1201.2 s：PSNR **+0.673 dB**、SSIM **+0.0057**、LPIPS **−0.0290**、总秒 **1.10×**、PLY **1.25×**、注册率与验证注册率均 1.000。
- 晋级门槛：PSNR +0.673 ≥ +0.50 支线达成，另两项不越容差（SSIM 微升、LPIPS 改善），总秒 1.10× ≤ 2.5×、PLY 1.25× ≤ 2.5× → **筛选阶段通过**，按计划补三次重复后进入跨场景与 holdout。
- 机制：`colmap_camera_model=PINHOLE` 让 COLMAP 不再拟合径向畸变，重投影与位姿更干净（相对 `quality-v4-original` 的 LPIPS 0.4293 → 0.4003）；代价是多花 10% 总时间与 25% 存储。
- `quality-v4-2400`（见 15.3）与 `quality-v4-pinhole` 的差异不是分辨率而是相机模型：前者 2400 长边买到 PSNR 但 LPIPS 回退，后者保持 1600 长边、改变畸变建模，两项同时改善。

`quality-v4-dense30k`（`colmap_mvs_max_image_size=0`、`gsplat_init_points=dense`、30000 步）单次筛选：**15.037 / 0.5468 / 0.3910，总 1654.4 s，PLY 1178 MB**。PSNR 相对基线 **−0.912 dB**，越过 −0.20 回退容差，三条支线（+0.50 / +0.02 / −0.10）无一达成 → **淘汰**；按“仅当 2400 与 dense30k 均通过才跑组合”的规则，`quality-v4-2400-dense30k` 不运行。可解释：dense 初始化把 MVS 点云（约 79 万点）塞给 3DGS，训练步数虽翻 1.5 倍，但 30000 步仍不足以在 1600 长边上收敛到更优的光度解，反而比稀疏初始化更差。

## 16. 生产取舍（v4 结论）

v4 的裁决标准是“激进但可判定”：任何一个默认值改动都必须同时过**筛选门槛**、**跨场景门槛**与**holdout**。按此口径，本轮没有拿到足以改动三条路线默认值的证据，**`src/rescene/config.py` 的 PROFILES 保持原值**（FAST `gsplat_steps=7000`、`preprocess_max_side=1600`；BALANCED `vggt_fine_tracking=False`；QUALITY `preprocess_max_side=1600`、`colmap_camera_model=SIMPLE_RADIAL`）。以下逐条列出“看到了什么、为什么仍不改”。

### 16.1 FAST：不晋级，默认值不变

- 筛选阶段两个候选都通过：`fast-v4-3500`（PSNR +0.271、总秒 0.594×）与 `fast-v4-5k-1920`（PSNR +0.355、总秒 0.788×），按 11.1 的排序规则 `5k-1920` 第一。
- 跨场景一票否决：`vggt-fern` 上 `3500` 的 LPIPS 回退 +0.0331、`5k-1920` 回退 +0.0145，均越过 +0.01 容差；`vggt-flower` 因 VGGT 无 BA 通道 `empty_sparse` 无法取得指标。
- 因此生产保持 7000 步与 1600 长边；`3500`/`5k-1920` 作为“同场景更快但跨场景退化”的负面证据记录，不进入默认值。

### 16.2 BALANCED：不晋级，默认值不变

- `balanced-v4-fine` 在 golden-kitchen 上三项全胜（PSNR +0.717、SSIM +0.0586、LPIPS −0.134，总秒 1.094×），是有真实收益的候选。
- 但 BALANCED 的跨场景四个 trial 全部 `valid=false`（`ba_failed+colmap_sparse`，见 15.5），跨场景门槛无法满足；`balanced-v4-reproj4` 在筛选阶段就三条支线全未达。
- 因此 `vggt_fine_tracking` 不改为默认 `True`；该候选的收益与风险都写入文档，供后续在 BA 路径修好后再评估。

**跨场景（QUALITY）**：`eth3d-delivery-area`（43 帧、`every:8`）上，基线 `quality-delivery-area-v4-original-r1` 为 **20.018 / 0.8226 / 0.3300，总 1384.0 s，`valid=true`**；候选 `quality-v4-pinhole-delivery-area-r1` 在 geometry 阶段直接失败：`RuntimeError: COLMAP registration rate is below 70%; dense reconstruction skipped`（`colmap_runner.py:99`，trial `returncode=1`、`valid=false`、wall 约 103 s）。原因是 `PINHOLE` 丢弃径向畸变后在该场景的注册率跌破 70% 阈值，稠密重建被既有守卫跳过——候选在“换场景”这一关就不能产出，**跨场景门槛不通过**。该次目录归档为 `runs/archived-quality-v4-pinhole-delivery-area-r1-registration-fail`。

第二个跨场景 `eth3d-facade`（73 帧、`every:8`）上，基线 `quality-facade-v4-original-r1` 为 **21.877 / 0.7837 / 0.2023，总 2957.7 s，`valid=true`**；候选 `quality-v4-pinhole-facade-r1` 为 **21.860 / 0.7776 / 0.2090，总 2462.4 s，`valid=true`**，即 PSNR −0.017、SSIM −0.0061、LPIPS +0.0067——三项都在回归容差内，但也**没有任何一项达到晋级门槛的增益方向**。两个场景合起来：一个直接产不出结果，一个只有“不越差”，因此 `pinhole` 不满足跨场景通过条件。

### 16.3 QUALITY：不晋级，默认值不变

- `quality-v4-2400`：PSNR/SSIM 上升但 LPIPS 回退 +0.0152（越过 +0.01 容差）、总耗时 1.83×，筛选阶段即淘汰。
- `quality-v4-dense30k`：PSNR −0.912 dB，淘汰。
- `quality-v4-pinhole`：筛选阶段三项指标全面改善（PSNR +0.673、LPIPS −0.0290、总秒 1.10×），是唯一进入跨场景的候选；但它在 `eth3d-delivery-area` 上直接失败（注册率 <70%，稠密重建被守卫跳过），在 `eth3d-facade` 上只是“不越差”（PSNR −0.017、SSIM −0.0061、LPIPS +0.0067），没有任何场景给出正向增益，跨场景门槛不通过。
- 因为没有任何 QUALITY 候选通过跨场景，按计划**不执行**点云 F1 对比（F1 只对通过跨场景的候选执行），也不做 holdout；`colmap_camera_model` 保持 `SIMPLE_RADIAL`、`preprocess_max_side` 保持 1600。
- 该路线的可复用结论：`PINHOLE` 在“标定良好的 golden-kitchen”上确实同时提升 PSNR 与 LPIPS，但它把未知场景的注册成功率压到阈值以下，属**不能全局默认**的改动；如果将来要启用，应当作为“已知标定/已知无畸变”的可选开关，而不是 profile 默认值。

### 16.4 生效的默认值改动（本轮为空）

`src/rescene/config.py` 不改：本轮没有任何候选同时通过筛选门槛、跨场景容差与 holdout，因此三条路线都保留原默认值（FAST `gsplat_steps=7000`、`preprocess_max_side=1600`；BALANCED `vggt_fine_tracking=false`；QUALITY `preprocess_max_side=1600`、`colmap_camera_model=SIMPLE_RADIAL`）。`tests/test_config.py` 因此保持原断言，23 项测试仍全部通过（`pytest tests/test_config.py` 在本轮实测 23 passed）。

### 16.5 本轮结论

- **FAST**：`-1920` 与 `-5k-1920` 在 screening 上看起来是“P95 提速 + PSNR 略升 + LPIPS 在容差内”，但换到 `vggt-fern` 后 LPIPS 分别回退 +0.0331 与 +0.0145，均越过 +0.01 容差；`bridge80`（把首帧直接当 80 帧基线）在 80 张 1600px 图像上直接 CUDA OOM。结论：保持 `7000 + 1600`，不换默认。
- **BALANCED**：`vggt_fine_tracking=true` 在 screening 上三项全改善（+0.718 dB、+0.0586、−0.134），但 FAILS-fast 的 4096 查询点会让 VGGT 的 CorrBlock 在 31 GB 卡上 OOM；`reproj4` 无分支胜出；跨场景每一对 trial 都以 `ba_failed + colmap_sparse` 降级，拿不到有效数据。结论：保持 `vggt_fine_tracking=false`，同时把“fine 的收益只在小图上成立、4096 查询点不可用”作为已知边界记录在案。
- **QUALITY**：`2400` 的 LPIPS 回退 +0.0152、`dense30k` 的 PSNR 回退 −0.912 dB 先被淘汰；唯一进入跨场景的 `pinhole` 在 `eth3d-delivery-area` 上注册率跌破 70%，跨场景门槛不通过。结论：保持 `1600 + SIMPLE_RADIAL`；`PINHOLE` 只能作为“已知标定/无畸变”场景的可选开关，不能做 profile 默认值。
