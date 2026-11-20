# 更新记录

## 未发布

## 0.4.1

发布候选。已完成的真机验证、六条 GPU 任务和上线门槛见 [0.4.1 验收报告](artifacts/test-runs/2026-11-20-release-041/report.md)。

- 官网与四端采用 RS 空间字标，同步更新安装图标、启动图、favicon、分享预览及发布进度。技术设计与中期报告提供带现状附录的更新版。
- 微信小程序明确以登录和项目列表页为启动入口。失效页面和未登录的私有入口返回首页，公开场景分享可直接打开复制链接页。
- 四端区分计算节点在线、离线与状态未知。无效素材提示更换原素材，重建失败后保留本次选材和路线。
- API 拒绝重试素材无效的任务并保留失败详情。任务事件按批续接，游标失效时客户端刷新任务状态。
- BALANCED 跳过参数相同的 BA 重试，保留 COLMAP 稀疏回退路径。
- Worker 在原留出图至少半数注册时可以继续验证评分，报告列出缺失源图。冻结基准沿用原规则。
- Web 与 Windows 侧栏项目名称可换行，长列表保持独立滚动。小程序使用原生主题选择器，按素材、重建路线、任务与结果分区，并将三维场景导向手机浏览器。
- Web 与 Windows 将素材、任务和结果分为独立视图。产物下载按行显示，校验值与撤销记录按需展开。

- 工作台支持服务端素材与任务分页，并兼容现行 API 的完整项目响应。四端保留跨页选材，Android/小程序提供素材网格和选材底栏。
- API 可独立回收过期 Worker 租约，四端区分取消中、输入错误与基础设施失败。
- 根开发规范统一为 `AGENTS.md`。补充 5090 共享盘预算和开机后的大数据集训练手册。

### 新增

- 独立静态官网 `apps/site`：产品流程、真实本地验收截图、重建路线与平台交付边界；复用品牌变量，支持无 JavaScript 阅读、移动导航和搜索元数据。
- 官网发布工具 `scripts/deploy_site.sh`：按成功 CI 的精确提交构建，校验 DNS 和现有服务，独占锁内原子切换静态版本与 Caddy 受管块，失败时按所有权恢复；不升级 API/Web/DB 或 Worker。

### 文档与流程

- 重组 README：补充品牌入口、架构图、可执行的本地 API/Web 启动步骤及各端实际交付边界；历史实验与运维细节移交专门文档。
- 开发指南与五项 CI 检查对齐，区分本地质量检查、构建、GPU 回归和实机验收；新增 PR 模板，要求记录契约、迁移、实际验证及回滚限制。
- 用户手册与项目说明同步 0.3.0 的注册、权限、管理和发布状态；部署指南改用干净暂存源码与定向升级/回滚，保留数据库及运行配置，纠正历史部署证据表述。

## 0.4.0 - 2026-11-18

### 新增与界面

- 四端提供跟随系统、浅色、深色主题，偏好按设备保存并在退出后保留。
- Web/Windows 新增项目卡片与素材缩略图。四端统一中文任务状态、路线说明、帧数提示和素材选中反馈。
- Android/小程序将成员、账户管理与日志按需展开，增加主题、上传重试和离线排队反馈；素材每批展示 24 个，可继续加载。
- 新增受项目权限保护的素材预览接口，使用限定到单个对象的 STS 签发五分钟缩略图链接。
- Viewer 渲染器按需加载。Windows 入口 JavaScript 从约 4.24 MB 降到约 1.07 MB。
- 小程序提供复制场景链接到浏览器的入口，登录表单可显示密码。
- 新增根 AGENTS.md/AGENT.md 开发规范、双主题视觉验证脚本与发布证据。

### 修复与兼容

- 修复小程序生产包在微信运行时的动态校验调用异常。
- 小程序显式使用 Taro 请求适配器，避免微信模块隔离下的全局 fetch 绑定失效。
- 修复 Android OSS multipart 编码及图片实际格式与临时文件后缀不一致导致的失败。
- 修复阶段恢复时的图像路径与训练溯源文件归档。
- 素材删除改用单对象 STS 授权，保留任务引用检查和并发保护。

### 发布验证

- Windows 提供 NSIS 安装包，Android APK 使用原发布密钥签名，版本码提升至 5。
- 本地 217 项 Python 测试通过、6 项按环境跳过，58 项 workspace 测试通过。
- Web/桌面前端在宽窄屏浅深主题下完成 10 组模拟 API 验证，原生 Windows 与 Android 模拟器验证登录、主题切换和偏好保存。
- 本轮 5090 关机，GPU 训练回归待开机验收。完整记录见 artifacts/test-runs/2026-11-18-ui-v040/report.md。
- Windows 安装包沿用无商业证书状态，macOS 产物的公证状态见发布清单。手机真机复测需使用本轮新包。

## 0.3.0 - 2026-11-11

### 新增

- 管理控制台（四端）：用户目录改为分页 + 邮箱/状态/管理员筛选，新增 `GET /v1/users/{id}` 返回账号的活跃项目与角色；新增公告 `POST/GET/DELETE /v1/announcements`，发布时向全部活跃账号写入一条通知、撤回时同批删除；新增全局操作日志 `GET /v1/audit`（操作者/动作/项目/起止时间过滤与分页）、`GET /v1/audit/actions` 与 `GET /v1/audit.csv`（最多 1 万行，带 BOM）。Web/桌面、Android、小程序均提供「管理控制台」入口。
- 任务运行日志：Worker 新增 `LogShipper`，按 2 秒增量采集 `worker.log` 与阶段日志并以 `POST /v1/worker/jobs/{id}/logs` 上报（单批 ≤200 行、单行 ≤4000 字，失败不影响任务）；`GET /v1/jobs/{id}/logs` 支持 `after_id` 增量、`before_id` 回看与级别过滤，每任务保留最新 `RESCENE_JOB_LOG_LIMIT`（默认 2000）行。四端任务面板展示运行日志并在运行态每 3 秒增量轮询。
- 通知中心增强：`GET /v1/notifications` 支持 `offset` 与 `kind`，新增 `GET /v1/notifications/count` 未读计数；Web/桌面与 Android 支持未读筛选、加载更多、公告标签与任务深链。
- Web/桌面响应式外壳：≤1024px 侧栏改为抽屉（汉堡按钮、遮罩、Esc 关闭），≤1100px 主网格单列，≤640px 移动端排版、单列表单与 16px 输入字号，粗指针设备 44px 触控目标。
- 桌面多平台安装包：`release.yml` 新增 Linux（`deb` + `AppImage`）与 macOS（universal `dmg`）任务，tag 触发后由 `github-release` 任务创建 GitHub Release；Tauri `bundle.targets` 改为 `all`，图标集由 `icon.svg` 生成。新增 `scripts/build-desktop-release.sh` 与 `scripts/release-notes.mjs`。
- 仓库与发布流程：`scripts/bump-version.mjs` 单入口改版本（同步全部元数据、`versionCode` 自增并立即复验），`scripts/check-commits.mjs` + `.githooks/commit-msg` + CI `commit-messages` 任务强制 Conventional Commits。
- 开放自助注册：新增 `POST /v1/auth/register`（邮箱 + 密码，至少 12 位，同邮箱返回 409）。Web、桌面端、Android 与小程序均提供登录/注册切换，注册成功直接进入工作台。
- 四端（Web/桌面、Expo Android、微信小程序）统一为深色玻璃拟态视觉：半透明面板、渐变主按钮、聚焦光晕与更圆润的卡片。
- 素材可删除：`DELETE /v1/assets/{id}`（被任务引用时返回 409 `asset.in_use` 并附带稳定错误码），四端素材列表均提供删除入口；读取项目详情时顺带清理超过 `RESCENE_STALE_UPLOAD_SECONDS`（默认 24 小时）仍未完成的上传。
- 任务阶段历史：`GET /v1/jobs/{id}/stages` 返回每阶段状态、进度、消息与指标，四端在任务下方以「阶段记录/时间线」展示；SSE 阶段事件同样进入该列表。
- 协作通知：任务完成/失败时给任务创建者与项目所有者写入通知，`GET /v1/notifications`、`POST /v1/notifications/read` 提供读取与已读；Web/桌面、Android、小程序提供「通知」面板与未读数。
- 账号治理：`POST /v1/auth/password` 自助改密（旧 token 立即失效），管理员可 `GET /v1/users`、`PATCH /v1/users/{id}`（停用/降权，禁止锁死自己）、`POST /v1/users/{id}/password` 重置密码。
- 邮箱邀请：`POST /v1/projects/{id}/members` 对未注册邮箱返回 `{"status":"invited"}` 并落库 `project_invitations`，对方注册时自动成为成员；`GET/DELETE /v1/projects/{id}/invitations` 查看与撤销。
- 审计查询：`GET /v1/projects/{id}/audit` 返回项目范围的审计记录（含操作者邮箱与元数据），Web/桌面在项目设置内展示。
- 分享二维码：`GET /v1/public/shares/{token}/qr.png` 生成 PNG 二维码，Web/桌面、Android 与小程序在创建分享后直接展示；分享到期改为「永久/1 天/7 天/30 天」预设。
- 稳定错误码：新增 `X-Error-Code` 响应头（如 `auth.rate_limited`、`asset.in_use`、`admin.self_locked`），CORS 同时暴露该头与 `Retry-After`；客户端据码映射中文提示。
- 登录/注册/改密限流：`RESCENE_AUTH_RATE_LIMIT`（默认每分钟 10 次）滑动窗口，超限返回 429 与 `Retry-After`。
- 客户端重试：任务轮询与 SSE 重连改为指数退避（上限 15s / 8s）；Android 与小程序新增上传队列，离线创建项目与上传在恢复前台时按序重放，409 的重复上传自动丢弃。

### 变更

- **不兼容**：`GET /v1/users` 由数组改为 `{total, items}`，并新增 `active`、`is_admin`、`offset` 参数（`limit` 仍限 1–100）；`GET /v1/projects/{id}/audit` 由数组改为 `{total, items}` 并新增 `action`、`offset` 参数。四端与测试同批更新，不保留兼容分支。
- **不兼容**：删除微信登录与绑定（`POST /v1/auth/wechat`、`/v1/auth/wechat/link`、`users.wechat_openid`、迁移 `0004`、`RESCENE_WECHAT_APP_ID/SECRET`）；小程序改为邮箱密码注册/登录。
- 登录邮箱统一去空格并转小写后再查询，与注册写入保持一致。
- 管理员建号表单、Android 与小程序的管理员建号提示统一为 12 位密码，与 `auth.hash_password` 的下限一致。

## 0.2.1 - 2026-11-10

### 新增

- 增加 Windows NSIS 与 Android release 构建脚本、源清单/发布清单流程和统一版本校验。
- 增加中文用户手册、开发与发布指南，并更新部署运维与项目说明。

### 修复

- Android Viewer 改为原生获取短期签名场景地址后加载，Bearer token 不进入 WebView；修复 Android WebView 消息缺少 `nativeEvent.url` 时桥接静默超时的问题。
- Viewer 改为按需渲染，移动端像素比限制为 1；场景加载后只预热渲染 2 秒，避免 Android WebView 空闲时持续重绘导致无响应。
- Android 登录恢复、上传、任务、分享和系统返回导航完成 release APK 实测。
- README 与两份 5090 历史报告增加评测勘误：冻结源图未等于实际渲染分割，缺失坐标变换的高斯产物不得沿用几何评分；保留历史数值，不计为算法收益。

- Worker 发布 PLY 使用声明的最终训练 step，并校验配置与评测 step 一致；不再挑体积最大或字典序靠后的文件。对应产物哈希和发布 manifest 的回归已通过。
- Web 与 API 的 Compose 构建上下文统一解析到仓库根目录，避免 Web 构建取错目录。
- Docker 上下文排除部署秘密、数据库、备份、实际环境文件、签名材料和原生构建缓存。
- 发布产物校验改为显式 API 地址和受保护 token 文件；失败任务、缺失产物、大小或 SHA256 不符、无效必需指标均返回失败。PLY、SPZ 与元数据均完整校验，不再仅探测首字节。
