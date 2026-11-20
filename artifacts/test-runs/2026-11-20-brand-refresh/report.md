# ReScene 品牌更新验收

2026-11-20 · 0.4.1 候选

## 官网与平台

- 用户选择 B「RS 空间字标」。官网、Web 与桌面工作台、安装图标、Android 启动图、微信界面及文档采用同一符号。
- [官网](https://rescene.xyz/) 已从 `489c8c4b415ee4033254d7906545be7574a89378` 独立发布。Caddy 配置验证与事务后检查通过，部署记录为 `20261120T043355Z-489c8c4b415e-a8499e58`。生产工作台、API 与 PostgreSQL 容器保持健康。 [构建 CI](https://github.com/FLmhp/ReScene/actions/runs/44674172421)
- 官网使用桌面 1440 px、手机 390 px 和关闭 JavaScript 的 320 px 视口验证，检查 favicon、分享图、键盘菜单、FAQ、表格布局及线上工作台入口。 [桌面首页](screenshots/site-desktop.png) · [手机交付状态](screenshots/site-mobile-delivery.png)
- GitHub 仓库的官网字段已更新。社交预览需要已登录的仓库设置页面，微信平台头像需要公众平台管理员操作。

## 工具与文档

- OfficeCLI 从 1.0.161 升至 1.0.162。按官方 SHA-256 校验 Windows 二进制，依次通过新建、插图、保存、校验、重开和 HTML 预览。
- 两份 Word 更新版各增加一页现状附录。渲染对比确认原有 16 和 26 页像素一致，OfficeCLI 校验结果与原件一致，旧表格结构警告仍可复现。 [Word 文档索引](../../../docs/reference/README.md)
- `d7602ae` 首次 CI Web 镜像构建报告 React 类型冲突。本机从该提交无缓存重建成功，GitHub Actions 在同一提交重跑失败项后也通过。 [重跑结果](https://github.com/FLmhp/ReScene/actions/runs/44587362848)

## 客户端与发布门槛

- Web、桌面、Android 导出和实际 AppID 的微信包均已构建，`pnpm quality` 通过。
- Windows NSIS 候选已覆盖安装并显示新字标。Android APK 使用既有签名，已生成并校验。 [Windows 实际安装图标](screenshots/windows-native-mark.png) · [两份候选包 SHA-256](installers.sha256)
- 微信启动修复显式配置首页，失效入口返回首页。开发者工具已显示登录表单，构建产物通过启动回退、登录、素材预检与分页夹具测试。
- 用户确认 `1c5e658` 微信体验版冷启动正常，无需点主页按钮。主题和导航继续按新版体验版验收。
- Android 平板 BKY-W10 已成功覆盖安装 RS 字标签名 APK。真机选择已上传的 `ReScene041.mp4`，提交 BALANCED 任务 `f8201574-991a-4f88-bc8a-9b1c86f370d8`。强制结束应用并重开后，从项目历史打开同一任务，仍为 `QUEUED`，尝试次数为 0。API 核对项目只新增这一条任务。 [重启前](screenshots/android-video-queued-before-restart.png) · [重启后](screenshots/android-video-queued-after-restart.png) · [校验结果](android-video-restart.json)
- RTX 5090 暂未开机，该任务保留排队。视频训练、产物发布和正式切换待下一次上电。正式版仍为 0.4.0。
