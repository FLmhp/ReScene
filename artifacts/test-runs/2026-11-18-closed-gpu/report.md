# 5090 关机期开发与隔离验收

验证日期为 2026-11-18。源码从 `codex/workbench-reliability` 的 `5f512e7` 开始。本轮使用本机、Android 模拟器、隔离 PostgreSQL 和本地公开场景。5090 保持关机。

## 四端素材预检

- Web 与 Windows 共用工作台。浏览器在上传前拒绝伪装成 JPG 的文本；低纹理图和同批相似图弹出确认，取消时上传会话请求数为 0。两端共 10 组主题与视口检查、2 组素材检查通过。Web 使用示例 SPZ 验证签名地址过期后的重取和实际渲染，Tauri Windows 原生程序完成 release 编译。[浏览器结果](browser-results.json) · [Web 格式错误](screenshots/web-material-validation.png) · [桌面格式错误](screenshots/windows-ui-material-validation.png) · [Viewer 恢复](screenshots/web-viewer-recovered.png)
- Android 使用原生文件读取与有尺寸上限的解码生成检查样本。Windows 长路径构建失败后使用独立短路径工作目录，通过原生编译和签名校验。API 35 模拟器用独立签名测试 APK 连接本机 API，实测登录和项目分页。首次测试发现具体格式错误被通用文案覆盖，修复后复测能显示文件名和错误原因，重复与模糊警告也正常显示，取消后无上传会话。[Android 结果](android-results.json) · [格式错误](screenshots/android-material-validation.png) · [模糊与重复提示](screenshots/android-material-warnings.png)
- 微信小程序使用真实 AppID 构建。本地测试执行打包后的 JavaScript，模拟 Taro 原生 request 文件读取和离屏画布，覆盖登录、工作台分页、坏文件头、模糊及重复提示。真实微信客户端摄取素材和浏览器跳转留待体验版复测。

视频首部仅检查容器类型，Worker 继续检查实际解码和对象 SHA-256。图像的模糊和重复度为基于缩略图的提示，用户可以确认继续。重复检查范围为同一批次。

## 隔离系统验收

从仓库根目录执行 `.venv/Scripts/python.exe scripts/verify_offline.py --build-clients` 可重跑。流程创建只绑定本机的临时 PostgreSQL 16，运行接口、角色范围、租约和四端契约回归，执行 `pg_dump` 与 `pg_restore`，再从 FastAPI 检查恢复的数据、角色与迁移版本。模拟 OSS 归档失败时，Worker 保留本地阶段结果，API 不接收无效的恢复地址。

`pnpm quality` 的隔离验收通过 236 项 Python 测试，3 项按环境跳过。64 项前端测试、类型检查、Ruff 和 mypy 均通过。恢复结果保留 Alembic `0006`，只读运维 SQL 输出队列状态和 Worker 心跳。并行原生构建期间曾有一项工作台用例达到 5 秒超时，单独重跑完整门禁通过。[数据库恢复与健康快照](database-results.json)

## 数据准备与实验入口

| ETH3D 场景 | 原始图像 | 通过 CPU 质量筛选的图像 | 冻结子集 |
|---|---:|---:|---|
| delivery_area | 948 | 493 | 64 / 80 / 160 / 250 |
| playground | 960 | 636 | 64 / 80 / 160 / 250 |
| terrains | 660 | 322 | 64 / 80 / 160 / 250 |
| forest | 1,028 | 566 | 64 / 80 / 160 / 250 |

四个场景的 12 个图像、真值和遮挡归档共 1,822,380,154 字节，已通过 7-Zip 完整性检查并计算 SHA-256。每个场景四个子集共享 8 张验证图，16 份规格都通过 `--preflight`，核对了源文件哈希和最终筛选。数据和逐图清单放在本地 `.cache/closed-gpu-acceptance/eth3d/`。[官方来源](https://www.eth3d.net/datasets) · [归档清单](archives.json) · [预检结果](preflight-summary.json)

在 PyCOLMAP 4.2.1 CPU wheel 上，全局建图对合成数据库重建出 6 个相机和 80 个点。MV-DUSt3R+ 的离线交换格式通过已知投影误差检查，导出的合成场景通过 PyCOLMAP 重载。监督器的挂载门槛、磁盘门槛、截止时间、失败续排和归档破损用例均可脱离 GPU 复跑。真实推理、显存、训练和 AutoDL 数据同步在 5090 开机后验证。[运行手册](../../../docs/5090大数据集训练运行手册.md)
