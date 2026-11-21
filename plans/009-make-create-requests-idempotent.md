# 计划 009 · 为项目与重建创建增加幂等重试

> 本计划从 `21b2052` 的 ReScene 源码编写。开始前执行 `git diff --stat 21b2052..HEAD -- src/rescene_api/main.py src/rescene_api/models.py src/rescene_api/schemas.py src/rescene_api/migrations/versions/ tests/test_api.py tests/test_api_postgres.py tests/test_api_contract.py packages/schemas/src/index.ts packages/api-client/src/index.ts packages/api-client/src/index.test.ts packages/workbench/src/Workbench.tsx packages/workbench/src/Workbench.test.tsx packages/uploader/src/queue.ts packages/uploader/src/queue.test.ts apps/mobile/src/queue.ts apps/mobile/src/screens/Project.tsx apps/mobile/src/screens/Projects.tsx apps/miniapp/src/queue.ts apps/miniapp/src/pages/index/index.tsx apps/miniapp/src/pages/project/index.tsx scripts/check-miniapp-login.mjs`。若有差异，逐项核对下面的代码锚点和已集成的改动，再决定是否更新计划。使用独立工作树，运行过程中记录实际命令与覆盖证据。

## 状态

- **优先级** P1
- **工作量** L
- **修复风险** 中，服务端事务与四端重试语义需配合
- **类别** 正确性／契约
- **基线** `21b2052`，2026-11-21，审计发现 A04
- **依赖** [005](005-make-native-replay-concurrency-safe.md) 已在独立分支 `cced25e` 交付。原生项目重放或素材队列验收须在保留其账户隔离与队列事务语义的集成头执行。

## 影响

数据库写入后，客户端可能没有收到回执。重复提交会留两条项目记录，或者安排两次重建并占用 GPU。需要区分同一操作的重试与用户明确发起的新操作。

## 当前实现

- `src/rescene_api/main.py:460,1029` 中，`create_project 和 create_job 每次 db.add 并提交`。
- `src/rescene_api/main.py:266` 中，`CORS 已声明 Idempotency-Key`。
- `packages/api-client/src/index.ts:334,485` 中，`createProject(name) 与 createJob(projectId, profile, assetIds)`。
- `plans/005-make-native-replay-concurrency-safe.md` 中，`首次发送的请求已提交但客户端未收到回执，需要服务端协议`。

沿用现有 `fail(status, message, code)` 与共享 client 请求头。仅在授权通过后读取幂等记录。客户端同一操作复用标识，不从项目名或素材列表派生全局标识。005 的账户绑定和事务队列要保留。

## 范围

允许修改以下文件或指定路径。

- `src/rescene_api/{main,models,schemas}.py`
- `src/rescene_api/migrations/versions/ 新增一个 revision`
- `tests/{test_api,test_api_postgres,test_api_contract}.py`
- `packages/schemas/src/index.ts`
- `packages/api-client/src/{index.ts,index.test.ts}`
- `packages/workbench/src/{Workbench.tsx,Workbench.test.tsx}`
- `packages/uploader/src/{queue.ts,queue.test.ts}`
- `apps/mobile/src/{queue.ts,screens/Project.tsx,screens/Projects.tsx}`
- `apps/miniapp/src/{queue.ts,pages/index/index.tsx,pages/project/index.tsx}`
- `scripts/check-miniapp-login.mjs`

相关后续工作可单独处理，包括上传分片、删除或其他动作的幂等化。历史重复数据去重。生产部署与重建任务执行。上一轮 001、003 和计划 008 的迁移应明确排列。

## 验证命令

Python 3.11 使用 `uv pip install -c infra/api/constraints.txt -e ".[dev,api,worker]" scipy` 安装至激活的隔离虚拟环境。Node 22 使用 `pnpm install --frozen-lockfile` 安装项目依赖。PostgreSQL 使用隔离服务并设置 `RESCENE_TEST_POSTGRES_URL`。构建顺序为 API 与迁移、共享 schema、API client、Web／桌面、Android、微信。在 PowerShell 用同名 `$env:` 变量设置表中的三个示例值后执行构建。示例 AppID 只用于编译测试。断言依赖隔离夹具与合成数据，构建、真机和发布结果按各自来源记录。

| 命令 | 预期 |
|---|---|
| `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_api_contract.py` | 现有及新增场景全部通过 |
| `python -m ruff check src tests scripts` | 退出 0 |
| `python -m ruff format --check src tests scripts` | 退出 0 |
| `python -m mypy --follow-imports=skip src/rescene_api/schemas.py` | 退出 0 |
| `pnpm -r typecheck` | 所有受影响 workspace 通过 |
| `pnpm --filter rescene-web build` | Web 构建成功 |
| `pnpm --filter @rescene/desktop build` | 桌面前端构建成功 |
| `pnpm --filter @rescene/mobile export` | Android bundle 导出成功 |
| `TARO_APP_API_URL=https://api.example.com TARO_APP_WEB_URL=https://app.example.com TARO_APP_WECHAT_APP_ID=wx0123456789abcdef pnpm --filter @rescene/miniapp build:weapp` | Taro 微信生产模式编译成功 |
| `node scripts/check-miniapp-login.mjs` | 本地编译产物回归通过 |
| `pnpm -r test` | 共享包和客户端回归通过 |

## 实施步骤

### 1. 先完成服务端任务创建

接受可选有界 `Idempotency-Key`，按账户、操作及必要的项目上下文建立唯一记录，比较经过契约归一化的请求。用同一事务保存唯一记录、业务对象和原成功响应或其不可变表示。并发应等待已提交结果，滚回的同标识仍可重试。变更请求返回结构化 409。

验证 `python -m pytest -q tests/test_api.py tests/test_api_postgres.py tests/test_api_contract.py`。服务端按新测试验证同一操作的重试及竞争。

### 2. 扩展到项目与共享 client

以同一机制覆盖项目接口，保持无请求头的原有行为。`ResceneClient` 用可选参数显式传标识，公开共享 schema 只在需要描述稳定错误或响应时变更。

按验证表编译微信小程序，再执行 `node scripts/check-miniapp-login.mjs`。共享 client 测试核对可选请求头及旧调用。

### 3. 让四端稳定传递标识

同一次操作在首发前获得标识，临时失败重试复用。更改输入、明确发起新操作或成功后新开生成新标识。原生离线草稿在首次在线尝试之前创建并持久化标识，在线失败转离线仍使用同一标识。兼容无该字段的旧队列，首次重放前补齐。

按验证表编译微信小程序，再执行 `node scripts/check-miniapp-login.mjs`。端到端夹具只使用一轮合成请求和新建的数据。

## 回归场景

真实 PostgreSQL 并发同标识仅创建一次。在客户端夹具丢弃首个合法响应并确认重试同一 ID。不同 payload 冲突。无请求头仍兼容。账户和项目隔离。新操作可提交相同内容。Android／微信重启重放覆盖旧队列和账户切换。

## 完成标准

- [ ] 表中验证命令均成功，新增断言覆盖本计划涉及的故障和正常路径。
- [ ] 应用行为按回归场景核对。涉及设备、真实 PostgreSQL 或操作系统的项分别记录环境、基线提交、观测结果及跳过原因。
- [ ] `git diff --check` 通过，`git status --short` 与计划范围一致。使用 `codex/make-create-requests-idempotent` 分支，提交采用 Conventional Commits，在独立工作树中留存结果。交由执行者时据实更新 [索引](README.md) 状态。

## 停止条件

005 未合入时可独立交付 API 和客户端对任务请求的能力，但原生项目重放验收必须在包含账户隔离的集成头完成。若需要删除可重放的幂等记录，先确定重放窗口和客户端边界，避免不受控地过期。已有实现继续保留，先向维护者说明漂移或证据缺口。

## 维护

幂等策略需定义保存期限，先保留记录直至产品确认重放窗口。重试返回绑定原始操作，禁止用后来变更的状态替代原回执约定。
