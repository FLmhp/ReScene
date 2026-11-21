# 042 · 桌面分享二维码 CSP

## 现状

- `apps/desktop/src-tauri/tauri.conf.json:24` 的 `img-src` 只允许 `'self' data: asset: http://asset.localhost` 和 OSS bucket，没有 `https://api.rescene.xyz`；`:25` 的 `devCsp` 同样没有。
- `packages/api-client/src/index.ts:554-555` 的 `shareQrUrl` 返回 `${baseUrl}/v1/public/shares/{token}/qr.png`；桌面 release 的 `baseUrl` 是 `https://api.rescene.xyz`。
- `packages/workbench/src/Workbench.tsx:1061` 用普通 `<img src>` 渲染该 URL。
- 结果是桌面版“管理分享”二维码被 CSP 拦截，只显示 alt 文本；Web/Android/小程序不受影响。

## 变更范围

- `apps/desktop/src-tauri/tauri.conf.json` 的 `csp` 与 `devCsp`。
- 可选：`packages/api-client` 提供 QR 的 CDN/OSS 地址，避免把 API 主机加入 `img-src`。
- 构建/配置测试或桌面验收记录。

## 步骤

1. 在 `img-src` 中加入 `https://api.rescene.xyz`，或在 API 侧把 `qr.png` 重定向/代理到已允许的 OSS/CDN 主机。
2. 同步 `devCsp`：本地 API `http://localhost:8000` 也应允许，便于桌面开发。
3. 增加一个构建期断言：`shareQrUrl` 的主机必须在桌面 `img-src` 中；或在桌面验收脚本中断言二维码图片 `naturalWidth > 0`。
4. 用桌面 release 构建打开“管理分享”，确认二维码渲染并可扫码；检查 DevTools/tauri 日志没有 CSP violation。

## 验证

- `cargo build`/现有桌面构建通过。
- 在 Windows 桌面 release 中创建分享，二维码显示；用手机扫码打开分享页。
- 改成非法主机时构建断言失败（如果实现断言）。

## 验收

- 桌面分享二维码与 Web 行为一致。
- CSP 仍保持最小权限，没有放开任意 `https:` 图片源。

## 风险与回退

- 直接把 `https:` 加入 `img-src` 会扩大攻击面；只加精确 API/OSS 主机。回退只移除主机条目，不影响其他功能。
