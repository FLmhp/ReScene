# 验收与发布证据

本目录保存可复核的证据：界面截图、黄金样例指标、每次发布的校验清单。这里只放小体积的文本与图片；安装包本体和 `scene.spz` 等二进制不进入 Git。

| 子目录 | 内容 | 说明 |
|---|---|---|
| `screenshots/` | 各端真实运行截图 | 每张都来自实际运行，不使用设计稿或合成图 |
| `golden/` | 黄金样例的 `metrics.json` 与 `report.md` | 只保留指标与报告，`scene.spz` 由重建流程重新产出 |
| `release/<版本>/` | `release-manifest.json`、`source-manifest.json` | 发布包的 SHA-256 与源码快照清单；安装包本体在 GitHub Release |

## 截图

| 文件 | 环境 | 内容 |
|---|---|---|
| `web-workbench.webp` | 公网 Web `https://app.rescene.xyz` | 验收-厨房项目、素材、三条路线与任务记录 |
| `web-viewer.webp` | Web Viewer | 真实重建场景的 WebGL 渲染 |
| `web-admin-console.png` | Web 桌面视口 1280×800 | 管理控制台：用户目录、公告、全局操作日志 |
| `web-mobile-drawer.png` | Web 移动视口 390×844 | 抽屉导航与移动端布局 |
| `windows-workbench.png` | Windows 安装版 | 同一账号下的项目与任务记录 |
| `windows-installed.png` | Windows 安装版 | 安装完成界面 |
| `android-login.png` | Android release APK | 邮箱会话登录 |
| `android-viewer.png` | Android release APK | 原生安全 URL 下发的 Viewer |
| `android-share.png` | Android release APK | 分享链接创建结果 |
| `android-back.png` | Android release APK | 系统返回后的项目页 |
| `miniapp-login-required.png` | 微信开发者工具 | 工程可打开；未登录时无法启动模拟器，故不把该端标为真机发布 |

微信小程序的生产发布仍受真实 AppID/Secret、业务域名和隐私审核资格限制；本目录不以欢迎页冒充小程序业务截图。

## 发布清单

`release/0.3.0/` 记录 0.3.0 的四个桌面安装包（Windows NSIS、Linux deb/AppImage、macOS universal dmg）的大小与 SHA-256。校验方式：从 Release 下载同名文件后计算 SHA-256，与 `release-manifest.json` 对照；`source-manifest.json` 列出打包时每个源文件的大小与哈希。
