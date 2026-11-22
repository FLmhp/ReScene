# ReScene 开发与发布指南

本文面向贡献者和发布人员。用户操作见 [用户手册](docs/用户手册.md)，生产部署、备份和回滚见 [部署与运维](docs/单5090系统部署与运维.md)。以下命令均在仓库根目录执行。

## 开发环境

普通 API/Web 开发可使用 CPU。CI 使用 Python 3.11、Node.js 22、pnpm 10.18.3；Python 包支持 3.11–3.13。安装 [uv](https://docs.astral.sh/uv/) 后创建虚拟环境并安装依赖：

Windows PowerShell：

```powershell
py -3.11 -m venv .venv
uv pip install --python .venv/Scripts/python.exe -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy
. .venv/Scripts/Activate.ps1
pnpm install --frozen-lockfile
```

Linux/macOS：

```bash
python3.11 -m venv .venv
uv pip install --python .venv/bin/python -c infra/api/constraints.txt -e '.[dev,api,worker]' scipy
source .venv/bin/activate
pnpm install --frozen-lockfile
```

桌面原生检查还需要 Rust stable、rustfmt、clippy 和平台依赖；Android 原生构建需要 JDK 21 和 Android SDK。GPU 重建需要单独配置 CUDA、模型和 Worker，见部署文档。

### 本地 API 和 Web

开发数据库放在已忽略的 `.cache/dev`，不要使用默认根目录 `rescene.db`。Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force .cache/dev | Out-Null
$env:RESCENE_DATABASE_URL = "sqlite:///.cache/dev/rescene.db"
$env:RESCENE_PUBLIC_WEB_URL = "http://localhost:3000"
.venv/Scripts/python.exe -m uvicorn rescene_api.main:app --host 127.0.0.1 --port 8000 --reload
```

Linux/macOS：

```bash
mkdir -p .cache/dev
export RESCENE_DATABASE_URL=sqlite:///.cache/dev/rescene.db
export RESCENE_PUBLIC_WEB_URL=http://localhost:3000
.venv/bin/python -m uvicorn rescene_api.main:app --host 127.0.0.1 --port 8000 --reload
```

在另一个终端执行 `pnpm --filter rescene-web dev`，访问 `http://localhost:3000` 并自行注册账号。开发默认密钥只适合本机回环环境，不能用于公开部署。上传和 STS 依赖 OSS 配置，重建任务依赖 GPU Worker；启动 API 和 Web 不等于验证了完整链路。

### 邮箱验证码联调

登录页的「使用邮箱验证码登录」和「忘记密码」依赖 SMTP 投递。未配置 SMTP 时，开发环境（默认 `RESCENE_ENV=development`）把验证码写入 API 的 `WARNING` 日志，便于本机联调：

```text
SMTP is not configured; login code for you@example.com is 123456 (10-minute TTL, development log only)
```

需要真实投递时，在启动 API 前设置以下变量（示例为 QQ 邮箱的 SMTP 授权码，密码只放本机环境变量，不要写入仓库或提交）：

```bash
RESCENE_SMTP_HOST=smtp.qq.com
RESCENE_SMTP_PORT=465
RESCENE_SMTP_SECURITY=ssl          # starttls / ssl / none
RESCENE_SMTP_USERNAME=you@qq.com
RESCENE_SMTP_FROM=you@qq.com
RESCENE_SMTP_PASSWORD=<SMTP 授权码>
```

`RESCENE_ENV=production` 时未配置 SMTP 只记录错误、不回显验证码；请求验证码接口仍返回 `202`，避免暴露邮箱是否注册。验证码登录、密码重置和限流的自动化用例见 `tests/test_api.py`（`-k "email_code or password_reset"`）。

### 独立官网

`apps/site` 是静态 Vite 页面，不依赖 API、登录态或 GPU。开发使用 `pnpm --filter @rescene/site dev`（127.0.0.1:4320），生产构建为 `pnpm --filter @rescene/site build`，本地预览为 `pnpm --filter @rescene/site preview`（127.0.0.1:4321）。若 Windows 保留了该端口，可临时传入 `--port 14321`，不修改仓库默认端口。版本由根 `VERSION` 在构建时注入；修改后运行官网 typecheck/build，并在浏览器验证桌面、手机、无 JavaScript 导航与 FAQ。

官网只公开品牌素材和清洗后的演示账号截图；不得复制整个 `artifacts`、生产账号、私有分享链接或安装包。公网发布与工作台升级独立，见部署文档第 15 节。

### 其他客户端

品牌图形以 [共享 SVG 母版](packages/design-tokens/assets/rescene-mark.svg) 为准。改图时同步检查 Web 与桌面、Android 启动器、小程序、官网 favicon、分享卡片与文档。

更新 [Word 参考文档](docs/reference/README.md) 时先另存。Windows 上 OfficeCLI 1.0.162 已验证可创建、插图、重开与渲染 DOCX，原件的表格校验结果可用于比对更新前后是否引入新问题。

#### Android 开发环境

`apps/mobile` 在打包时读取 `EXPO_PUBLIC_API_URL` 和 `EXPO_PUBLIC_WEB_URL` 并内联到 bundle。两者未设置时会回退到生产 `https://api.rescene.xyz` 与 `https://app.rescene.xyz`，开发构建也一样；本地调试必须先设置，否则登录、上传和重建任务都会进入生产。

从 `apps/mobile/.env.example` 复制出被 git 忽略的 `apps/mobile/.env.local`，按运行目标填写：

```powershell
Copy-Item apps/mobile/.env.example apps/mobile/.env.local
```

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
```

| 运行目标 | `EXPO_PUBLIC_API_URL` | `EXPO_PUBLIC_WEB_URL` |
|---|---|---|
| Android 模拟器（AVD） | `http://10.0.2.2:8000` | `http://10.0.2.2:3000` |
| 同一局域网的真机 | `http://<主机局域网 IP>:8000` | `http://<主机局域网 IP>:3000` |
| 生产构建 | `https://api.rescene.xyz` | `https://app.rescene.xyz` |

`10.0.2.2` 只是 Android 模拟器指向主机回环地址的别名，真机无法访问；真机要改用主机在局域网中的地址（`ipconfig` / `ip addr` 查看），并确认系统防火墙放行 8000 和 3000。API 需以 `--host 0.0.0.0 --port 8000` 启动，Web 需以 `pnpm --filter rescene-web exec next dev -H 0.0.0.0` 启动。若要在 App 内打开 Viewer，Web 端还需设置 `NEXT_PUBLIC_API_URL` 为同一 API 地址（模拟器 `http://10.0.2.2:8000`，真机 `http://<主机局域网 IP>:8000`），并把页面来源 `http://10.0.2.2:3000` 或 `http://<主机局域网 IP>:3000` 加入 `RESCENE_CORS_ORIGINS`。

配置后运行 `pnpm --filter @rescene/mobile start`。Expo 会读取 `.env.local`；修改环境变量后需清除旧 bundle，例如 `pnpm --filter @rescene/mobile exec expo start --clear`。

启动 API 后先在主机确认就绪（返回 `{"status":"ready"}`），设备端实际目标以账号页显示为准：

```bash
curl -fsS http://127.0.0.1:8000/health/ready
```

启动后 Android 账号页会显示 `服务器地址：<目标 URL>`，登录时 uvicorn 访问日志应出现来自模拟器或真机的请求；若显示生产地址，说明 env 未加载或进程未重启，应先停止调试。模拟器也可用浏览器打开 `http://10.0.2.2:8000/health/ready` 验证。`EXPO_PUBLIC_*` 会被打进客户端包，不能写入任何密钥。

#### 客户端命令

| 客户端 | 开发命令 | 说明 |
|---|---|---|
| 桌面前端 | `pnpm --filter @rescene/desktop dev` | 只启动 Vite，不启动原生窗口 |
| 桌面应用 | `pnpm --filter @rescene/desktop tauri dev` | 启动 Tauri 原生窗口，需要 Rust 和平台依赖 |
| Android | `pnpm --filter @rescene/mobile start` | 启动 Expo 开发服务；先在 `apps/mobile/.env.local` 配置本地 API/Web，见上节 |
| 微信小程序 | `pnpm --filter @rescene/miniapp dev:weapp` | 监听构建，使用微信开发者工具打开产物 |

原生构建依赖和 CI 配置见 [release.yml](.github/workflows/release.yml)、[桌面构建脚本](scripts/build-desktop-release.sh)及 [Android 构建脚本](scripts/build-android-release.ps1)。

## 分支、提交和 PR

1. 从最新目标分支创建工作分支，限定变更范围。检查相关模块、测试和调用方。
2. 修改 API 时先确定服务端权限、请求与响应及数据迁移，再同步 `packages/schemas`、`packages/api-client` 和 Web、桌面、Android、小程序调用方，补充权限、契约和迁移测试。UI 隐藏按钮不能代替服务端鉴权；破坏性变更要说明客户端兼容和部署顺序。
3. 按改动范围运行下述检查，在 PR 中记录实际命令、结果和未验证项；涉及数据迁移时说明备份、恢复与回滚限制。更新相关文档，不提交凭据、`.env`、`infra/secrets/`、keystore、模型权重、运行数据或缓存。
4. 提交信息使用 Conventional Commits：`<type>(<scope>)?: <subject>`，允许 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`；`Merge ` 开头的合并提交豁免。可启用本地钩子并检查提交范围：

```bash
git config core.hooksPath .githooks
node scripts/check-commits.mjs --range HEAD~1..HEAD
```

向目标分支提交 PR，请审阅者检查权限、兼容性、迁移和证据；本地钩子可被绕过，不能代替 CI 和审阅。

## 检查

选择与改动相应的检查；下面的完整质量命令要求当前终端已激活 `.venv`，以便其中的 `python` 指向虚拟环境：

```bash
pnpm quality
```

它依次执行版本一致性检查、Ruff 格式与 lint、API 请求 schema 的 mypy、pytest、所有 workspace 的 typecheck 和 test；不包含原生 Rust 检查、各端构建或镜像构建。也可分别运行：

```bash
pnpm check:versions
python -m ruff format --check src tests scripts
python -m ruff check src tests scripts
python -m mypy --follow-imports=skip src/rescene_api/schemas.py
python -m pytest -q
pnpm -r typecheck
pnpm -r test
```

Python/API 改动至少运行相关测试和 Python 检查；共享契约改动还需覆盖各调用端的类型和测试；桌面壳改动需运行 Rust 检查。按受影响的平台运行构建，配置要求以工作流为准。`pnpm quality` 不启动 CI 的 PostgreSQL 服务，本地 SQLite 结果不能替代 PostgreSQL 测试。

按需执行的命令示例（共享包变更还需检查受影响的消费端）：

| 范围 | 命令 |
|---|---|
| API 客户端 | `pnpm --filter @rescene/api-client typecheck` 和 `pnpm --filter @rescene/api-client test` |
| 共享工作台 | `pnpm --filter @rescene/workbench typecheck` 和 `pnpm --filter @rescene/workbench test` |
| Web | `pnpm --filter rescene-web typecheck` 和 `pnpm --filter rescene-web build` |
| 桌面前端 | `pnpm --filter @rescene/desktop typecheck` 和 `pnpm --filter @rescene/desktop build` |
| Android | `pnpm --filter @rescene/mobile typecheck` 和 `pnpm --filter @rescene/mobile export` |
| 小程序 | `pnpm --filter @rescene/miniapp typecheck`，生产模式构建见下方环境变量 |

小程序生产模式编译需要三个变量。ReScene 当前使用 AppID `wxedb245fb415d436e`：

```bash
TARO_APP_API_URL=https://api.rescene.xyz TARO_APP_WEB_URL=https://app.rescene.xyz TARO_APP_WECHAT_APP_ID=wxedb245fb415d436e pnpm --filter @rescene/miniapp build:weapp
```

PowerShell 可先分别用 `$env:TARO_APP_API_URL`、`$env:TARO_APP_WEB_URL`、`$env:TARO_APP_WECHAT_APP_ID` 设置相同值，再运行 `pnpm --filter @rescene/miniapp build:weapp`。AppID 和域名必须与微信公众平台后台一致；编译成功不代表已经通过平台审核或发布。

[check.yml](.github/workflows/check.yml) 在 `pull_request` 和 push 到 `main` 时运行，跳过纯文档与 Markdown 改动，只保留最新一次运行。仓库已公开，所有检查跑在 GitHub 托管运行器上，标准运行器不计分钟；[desktop.yml](.github/workflows/desktop.yml) 单独检查桌面壳，仅在桌面、共享包或锁文件变化时触发：

| 检查 | 运行位置 | 覆盖 |
|---|---|---|
| `python` | GitHub Ubuntu | Python 检查和测试，含服务容器 PostgreSQL 16 |
| `workspace` | GitHub Ubuntu | 版本、类型、测试及官网、Web、桌面前端、移动端导出、小程序构建 |
| `commit-messages` | GitHub Ubuntu | PR 或 push 范围内的提交标题 |
| `desktop-shell` | GitHub Windows | 桌面前端构建、Rust fmt、clippy 和测试 |
| `images` | GitHub Ubuntu | API 和 Web Docker 镜像构建与冒烟 |

功能分支不再直接触发检查，先推送分支并开 PR 才会运行。公开仓库的标准运行器不计分钟，日常检查和发行标签都不再消耗额度；发行标签仍会构建三平台安装包，其中 macOS 运行器的耗时最长。本地命令与 `pnpm quality` 仍是提交前的快速自证手段，不能替代 CI 的 PostgreSQL 结果。

例如桌面壳检查可运行：

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

这些检查和代码审阅是合并前的人工门禁，不代表 GitHub 已配置分支保护或强制检查；以仓库实际设置为准。CI 不执行 GPU 实验或安装包实机验证，绿色状态不能代替这些证据。

## 版本、源身份与发布

`VERSION` 是版本事实源。选定尚未发布的新版本后，用唯一入口同步元数据并增加 Android `versionCode`，不要再次使用已发布的版本：

```bash
node scripts/bump-version.mjs <新版本号>
```

将 `<新版本号>` 替换为例如 `0.3.1`（确认未发布后），同步更新 `CHANGELOG.md` 中对应的 `## <版本号>` 段；发布说明脚本找不到该段会失败。版本检查为 `pnpm check:versions`。版本变更后重新安装可编辑 Python 包，避免本地包元数据仍为旧版本。

发布前确认源 commit、检查结果、迁移与回滚方案；tag 必须为 `v` 加 `VERSION`，并指向已审阅的发布 commit。已发布 tag 不可移动或复用；修复应提交新 commit、使用新版本和新 tag。源身份、发布产物与部署身份应分别记录：commit/tag 和 `source-manifest.json` 说明源码；`release-manifest.json` 记录源清单及各产物的大小和 SHA-256；部署记录还需记录实际镜像或安装包摘要、配置、数据库迁移状态和环境。源清单仅包含脚本白名单选中的源码树、文件类型及根文件，不包含所有仓库文件，也不是完整源码快照；其哈希不等同于线上运行状态或代码签名。

[release.yml](.github/workflows/release.yml) 一次运行完成构建、部署和发布：`v*` tag 触发，或在 `workflow_dispatch` 中填入 `tag` 重放已发布的 tag（`recreate=true` 时先删除同名 Release 再发布）。发布环境需配置 HTTPS 的 `RELEASE_API_URL` 和 `RELEASE_WEB_URL`，桌面 API origin 还须符合 CSP。工作流生成 Windows x64 NSIS、Linux x64 deb/AppImage、macOS universal dmg，以及源清单和发布清单；Android APK 仅在 `RELEASE_ANDROID_SIGNING=true` 且签名材料齐全时生成。

`RELEASE_DEPLOY=true` 时，`deploy` job 在生产主机上重建并切换 `api`、`web` 镜像：先在 `/opt/rescene/infra/backups/` 留下 `pg_dump` 快照，再逐个服务等待健康，最后探测公网入口并把结果写入 `deploy-log.json`。它需要 secrets `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS` 和 variables `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_PORT`。部署失败不自动回滚（数据库迁移不随镜像回退），`github-release` 会因此不发布；只想发安装包时把 `RELEASE_DEPLOY` 改为 `false` 重跑，`release-log.json` 会把部署记为未执行而不是成功。

Release 创建时即对外发布，不再经过草稿；附加资产除安装包外还有 `source-manifest.json`、`release-manifest.json` 和 `release-log.json`（产物哈希、镜像摘要、迁移版本、备份路径与探针结果，以及本次运行的 URL）。GitHub 只在该次运行结束后才提供日志，所以发布时无法把自身日志打包成资产；日志通过运行 URL 查看，`deploy-log.json` 另存为本次运行的 artifacts。工作流没有生成独立的 `SHA256SUMS`，请按发布清单中的哈希核对实际下载文件。最终资产集合以成功的运行和 Release 为准，不把构建计划当成已发布证据。

Windows 签名为可选：证书和密码都未配置时产物未签名，只配置一项会失败；配置两项后工作流签名并验证。macOS 工作流生成未签名 dmg；只对来源及哈希已核实的单个文件按系统提示处理，不要全局关闭安全检查。Android 发布必须配置 keystore 和密码，工作流校验签名及包信息；不要把签名材料提交到仓库。小程序构建成功不等于已通过平台审核或发布。

本地桌面安装包可在对应系统运行 `scripts/build-windows-release.ps1` 或 `scripts/build-desktop-release.sh`，默认指向生产 URL，非生产构建须明确设置 `RELEASE_API_URL` 和 `RELEASE_WEB_URL`。Android 本地构建见 `scripts/build-android-release.ps1`。安装、登录、上传、任务和 Viewer 等实机结果应逐项记录；未验证或未签名的部分须写入发布说明。

发布与部署按以下顺序留存证据：

1. 确认审阅通过的源 commit、版本和不可移动的发布 tag。
2. 检查对应发布工作流结果与实际 Release 资产，不将预期产物视为已交付。
3. 下载产物，按发布清单核对大小和哈希；适用时验证签名并记录签名状态。
4. 按平台记录安装、启动及必要业务流程的实机结果，注明未覆盖项。
5. 部署由 `release.yml` 的 `deploy` job 执行并写入 `deploy-log.json`，按其中的镜像摘要、备份路径、迁移版本和探针结果核对；手工部署时单独记录实际部署身份，确认数据库迁移兼容、备份及回滚方案。

部署前核对目标环境、备份和迁移兼容性；回滚代码或镜像不自动撤销数据库迁移。按 [部署与运维](docs/单5090系统部署与运维.md) 制定恢复步骤，记录执行人、时间、部署摘要和健康检查证据，避免影响其他服务。生产任务产物可使用 `scripts/verify_release_artifacts.py` 核验；它验证任务产物，不替代安装包签名与部署验证。
