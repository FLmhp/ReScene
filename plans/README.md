# ReScene 深度审计与实施计划

基线为 `21b2052`，审计日期为 2026-11-20。首批计划覆盖用户选定的前五项。每份计划包含现状锚点、变更范围、分步验证和验收标准。验证通过后更新对应状态。

[2026-11-21 第二轮深度审计](audit-2026-11-21.md) 记录 27 项新增发现及本轮验证。[第二轮实施顺序](#第二轮实施顺序) 对应 `006`–`032`。

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

- **从注册率低开始试点补拍反馈（M）**。在任务结果里把低注册率和可用视角不足转成可执行的补拍建议，并提供另一路线的选择条件。现有候选记录中同一组微信照片在 QUALITY 注册不足后通过 BALANCED，先用小样本确定提示是否帮助用户完成交付。 [历史需求 W18](../docs/系统剩余任务与实施路线图.md#L551) · [候选验收](../artifacts/test-runs/2026-11-20-release-041/report.md#L16)
- **用提交与产物身份汇总候选验收（S–M）**。把真机设备、测试 API 类型、安装包 SHA-256、GPU 路线和待验收项收在同一张表，官网只引用已核对状态。先复用现有 release manifest 和验收 Markdown，人工确认真机结果。 [发布清单约定](../CONTRIBUTING.md#L146) · [官网交付表](../apps/site/index.html#L157) · [生产切换门槛](../artifacts/test-runs/2026-11-20-release-041/report.md#L56)

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

本轮按用户选择为全部 27 项发现编写独立计划。以下工作均待实施。

| 计划 | 审计编号 | 工作项 | 优先级 | 工作量 | 前置 | 状态 |
|---|---|---|---|---|---|---|
| [006](006-redact-share-access-logs.md) | A01 | 从 API 访问日志移除分享凭证 | P1 | S | 无 | DONE · `dd2607e`（镜像构建待验收） |
| [007](007-bind-share-state-to-reconstruction.md) | A02 | 将分享状态绑定到当前重建 | P1 | M | 无 | DONE · `2c172bb`（微信 DevTools 场景切换待验收） |
| [008](008-persist-asset-deletion-intent.md) | A03 | 持久化素材删除意图并重试 OSS 清理 | P1 | M | 无 | DONE · `afe1691`（真实 OSS 删除待验收） |
| [009](009-make-create-requests-idempotent.md) | A04 | 为项目与重建创建增加幂等重试 | P1 | L | [005](005-make-native-replay-concurrency-safe.md) 的原生集成基线 | DONE · `339ddc0`（模拟器重启重放待验收） |
| [010](010-fence-targeted-deployment-rollback.md) | A05 | 确保定向部署可以安全停止与回滚 | P1 | M | 无 | DONE · `53cf75d`（真实服务器演练待验收） |
| [011](011-preserve-evaluation-in-regenerated-reports.md) | A06 | 重生成报告时保留匹配产物的评估证据 | P2 | S–M | 无 | DONE · `c760512` |
| [012](012-persist-native-queued-media.md) | A07 | 让原生离线上传保存素材字节 | P2 | L | [005](005-make-native-replay-concurrency-safe.md) 的原生集成基线 | DONE · `b047977`（真机重启重放待验收） |
| [013](013-make-session-version-monotonic.md) | A08 | 保证会话撤销版本单调更新 | P2 | M | 无 | DONE · `59d1221` |
| [014](014-scope-project-notifications-to-current-access.md) | A09 | 按当前项目访问权限筛选任务通知 | P2 | M | 无 | DONE · `4274f91` |
| [015](015-reconcile-job-status-with-sse.md) | A10 | 同步任务主状态并给 SSE 加空闲回退 | P2 | M | 无 | TODO |
| [016](016-repair-incomplete-downsample-cache.md) | A11 | 拒绝复用中断留下的不完整降采样目录 | P2 | S | 无 | DONE · `74b0395` |
| [017](017-poll-miniapp-logs-from-empty.md) | A12 | 微信任务日志从空列表开始追踪 | P2 | S | 无 | TODO |
| [018](018-verify-experiment-process-group-exit.md) | A13 | 试验退出时确认所属进程组停止 | P2 | M | 无 | DONE · `2a18993`（Linux 进程组待实测） |
| [019](019-stop-worker-between-artifact-uploads.md) | A14 | 取消或失租后停止后续产物上传 | P2 | S–M | 无 | TODO |
| [020](020-request-initial-viewer-url-over-native-bridge.md) | A15 | 通过原生桥加载 Android 私有场景 | P2 | S–M | 无 | TODO |
| [021](021-show-retry-on-native-viewer-load-error.md) | A16 | Android Viewer 主页面加载失败时显示重试 | P2 | S | 无 | TODO |
| [022](022-verify-legacy-database-adoption.md) | A17 | 按固定基线接管无版本标记的旧数据库 | P2 | M | 无 | TODO |
| [023](023-lock-only-next-lease-candidate.md) | A18 | 领取任务时仅锁一个候选 | P2 | S | 无 | DONE · `0ab1bda` |
| [024](024-bound-worker-gpu-probes.md) | A19 | 为 Worker GPU 探测设置超时 | P2 | S | 无 | TODO |
| [025](025-serialize-desktop-artifact-cache-publication.md) | A20 | 串行化同一桌面场景缓存发布 | P2 | M | 无 | DONE · `6606dfc`（单进程锁，跨进程不保证） |
| [026](026-preserve-expanded-notification-pages.md) | A21 | 在自动刷新时保留已展开的通知分页 | P2 | S–M | 无 | TODO |
| [027](027-project-list-role-projection.md) | A22 | 在项目列表查询中一次取回角色 | P3 | S | 无 | DONE · `cba4a06` |
| [028](028-reject-degenerate-pose-alignment.md) | A23 | 拒绝退化的相机位姿对齐 | P3 | S | 无 | DONE · `47038ab` |
| [029](029-make-narrow-navigation-keyboard-accessible.md) | A24 | 让窄屏工作台抽屉遵循键盘焦点顺序 | P3 | S–M | 无 | TODO |
| [030](030-split-trial-summaries-by-scene.md) | A25 | 按数据集和场景分组试验汇总 | P3 | S–M | 无 | DONE · `0a2fdc6` |
| [031](031-classify-only-current-backend-attempt.md) | A26 | 仅按当前引擎子进程日志分类失败 | P3 | S | 无 | DONE · `ff7a640` |
| [032](032-restore-owned-worker-drain-after-startup-failure.md) | A27 | 试验启动失败后恢复本次设置的 Worker drain | P3 | M | 无 | DONE · `88eeeee`（真实 Worker 停启待验收） |

- 优先启动 006–010。006、007、010 可以独立执行。008、009 共用 API 测试和迁移链，建议先落 008，随后核对 009 的迁移编号、API 锚点与并发验收。若 001 已集成，以该基线的最新 revision 为准。
- 009 的原生项目重放和 012 的素材队列以 005 的账户隔离及队列状态为基础。007 与 001、005 同时涉及原生项目页面，集成时保留双方行为。
- 018 与 032 共用实验监督脚本，建议先验证进程组退出，再验证 Worker drain 的恢复。020 与 021 都修改 Android Viewer，建议同一次设备回归覆盖首载、续签与错误恢复。
- 015 与上一轮发现 #9 分别处理任务状态和事件流授权。014 与 026 分别处理服务端通知范围和客户端分页。验收采用同一集成基线核对对应行为。
