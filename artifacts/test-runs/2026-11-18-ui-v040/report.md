# ReScene 0.4.0 四端验收记录

验证日期为 2026-11-18，时区 Asia/Shanghai。功能源码截至提交 `6d439d4`，发布标签另含本次文档与证据。5090 保持关机。线上验证复用已有项目、素材和成功的 SPZ 产物，新建生产训练任务数为 0。

| 范围 | 环境与数据 | 结果 |
|---|---|---|
| Python 与契约 | 本地 `pnpm quality`，API 单元与集成用例 | 217 通过，6 项按环境跳过。检查对象访问权限、待校验素材、视频与 OSS 失败路径 |
| 前端 | workspace 类型检查与测试，包含小程序原生请求回归 | 58 项测试通过，构建通过 |
| Web / 桌面视口 | Edge，模拟 API，Web 1440/1024/768/390px、桌面 1280px 各两种主题 | 10 组通过。验证选择、路线、排队反馈、表单状态与主题持久化 |
| Web 生产 | 线上账号权限、历史素材及成功任务 | 签名缩略图 HTTP 200，320×214。历史 SPZ 完成渲染，页面无 JS 异常 |
| Windows | x64 NSIS 本机覆盖安装，WebView2，生产账号 | 0.4.0 安装成功，浅深主题与项目页通过 |
| Android | 已签名 APK，SLT_API35，生产账号 | 0.4.0/code 5 覆盖安装、登录、浅深主题和重启保留会话及外观通过 |
| 微信小程序 | AppID `wxedb245fb415d436e`，开发者工具 Stable 2.01.2510290，基础库 3.16.2 | 生产账号登录、项目列表、浅深主题、素材缩略图通过。开发版上传成功，上传产物 571640 字节 |
| 部署 | 定向升级 ReScene API 与 Web | 预部署数据库备份与镜像留存，API ready、Web 正常返回。其他容器 ID 未变化，可用内存 5262 MiB |

模拟器最初出现 `fetch is not a function`。小程序改用显式的 Taro 请求适配器，保留 Zod 禁用动态代码生成的兼容修复。以缺少全局 `fetch` 的环境检查打包后登录，随后使用真实账号在开发者工具复测。

- [最终代码 CI](https://github.com/FLmhp/ReScene/actions/runs/44215987393)
- [视口验证记录](browser-results.json)与[线上缩略图、Viewer 验证](live-results.json)
- Web 界面：[桌面浅色](screenshots/web-1440-light-workspace.png)、[手机深色](screenshots/web-390-dark-workspace.png)、[生产 Viewer](screenshots/web-live-viewer-light.png)
- Windows 界面：[登录](screenshots/windows-login-light.png)、[深色项目](screenshots/windows-projects-dark.png)
- Android 界面：[浅色项目](screenshots/android-projects-light.png)、[重启后深色](screenshots/android-reopened-dark.png)
- 小程序界面：[浅色项目](screenshots/miniapp-projects-light.jpg)、[深色素材工作区](screenshots/miniapp-workspace-dark.jpg)

本轮发布包的 SHA-256 以 Release 清单为准。截图反映对应测试环境，带宽、GPU 峰值显存和重建质量指标需在 GPU 开机后另跑基准。旧版手机验证与本轮模拟器记录分别保留，0.4.0 手机真机、Linux/macOS 安装及个人主体小程序的浏览器跳转需在对应设备复查。
