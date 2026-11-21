# 048 · Android 开发环境目标与发布说明

## 现状

- `apps/mobile/src/api.ts:13-14`：`apiBaseUrl`/`webBaseUrl` 在未设置 `EXPO_PUBLIC_API_URL`/`EXPO_PUBLIC_WEB_URL` 时无条件回退到 `https://api.rescene.xyz` / 生产 Web，开发构建也一样。
- `CONTRIBUTING.md:67` 只写 `pnpm --filter @rescene/mobile start`；“设备或模拟器需另行配置”没有给出变量名或模拟器/真机地址。
- `README.md:146` 明确要求日常测试不要把本地客户端连到生产。
- `apps/desktop/src/App.tsx:14`、`apps/web/app/env.ts:3-4` 在开发时默认 loopback，Android 与它们不一致。
- `docs/0.4.0发布说明.md:13` 让用户用 `SHA256SUMS.txt` 校验，但 `scripts/release-manifest.mjs:12` 只生成 `release-manifest.json`；`docs/项目说明.md:91-105,138` 缺 0007–0009 表、邀请领取和成员 PATCH。

## 变更范围

- `CONTRIBUTING.md`、`README.md`、`docs/0.4.0发布说明.md`、`docs/项目说明.md`。
- 新增 `apps/mobile/.env.example`（不提交真实值）。
- 可选：`apps/mobile/src/api.ts` 在 `__DEV__` 下默认 loopback 或显示环境 banner。

## 步骤

1. 在客户端表格中列出 `EXPO_PUBLIC_API_URL`、`EXPO_PUBLIC_WEB_URL`；写明模拟器用 `10.0.2.2`、真机用局域网地址、端口 `8000`/`3000`，并说明未设置会连生产。
2. 添加 `apps/mobile/.env.example` 和 `.gitignore` 检查；如采用开发默认 loopback，补 `__DEV__` 判断和单测/启动脚本。
3. 把 0.4.0 发布说明改为下载 `release-manifest.json` 并按其中 SHA-256 校验；不要要求不存在文件。
4. 同步 `docs/项目说明.md`：补 `idempotency_records`、`asset_cleanups`、邀请 `claim_digest/expires_at`，补邀请领取、成员 PATCH、素材 DELETE/preview 端点，增加“幂等与延迟清理”段落。
5. 在 onboarding 文档中加入一个“确认当前 API”命令（启动日志/账号页显示目标 host）。

## 验证

- 按文档从干净环境启动 Android；确认请求打到本地 API（服务端日志/代理），不是生产。
- 检查 `.env.example` 不含真实凭据。
- 用 `release-manifest.json` 对下载包做一次 SHA-256 校验。
- 文档中的端点/表名与 `models.py`/`main.py` 逐项对照。

## 验收

- 新开发者不会在不知情时连接生产。
- 当前发布说明可执行。
- 数据模型/API 总览覆盖最新迁移。

## 风险与回退

- 只改文档风险低；若改开发默认值，必须处理模拟器/真机地址差异，并保留显式环境变量优先。不要在生产构建中回退到 loopback。
