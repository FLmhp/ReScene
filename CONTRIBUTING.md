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

### 独立官网

`apps/site` 是静态 Vite 页面，不依赖 API、登录态或 GPU。开发使用 `pnpm --filter @rescene/site dev`（127.0.0.1:4320），生产构建为 `pnpm --filter @rescene/site build`，本地预览为 `pnpm --filter @rescene/site preview`（127.0.0.1:4321）。若 Windows 保留了该端口，可临时传入 `--port 14321`，不修改仓库默认端口。版本由根 `VERSION` 在构建时注入；修改后运行官网 typecheck/build，并在浏览器验证桌面、手机、无 JavaScript 导航与 FAQ。

官网只公开品牌素材和清洗后的演示账号截图；不得复制整个 `artifacts`、生产账号、私有分享链接或安装包。公网发布与工作台升级独立，见部署文档第 15 节。

### 其他客户端

品牌图形以 [共享 SVG 母版](packages/design-tokens/assets/rescene-mark.svg) 为准。改图时同步检查 Web 与桌面、Android 启动器、小程序、官网 favicon、分享卡片与文档。

更新 [Word 参考文档](docs/reference/README.md) 时先另存。Windows 上 OfficeCLI 1.0.162 已验证可创建、插图、重开与渲染 DOCX，原件的表格校验结果可用于比对更新前后是否引入新问题。

| 客户端 | 开发命令 | 说明 |
|---|---|---|
| 桌面前端 | `pnpm --filter @rescene/desktop dev` | 只启动 Vite，不启动原生窗口 |
| 桌面应用 | `pnpm --filter @rescene/desktop tauri dev` | 启动 Tauri 原生窗口，需要 Rust 和平台依赖 |
| Android | `pnpm --filter @rescene/mobile start` | 启动 Expo 开发服务；设备或模拟器需另行配置 |
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

[check.yml](.github/workflows/check.yml) 定义五个检查：

| 检查 | 覆盖 |
|---|---|
| `python` | Python 检查和测试，含 PostgreSQL 16 服务 |
| `workspace` | 版本、类型、测试及官网、Web、桌面前端、移动端导出、小程序构建；小程序使用示例配置 |
| `desktop-shell` | Windows 桌面前端构建、Rust fmt 和 clippy |
| `commit-messages` | PR 或 push 范围内的提交标题 |
| `images` | API 和 Web Docker 镜像构建 |

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

[release.yml](.github/workflows/release.yml) 支持手动运行及 `v*` tag 触发；只有 tag 运行会创建 GitHub Release。发布环境需配置 HTTPS 的 `RELEASE_API_URL` 和 `RELEASE_WEB_URL`，桌面 API origin 还须符合 CSP。工作流生成 Windows x64 NSIS、Linux x64 deb/AppImage、macOS universal dmg，以及源清单和发布清单；Android APK 仅在 `RELEASE_ANDROID_SIGNING=true` 且签名材料齐全时生成。工作流没有生成独立的 `SHA256SUMS`，请按发布清单中的哈希核对实际下载文件。最终资产集合以成功的运行和 Release 为准，不把构建计划当成已发布证据。

Windows 签名为可选：证书和密码都未配置时产物未签名，只配置一项会失败；配置两项后工作流签名并验证。macOS 工作流生成未签名 dmg；只对来源及哈希已核实的单个文件按系统提示处理，不要全局关闭安全检查。Android 发布必须配置 keystore 和密码，工作流校验签名及包信息；不要把签名材料提交到仓库。小程序构建成功不等于已通过平台审核或发布。

本地桌面安装包可在对应系统运行 `scripts/build-windows-release.ps1` 或 `scripts/build-desktop-release.sh`，默认指向生产 URL，非生产构建须明确设置 `RELEASE_API_URL` 和 `RELEASE_WEB_URL`。Android 本地构建见 `scripts/build-android-release.ps1`。安装、登录、上传、任务和 Viewer 等实机结果应逐项记录；未验证或未签名的部分须写入发布说明。

发布与部署按以下顺序留存证据：

1. 确认审阅通过的源 commit、版本和不可移动的发布 tag。
2. 检查对应发布工作流结果与实际 Release 资产，不将预期产物视为已交付。
3. 下载产物，按发布清单核对大小和哈希；适用时验证签名并记录签名状态。
4. 按平台记录安装、启动及必要业务流程的实机结果，注明未覆盖项。
5. 部署单独执行并记录实际部署身份，确认数据库迁移兼容、备份及回滚方案。

部署前核对目标环境、备份和迁移兼容性；回滚代码或镜像不自动撤销数据库迁移。按 [部署与运维](docs/单5090系统部署与运维.md) 制定恢复步骤，记录执行人、时间、部署摘要和健康检查证据，避免影响其他服务。生产任务产物可使用 `scripts/verify_release_artifacts.py` 核验；它验证任务产物，不替代安装包签名与部署验证。
