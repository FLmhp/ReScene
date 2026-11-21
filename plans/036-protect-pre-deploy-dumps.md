# 036 · 预部署快照权限与保留期

## 现状

- `scripts/deploy_targeted.sh:111-115` 创建 `infra/backups` 并把 `pg_dump` 直接重定向到 `pre-deploy-$VERSION.dump`，没有 `umask`、`chmod` 或 `chgrp`。
- `infra/deploy/backup.sh:5,10-13` 的既定策略是 `umask 077`、`chmod 640`、`chgrp 65532`，并用 `find /backups -name 'rescene-*.dump' -mtime +14` 清理。
- 预部署文件名不匹配 `rescene-*`，因此既不会被 14 天清理，也不在上传/归档 glob 中。
- 文档要求数据库快照 host-only `0600`；如果 `infra/backups` 由脚本 `mkdir -p` 创建，默认 `0755` 会让同主机其他服务可读。

## 变更范围

- `scripts/deploy_targeted.sh` 的快照路径、权限、命名与清理。
- 必要时 `infra/deploy/backup.sh` 抽出可复用函数。
- 部署文档中的回退路径说明。

## 步骤

1. 在写 dump 前设置 `umask 077`；创建后 `chmod 600`（或按备份策略 `640` + 专用组），并在继续停写前断言文件模式。
2. 把文件名改为 `rescene-pre-deploy-<version>-<timestamp>.dump`，使其落入现有 14 天清理规则；同时更新回退脚本/文档中的查找路径。
3. 复用 `infra/deploy/backup.sh` 的目录创建、权限和校验逻辑，避免两份策略漂移。
4. 增加脚本级测试或部署前检查：`stat -c %a` 必须为 `600/640`，`pg_restore -l` 可读。
5. 对历史遗留 `pre-deploy-*.dump` 做一次性清理/迁移说明；不要自动删除未知文件。

## 验证

- 在隔离主机运行 `scripts/deploy_targeted.sh` 的 dry-run/测试路径，检查生成文件模式、所有者、名称。
- 运行 14 天清理模拟（把 mtime 改为 15 天前），确认文件被匹配。
- 从快照执行一次 `pg_restore -l`，确认仍可用于回退。

## 验收

- 预部署快照不再 world-readable。
- 快照受现有保留期约束，不会无限累积。
- 回退文档能找到新文件名，回退演练仍通过。

## 风险与回退

- 修改文件名会改变人工回退路径；必须在同一提交更新文档/脚本。不要自动清理旧文件，先列出再人工确认。
