# RTX 5090 克隆实例验收记录

2026-11-18，使用项目 SSH 别名 `rescene-5090` 连接新实例。验证使用隔离源码 `8f048a2584614ae5751a12ef9f2c4940e2d448c1` 和克隆保留的环境锁，SHA-256 为 `17ea8b4af60c5d53de2ced96a6ceba578cba72d1a7bd2f6df327c3b33cbb5112`。

## 环境

- SSH 通过现有密钥及固定的主机密钥验证。GPU 为 RTX 5090，NVML 报告 32,607 MiB，驱动为 580.76.05。PyTorch 2.12.0+cu130 的 CUDA 冒烟通过。
- PyCOLMAP 4.2.1 已启用 CUDA，并提供 `global_mapping` 接口。本轮验证到接口可调用，建图性能留待正式对照实验测量。
- `/root/autodl-fs` 是指向实际挂载 `/autodl-fs/data` 的符号链接。归档检查统一解析符号链接后校验挂载及路径范围。两项针对性测试及新实例挂载实测通过。
- FAST 使用原有 GPU 锁单独运行。生产 Worker 在本次验证期间处于停止状态。

## Golden Kitchen FAST 冒烟

| 指标 | 结果 |
| --- | ---: |
| 注册图像 | 25 / 25 |
| 注册验证图 | 4 / 4 |
| 实际优化步数 | 100 |
| 训练耗时 | 9.884 s |
| 端到端耗时 | 32.28 s |
| PSNR / SSIM / LPIPS | 13.756 dB / 0.3413 / 0.7024 |
| Gaussian 数量 | 100,000 |

Checkpoint、PLY 和 SPZ 均通过重新加载。20 个归档文件的 SHA-256 通过独立复检，未发生 OOM 降级。冒烟的光度指标用于检查输出有效性，正式质量比较使用完整训练步数。

产物及逐文件校验值位于 `/root/autodl-fs/rescene/experiments/clone-56235-preflight/fast100/`，执行日志位于 `/root/autodl-tmp/rescene/large-scenes/clone-56235-preflight/fast100.log`。

## ETH3D 冻结输入

将本机已检验的 12 个归档通过 SSH 传到新实例，写入共享盘后重新核对字节数和 SHA-256，共 1,822,380,154 字节。`delivery_area`、`playground`、`terrains` 和 `forest` 各有 64、80、160、250 帧四个嵌套子集。同一场景四个子集使用固定的 8 张验证图。16 组 CPU 预检全部通过，核对了源图、哈希和实际验证划分。归档、逐场景冻结清单和通过标记 `ready.json` 位于 `/root/autodl-fs/rescene/datasets/eth3d-manyview-v1/`。同目录下 `preflight-56235.tar.gz` 收录各组规格、结果和准备日志，SHA-256 为 `86da3e7ed54047572492b45d70307be372688f411c3e5a3ddd85b1165da903ad`。

验收结束时共享盘可用 197.6 GiB，本地数据盘可用 10.50 GiB，GPU 无计算进程。完整三路线训练和候选比较尚未开始。正式训练前按单次试验估算本地盘的峰值占用，尤其是 QUALITY 的去畸变和 MVS 临时文件。[大数据集训练运行手册](../../../docs/5090大数据集训练运行手册.md) · [关机期验收与源归档清单](../2026-11-18-closed-gpu/report.md)
