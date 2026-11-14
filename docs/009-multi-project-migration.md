# 多项目与旧 GitHub 状态迁移

每个新项目使用由 Provider、host 和规范化项目路径生成的稳定 ProjectSource ID。项目设置保存在 `sources[ID]`，包含 `kind`、`enabled` 和项目配置。管理 API 的 `POST projects` 接受 `{ provider, config, enabled }`，创建时通过宿主 Worker 环境检查账号与项目权限。策略使用对应的项目 ID 单独设置，不能继承其他项目的授权账号。

旧的 `sources.github` 配置和持久化记录可以直接继续运行，无需删除数据库。要统一为新的项目身份，先停止运行时，再在产品源码目录执行：

```bash
node --experimental-transform-types scripts/migrate-github.ts --state-dir /绝对路径/状态目录
```

默认命令获取与 Runtime 相同的状态目录锁，然后对 SQLite 一致性副本预览，不写原数据库。运行时仍在运行、目标项目已存在或身份冲突时，迁移会拒绝执行。确认预览结果后执行：

```bash
node --experimental-transform-types scripts/migrate-github.ts --state-dir /绝对路径/状态目录 --apply
```

应用前会在状态目录的 `backups` 下保存权限为 `0600` 的数据库备份。迁移在同一个事务内更新 Source 设置、历史设置、策略、Thread、Trigger、Ticket、Decision、Outbox 关联与 GitHub 游标；失败时回滚，再次执行已完成的迁移不会重复写入。原有 Outbox 消息 ID 保留，避免重发平台评论。迁移完成后重新启动 Runtime。

需要回滚时，保持 Runtime 停止，将备份恢复为 `orchestrator.sqlite`，并同时清理仅属于当前数据库的 `orchestrator.sqlite-wal` 与 `orchestrator.sqlite-shm`，再启动旧配置。不要在运行中的数据库上覆盖文件。

每个项目使用独立 Git 配置与 CLI 选择。GitLab 的 `GLAB_CONFIG_DIR`、代理和 CA 由宿主提供，项目不会保存 Token。宿主负责 VPN 路由；运行时、Worker、`glab` 必须处于能访问内网 GitLab 的网络命名空间。禁止以关闭 TLS 校验解决 CA 配置问题。
