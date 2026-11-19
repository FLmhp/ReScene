# ReScene 0.4.1 发布候选验收

## 版本与范围

- 候选提交为 `e42f505059c3375a05ead5bf14ca196f2649c7a2`，分支为 `codex/workbench-reliability`。GitHub Actions 的五项检查均通过。 [CI 44583325261](https://github.com/FLmhp/ReScene/actions/runs/44583325261)
- 生产 API、Web、PostgreSQL 仍使用原容器。5090 候选 Worker 使用独立目录和只监听回环的验收 API，通过与生产 Worker 共用的单卡锁执行。两者不并行占用 GPU。候选任务使用独立项目和 OSS 对象前缀。
- API 拒绝重试 INVALID_INPUT 并保留失败记录。205 条同时间戳事件通过每批 100 条、顺序续接及末尾终态的回归。共享客户端兼容当前生产 API 的完整项目响应和候选 API 的分页响应。

## 四端验证

| 端 | 已验证 | 证据范围 |
| --- | --- | --- |
| Web | 1440、1024、768、390 px 浅深主题，键盘关闭 Viewer，过期签名链接刷新，OSS multipart 中断后复用原 upload ID | 本地候选构建与隔离接口测试；续传连接当前生产 API 和真实 OSS |
| Windows | 从 0.4.0 覆盖安装 0.4.1，真实视频上传、FAST 完成、SPZ 渲染、五种产物下载、分享撤销 | 本机 Windows/WebView2。最新包重新打开同一任务并验证结果布局、渲染和撤销。24 条长项目名滚动回归 |
| Android | 同一签名由 0.4.0 升至 0.4.1，登录、8 张图片上传、BALANCED 完成、视频上传 | BKY-W10 安装与工作区。任务 `aa7b4821-f2f5-41c9-a109-7d9f103a3289` 已发布，下载与分享由用户真机确认。视频任务重启恢复仍待真机操作 |
| 微信 | 真实 AppID 登录、8 张图上传、任务排队、手机浏览器打开分享 | 用户手动验证。QUALITY 因 COLMAP 注册率低于 70% 失败，保留原记录。复用原 8 张图新建 BALANCED 后完成，任务 8d185ba4-bf5e-4e8b-bad4-49724c9988ce |

桌面侧栏为项目行保留最小高度，长名称换行。Web 和 Windows 提供独立的结果视图，场景操作、下载和分享分区，校验值与撤销历史可展开。微信使用系统主题选择器，每页显示最多 8 个项目，项目内分为素材、重建路线、任务与结果。提交直达任务，通知定位相应任务。个人主体 AppID 的场景页提供浏览器链接和微信转发入口。描述含 `9c41a94` 的开发包已上传，小程序源码与最终候选一致。新版主题选择和导航仍待体验版真机复测。 [Taro WebView 文档](https://docs.taro.zone/docs/components/open/web-view)

截图包括 [桌面项目列表](screenshots/windows-project-sidebar.png)、[Windows 原生结果页](screenshots/windows-native-result-layout.png)、[Windows 原生 Viewer](screenshots/desktop-04-viewer.png)、[Android 工作区](screenshots/android-02-workspace.png)、[Web 续传](screenshots/web-08-upload-recovered.png) 和 [Web 签名恢复](screenshots/web-viewer-recovered.png)。

## 存储与回滚

- 本地质检与构建通过。[隔离验收结果](isolated-results.json)记录 PostgreSQL 16 独立备份恢复和迁移版本。
- 生产数据库备份在全新、无外部网络的 PostgreSQL 容器内恢复。确认版本 0006、23 条任务，旧 API 镜像可读取结果。备份仍在公网服务器受限目录。[生产库恢复核验](postgres-restore.txt)
- 中间运行检查控制服务器约 4.8 GiB 可用内存，5090 临时盘约 11 GiB 可用，共享盘约 162 GiB 可用。生产 Worker PID 408207，测试期间与候选进程使用同一把锁，候选暂停领取后生产端完成 Android 与微信补跑任务。
- 以下为候选镜像和安装包标识。安装包留在本地候选目录，微信包仅上传开发版本。

| 产物 | SHA-256 |
| --- | --- |
| API 容器镜像 ID | 9e75d2608736f03db27e978c52958dc6506e2d1eccb1842eba6071c3cca4c40e |
| Web 容器镜像 ID | 1d6a1d20f8aa1d0c244d475c66d66fb8865d71a8bfecd5a0c119391c25d72bc5 |
| Windows 0.4.1 x64 NSIS 安装包 | a6a578ae6ce4ad626733475c8abfcb910ad008ee2afff764fa152262f279d2fe |
| Android 0.4.1，versionCode 6 | 3a83faf076caf317bd779739ca36964ae88d4c551b66a0c0499ee02f4148ac08 |

## 5090 路线

- RTX 5090 和 CC 12.0 核对通过。Golden Kitchen FAST 100-step 冒烟完成至第 99 步，25 张注册，验证指标均为有限值。
- FAST 分网格保持实验规格。office、courtyard、kicker 和 terrace 的稀疏验证支持均恢复到 8/8。BALANCED 纳入重复 BA 去重，QUALITY 保留 5 次 PatchMatch。 [四个 DSLR 场景的实测记录](../2026-11-19-5090-independent-optimization/report.md)
- QUALITY 视频初次已完成 MVS。COLMAP 注册 23 张，但预选验证图 `000001.jpg` 未注册，原训练器拒绝开始评分。候选引擎允许 Worker 在保留至少半数原留出图时继续，指标记录缺失列表。冻结实验规则保持不变，留出图始终排除在训练集之外。复跑复用已保存几何，以 3/4 张验证图完成。
- 六条任务全部发布，OSS 每个交付对象均按大小和 SHA-256 核对。5090 已逐条重载 checkpoint、PLY 和 SPZ，核对最终训练步和 Gaussian 数量。前五条用 `43d2f22` 的引擎完成，QUALITY 视频用 `9244495` 的引擎修复后恢复训练。两版引擎的差异限于缺失验证图处理，前五条均有完整验证图。 [素材、任务与指标](gpu-matrix.json) · [重载记录](gpu-reload.json)

| 输入与路线 | 注册张数 | 验证支持 | PSNR / SSIM / LPIPS | 阶段耗时 | 训练峰值显存 |
| --- | ---: | ---: | --- | ---: | ---: |
| 图片 FAST · VGGT | 25/25 | 4/4 | 13.973 / 0.335 / 0.546 | 144.5 s | 1,388 MiB |
| 图片 BALANCED · VGGT/BA | 25/25 | 4/4 | 15.316 / 0.498 / 0.437 | 378.2 s | 1,612 MiB |
| 图片 QUALITY · COLMAP/MVS | 24/25 | 4/4 | 16.759 / 0.567 / 0.312 | 435.3 s | 1,152 MiB |
| 视频 FAST · VGGT | 25/25 | 4/4 | 14.150 / 0.334 / 0.494 | 90.6 s | 1,326 MiB |
| 视频 BALANCED · VGGT/BA | 25/25 | 4/4 | 16.519 / 0.467 / 0.313 | 285.1 s | 1,301 MiB |
| 视频 QUALITY · COLMAP/MVS | 23/25 | 3/4 | 17.500 / 0.579 / 0.364 | 571.9 s | 1,123 MiB |

阶段耗时来自引擎，排队、OSS 传输以及整次重试的等待时间另计。视频 BALANCED 第一次遇到 OSS 上传超时，第 2 次成功。视频 QUALITY 改用 exhaustive matching 后得到有效几何，复用了这份几何。表中的显存来自训练器，完整进程树峰值仍需连续采样。

隔离取消在运行中生效，取消任务未发布场景。隔离 API 暂停 110 秒后，原任务租约过期，Worker 领取第 2 次尝试并从 OSS 恢复。预处理与几何成功事件各一条。 [Worker 故障演练](worker-recovery.json)

## 生产切换

生产切换等待最新版微信体验版复测和 Android 视频任务重启恢复的真机证据。生产 API、Web、Worker 继续使用原版本，GitHub Release 和微信正式版仍待发布。
