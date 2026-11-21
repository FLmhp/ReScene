# Android 真机验收（2026-11-21）

## 环境与安装包

| 项 | 值 |
|---|---|
| 设备 | HUAWEI BKY-W10，Android 12（SDK 31），arm64-v8a，2800×1840 平板 |
| 连接 | `adb devices` 显示 `4CDBB25208200044 device` |
| 应用 | `app.rescene.mobile`，`versionName=0.4.1`，`versionCode=6` |
| 安装包 SHA-256 | `249c6ef3e894338ab336d23a123ef663ad95c59344b8e43bf9bd9f739438dcca` |
| 后端 | 生产 `https://api.rescene.xyz`，0.4.1；未使用隔离 API |
| 测试账号 | 合成账号 `qa.device.20261121@example.com`；未使用真实用户凭据 |

应用为设备上已安装的 0.4.1 包，本次未覆盖安装。测试项目为「设备真机验收 2026-11-21」，上传 8 张合成测试图片（设备下载目录中的 Lego 推土机序列，5.8 MiB）。

## 结果

| 检查 | 结果 |
|---|---|
| 登录 | 邮箱密码登录成功；系统密码保险箱选择「永不保存」 |
| 会话持久化 | `am force-stop` 后冷启动，直接进入「我的项目」，无需重新登录；通知数 1 |
| 素材上传 | 8/8 通过 `PostObject` 上传，界面均显示 `100% · 完成`，项目显示 8 个素材 |
| 创建任务 | BALANCED，任务 `e301947a-c7cd-4574-9e8a-dc6a226199ce`，第一次领取即进入 GPU |
| 阶段 | 排队 0% → 筛选素材 20% → 估计相机与几何 50% → 训练 80% → 交付 100% |
| 交付 | `SUCCEEDED`；重建 `e66de4a3-4576-44e7-afee-5a6e8099e9e6`；训练 332.693 秒，总计约 5.5 分钟 |
| 产物 | SPZ 12,515,130 B；PLY 122,788,973 B；另含 metrics、report、manifest |
| 日志 | 「查看运行日志（328）」展开成功，按级别筛选与时间行正常；从空列表追踪到实时输出 |
| Viewer 首载 | 首次点击「打开三维场景」即加载 SPZ，未出现原首载超时；实际渲染彩色高斯场景 |
| 冷启动后重开项目 | 项目卡片与任务历史保留；Viewer 入口仍在 |

截图：

- [cold-start.png](cold-start.png)
- [job-success.png](job-success.png)
- [viewer-first-load.png](viewer-first-load.png)
- [job-logs.png](job-logs.png)

## 发现

1. 阶段记录直接显示内部素材 ID 数组（排队阶段）和原始 metrics JSON。功能正确，但泄漏内部标识且可读性差；建议 API 把素材 ID 放入内部字段，UI 格式化耗时/指标。
2. 8 帧 BALANCED 重建出的场景质量较低，且 Viewer 显示大量彩色噪声；这是输入覆盖不足，不据此判定 Viewer 缺陷。首载、渲染与交互入口均已验证。
3. 本次未做断网首载/重试、分享面板和正式签名包覆盖升级；这些仍需单独场景。

## 结论

Android 0.4.1 物理设备的主路径验收通过：登录、会话恢复、真实 OSS 上传、生产 GPU 重建、日志轮询、Viewer 首载与渲染。未使用模拟器或伪造状态。
