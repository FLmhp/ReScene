# 001 校验项目邀请领取资格

> 基线为 `21b2052`，日期 2026-11-20。先运行 `git diff --stat 21b2052..HEAD -- src/rescene_api tests/test_api.py tests/test_api_contract.py tests/test_api_postgres.py packages/schemas/src packages/api-client/src packages/workbench/src apps/mobile/src/screens apps/miniapp/src/pages apps/site/index.html docs/用户手册.md`。相关差异存在时，按下方锚点复核。若业务契约已改变，带着差异停下来核对。通过全部门禁后更新计划索引。

**优先级 P1 · 安全 · 工作量 L · 修复风险中 · 无前置计划**

## 目标与当前契约

新建成员授权需要项目管理者签发的一次性邀请凭证和受邀账户的登录态。邮箱作为邀请地址和匹配条件。发送沿用项目管理者主动转交的流程，无需引入邮件服务。旧成员关系保留并单独复核，旧待处理邀请由管理者重新签发。

- `src/rescene_api/main.py:283` 的 `register` 在 `db.flush()` 后对 `ProjectInvitation.email == email` 查询结果写入 `ProjectMember`。删除这段领取逻辑，保留注册、审计、登录响应及重复邮箱处理。
- `src/rescene_api/main.py:657` 的 `add_member` 查找 `User.email == email` 并直接授权。现有成员角色由 `update_member`（第 614 行）接收已存在的 `user_id` 更新。邀请撤销（第 715 行）锁项目。
- `src/rescene_api/main.py:1771` 的分享路径用 `secrets.token_urlsafe(32)` 和 `hashlib.sha256(token.encode()).hexdigest()`，只把明文返回给创建者。邀请复用这种凭证生成方式。
- `src/rescene_api/models.py:184`、迁移 `v0005.py:27` 定义 `project_invitations`，每个项目与地址一条待处理邀请。`v0006.py:6` 是当前迁移头。`db.py:32` 启动时由程序集成 Alembic。
- `packages/schemas/src/index.ts:225` 允许 `status: "invited"` 或 `"member"`。共享 API 客户端 `packages/api-client/src/index.ts:379` 和各端据此判断。官网 FAQ 与用户手册目前承诺注册自动加入。

## 范围与 Git

允许修改 `src/rescene_api/{main,models,schemas}.py`、新增 `src/rescene_api/migrations/versions/v0007.py`，以及 API 测试 `tests/test_api.py`、`tests/test_api_contract.py`、`tests/test_api_postgres.py`。前端仅限 `packages/schemas/src/index.ts` 与相应测试、`packages/api-client/src/index.ts` 与相应测试、`packages/workbench/src/Workbench.tsx` 和 `Workbench.test.tsx`、`apps/mobile/src/screens/{Project,Projects}.tsx`、`apps/miniapp/src/pages/{index,project}/index.tsx`、`apps/site/index.html`、`docs/用户手册.md`。样式需要调整时使用现有组件类。保留现有账户、权限角色、注册及分享契约。使用 `codex/verify-project-invitations` 和 Conventional Commits，例如 `fix(api): require explicit project invitation acceptance`。发布与生产数据操作走独立授权。

## 命令与预期

| 用途 | 命令 | 预期 |
|---|---|---|
| API 回归 | `python -m pytest -q tests/test_api.py tests/test_api_contract.py` | 全过 |
| PostgreSQL | 用本地隔离 PostgreSQL 16 设置 `RESCENE_TEST_POSTGRES_URL`，运行 `python -m pytest -q tests/test_api_postgres.py` | 新并发场景通过且计入通过数 |
| Python 门禁 | `python -m ruff format --check src tests scripts`、`python -m ruff check src tests scripts`、`python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |
| JS/TS 门禁 | `pnpm -r typecheck`、`pnpm -r test` | 退出 0 |
| 平台构建 | `pnpm --filter rescene-web build`、`pnpm --filter @rescene/desktop build`、`pnpm --filter @rescene/mobile export`、`pnpm --filter @rescene/miniapp build:weapp`、`pnpm --filter @rescene/site build` | 全过，小程序用 `.github/workflows/check.yml:83` 的测试环境变量 |

开发环境为 Python 3.11、Node 22、pnpm 10.18.3。缺少本地依赖时按 `CONTRIBUTING.md:5` 建立执行环境。先确认分支只包含本计划的变更。

## 步骤

1. **创建邀请并升级数据库。** 新增可空的唯一摘要和有时区的到期时间，保留旧行为空，允许管理者重新签发。管理者使用现有 POST 接口签发或轮换邀请，返回 `{status:"invited",email,role,claim_code,expires_at}`，有效期 7 天。禁改 owner 规则继续适用。对于已有项目成员，返回既有 `member` 结构并保留其角色。角色变更使用现有 PATCH。签发和撤销共用项目行锁，签发响应设置 `Cache-Control: no-store`。列表、审计、通知和日志只包含原有非凭证信息。把全量注册流程中的自动授权移除。验证用 `python -m pytest -q tests/test_api.py -k invitation`，覆盖新库启动和从 0006 升级后的旧记录。
2. **实现领取并验证权限。** 新增 `POST /v1/project-invitations/accept`，通过 `UserDep` 和有限长度的请求体 `{code}` 领取，返回 `{project_id,role}`。用现有 `rate_limit` 限制请求数。先仅凭摘要查项目 ID，再锁定项目行，随后重新读取邀请并检查项目未删除、摘要未轮换、邀请未过期且当前用户邮箱匹配。领取者在授予成员前尚无项目访问权，使用独立的项目行锁路径。写成员、写 `project.member.invite.accept` 审计和消费邀请在同一事务内。失效凭证和不匹配均返回通用错误，避免泄露细节。成员已存在时保留当时的角色。验证用本地 PostgreSQL 夹具，两个事务同时领取只有一次成功，撤销或轮换先提交时没有成员授权。API 权限回归均通过。
3. **同步契约与四端交互。** 共享 schema 给旧 `invited` 结果保留可选字段，新客户端遇到缺失代码的旧服务端响应时显示明确版本提示。共享 client 新增领取方法。Web/桌面使用共享 Workbench，Android 使用项目列表，微信使用首页提供登录后的领取表单。复用现有成员管理按钮、复制或可选择文本及错误状态。签发后只短时显示凭证，切换项目或退出时清除。更新官网 FAQ、手册和各端的邀请文案。验证运行上表全部 JS 构建和测试，旧响应解析与新签发/领取契约测试分别通过。用隔离环境完成签发、转交、登录后领取、刷新列表和撤销。
4. **验证旧版本。** 现有自动领取测试改为签发和显式领取；依赖直接添加的角色夹具用真实领取流程或明确的 fixture 数据建立。客户端旧版本仍可登录和管理已有成员。说明旧客户端签发的邀请需要用新版重新签发以获取凭证。在隔离 0006 数据库演练升级并确认旧记录仍可撤销。验证 `python -m pytest -q` 和 `git diff --check`。由发布负责人检查部署时旧 API 实例不再并行处理注册或成员授权。

## 测试与交付标准

- [ ] 已注册和新注册账户都必须完成领取才获权限。错误账户、逾期、重复领取、撤销、轮换及无摘要的旧邀请均保持无授权。
- [ ] 保留现有成员、历史邀请撤销能力及非管理者的拒绝行为。断言列表及审计数据没有明文和摘要。
- [ ] 参考 `tests/test_api_contract.py:220` 的角色矩阵、`tests/test_api_postgres.py:100` 的并发 fixture、`packages/api-client/src/index.test.ts:394` 的契约测试和 `packages/workbench/src/Workbench.test.tsx:322` 的交互测试。完成命令表和平台验收记录。
- [ ] `git diff --check` 通过，变更文件在范围内，索引状态更新。

## 停止条件与维护

如果目标库跳过 Alembic 基线校验、项目禁用密码账户，或现有运维需要混跑旧 API 写流量，先记录现状并交给维护者决定迁移与发布顺序。将已授予的历史成员按审计事件交给拥有者复核，保留现有权限直到拥有者作出明确决定。以后添加自动发信时沿用相同领取边界，并更新新旧客户端验收。
