# 多项目与旧 GitHub 状态迁移

每个新项目使用由 Provider、host 和规范化项目路径生成的稳定 ProjectSource ID。项目设置保存在 `sources[ID]`，包含 `kind`、`enabled` 和项目配置。管理 API 的 `POST projects` 接受 `{ provider, config, enabled }`，创建时通过宿主 Worker 环境检查账号与项目权限。策略使用对应的项目 ID 单独设置，不能继承其他项目的授权账号。

## 项目编排会话和飞书群

一个 Runtime 为各启用项目创建独立的 DSH 编排会话。GitHub 或 GitLab 事件、项目工单通知和 Reporter 报告都进入所属项目的会话。重启时恢复原会话，旧全局会话保留供查阅。

启用飞书后，在飞书来源的「接收的群」中选择机器人已加入的群，为每个项目绑定一个独立群。程序使用稳定群 ID 确定项目，通过现有飞书准入策略判断谁可发起工作。答复回到原飞书话题。多项目时请在绑定群发起请求，私聊和未绑定群无法确定项目。群绑定缺少或失效时可在设置页核对项目和对应群。

旧配置只有一个启用项目和一个已配置群时，可按唯一关系继续路由。升级会检查旧设置记录，为历史归属明确的飞书消息补充项目身份。多项目或多群配置需要显式保存绑定。已有工单、已发送回复和旧编排会话历史保留原身份。

群改绑后，新话题进入新项目，历史话题仍归原项目。旧话题的新消息会被过滤，改绑前排队的旧项目回复会记录为已丢弃。编排会话查看显式绑定群的上下文时使用本系统已接收且项目归属明确的消息。

## 旧 GitHub 来源身份迁移

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
