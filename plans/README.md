# ReScene 深度审计与实施计划

历史证据链接固定到归档前的源码提交，需要仓库权限。0.5.0 发布资产与部署尚待核验，见 [发布说明](../docs/0.5.0发布说明.md)。

基线为 `21b2052`，审计日期为 2026-11-20。首批计划覆盖用户选定的前五项。每份计划包含现状锚点、变更范围、分步验证和验收标准。验证通过后更新对应状态。

[2026-11-21 第二轮深度审计](audit-2026-11-21.md) 记录 27 项新增发现及本轮验证。[第二轮实施顺序](#第二轮实施顺序) 对应 `006`–`032`。

[2026-11-21 第三轮深度审计](audit-2026-11-21-b.md) 以 `8c6009c` 为基线记录 41 项发现及 5 项产品机会；新增计划 `033`–`049` 见该报告的[实施顺序](audit-2026-11-21-b.md#实施顺序)。

## 实施顺序

| 计划 | 工作项 | 优先级 | 工作量 | 依赖 | 状态 |
|---|---|---|---|---|---|
| [001](001-verify-project-invitations.md) | 校验项目邀请领取资格 | P1 | L | 无 | DONE · `7404d8b`，已并入集成分支 `13bfa65`（设备复测见实施记录） |
| [002](002-isolate-native-offline-queues.md) | 按账户隔离 Android 与微信离线队列 | P1 | M | 无 | DONE · `072030b`，随 005 并入集成分支 |
| [003](003-fence-stale-upload-cleanup.md) | 串行化过期上传清理与完成 | P1 | M | 无 | DONE · `2d2ff23`，已并入集成分支 `19d5224` |
| [004](004-restart-from-corrupt-checkpoint.md) | 损坏的 checkpoint 回退到干净重建 | P1 | S–M | 无 | DONE · `ecc88b6`，已并入集成分支 `3c0925a` |
| [005](005-make-native-replay-concurrency-safe.md) | 防止离线重放覆盖新入队项 | P1 | M | 002 | DONE · `cced25e`，已并入集成分支 `d9e2121` |

001、002、003、004 的行为可独立验证。001 与 002 同时修改原生页面，001 与 003 同时修改 API 主模块和测试文件。先落对应变更后再基于最新分支核对另一份计划的锚点。005 使用 002 的账户存储键、会话代次和重放上下文。

状态使用 TODO、IN PROGRESS、DONE、BLOCKED（注明原因）、REJECTED（注明替代结果）。工作量 S 为数小时，M 约一天，L 为多天，包含回归验证。

## 实施记录（2026-11-21）

| 计划 | 本地分支 | 工作树 | 验证 |
|---|---|---|---|
| 001 | `codex/verify-project-invitations` | `C:/rs-plan-001` | Python 260 项通过、7 项跳过，包含 Alembic 升级和 PostgreSQL 16.16 并发。71 项 TypeScript 测试、11 个 workspace 类型检查及五端构建通过。Edge 连接隔离 API，验证签发、注册后未获授权、键盘领取、只读访问和撤销，复核宽屏浅色与窄屏深色截图。 |
| 002 | `codex/isolate-native-offline-queues` | `C:/rs-plan-002` | Uploader 18 项通过，Android 导出、小程序构建与编译产物跨账户回归通过。API 35 模拟器用包含 002 的 `cced25e` 验证 A 离线入队、B 上线无串号、A 回来恰好重放一次。真实模拟器暴露的 Expo 原生拒绝处理已随 `072030b` 修复。 |
| 003 | `codex/fence-stale-upload-cleanup` | `C:/rs-plan-003` | Python 全量 253 项通过、7 项跳过。独立 PostgreSQL 16.16 复跑 6 项通过，覆盖三种清理与完成交错。存储通过可观测替身验证缺对象与暂时性删除失败。 |
| 004 | `codex/restart-from-corrupt-checkpoint` | `C:/rs-plan-004` | 预处理与 Worker 聚焦 52 项通过，全量 267 项通过、7 项跳过。隔离夹具验证损坏清单回退、租约栅栏、合法 checkpoint 和后续任务。 |
| 005 | `codex/make-native-replay-concurrency-safe` | `C:/rs-plan-005` | 以 `072030b` 为基底。复核 24 项 uploader、79 项 workspace 测试、11 个类型检查、Android 导出、小程序生产构建以及成品重放夹具。API 35 模拟器暂停第一条重放请求，期间添加另一条离线草稿，依次恢复后两条均只创建一次。 |

Python 复核使用 Windows 上的 Python 3.11.18、仓库约束文件和隔离 PostgreSQL 16.16。前端复核使用 Node 22.23.5、pnpm 10.18.3。001 的首次冻结安装选到了 React 18 类型，将该工作树忽略目录中的 junction 对齐到 React 19.2.2 后，类型和 Web 构建通过。001 的收件人测试使用合成账户。Android `SLT_API35` 模拟器使用本地签名的 x86_64 测试包、合成账户和回环 API，网络故障由测试代理控制。测试包 SHA-256 为 `9d3aec8afb600d7c8e58da07b3fe3e3e24afdd4042c841e9afbb6ec5aeaddff4`。微信编译产物回归使用模拟原生 API，开发者工具的自动化连接未建立。真实 OSS、原生设备正式包和新 5090 运行仍待验收。

各项已分别保存在本地分支。005 已包含 002。组合检查发现 001 与 003 在 `tests/test_api.py`、`tests/test_api_postgres.py` 有冲突，001 与 005 在 `apps/miniapp/src/pages/index/index.tsx` 有冲突。原工作区的 HEAD 为 `21b2052`。

### 集成分支（001–005）

集成工作树 `C:/rs-audit-integration`，分支 `codex/audit-integration`，起点 `21b2052`。合并顺序 001 → 003 → 004 → 005（005 已含 002），每步 `git merge --no-ff` 后运行该计划聚焦命令。

| 计划 | 合并提交 | 冲突处理 | 聚焦验证 |
|---|---|---|---|
| 001 | `13bfa65` | 无 | API/契约/PostgreSQL 测试与 workbench 17 项通过 |
| 003 | `19d5224` | `tests/test_api.py`、`tests/test_api_postgres.py` 导入并集；以 001 的 Alembic `migrate()` 夹具为准，删除失效的 `from rescene_api.db import Base`，双方测试函数均保留 | 含 PostgreSQL 夹具 35 项通过 |
| 004 | `3c0925a` | 无 | preprocess 与 worker 52 项通过 |
| 005 | `d9e2121` | `apps/miniapp/src/pages/index/index.tsx` 以 005 的 owner/会话结构为基底，重加 `inviteCode` 状态、`currentQueueOwner()` 栅栏的 `acceptInvitation()` 与领取码卡片；登出改用 `signOutSession()` 并清空领取码 | 全量 282 项通过（7 项跳过为可选引擎依赖）、11 个类型检查、68→79 项 workspace 测试、Android 导出、小程序生产构建与 `check-miniapp-login` 通过 |

环境：Python 3.11.18（uv 虚拟环境 + `infra/api/constraints.txt`）、Node 26.13.1、pnpm 10.18.3、PostgreSQL 16.16（scoop 隔离实例，端口 55432，schema 级隔离夹具）。Ruff lint/format、`mypy` schema、`pnpm check:versions` 通过。Docker 守护进程在本机未启动，镜像构建与容器日志抽查记录为待验收。

### 第二轮集成（006–032）

集成工作树 `C:/rs-audit-integration`，分支 `codex/audit-integration`，起点 `21b2052`。各计划提交哈希见上表；合并均使用 `git merge --no-ff`，共享文件（`rescene_api/main.py`、`Workbench.tsx`、原生项目页与测试夹具）按先落计划再核对后一计划锚点的方式逐项合并。

| 范围 | 计划 | 聚焦验证 |
|---|---|---|
| API、权限、迁移、日志 | 006 007 008 009 010 013 014 022 023 027 | 隔离 PostgreSQL 的租约、分享、删除、幂等、账户代次与旧库接管用例通过；Alembic `0007→0009`、SQLite 与 PostgreSQL 迁移夹具通过；lint/format/mypy 通过 |
| Worker、离线实验、流水线 | 011 016 018 019 024 028 030 031 032 | 评估证据合并、降采样清单校验、进程组退出、租约丢失后停止上传、GPU 探测超时、退化位姿拒绝、按场景汇总、仅当前尝试分类、Worker drain 恢复用例通过 |
| 四端客户端 | 012 015 017 020 021 025 026 029 | 原生素材持久化、任务快照与 SSE 空闲回退、编译产物日志轮询、原生桥首载与重试、桌面缓存跨进程限制、通知分页保留、窄屏抽屉焦点管理用例通过 |

最终闸门（2026-11-21）：Python 全量 `pytest` 362 项通过、7 项跳过（含 PostgreSQL 16.16）；Ruff lint/format 与 `mypy` 通过。Node 侧 `pnpm -r typecheck` 全部通过，workspace 测试 101 项通过；`rescene-web`、`@rescene/desktop`、`@rescene/miniapp`（生产 `build:weapp`）与 `@rescene/mobile`（Android 导出）构建成功；`scripts/check-miniapp-login.mjs` 与 `scripts/check-mobile-viewer.cjs` 夹具通过。Rust `cargo fmt --check`、`cargo clippy --offline --all-targets -D warnings`、`cargo test --offline`（3 项）通过。执行环境为 Node 26.13.1、pnpm 10.18.3、Python 3.11.18；仓库声明的 Node 22 未复跑。

本次集成本地检查不含真机、Docker 容器日志、真实 OSS 与 GPU 训练；后续补验见下节。025 的缓存锁只覆盖进程内，跨进程并发仍未防护。

### 第三轮集成（033–049）

集成工作树 `C:/rs-audit-integration`，分支 `codex/audit-integration`，提交 `f16372e`。17 份计划按安全/上传/任务、客户端、引擎、CI/文档四个切片实现，未改动生产环境。

| 范围 | 计划 | 验证 |
|---|---|---|
| 安全与上传 | 033 034 035 036 037 039 040 | API 全量 `pytest` 374 项通过、32 项跳过；针对 XFF/X-Real-IP、2 MB 请求体上限、邮箱边界、四个 409 错误码、上传凭据回滚、过期上传批次与清理上限的用例通过。Caddy 配置用 v2.11.9 `validate` 通过；`deploy_targeted.sh`/`backup.sh` 语法检查通过。 |
| 任务与客户端 | 038 041 042 043 044 | 重试/租约/Worker 失败的进度与阶段重置用例通过；Uploader 36 项、Workbench 36 项、workspace 类型检查通过；Android 串行上传、缓存清理、桌面 CSP 断言、通知刷新/工作区错误条、日志/上传/管理员搜索围栏用例通过。 |
| 引擎与性能 | 045 046 049 | 引擎恢复证据、OOM 降级、几何分类、损坏 checkpoint、benchmark 原子写/校验、环境哈希缓存与 checkpoint 成员用例通过；项目摘要批量查询与 `job_logs(job_id,id)` 迁移测试通过。 |
| 契约、CI、文档 | 047 048 | 13 份契约夹具与 zod 解析一致；Rust `cargo test` 3 项通过；health 测试 3 项通过；四端构建通过；文档链接和版本一致性检查通过。 |

本地构建：`rescene-web`、`@rescene/desktop`、`@rescene/mobile`（Android 导出）和 `@rescene/miniapp`（生产 `build:weapp`，使用仓库 AppID 与合成 HTTPS 域名）成功。PostgreSQL 测试因本机无 `RESCENE_TEST_POSTGRES_URL`/Docker 守护进程而跳过。

### 第三轮生产部署（2026-11-21）

生产主机 `107.151.246.42`，最终代码提交 `1dd6bae`，分支 `codex/audit-integration`。本轮先把 `0009` 备份写入 `/root/rescene-backup-audit-20261121T134059Z`，并在临时 PostgreSQL 16 恢复，校验 `jobs=25`、`assets=131`、`users=8` 后切换到 `0010`。Caddy 为 2.11.4，先备份并 `validate`/graceful reload，再切换 API/Web；镜像从干净归档在公网主机构建，未使用本地 Docker。

| 项目 | 结果 |
|---|---|
| API | `rescene-api:0.4.1-1dd6bae`，`sha256:0cd7f77b324834a47e441510ac401f72bcfe8aa168059d9169f35b6ea4c690eb`，healthy，重启 0 |
| Web | `rescene-web:0.4.1-f16372e`，`sha256:0f1ca323845a84e7d39f965bcec029dfe7c74c297e5f959590a49655367e67dd`，healthy，重启 0 |
| 数据库 | PostgreSQL 16，Alembic `0010`，`ix_job_logs_job_id_id` 已建立，无 `QUEUED`/`RUNNING` 任务 |
| Caddy | 安全头、HSTS、CSP 已生效；2 MB 请求返回 413；`X-Real-IP` 改用 `{http.request.client_ip}`，伪造地址不再绕过限流（10 次后 429） |
| API 冒烟 | 管理员登录 200；16 个项目；任务 `e301947a-c7cd-4574-9e8a-dc6a226199ce` 为 `SUCCEEDED`；7 个阶段；SSE 事件可读 |
| Web 冒烟 | 真实浏览器登录、项目列表、任务页和 SPZ Viewer 渲染成功；Viewer canvas 1643×897 |
| 本轮测试 | Python 374 通过/32 跳过；Ruff、mypy；workspace 类型检查；workspace 115 项；Rust fmt/clippy/test；13 份契约夹具；Web、Desktop、Site、Android 导出、小程序生产构建 |

本轮未触发新的 GPU 训练，也未重跑 Android/微信真机、桌面 release 扫码或真实 OSS 故障注入；这些保持待验收。生产 Worker 在切换后继续以 200 响应领取租约。

### 0.4.1 审计集成补验

候选应用源码：`70e509afb602919fcc577be3f737644d2f6f941a`。不把此前 `e42f505` 的 [六条 GPU 任务与设备验收](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/report.md)计入本次候选。

| 事项 | 环境与结果 |
|---|---|
| 029 · Web 窄屏键盘 | Windows Edge 157.0.4341.60，候选生产构建、隔离 API 夹具。390 px 浅色和 1024 px 深色：关闭时 Tab 跳过抽屉，打开后 Tab / Shift+Tab 循环，Escape 返回入口，选择项目后焦点进入标题；切到 1366 px 后侧栏正常可用。 |
| 001、009 · 容器业务验收 | 候选 API + 独立 PostgreSQL：先签发、后注册仍无权限；错误账号拒绝领取，正确账户仅领取一次，移除成员后访问撤销。同一幂等键重复创建返回同一项目。没有使用生产账号或数据。生产备份中的历史成员关系未改动，仍由项目所有者复核。 |
| 010 · 定向切换与回退 | Ubuntu CI 暴露 `BASH_ENV` 测试路径误转；修正后 Git Bash、GPU Linux 各 7 项通过。旧 0.4.0 API 在隔离 `0009` 启动失败；另从原备份还原 `0006` 后启动并返回 200。不能只换镜像回退；有写入后不能直接还原部署前快照。 |
| Docker 镜像 | 公网主机用 `70e509a` 干净归档单独构建：API `sha256:1bd805f4f9c5602a41aac79e36100427fe34c33db2d7a54088ad926ce3228476`、Web `sha256:2b6f587303bf1d5ec76baa3b7d13ca8c5cd5b568539dcbee492b1c8f129ab29c`；Web 容器在无网络、无端口映射时就绪，容器内请求首页 HTTP 200。两者均未替换线上镜像。 |
| 006 · 容器访问日志 | 候选 Docker 容器返回分享 404、健康检查 200；Uvicorn 保留脱敏访问行，合成路径与查询凭证均未出现在容器日志。 |
| 008 · OSS 素材删除 | 候选独立项目和新对象：STS 上传、完成及读取通过；DELETE 204 后素材行消失，清理队列先有记录，再由后台回收；STS 再读返回对象不存在。真实 OSS 未注入故障，失败和并发路径由隔离夹具覆盖。 |
| 022 · 迁移与旧库接管 | 在隔离 PostgreSQL 还原本轮生产 `0006` 备份，升级至 `0009`，15 张原表的行数和原列指纹一致。另还原 2026-11-09 无 `alembic_version` 的真实历史备份，自动接管并升级至 `0009`，11 张原表的行数和原列指纹一致。生产 PostgreSQL 16.14 未迁移；本轮部署前演练备份 367,926 字节、root `0600`，SHA-256 `dadb7db5e0a1be6dba660634899cb405126fbd1701b2f8692876e59dadce80ff`。正式切换须重新生成停写后的最终快照。 |
| 001、002、005、009、020、021 · Android 模拟器 | `SLT_API35` 上的旧候选复现 Viewer 首载超时：WebView 14.0.1 在 Android 只上报发送者 origin，被旧路径校验拒绝。`d87c268` 修正并接入回归脚本，[CI 44896479485](https://github.com/FLmhp/ReScene/actions/runs/44896479485) 五项通过。含修复的内嵌 JS 测试 APK（SHA-256 `738db4e4763ba0be2a04075e5a8664ae1d2b152eb75ca36b6fc2e33c9ae5f9eb`）在真实 WebView 验证无 `src` 导航、原生首载、模拟签名地址 403 后重试换 URL 并收到 200，主文档 503 后也可重试。另验收断网强制退出再启动、A/B 换号无串队列、隔离邀请领取及 A 只重放一个项目。另经回环代理加载真实 FAST 交付的 19,517,631 字节 SPZ（SHA-256 `d63b2de6ddb404ed7a0f128cf5fd8c3c1f3e3d428792479f92902244b4dec15f`），模拟器实际显示彩色高斯场景。未使用物理设备、正式签名或真实移动网络。 |
| 001、020、021 · Android 真机 | HUAWEI BKY-W10，Android 12 / SDK 31，arm64-v8a；已安装 0.4.1（versionCode 6，APK SHA-256 `249c6ef3e894338ab336d23a123ef663ad95c59344b8e43bf9bd9f739438dcca`），生产 API 与真实 OSS。合成账号登录、`am force-stop` 冷启动保留会话；选择设备本地 8 张 Lego 序列，8/8 PostObject 上传完成；BALANCED 任务 `e301947a-c7cd-4574-9e8a-dc6a226199ce` 第一次领取成功，332.693 秒训练后交付 `e66de4a3-4576-44e7-afee-5a6e8099e9e6`（SPZ 12,515,130 B、PLY 122,788,973 B）。日志从空列表轮询到 328 行；首次点击「打开三维场景」直接加载并渲染，未复现首载超时。8 帧场景质量低，且阶段记录显示原始素材 ID 数组和 metrics JSON，记为可读性问题。[报告](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-21-android-device/report.md) |
| 012 · Android 素材重放 | 离线选入合成 PNG；强制退出并删除测试原文件及选取缓存后，应用管理副本仍在。重新联网后发送到隔离上传替身，27,769 字节与 SHA-256 一致，接口返回 `READY` 后清掉管理副本。该次不涉及真机或真实 OSS。 |
| 007、017 · 微信运行时 | DevTools Stable 2.01.2510290 / SDK 3.17.6，候选开发构建、合成账号与回环 API。CLI 已登录；首次启动页面方法超时，最小工程及候选重新打开后都能显示首页，但自动化元素查询仍卡住。DevTools 确认候选登录页渲染；尝试操作登录未到达回环 API，未证实日志追踪或分享切换。编译夹具通过，仍需微信真机及有效 HTTPS 分享配置复测。 |
| 007、017 · 微信真机 | **BLOCKED（2026-11-21）**：Android 设备已接入，但没有可用的微信开发者工具/登录态、微信测试账号和第二个接收账号，无法上传体验版或验证真机分享切换、任务日志和双账号领取。代码与编译夹具通过，状态不记为真机验收。 |
| 018 · Linux 进程组 | 主进程先退出后，真实同组子进程忽略 TERM，随后由 KILL 结束；10.1 秒确认组消失，无关进程未受影响，归属未知时拒绝继续。 |
| 019 · 5090 传输边界 | 候选 Worker、独立 PostgreSQL 与真实 OSS；第一件约 19 MB 实际 PUT 开始后通过候选 API 取消。当前 PUT 允许完成，未开始下一件或 manifest，任务为 `CANCELLED` 且未发布重建。任务 `033a7fe7-08a0-49ed-99f2-79ba48b6c868`。 |
| 5090 · FAST 交付 | `5d2fcc3e-3f3f-4868-bf9f-1f67e06b22ef` 在隔离 SSH 转发中断后失租，第 2 次领取成功并发布重建 `c098aeb9-eee4-4c38-baff-d8edd98e0dfe`；从 5090 通过 API 签名链接读回 SPZ、PLY、metrics、report、manifest，字节数及 SHA-256 全部匹配；注册率 100%，训练峰值显存 1381 MiB，指标有限。仅凭这次重试成功不认定已恢复 checkpoint。 |
| 5090 · BALANCED 交付 | `79e8ad83-02cf-446f-ba2d-e9c3a9c35703` 第 1 次领取成功，发布 `6a898941-f309-44a2-a5b6-e34b1087017c`。25 张图全部注册，重投影 1.0928 px，PSNR 15.296，SSIM 0.4739，LPIPS 0.4744，训练峰值 1486.5 MiB，耗时 333.1 秒；通过候选 manifest 取回并校验五类产物。 |
| 5090 · QUALITY 交付 | `c550c6b8-7df5-4fc4-a95c-4a8be4a5e24c` 第 1 次领取成功，发布 `02dde559-9ed2-4372-a0a3-913d6feb5855`。25 张源图注册 24 张（96%），重投影 0.3481 px，PSNR 16.988，SSIM 0.5612，LPIPS 0.3709，峰值显存 1137.9 MiB，耗时 549.6 秒；稠密点 157,267、网格 63,072，manifest、metrics 与全部产物 SHA-256 及 Range GET 206 通过。 |
| 5090 · OSS checkpoint 恢复 | 另建隔离 FAST 任务 `e7a1b7b8-83f4-4888-919e-ca5f993879b2`。第 1 次真实上传几何 checkpoint 并获 API 确认后，受控退出本次 Worker，租约自然过期。第 2 次领到相同对象键、实际从 OSS 读取并还原归档，最终成功发布 `2e9bf811-b044-4920-b259-f8089c879d77`。 |
| 024 · GPU 探测 | RTX 5090 上注入挂起的 `nvidia-smi` 命令，10 秒超时，独立锁释放、未领租约；随后真实探测恢复。未制造物理驱动故障或重置。 |
| 032 · drain 归属 | 5090 独立根目录和独立队列：候选 Worker PID 6807 被监督器 drain / stop，注入试验子进程启动失败后恢复为 PID 6885，`drain=no`，随后正常停止。夹具另证实保留预置 drain 与停止失败标记。未改动生产 Worker 或标记。 |
| 5090 基础回归 | 驱动 580.76.05、Torch 2.12.0+cu130；CUDA smoke 通过。共用 GPU 锁下用 25 张 Golden Kitchen 图运行 100 步，39.2 秒完成，PLY 导出和评估均到第 99 步。不是三条路线的生产任务。 |
| 上线前现网 | API 0.4.0，PostgreSQL 16.14 revision `0006`；API、Web、数据库容器均健康。新 RTX 5090 节点已用固定主机密钥登录；检查时生产 Worker 停止、无 drain 标记、GPU 无计算进程。 |
| 生产上线 | 2026-11-21T11:17:58Z–11:18:20Z 停写切换，源码 `d87c268`、CI 44896479485。备份 `rescene.dump` SHA-256 `2e6f5d21…0a94`，数据库 `0006`→`0009`，四类行数保持 16/120/24/18。API 0.4.1、Web 健康，公网三入口 200，管理员读取 14 个项目与 12 条未读通知。 |
| 生产 Worker | 5090 原树为 0.3.0；备份配置与 `.sync.tar.gz` 后换入 `d87c268` 干净归档，保留 `worker.env`、`worker_token` 与共享数据链接。`workerctl bootstrap` 和 GPU smoke 通过，Worker 以 PID 22691、`drain=no` 启动，租约验证后领取任务 `f8201574-991a-4f88-bc8a-9b1c86f370d8`；该任务已 SUCCEEDED，重建 `3814d608-dc1d-4c81-9604-6300d50d652c` 质量分 16.34，发布 manifest、metrics、report、19,717,200 字节 SPZ 和 185,513,761 字节 PLY。旧树保留在 `/root/ReScene-0.3.0-live-20261121T112035Z`。 |
| 官网第二次发布 | 交付文案改为线上 0.4.1、Worker 已恢复和 Android 模拟器结果，由 `674c69c` 构建；事务 `20261121T112721Z-674c69c23e03-ae135037` 提交。最终补充旧版客户端领取码路径，由 `4396ad9` 构建，事务 `20261121T114028Z-4396ad904fdb-37ef7fa8` 提交，站点校验通过，1440 / 390 px 实测新表格与说明。 |
| 官网发布 | 交付状态先由 `d25f301` 通过 [CI 44895065999](https://github.com/FLmhp/ReScene/actions/runs/44895065999) 独立发布；现网为 `20401f80adb1eb71bbbcbabe0a9c7fa0e4457193`，[CI 44895921345](https://github.com/FLmhp/ReScene/actions/runs/44895921345) 通过，明确领取码只适用于候选。事务 `20261121T105214Z-20401f80adb1-1e803786` 已提交，发布归档 SHA-256 为 `091cdc99a96cc3550174ed810f39fe01d94494ca3bc8e435a62862f45b0a5ddc`；HTTPS、重定向、静态产物、缓存、安全头及既有 API/Web/数据库/Caddy 容器身份检查通过。公网 Edge 390 / 1440 px 验证新文案，官网、工作台和 API 就绪入口均为 HTTP 200；API 仍为 0.4.0、数据库仍为 `0006`。 |

**0.4.1 生产上线（2026-11-21T11:17:58Z–11:18:20Z）。** 发布源码为 `d87c268ab14ed900c7c966eb7e605f9cee975f69`，[CI 44896479485](https://github.com/FLmhp/ReScene/actions/runs/44896479485) 五项通过。停写窗口先停 Web 再停 API；生产 Worker 已停止、无 drain 标记、GPU 无计算进程，排队任务 1 项。最终快照 `/root/rescene-rollback-041-production-20261121T111758Z/rescene.dump` 为 root `0600`、367,926 字节，SHA-256 `2e6f5d21d3d798ae5699f7996853c39de65fb20b6131d68ebec1f07d0cb80a94`，`pg_restore -l` 可读；同目录保留原镜像 ID、前后行数、会话数和校验文件。切换镜像为 API `sha256:7fdf98cccc4b2119710aa509ba5fbe08f09942497d289ba7face732228c8508a`、Web `sha256:fdb2161a75e5b5ffaa93ca945a59cc69f59d75e75f66a33bc5078d5c5461db68`；原 API `sha256:d1dcbb34364782fd4ce2e82859b4087e7452ba41e0855e4d11b607a7fedfd976`、Web `sha256:037419dc0f13c5211ade4b201a32fd087dfeec99e802026833980ec1beb13025` 及先前镜像归档继续保留。数据库由 `0006` 升级至 `0009`，项目、素材、任务、重建前后均为 16、120、24、18。API `0.4.1` 和 Web 健康检查通过，公网 API、工作台、官网均返回 200；管理员登录及项目、通知读取返回 200（14 个可见项目）。生产 Worker 仍离线，1 项排队任务等待 GPU Worker 恢复；原生真机、微信真机和正式签名安装包仍未验收。回退须恢复最终快照后再启动旧镜像；旧 API 不能读取 `0009`，开放写入后的异常只能前滚修复，直接还原会丢失上线后写入。

## 审计发现

| # | 发现与影响 | 类别 | 工作量 | 修复风险 | 置信度与证据 |
|---|---|---|---|---|---|
| 1 | 邮箱字段直接用于授予项目权限。注册会领取待处理邀请，添加已有账户也依赖未经验证的地址。 | 安全 | L | 中，涉及迁移和四端协作 | 高。[注册](../src/rescene_api/main.py#L283) · [添加成员](../src/rescene_api/main.py#L657) |
| 2 | Android 与微信的离线队列按设备存储。切换账户后，当前账户可能收到另一个账户留下的离线草稿。 | 安全／正确性 | M | 中，涉及历史队列和账户恢复 | 高。[Android 存储](../apps/mobile/src/queue.ts#L7) · [微信存储](../apps/miniapp/src/queue.ts#L13) · [重放](../packages/uploader/src/queue.ts#L72) |
| 3 | 过期清理和完成上传没有共用同一行锁。清理可能丢失已完成素材，OSS 删除失败也可能丢失可重试记录。 | 数据完整性 | M | 中，需核对锁序与失败路径 | 高。[清理](../src/rescene_api/main.py#L1408) · [完成](../src/rescene_api/main.py#L956) |
| 4 | 损坏的 checkpoint 清单可能结束 Worker 轮询。合成测试中截断清单抛出的异常绕过现有从头回退分支。 | 正确性 | S–M | 低，已有回退路径 | 高。[清单解析](../src/rescene/preprocess.py#L412) · [恢复分支](../src/rescene_worker/main.py#L454) · [轮询](../src/rescene_worker/main.py#L558) |
| 5 | 离线重放结束时写回旧快照，可能覆盖重放期间新增的条目。微信有两个页面能触发重放，原生前台上传也会改写同一队列。 | 正确性 | M | 中，涉及续传及重试 | 高。[Android](../apps/mobile/src/queue.ts#L40) · [微信](../apps/miniapp/src/queue.ts#L37) · [项目页入口](../apps/miniapp/src/pages/project/index.tsx#L166) |
| 6 | Worker 读取阶段文件和时间戳使用两次系统调用。文件被原子替换时，旧状态可被记成新版本已上报，漏掉最终阶段或 checkpoint。改为从同一快照确定去重标记。 | 正确性 | S | 低，需保留 export 延迟条件 | 高，本地合成时序复现。[Worker](../src/rescene_worker/main.py#L293) · [原子替换](../src/rescene/stages.py#L37) |
| 7 | Web/桌面换号后，旧项目或通知状态可在新会话刷新前出现。按会话重置账户状态并隔离在途响应。 | 安全／正确性 | M | 中，涉及会话恢复 | 高。[退出处理](../packages/workbench/src/Workbench.tsx#L395) · [通知状态](../packages/workbench/src/Workbench.tsx#L545) |
| 8 | 审计 CSV 直接导出用户控制的项目名，表格软件可能把字段作为公式处理。应在 CSV 序列化边界转义公式型文本。 | 安全 | S | 低，普通字段和 BOM 需保持兼容 | 高。[项目名输入](../src/rescene_api/main.py#L460) · [CSV 输出](../src/rescene_api/main.py#L833) |
| 9 | 任务事件流只检查初次连接的权限。会话或项目权限撤销后，在途连接可能继续接收事件。为事件批次做有限开销的权限复查。 | 安全 | M | 中，涉及断线重连和轮询负载 | 高。[首次检查](../src/rescene_api/main.py#L1337) · [事件循环](../src/rescene_api/main.py#L1350) |
| 10 | 默认留出集可能为空。黑帧筛除后原始索引取模可使所有已选帧落在训练侧，训练器随后拒绝运行。默认划分需在可用帧足够时确定性地补齐，冻结实验仍遵循显式划分。 | 正确性 | S | 中，涉及指标可比性 | 高，本地合成样例复现。[划分](../src/rescene/preprocess.py#L294) · [训练前校验](../src/rescene/gsplat_runner.py#L21) |
| 11 | 标定重新使用运行前缀时可读取旧指标，普通 resume 也会先覆盖运行配置。指标复用前应核对运行身份。 | 正确性／技术债 | M | 中，需兼容历史实验 | 高，本地合成样例复现。[指标复用](../src/rescene/benchmark.py#L398) · [配置写入](../src/rescene/pipeline.py#L390) · [运行身份示例](../scripts/route_experiments_v3.py#L270) |
| 12 | Viewer 清理路径漏掉 SparkRenderer 的 dispose。反复开关或重试可能累计渲染资源。 | 资源／性能 | S | 低，需验证重试可重建上下文 | 高。[构造](../packages/viewer/src/Viewer.tsx#L78) · [清理](../packages/viewer/src/Viewer.tsx#L142) |
| 13 | Web/桌面的通知请求失败会中断项目详情加载。通知请求应有自己的失败状态，并沿用认证失效逻辑。 | 正确性 | S | 低 | 高。[加载顺序](../packages/workbench/src/Workbench.tsx#L166) |
| 14 | 重建耗尽租约重试或领取时缺少输入会进入 FAILED，跳过普通失败通知。补齐这两个终态分支。 | 正确性 | S | 低，需核对重复回收 | 高。[租约回收](../src/rescene_api/main.py#L1431) · [领取输入校验](../src/rescene_api/main.py#L1496) · [普通失败通知](../src/rescene_api/main.py#L1691) |
| 15 | Android 与微信直接为一页素材请求缩略图签名。微信的 lazyLoad 只延迟图片加载，签名仍可触发 OSS STS。参考 Web 的可见性控制。 | 性能 | M | 中，需验证滚动与重试 | 高。[Android](../apps/mobile/src/AssetThumbnail.tsx#L13) · [微信](../apps/miniapp/src/asset-thumbnail.tsx#L11) · [签名](../src/rescene_api/storage.py#L180) |
| 16 | 删除素材时可能对项目中每个任务各读取一次输入列表。任务多的项目应先测查询增长和耗时，再决定合并查询。 | 性能 | S–M | 中，必须保留历史任务的引用保护 | 中，查询结构已确认，实际成本待测。[删除检查](../src/rescene_api/main.py#L1002) · [任务输入读取](../src/rescene_api/main.py#L1397) |
| 17 | 桌面缓存失败的运维指引承诺回退 CDN，Tauri 实际展示重试。更新指引可减少误诊。 | 文档 | S | 低 | 高。[运维指引](../docs/单5090系统部署与运维.md#L324) · [桌面错误状态](../apps/desktop/src/App.tsx#L65) |
| 18 | 小程序依赖树命中 Swiper 和 webpack-dev-middleware 的高等级公告。先检查微信产物是否包含相关代码，以及开发中间件是否有匹配的使用场景，再决定升级 Taro 或调整依赖。 | 依赖／工具 | S（核查） | 低，后续升级需要跨平台构建 | 低（实际可达性）。[锁文件](../pnpm-lock.yaml#L7128) · [Taro 配置](../apps/miniapp/config/index.ts#L229) · [Swiper 公告](https://github.com/nolimits4web/swiper/security/advisories/GHSA-hmx5-qpq5-p643) · [webpack 公告](https://github.com/webpack/webpack-dev-middleware/security/advisories/GHSA-g84c-rxfj-3j2c) |

第 1 项的历史成员关系需要人工复核。第 2、5 项的设备验收需要连续覆盖切换账户、联网上传和断线重试。第 3 项的并发验证以独立 PostgreSQL 服务为准，第 4 项的实现与单测可以在 CPU 环境完成。

## 产品方向

- **从注册率低开始试点补拍反馈（M）**。在任务结果里把低注册率和可用视角不足转成可执行的补拍建议，并提供另一路线的选择条件。现有候选记录中同一组微信照片在 QUALITY 注册不足后通过 BALANCED，先用小样本确定提示是否帮助用户完成交付。 [历史需求 W18](../docs/系统剩余任务与实施路线图.md#L551) · [候选验收](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/report.md#L16)
- **用提交与产物身份汇总候选验收（S–M）**。把真机设备、测试 API 类型、安装包 SHA-256、GPU 路线和待验收项收在同一张表，官网只引用已核对状态。先复用现有 release manifest 和验收 Markdown，人工确认真机结果。 [发布清单约定](../CONTRIBUTING.md#L146) · [官网交付表](../apps/site/index.html#L157) · [生产切换门槛](https://github.com/FLmhp/ReScene/blob/f999157c9ff04df1f33e820f7bd6742444ae6e92/artifacts/test-runs/2026-11-20-release-041/report.md#L56)

## 考虑后排除

- **把单卡全局只运行一个重建任务改为并发调度**。全局单租约与单 5090 是当前的部署约束，现阶段保留。 [租约路径](../src/rescene_api/main.py#L1474) · [系统架构](../docs/项目说明.md#L171)
- **直接移除冻结划分**。路径用于可比的标定和复验，默认划分的修复应保持这个边界。 [冻结帧配置入口](../src/rescene/preprocess.py#L222)
- **从锁文件警报直接推导已发布客户端受影响**。PyPI 约束中 46 个固定版本的 OSV 查询无匹配，Rust 锁文件 440 项命中两类停止维护提醒与一项尚无调用路径证据的 glib 问题。后续跟踪上游 Tauri 兼容发布。 [chrono](https://rustsec.org/advisories/RUSTSEC-2026-0543.html) · [proc-macro-error](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) · [glib](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)

## 审计与验证范围

审计覆盖 Python 引擎、Worker、FastAPI、数据库迁移、Web、Tauri、Android、微信小程序、官网、六个共享包、CI、发布和备份脚本。证据来自基线源码、锁文件、跟踪的运维文档和本地测试。历史路线图用作产品意图，当前状态以项目说明及验收记录为准。

- Windows 本地 Python 测试 246 项通过、10 项跳过。跳过包含 PostgreSQL 并发夹具及部分可选引擎依赖场景。Ruff lint/format、API schema mypy、版本一致性检查通过。
- Workspace 的 Vitest 测试 68 项通过。各包 TypeScript 类型检查通过，Web 单独以 `tsc --noEmit --incremental false` 运行。
- 依赖检查使用 `pnpm audit --prod --audit-level high --json` 和 OSV 固定版本查询。原生安装包、镜像构建、浏览器视觉、真机、真实 OSS、生产服务和完整依赖调用可达性均待单独验证。
- 用户已确认 5090 克隆至新机。本轮 GPU 证据来自历史归档，尚无本次新机上线或训练验证。源码与既有验收目录未改动。

## 第二轮实施顺序

本轮为 27 项发现编写独立计划。下表记录实现状态，环境验收与发布状态见 [0.4.1 审计集成补验](#041-审计集成补验)。

| 计划 | 审计编号 | 工作项 | 优先级 | 工作量 | 前置 | 状态 |
|---|---|---|---|---|---|---|
| [006](006-redact-share-access-logs.md) | A01 | 从 API 访问日志移除分享凭证 | P1 | S | 无 | DONE · `dd2607e`（候选 Docker 访问日志已复核） |
| [007](007-bind-share-state-to-reconstruction.md) | A02 | 将分享状态绑定到当前重建 | P1 | M | 无 | DONE · `2c172bb`（微信 DevTools 场景切换待验收） |
| [008](008-persist-asset-deletion-intent.md) | A03 | 持久化素材删除意图并重试 OSS 清理 | P1 | M | 无 | DONE · `afe1691`（隔离候选真实 OSS 删除通过） |
| [009](009-make-create-requests-idempotent.md) | A04 | 为项目与重建创建增加幂等重试 | P1 | L | [005](005-make-native-replay-concurrency-safe.md) 的原生集成基线 | DONE · `339ddc0`（Android 模拟器项目冷启动重放通过） |
| [010](010-fence-targeted-deployment-rollback.md) | A05 | 确保定向部署可以安全停止与回滚 | P1 | M | 无 | DONE · `53cf75d`（真实备份隔离恢复已演练，未切换业务） |
| [011](011-preserve-evaluation-in-regenerated-reports.md) | A06 | 重生成报告时保留匹配产物的评估证据 | P2 | S–M | 无 | DONE · `c760512` |
| [012](012-persist-native-queued-media.md) | A07 | 让原生离线上传保存素材字节 | P2 | L | [005](005-make-native-replay-concurrency-safe.md) 的原生集成基线 | DONE · `b047977`（Android 模拟器素材冷启动重放通过，真机待验收） |
| [013](013-make-session-version-monotonic.md) | A08 | 保证会话撤销版本单调更新 | P2 | M | 无 | DONE · `59d1221` |
| [014](014-scope-project-notifications-to-current-access.md) | A09 | 按当前项目访问权限筛选任务通知 | P2 | M | 无 | DONE · `4274f91` |
| [015](015-reconcile-job-status-with-sse.md) | A10 | 同步任务主状态并给 SSE 加空闲回退 | P2 | M | 无 | DONE · `adcec37` |
| [016](016-repair-incomplete-downsample-cache.md) | A11 | 拒绝复用中断留下的不完整降采样目录 | P2 | S | 无 | DONE · `74b0395` |
| [017](017-poll-miniapp-logs-from-empty.md) | A12 | 微信任务日志从空列表开始追踪 | P2 | S | 无 | DONE · `e08c21c`(编译产物夹具覆盖,微信开发者工具待验收) |
| [018](018-verify-experiment-process-group-exit.md) | A13 | 试验退出时确认所属进程组停止 | P2 | M | 无 | DONE · `2a18993`（真实 Linux 进程组实测通过） |
| [019](019-stop-worker-between-artifact-uploads.md) | A14 | 取消或失租后停止后续产物上传 | P2 | S–M | 无 | DONE · `0f7f91f`（5090 + 独立 API + 真实 OSS 取消通过） |
| [020](020-request-initial-viewer-url-over-native-bridge.md) | A15 | 通过原生桥加载 Android 私有场景 | P2 | S–M | 无 | DONE · `17008c8`、`d87c268`（Android 模拟器通过，真机待验收） |
| [021](021-show-retry-on-native-viewer-load-error.md) | A16 | Android Viewer 主页面加载失败时显示重试 | P2 | S | 无 | DONE · `17008c8`、`d87c268`（Android 模拟器通过，真机待验收） |
| [022](022-verify-legacy-database-adoption.md) | A17 | 按固定基线接管无版本标记的旧数据库 | P2 | M | 无 | DONE · `d10b698`（真实历史备份自动接管通过） |
| [023](023-lock-only-next-lease-candidate.md) | A18 | 领取任务时仅锁一个候选 | P2 | S | 无 | DONE · `0ab1bda` |
| [024](024-bound-worker-gpu-probes.md) | A19 | 为 Worker GPU 探测设置超时 | P2 | S | 无 | DONE · `ccf3587`（5090 上注入超时通过，未制造驱动故障） |
| [025](025-serialize-desktop-artifact-cache-publication.md) | A20 | 串行化同一桌面场景缓存发布 | P2 | M | 无 | DONE · `6606dfc`（单进程锁，跨进程不保证） |
| [026](026-preserve-expanded-notification-pages.md) | A21 | 在自动刷新时保留已展开的通知分页 | P2 | S–M | 无 | DONE · `abf9e1a` |
| [027](027-project-list-role-projection.md) | A22 | 在项目列表查询中一次取回角色 | P3 | S | 无 | DONE · `cba4a06` |
| [028](028-reject-degenerate-pose-alignment.md) | A23 | 拒绝退化的相机位姿对齐 | P3 | S | 无 | DONE · `47038ab` |
| [029](029-make-narrow-navigation-keyboard-accessible.md) | A24 | 让窄屏工作台抽屉遵循键盘焦点顺序 | P3 | S–M | 无 | DONE · `8ecc5fe`（Edge 实测通过，见后续验收） |
| [030](030-split-trial-summaries-by-scene.md) | A25 | 按数据集和场景分组试验汇总 | P3 | S–M | 无 | DONE · `0a2fdc6` |
| [031](031-classify-only-current-backend-attempt.md) | A26 | 仅按当前引擎子进程日志分类失败 | P3 | S | 无 | DONE · `ff7a640` |
| [032](032-restore-owned-worker-drain-after-startup-failure.md) | A27 | 试验启动失败后恢复本次设置的 Worker drain | P3 | M | 无 | DONE · `88eeeee`（隔离 5090 Worker 停启恢复通过） |

- 优先启动 006–010。006、007、010 可以独立执行。008、009 共用 API 测试和迁移链，建议先落 008，随后核对 009 的迁移编号、API 锚点与并发验收。若 001 已集成，以该基线的最新 revision 为准。
- 009 的原生项目重放和 012 的素材队列以 005 的账户隔离及队列状态为基础。007 与 001、005 同时涉及原生项目页面，集成时保留双方行为。
- 018 与 032 共用实验监督脚本，建议先验证进程组退出，再验证 Worker drain 的恢复。020 与 021 都修改 Android Viewer，建议同一次设备回归覆盖首载、续签与错误恢复。
- 015 与上一轮发现 #9 分别处理任务状态和事件流授权。014 与 026 分别处理服务端通知范围和客户端分页。验收采用同一集成基线核对对应行为。
