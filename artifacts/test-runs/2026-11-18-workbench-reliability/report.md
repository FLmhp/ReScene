# 四端工作台与离线恢复验收

验证日期为 2026-11-18，分支为 `codex/workbench-reliability`。功能源码截至 `17943a5`。本次使用本地构建、本地隔离 PostgreSQL 和测试 API。5090 维持关机状态，训练待开机执行。

| 范围 | 结果 |
|---|---|
| 质量检查 | `pnpm quality` 通过。222 项 Python 测试通过，4 项按环境跳过。61 项前端测试通过。Ruff、mypy、类型检查和版本一致性通过。 |
| 素材与任务分页 | 500 个素材、25 个任务的测试项目首屏分页各返回 24 条。验证同时间戳排序、删除游标行后续页、旧接口兼容和越权拒绝。 |
| 任务恢复 | PostgreSQL 并发回收两次，迟到心跳返回 409。API 实际启动定时回收，Worker 未轮询时，过期任务在约 30.3 秒后回到队列。 |
| 隔离还原 | PostgreSQL 16 用 `pg_dump -Fc` 与 `pg_restore` 恢复到独立数据库，验证迁移版本 0006 和测试项目数据。 |
| Web 与 Windows | Next.js 生产构建、Vite 工作台及 Tauri Windows 原生程序编译通过。浏览器验收通过 10 组视口与外观组合，验证跨页选材、路线提示、离线排队和窄屏切换。 |
| Viewer | 用实际 SPZ 文件验证解码渲染。测试 API 首先返回会收到 HTTP 403 的链接，点击重试后取得新链接、恢复场景，并可用 Escape 关闭查看器。 |
| Android | Expo Android bundle 和原生 APK 构建通过。重打包强制更新 Hermes bundle，检查 APK 中存在分页接口、选材栏及新的失联文案。 |
| 微信小程序 | 实际 AppID 对应的生产构建和原生请求适配器回归通过。 |

最终本地 Android 测试 APK 的 SHA-256 为 `19bb7802fae2f46861e1a5d23f986357ded7f560079927cb0981930c9014fdc4`。

上传中断、授权删除及已引用素材拦截由现有自动化回归覆盖。本轮未在生产 OSS 运行这些写入用例，未做新版手机真机验收。生产发布需先上线兼容 API，再用对应版本验证各端。历史证据保留在原目录。

- [浏览器用例结果](results.json)
- [Web 桌面浅色](screenshots/web-1440-light-workspace.png) · [Web 手机深色](screenshots/web-390-dark-workspace.png) · [排队反馈](screenshots/web-390-dark-offline-queue.png)
- [Windows 工作台浅色](screenshots/windows-ui-1280-light-workspace.png) · [Windows 工作台深色](screenshots/windows-ui-1280-dark-workspace.png)
- [场景链接过期](screenshots/web-viewer-expired.png) · [重试后渲染](screenshots/web-viewer-recovered.png)

SPZ 验证素材是 Spark 官方示例 `butterfly.spz`。测试下载的 SHA-256 为 `2e22c9967731bebc0ea74e1747cd42e955dec16a89dba9aac07d62a6c5780e0d`，原始文件保存在本地缓存。[示例来源](https://github.com/sparkjsdev/spark#copy-code)

设计对照使用固定版本的 `frontend-design` 和 Vercel 界面规则。优先让素材、路线和恢复动作出现在任务发生的位置，无障碍审查覆盖键盘焦点、对话框、窄屏导航和状态反馈。[Frontend Design](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/frontend-design/SKILL.md) · [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md)
