---
name: dsh-superagent-gitlab
description: 通过受限的 GitLab ProjectSource 阅读 Issue、合并请求、讨论、审批与流水线。
---

当前工单的 GitLab host、项目、账号和 IID 已由执行环境绑定。仅在 `DSH_SUPERAGENT_GITLAB_HOST` 与 `DSH_SUPERAGENT_GITLAB_PROJECT` 指定的项目中工作；所有 GitLab API 操作使用已登录该项目独立 `GLAB_CONFIG_DIR` 的 `glab`。不要切换账号、读取其他项目或自行传入 Token。

需要平台上下文时使用 `orchestrator_read`：`gitlab/issue/<iid>` 读取 Issue，`gitlab/merge_request/<iid>` 读取合并请求；在后面追加 `/notes/<页码>` 读取讨论，追加 `/discussions/<discussion-id>` 读取 MR 讨论串，追加 `/approvals` 读取审批状态，追加 `/pipelines` 或 `/checks` 读取流水线。每页最多 20 条讨论，并以 `next_resource` 提示后续页。`orchestrator_read` 只读，不会创建工单或发送回复。

对实质性的人类请求或 MR review 讨论开始工作前，先用 `orchestrator_ack` 携带原始 Trigger id 和简短的请求说明确认收到；不要确认机器人或 CI。讨论在它所属的 Issue 或 MR 线程中送达；MR 行内讨论保留文件路径和行号。审批、流水线和 MR 合并/关闭变化也会作为项目内触发进入工单。

执行环境提供 `DSH_SUPERAGENT_GITLAB_HOST`、`DSH_SUPERAGENT_GITLAB_PROJECT`、`DSH_SUPERAGENT_GITLAB_ACCOUNT` 和 `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`。当前请求来自 Issue 时，`DSH_SUPERAGENT_GITLAB_ISSUE_IID` 有值；来自 MR 时，`DSH_SUPERAGENT_GITLAB_MR_IID` 与 `DSH_SUPERAGENT_GITLAB_MR_HEAD` 有值。其他请求来源中对应 IID 为空。提交、推送、开 MR、回复讨论以及审批或合并操作都应针对这些变量指定的项目与工单。

回复通过当前工单绑定的 GitLab Note 渠道交付，并带有重试去重标记。MR 行内讨论的回复会留在该讨论串。不要把回复复制到其他项目，也不要把 CLI 输出中的认证配置写入日志、报告或提交。

VPN 路由由运行时宿主提供。遇到 DNS、路由、TLS/CA 或认证问题时报告具体症状；不要安装或启动 VPN 客户端，不要关闭 TLS 证书验证。为 GitLab 自托管实例补充 CA 时，使用执行环境允许的 CA 配置。
