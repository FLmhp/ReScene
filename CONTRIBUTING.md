# ReScene 开发与发布指南

本文面向在本仓库修改代码、验证或发布构建的开发者。用户操作见 [用户手册](docs/用户手册.md)，生产部署与回滚见 [单 5090 系统部署与运维](docs/单5090系统部署与运维.md)。

## 1. 环境

| 组件 | 版本/要求 |
|---|---|
| Python | 3.11 |
| Node.js | 22 |
| pnpm | 10.18.3（`packageManager` 锁定） |
| Rust | stable，含 `rustfmt`、`clippy` |
| Windows 桌面 | Visual Studio Build Tools（C++ 桌面开发）、Windows SDK、NSIS |
| Android | JDK 21、Android SDK platform 36 / build-tools 36、NDK 27、CMake |
| GPU 引擎 | CUDA 12.x，RTX 5090/A100；普通开发机可不装 GPU 依赖 |

安装 Python 依赖：

```powershell
py -3.11 -m venv .venv
uv pip install --python .venv\Scripts\python.exe -e ".[dev,api,worker]"
```

安装 Node 依赖：

```powershell
pnpm install --frozen-lockfile
```

## 2. 目录与所有权

| 路径 | 作用 |
|---|---|
| `src/rescene/` | 引擎：预处理、VGGT/COLMAP 几何、3DGS、评估、导出 |
| `src/rescene_api/` | FastAPI：认证、项目、上传、任务、Worker、分享 |
| `src/rescene_worker/` | GPU Worker：租约、心跳、阶段、checkpoint、产物 |
| `packages/schemas` | Zod 契约；API 响应字段以它为准 |
| `packages/api-client` | 类型化 API/SSE 客户端 |
| `packages/uploader` | STS multipart、PostObject、进度和校验 |
| `packages/viewer` | three.js + Spark 查看器 |
| `packages/workbench` | Web/桌面共享工作台 |
| `packages/design-tokens` | 颜色、间距、字号 |
| `apps/web` | Next.js 工作台、Viewer、分享页 |
| `apps/desktop` | Tauri 2 桌面壳与 Rust 缓存命令 |
| `apps/mobile` | Expo/React Native Android 客户端 |
| `apps/miniapp` | Taro 微信小程序 |
| `configs/` | 数据集、候选、路线和标定配置 |
| `scripts/` | 运维、标定、发布、源清单脚本 |

共享契约只能在 `packages/schemas` 和 `packages/api-client` 修改；不要在各端复制响应形状。

## 3. 本地修改流程

1. 先读对应模块和测试；导出符号变更前先查全部引用。
2. 只改与任务相关的文件，复用现有模式；不要顺手重构。
3. 改后端响应时同步 `packages/schemas`、客户端和消费端。
4. 新增公开 API 时补类型和权限测试；不要用前端隐藏按钮代替服务端授权。
5. 不提交 `.env`、`infra/secrets/`、`worker.env`、keystore、签名密码、模型权重、运行数据或缓存。

## 4. 质量门禁

提交前运行与改动范围匹配的检查：

```powershell
.venv\Scripts\python.exe -m ruff format --check src tests scripts
.venv\Scripts\python.exe -m ruff check src tests scripts
.venv\Scripts\python.exe -m mypy --follow-imports=skip src/rescene_api/schemas.py
.venv\Scripts\python.exe -m pytest -q

pnpm check:versions
pnpm -r typecheck
pnpm -r test
pnpm --filter rescene-web build
pnpm --filter @rescene/desktop build
pnpm --filter @rescene/mobile export
pnpm --filter @rescene/miniapp build:weapp
```

Windows 桌面壳：

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

完整本地质量命令：

```powershell
pnpm quality
```

CI 的 `python` 任务还使用 PostgreSQL 16 服务；`workspace` 任务覆盖四端类型检查和构建；`desktop-shell` 在 Windows 上跑 Rust 检查和桌面前端构建；`commit-messages` 用 `scripts/check-commits.mjs` 校验提交信息。GPU 实验不在普通 CI runner 执行，不能把 CI 绿当作算法证据。

`main` 分支保护：仓库当前是私有免费套餐，GitHub 对该组合直接拒绝分支保护（`PUT /branches/main/protection` 返回 403 “Upgrade to GitHub Pro”），因此四个检查是人工门禁。升级到 Pro/Team 或转为公开仓库后，用下面的请求开启：

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["python","workspace","desktop-shell","commit-messages"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
```

## 5. 版本与源身份

- `VERSION` 是唯一版本事实源。
- Python 包、API、Node 包、Tauri、Android 版本必须与 `VERSION` 一致，由 `node scripts/check-versions.mjs` 校验。
- 改版本只走一个入口，它会同步所有元数据、把 Android `versionCode` 加一并立刻复验：

```powershell
node scripts/bump-version.mjs 0.3.0
```

- 版本变更同步 `CHANGELOG.md`：`scripts/release-notes.mjs` 只截取 `## <VERSION>` 段作为 GitHub Release 说明，缺段直接失败。
- 提交信息遵循 Conventional Commits：`<type>(<scope>)?: <subject>`，类型限 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`；`Merge ` 开头的合并提交豁免。本地钩子与 CI 使用同一正则：

```powershell
git config core.hooksPath .githooks
node scripts/check-commits.mjs --range HEAD~1..HEAD
```

- 发布源清单：

```powershell
node scripts/source-manifest.mjs > source-manifest.json
```

清单只包含项目自有源码、配置、文档和指定根文件，排除缓存、构建产物、秘密和模型。仓库没有 Git 历史时，源清单哈希就是可核验的源身份，不要伪造 commit。

## 6. 构建与发布

### Web/API 镜像

```bash
docker compose --env-file infra/.env -f infra/compose.yaml build api web
docker compose --env-file infra/.env -f infra/compose.yaml up -d db api web
```

生产发布只做定向构建、定向启动和健康检查；禁止整机重启、批量重启其他容器或 `docker system prune`。回滚和备份步骤见部署文档。

### Windows

```powershell
.\scripts\build-windows-release.ps1
```

脚本默认注入 `https://api.rescene.xyz` 与 `https://app.rescene.xyz`；非生产构建用 `RELEASE_API_URL` / `RELEASE_WEB_URL` 覆盖。产物：`apps/desktop/src-tauri/target/*/release/bundle/nsis/*.exe`。无商业代码签名证书时安装包为 unsigned，必须明确 SmartScreen 风险，不得声称可信签名。

### Linux / macOS

Linux 与 macOS 安装包由同一脚本在目标系统上构建：

```bash
./scripts/build-desktop-release.sh
```

- Linux：`--target x86_64-unknown-linux-gnu --bundles deb,appimage`，产物在 `apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/{deb,appimage}/`。
- macOS：`--target universal-apple-darwin --bundles dmg`，产物在 `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。
- 其他系统脚本会提示改用 `scripts/build-windows-release.ps1` 并以 1 退出。

Linux 构建需要 `libwebkit2gtk-4.1-dev`、`libappindicator3-dev`、`librsvg2-dev`、`patchelf`、`libxdo-dev`、`libssl-dev` 与 `build-essential`；macOS 需要 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`。

仓库没有 Apple 与商业 Windows 证书：Linux deb/AppImage 与 macOS dmg 均为 unsigned，macOS 首次打开需右键「打开」或 `xattr -d com.apple.quarantine`，不得声称产物已签名。

### Android

签名材料通过 `~/.rescene/android-signing.env` 或 CI secrets 提供，不进入仓库：

```text
RESCENE_ANDROID_KEYSTORE_PATH
RESCENE_ANDROID_KEYSTORE_PASSWORD
RESCENE_ANDROID_KEY_ALIAS
RESCENE_ANDROID_KEY_PASSWORD
```

构建：

```powershell
$env:EXPO_PUBLIC_API_URL = "https://api.rescene.xyz"
$env:EXPO_PUBLIC_WEB_URL = "https://app.rescene.xyz"
.\scripts\build-android-release.ps1
```

脚本执行已生成的 Android release 构建，产物在 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。安装后用 `apksigner verify --print-certs` 校验签名。

Android 原生工程由 prebuild 生成。不要执行 `expo prebuild --clean` 删除已有原生改动；签名配置由 `apps/mobile/withAndroidReleaseSigning.js` 注入。

### 小程序

```powershell
pnpm --filter @rescene/miniapp build:weapp
```

`dist` 用微信开发者工具导入。`project.config.json` 的 `touristappid` 只用于本地构建；正式发布需要真实 AppID、Secret、业务域名和审核，不能把构建成功当作发布完成。

## 7. 发布产物与校验

发布目录包含：

- Windows NSIS EXE；
- Linux `deb` 与 `AppImage`；
- macOS universal `dmg`；
- release 签名 Android APK（仅在 `vars.RELEASE_ANDROID_SIGNING=true` 时构建）；
- `source-manifest.json`；
- `release-manifest.json`；
- `SHA256SUMS`；
- 版本、大小、源清单哈希和已知限制。

生成发布清单：

```powershell
node scripts/source-manifest.mjs > release/source-manifest.json
node scripts/release-manifest.mjs --source-manifest release/source-manifest.json `
  release/ReScene_0.2.1_x64-setup.exe `
  release/ReScene-0.2.1.apk > release/release-manifest.json
```

校验下载产物和任务产物：

```powershell
.venv\Scripts\python.exe scripts\verify_release_artifacts.py --api-url https://api.rescene.xyz --token-file <token-file> --project-id <uuid> <job-id>
```

该命令对失败任务、缺失产物、大小/SHA-256 不符或必需指标缺失返回非零退出码。

## 8. 发布检查表

- [ ] `VERSION`、`CHANGELOG.md` 和全部版本元数据一致。
- [ ] Python/Node/Rust 检查和测试通过。
- [ ] Web、桌面、移动端、小程序构建通过。
- [ ] Windows 安装、覆盖更新、启动、Viewer、卸载实测。
- [ ] Linux deb/AppImage 与 macOS dmg 由 tag 触发的 CI 产出，`gh release view` 资产清单齐全。
- [ ] Android release APK 签名校验、安装、登录、上传、任务、Viewer 实测。
- [ ] 公网 `/`、`/viewer`、`/share/<token>`、`/health/ready` 逐路由检查。
- [ ] 分享下载和撤销实测。
- [ ] 安装包、APK、源清单、发布清单和 SHA256SUMS 同版本归档。
- [ ] 微信小程序外部资格缺失时在发布说明中明确标注，不写“已完成”。
