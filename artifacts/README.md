# 验收与发布证据

历史截图、黄金样例与验收记录的归档根为 `D:\ReScene-Archive\historical`。逐文件大小、SHA-256 与来源写入 `D:\ReScene-Archive\archive-manifest.json`；各来源的删除、保留和错误项写入 `historical/<来源>/archive-report.md`。以下历史链接固定到归档前提交，需要 GitHub 仓库权限。未提交的本地证据不在 Git 历史中。Git 仓库中的发布清单位于 `release/<版本>/`。

| 子目录 | 内容 | 说明 |
|---|---|---|
| 历史 `screenshots/` | 各端真实运行截图 | 见固定提交中的 [截图目录](https://github.com/FLmhp/ReScene/tree/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/screenshots) |
| 历史 `golden/` | 黄金样例指标与报告 | 见固定提交中的 [黄金样例](https://github.com/FLmhp/ReScene/tree/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/golden) |
| `release/<版本>/` | `release-manifest.json`、`source-manifest.json` | 发布包的 SHA-256 与源码快照清单；安装包本体在 GitHub Release |
| 历史 `test-runs/` | [0.4.1 候选验收](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/report.md) · [0.4.0 四端报告](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-18-ui-v040/report.md) · [工作台与离线恢复验收](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-18-workbench-reliability/report.md) | 客户端、GPU 三路线、校验值与故障演练 |

## 截图

下表列出归档前的截图文件名，文件位于固定提交的 `artifacts/screenshots/` 目录；当前工作树不再保留这些图片。

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

0.4.1 候选版保存了 [Windows 真机结果页](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/screenshots/windows-native-result-layout.png) 和 [桌面侧栏回归](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/screenshots/windows-project-sidebar.png)。微信小程序的验收覆盖真机端操作和手机浏览器打开分享。

## 复核规则

- 历史文件按固定提交 `f999157c9ff04df1f33e820f7bd6742444ae6e92` 的路径查看，需要仓库权限；提交或分支移动后不另找同名文件。
- 归档完成后重新计算 SHA-256，与 `archive-manifest.json` 的记录逐项比对；不一致时先查复制错误，不覆盖既有文件。
- 本轮及后续证据先写入 `D:\ReScene-Archive`，仓库只保留索引、报告和小体积清单。
- 归档的绝对路径不写进官网或公开页面。

## 发布清单

下载资产后逐项比较文件名、大小和 SHA-256 与对应 `release-manifest.json`，再核对 `source-manifest.json` 的大小和 SHA-256。0.5.0 的[发布清单](release/0.5.0/release-manifest.json)和[源码清单](release/0.5.0/source-manifest.json)与 GitHub Release 下载项一致；安装门禁见 [0.5.0 发布说明](../docs/0.5.0发布说明.md)。

`release/0.3.0/` 记录 0.3.0 的四个桌面安装包（Windows NSIS、Linux deb/AppImage、macOS universal dmg）的大小与 SHA-256。校验方式：从 Release 下载同名文件后计算 SHA-256，与 `release-manifest.json` 对照；`source-manifest.json` 列出打包时每个源文件的大小与哈希。

0.4.0 双主题的宽窄屏与原生客户端截图见 [历史截图目录](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-18-ui-v040/screenshots)，数据来源与平台状态以当时的报告为准。

0.4.1 候选的 [安装包 SHA-256](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/installers.sha256)、[六条 GPU 任务](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/gpu-matrix.json) 和 [重载记录](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/gpu-reload.json) 随验收报告归档。当时的正式包见 [0.4.0 Release](https://github.com/FLmhp/ReScene/releases/tag/v0.4.0)。

RS 字标、官网上线、客户端新标构建与微信启动修复见 [品牌更新记录](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-brand-refresh/report.md)。
