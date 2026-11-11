# ReScene A100 算法路线优化报告

日期：2026-11-05  
硬件：NVIDIA A100-PCIE-40GB  
范围：场景重建与 3DGS 优化；不涉及 VGGT 微调、服务端平台或 Viewer。

## 最终默认配置

| 路线 | 几何 | 3DGS | 关键参数 |
| --- | --- | ---: | --- |
| FAST | VGGT，无 BA | 7k | 最多 80 帧；异常空点时依次尝试增强 BA、COLMAP 稀疏回退 |
| BALANCED | VGGT + BA | 20k | 最多 80 帧；1024 查询点；BA 失败时 16 查询帧/2048 点重试，再回退 COLMAP 稀疏 SfM |
| QUALITY | COLMAP SfM/BA/MVS | 20k | 最多 250 帧；SIMPLE_RADIAL；exhaustive 失败时 sequential 重试 |

所有回退均为一次性、有界操作，并写入 `degradation.json` 与 `metrics.json`；不会无限重试。

## 参数筛选结论

### FAST

- kitchen 小场景中，7k baseline 总耗时 195 秒，继续增加到 10k 反而更慢且 PSNR 下降。
- `packed` 在 A100 上没有带来速度或显存优势，因此不作为默认值。
- 保留 7k；主要优化来自确定性覆盖选帧、全局去重和空稀疏点检测。

### BALANCED

kitchen 25 帧公平对照：

| 配置 | 总耗时 | PSNR | SSIM | LPIPS |
| --- | ---: | ---: | ---: | ---: |
| 30k baseline | 788 秒 | 14.817 | 0.478 | 0.448 |
| 20k + 1024 查询点 | 522 秒 | 15.854 | 0.506 | 0.446 |
| 20k + appearance | 812 秒 | 15.902 | 0.536 | 0.419 |

最终选择 20k + 1024 查询点：相对 30k 快 34%，三项渲染指标均不劣。appearance 仅带来小幅质量提升，但比普通 20k 慢 56%，不作为默认值。

### QUALITY

kitchen 25 帧对照：

| 配置 | 总耗时 | PSNR | SSIM | LPIPS | 稠密点 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 30k baseline | 1104 秒 | 19.076 | 0.619 | 0.277 | 157,321 |
| 20k | 848 秒 | 18.915 | 0.649 | 0.244 | 158,559 |
| 30k OPENCV | 1075 秒 | 19.221 | 0.648 | 0.272 | 150,581 |
| depth + appearance | 1565 秒 | 19.369 | 0.633 | 0.249 | 158,061 |

最终选择 20k + SIMPLE_RADIAL：相对 30k 快 23%，SSIM 和 LPIPS 更好，PSNR 仅低 0.16 dB。

## 留出场景结果

| 路线 / 场景 | 注册 | 总耗时 | PSNR | SSIM | LPIPS | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| FAST / fern | 18/18 | 183 秒 | 19.769 | 0.629 | 0.240 | VGGT 默认路径 |
| FAST / flower | 24/24 | 205 秒 | 24.851 | 0.811 | 0.086 | 空点后增强 BA |
| FAST / ETH3D playground | 34/37 | 572 秒 | 14.845 | 0.506 | 0.503 | VGGT/BA 失败后 COLMAP 稀疏回退 |
| BALANCED / fern | 18/18 | 512 秒 | 22.448 | 0.760 | 0.148 | VGGT + BA |
| BALANCED / flower | 24/24 | 447 秒 | 25.329 | 0.830 | 0.071 | VGGT + BA |
| BALANCED / ETH3D playground | 34/37 | 1630 秒 | 14.551 | 0.511 | 0.459 | COLMAP 稀疏回退 |
| QUALITY / fern | 18/18 | 715 秒 | 25.100 | 0.834 | 0.117 | 122,792 稠密点；154 网格顶点 |
| QUALITY / flower | 24/24 | 775 秒 | 26.383 | 0.863 | 0.060 | 146,500 稠密点；220,887 网格顶点 |
| QUALITY / ETH3D playground | 34/37 | 2512 秒 | 13.666 | 0.488 | 0.493 | 789,028 稠密点；1,616,585 网格顶点 |

ETH3D 的 QUALITY 峰值显存为 5.37GB，20k 训练耗时 1511 秒，PLY 为 851MB，SPZ 为 91MB。FAST 同场景总耗时约为 QUALITY 的 23%。

### ETH3D 真值评估

| 路线 | ATE (m) | 旋转误差 (°) | 官方 Accuracy @ 2 cm | 官方 Completeness @ 2 cm | 官方 F1 @ 2 cm |
| --- | ---: | ---: | ---: | ---: | ---: |
| FAST | 0.00616 | 0.1008 | 0.72% | 0.37% | 0.49% |
| BALANCED | 0.00646 | 0.1015 | 0.84% | 0.48% | 0.61% |
| QUALITY | 0.00600 | 0.0896 | 79.79% | 36.51% | 50.09% |

三条路线的位姿均与参考标定接近；QUALITY 的稠密 MVS 点云明显优于以 Gaussian 中心作为点云的 FAST/BALANCED。表中点云值来自固定提交的 ETH3D 官方可见性评测器；平均最近邻距离代理指标仍保留在各运行的 `metrics.json` 中供诊断。

## 稳定性修复

- DINOv2 权重现在从 ReScene 私有缓存离线加载并校验，不再触发网络请求。
- VGGT 输出在训练前验证 `points3D.bin` 非空，避免 gsplat 在空点云上产生不透明的特征值分解错误。
- FAST 空点时先增强 BA；BA 仍失败时才使用 COLMAP 稀疏 SfM。
- BALANCED 的 BA 无法建模时先增加查询帧与查询点，再使用 COLMAP 稀疏 SfM。
- QUALITY 的默认匹配器失败时只切换一次 exhaustive/sequential，并清理当前 run 内的 COLMAP 中间产物。
- QUALITY 默认建图完全失败时，进行一次同相机、放宽初始化约束的有界重试；该重试使 flower 从无初始对恢复为 24/24 注册。
- 重投影误差聚合会剔除超过相机图像对角线的非物理点误差，避免极端异常值污染报告。

## 已知限制

- ETH3D playground 的 FAST/BALANCED/QUALITY 位姿 ATE 分别为 0.00616/0.00646/0.00600 m，平均旋转误差分别为 0.1008/0.1015/0.0896°；点云指标已切换为官方评测器结果。
- VGGT-1B 与示例数据按学术非商用范围使用。
