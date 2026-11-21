# 035 · 工作台与 API 安全响应头

## 现状

- `infra/caddy/rescene.caddy:1-13`：`app.rescene.xyz` 和 `api.rescene.xyz` 只有 `reverse_proxy`，没有 `X-Frame-Options`、CSP、`X-Content-Type-Options` 或 HSTS。
- `rescene.xyz` 的静态站点在 `:18-24` 已有完整 header 块，但没有复用到工作台/API。
- `apps/web/next.config.ts` 没有 `headers()`，仓库没有 `middleware.ts`；`apps/web/app/page.tsx:13-15`、`viewer/page.tsx:42` 把 bearer JWT 放在 `localStorage`。
- API 端点没有 Origin/Referer 校验，已登录工作台可被第三方 iframe 覆盖并诱导删除项目、撤销分享或创建任务。

## 变更范围

- `infra/caddy/rescene.caddy` 的 `app.rescene.xyz`/`api.rescene.xyz` 块。
- 必要时 `apps/web/next.config.ts` 的 `headers()`。
- 部署校验脚本/文档。

## 步骤

1. 为 `app.rescene.xyz` 添加：
   - `X-Frame-Options DENY`、`Content-Security-Policy: frame-ancestors 'none'`；
   - `X-Content-Type-Options nosniff`；
   - `Referrer-Policy strict-origin-when-cross-origin`；
   - HSTS（确认所有子域 HTTPS 后）；
   - `default-src 'self'`、`connect-src 'self' https://api.rescene.xyz`、`img-src 'self' data: https://api.rescene.xyz https://rescene-prod-741277.oss-cn-beijing.aliyuncs.com`、`media-src` 允许 OSS、`worker-src 'self' blob:`。
   - Next.js 会注入内联 bootstrap 脚本；先用 nonce/hash，或在第一阶段保留 `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'` 并记录为后续收紧项。不要直接照搬静态站点不含内联脚本的 CSP。
2. 为 `api.rescene.xyz` 至少添加 `nosniff`、`X-Frame-Options DENY`、HSTS；API 不返回 HTML，CSP 可保持最小。
3. 用 `curl -I` 和真实浏览器验证工作台、Viewer、分享页、OSS 签名下载/缩略图没有被 CSP 拦截。
4. 在部署脚本中加一条 header 断言，避免只改仓库未上线。

## 验证

- `curl -I https://app.rescene.xyz`、`/viewer`、`/share/...`、`/api.rescene.xyz/health/live` 返回预期 header。
- Edge/Chrome 打开工作台，上传一张缩略图、打开 Viewer、创建分享并加载 QR；DevTools Console 无 CSP violation。
- 部署后回退只需移除 header 块，不影响数据。

## 验收

- 工作台不能被第三方 iframe 嵌入。
- 浏览器在已登录 origin 上有脚本注入兜底策略。
- 合法 API、OSS 图片/视频、分享二维码仍可加载。

## 风险与回退

- CSP 最容易误伤 OSS 媒体；先在 staging/隔离域名用 `Content-Security-Policy-Report-Only` 观察，再切换强制。不要直接把静态站点 `default-src 'none'` 复制到工作台。
