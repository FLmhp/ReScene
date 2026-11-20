# 验收与发布证据

本目录保存可复核的证据：界面截图、黄金样例指标、每次发布的校验清单。这里只放小体积的文本与图片；安装包本体和 `scene.spz` 等二进制不进入 Git。

| 子目录 | 内容 | 说明 |
|---|---|---|
| `screenshots/` | 各端真实运行截图 | 每张都来自实际运行，不使用设计稿或合成图 |
| `golden/` | 黄金样例的 `metrics.json` 与 `report.md` | 只保留指标与报告，`scene.spz` 由重建流程重新产出 |
| `release/<版本>/` | `release-manifest.json`、`source-manifest.json` | 发布包的 SHA-256 与源码快照清单；安装包本体在 GitHub Release |
| `test-runs/` | [0.4.1 候选验收](test-runs/2026-11-20-release-041/report.md) · [0.4.0 四端报告](test-runs/2026-11-18-ui-v040/report.md) · [工作台与离线恢复验收](test-runs/2026-11-18-workbench-reliability/report.md) | 客户端、GPU 三路线、校验值与故障演练 |

## 截图

| 文件 | 环境 | 内容 |
|---|---|---|
| `web-workbench.webp` | 公网 Web `https://app.rescene.xyz` | 验收-厨房项目、素材、三条路线与任务记录 |
| `web-viewer.webp` | Web Viewer | 真实重建场景的 WebGL 渲染 |
| `web-admin-console.png` | 本地 Web 桌面视口 | 管理控制台：用户目录、公告、全局操作日志 |
| `web-mobile-drawer.png` | 本地 Web 移动视口 390×844 | 抽屉导航与移动端布局 |
| `windows-workbench.png` | Windows 安装版 | 同一账号下的项目与任务记录 |
| `windows-installed.png` | Windows 安装版 | 安装完成界面 |
| `android-login.png` | Android release APK | 邮箱会话登录 |
| `android-viewer.png` | Android release APK | 原生安全 URL 下发的 Viewer |
| `android-share.png` | Android release APK | 分享链接创建结果 |
| `android-back.png` | Android release APK | 系统返回后的项目页 |
| `miniapp-login-required.png` | 微信开发者工具 | 工程可打开；未登录时无法启动模拟器，故不把该端标为真机发布 |

0.4.1 候选版保存了 [Windows 真机结果页](test-runs/2026-11-20-release-041/screenshots/windows-native-result-layout.png) 和 [桌面侧栏回归](test-runs/2026-11-20-release-041/screenshots/windows-project-sidebar.png)。微信小程序的验收覆盖真机端操作和手机浏览器打开分享。

## 发布清单

`release/0.3.0/` 记录 0.3.0 的四个桌面安装包（Windows NSIS、Linux deb/AppImage、macOS universal dmg）的大小与 SHA-256。校验方式：从 Release 下载同名文件后计算 SHA-256，与 `release-manifest.json` 对照；`source-manifest.json` 列出打包时每个源文件的大小与哈希。

0.4.0 双主题的宽窄屏与原生客户端截图保存在 test-runs/2026-11-18-ui-v040/screenshots，数据来源与平台状态以本轮报告为准。

0.4.1 候选的 [安装包 SHA-256](test-runs/2026-11-20-release-041/installers.sha256)、[六条 GPU 任务](test-runs/2026-11-20-release-041/gpu-matrix.json) 和 [重载记录](test-runs/2026-11-20-release-041/gpu-reload.json) 随验收报告归档。正式包仍见 [0.4.0 Release](https://github.com/FLmhp/ReScene/releases/tag/v0.4.0)。

RS 字标、官网上线、客户端新标构建与微信启动修复见 [品牌更新记录](test-runs/2026-11-20-brand-refresh/report.md)。
