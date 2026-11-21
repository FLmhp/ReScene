# 计划 025 · 串行化同一桌面场景缓存发布

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P2
- **工作量** M
- **修复风险** 中，需校验 Windows 文件占用与错误路径
- **类别** 桌面／正确性
- **基线** `21b2052`，2026-11-21，审计发现 A20
- **依赖** 无。基线变化后按本计划的漂移检查重新确认。

## 影响

两个原生缓存请求可并行下载同一场景。后一个请求可能在前一个完成校验后删除文件，使已返回的本地 URL 暂时失效或触发重复下载。

## 当前实现

- `apps/desktop/src-tauri/src/lib.rs:127` 中，`计算同一 target 后检查 verified`。
- `apps/desktop/src-tauri/src/lib.rs:159` 中，`重检、metadata、remove_file 和 rename 分别调用`。
- `apps/desktop/src/App.tsx:62` 中，`invoke cache_artifact，组件卸载只隔离其响应`。

沿用 `cache_path` 的身份规范、HTTPS、`verified` 哈希与大小检查、临时文件命名和原子重命名。优先同步同一个缓存身份，避免不同大场景互相卡住。

## 范围

允许修改以下文件或指定路径。

- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/Cargo.toml`（仅现有 Tokio 需要的特性）

相关后续工作可单独处理，包括缓存清理 UI、新增第三方依赖、退出时删除用户文件、改变场景下载或签名格式。

## 验证命令

Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。Rust stable 和 Windows WebView2 运行环境，前端构建使用 Node 22 与 pnpm 10.18.3。原生 CI 检查沿用 CONTRIBUTING.md 的 fmt 与 clippy 命令。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` | 现有及新增场景全部通过 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |

运行 `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` 和 `cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`。在 Windows 本地用同一合成资源快速打开和重试。

## 实施步骤

### 1. 复用同键并发的首个下载

在第一个命中判断前获取按缓存身份隔离的锁，在下载和发布后释放，等待者先重新检查已完成文件。确保失败释放锁、没有永久增长的锁表。

验证 `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`。聚焦用例覆盖该步骤的行为，现有接口回归通过。

### 2. 给本地发布过程补确定性并发测试

复用 Tauri 的 async runtime 在同一测试进程运行临时文件夹和可控下载替身触发两次同键请求，确认只启动一次有效下载，两个成功返回均指向完整文件。先返回失败时，另一个请求仍能正常重试。

验证 `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`。新增用例能观察到本项行为，既有用例通过。

## 回归场景

并发同键、不同键并行、已完成文件占用、目标损坏、网络失败、临时文件清理、已缓存历史文件。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/serialize-desktop-artifact-cache-publication` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

若多个 Tauri 进程可以操作同一缓存位置，先明确测试出来的共享范围。单进程锁验收不能声称覆盖跨进程发布。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

缓存发布及未来清理都须使用同一身份保护。生产输出记录 Windows 和其他平台的实际验证覆盖。
