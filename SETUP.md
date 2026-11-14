# 部署设置

本文件供编码 Agent 协助运营者部署 dsh-superagent。运营者可以让自己的编码 Agent 阅读并执行这里的流程。

## 多项目与内网 GitLab 接入

运营者使用 GitLab 或多个仓库时，采用本节流程。后面的单 GitHub 示例只适用于对应场景。

1. 阅读 `docs/006-deployment.md` 的多项目接入部分，确认每个项目的 Provider、host、完整路径及宿主 CLI 和配置目录。只询问已有上下文中仍缺失的信息。
2. GitLab 使用 `glab >= 1.50.0`，每项目独立 `GLAB_CONFIG_DIR`；让运营者在宿主终端完成认证。VPN、代理和 CA 均由宿主准备，本项目不安装 VPN、不接收聊天中的 Token、不关闭 TLS 校验。
3. 复用下文的机器安装和独立 DSH profile 步骤，通过 `POST /orchestrator/api/projects` 逐个创建项目。仅使用 GitLab 时禁用未配置的旧 GitHub Source，无需额外创建 GitHub 账号。
4. 按返回的项目 ID 单独设置 Policy 允许名单。Execution 的 prepare 命令依据工单环境选择仓库，不能固定到第一个项目的 clone。GitHub 和 GitLab 的提交身份分别从对应环境变量取得。
5. 每次保存导致重启后，重新读取设置与来源健康状态。先验证项目隔离和本地 Reporter，再在运营者授权的一次性项目上运行真实 GitLab 测试。未运行的平台测试必须标记未验证。
6. 已有单 GitHub 状态可以继续使用；需要统一身份时，按 `docs/009-multi-project-migration.md` 停机预览、备份并迁移，不得清空旧数据库。

## 执行原则

遵循[设计理念](docs/000-philosophy.md)，尽量减少对运营者的打扰。

- 首次提问前阅读本文件和设计理念，并运行一次环境探测。多项目或 GitLab 场景还需阅读上节指定的部署说明。
- 每次只问一个尚未确定的问题，等待回答后继续；已有上下文或探测能够回答的问题直接跳过。
- 每条消息控制在约 300 字内，除非运营者要求展开。问题给出推荐选项，并用一句话说明原因。
- 收集缺失信息后给出完整部署计划；已有授权覆盖的步骤可以继续执行，新增账号或外部部署等未授权操作再请求确认。
- 不在聊天中索取 Secret。创建账号、登录 CLI、填写应用密钥等需要人工完成的步骤，集中提供准确命令，让运营者在自己的终端执行。
- 结合问题逐步解释设计理念，不集中灌输。

## 1. 环境探测

在当前检出目录运行一次，保留结果用于后续判断。以下 CLI 项按所选 Provider 执行，无需为 GitLab 安装或登录 GitHub CLI。

```sh
node -v
pnpm -v
git --version
tmux -V
python3 --version
dsh --version
```

GitHub 场景：

```sh
gh --version
gh api user --jq .login
```

GitLab 场景：

```sh
glab --version
# 使用每个项目的配置目录和 host，避免读取其他账号的默认配置。
GLAB_CONFIG_DIR=/absolute/path/to/project-config glab auth status --hostname gitlab.internal
GLAB_CONFIG_DIR=/absolute/path/to/project-config glab api --hostname gitlab.internal user
```

使用飞书时检查 `command -v lark-cli`。检查 `${DSH_HOME:-$HOME/.dsh}/profiles/*/cordis.patch.yml` 中是否已有 `id: dsh-superagent`；已有 profile 应保留配置，按部署文档的升级说明处理。

通用前置条件为 Node.js 22.19+ 或 24+、pnpm、git 2.32+、tmux、Python 3.8+，以及满足 `package.json` 中 `engines.dsh` 的 DSH。GitHub 另需 GitHub CLI 2.48+，GitLab 另需 glab 1.50.0+。缺失依赖直接列入计划。DSH 还需模型 Provider；从未配置过模型时，把配置列为运营者步骤。

## 2. 补齐部署信息

按[领域模型](docs/001-domain.md)中的工作顺序了解来源、权限和执行方式；已有答案不再询问。

1. 请求来自哪些 GitHub/GitLab 项目，是否同时使用飞书？记录每个项目的 Provider、host、完整路径；GitHub 示例为 `owner/name`。
2. Agent 使用哪个独立账号？推荐专用账号，平台发言和提交均能明确归属；尚未创建时列为运营者步骤。
3. 哪些用户可以提出工作请求？推荐先只允许运营者，再逐步扩大；各项目分别配置。飞书还需确认群聊及允许名单，可先与首个群的成员保持同步。
4. 工单从哪个本地 clone 准备工作目录？单项目可推荐 `~/src/<name>` 下的新 clone；多项目按工单环境选择，不能共享一个固定仓库路径。
5. 提交使用什么身份？推荐 Agent 账号；其他身份写入交付要求。
6. 是否允许自动合并？推荐先由人工合并。GitHub 的自动合并若需另一个有权限的账号，由运营者在终端登录独立 CLI，并在交付要求中明确。GitLab 按项目权限和分支保护另行确认，不沿用 GitHub 的账号假设。

无需询问有合理默认值的项目，列入计划即可：

- 独立 profile `superagent`，从 DSH Web profile 复制，使运行时重启不关闭运营者的其他 Session；端口 `3082`；状态目录使用 `<home>/.dsh/state/superagent` 的绝对路径。
- 可在运营者自己的 profile 中配置每小时健康检查，故障时修复运行时。
- 分支前缀 `agent/`，接纳模式 `observe`，先记录主动发现的工作而不自动执行，保留默认规则与提示词章节。
- 飞书默认只读取提及，允许私信。

## 3. 部署计划

用一条简短消息列出安装项、项目和账号、CLI、待保存设置、人工步骤及默认值。将需要额外授权的操作说明清楚；不要重复确认已经授权的实施范围。

## 4. 执行

1. **人工步骤。** 阅读部署文档的账号说明，准备 CLI wrapper，再集中说明运营者需要完成的账号创建、邀请接受和 `auth login`。使用飞书时还需创建并发布机器人应用，在本机执行含密钥的 `config init`。人工步骤完成后逐一核实登录身份。
2. **安装并启动。** 按部署文档的安装、机器配置和启动停止章节执行。当前已在本项目 checkout 内，无需重复 clone。按需准备目标项目 clone。已有 profile 时不要执行会覆盖配置的 `dsh superagent --from-default-profile`，直接编辑既有 `cordis.patch.yml`。
3. **保存设置。** 多项目通过项目 API 注册后，按项目 ID 保存来源和策略。旧单 GitHub 可以依次保存 `github`、可选 `feishu`、`policy` 和 `executor`；飞书群 ID 先由机器人 CLI 查询。prepare 命令使用已确定的 clone 及项目环境。交付要求写明提交身份和合并方式。返回 `restarting: true` 时，等 `scripts/dsh-superagent status` 不再以状态码 1 退出，再请求下一步，并从 `GET settings` 重新读取 revision。
4. **处理失败。** 保存失败的响应包含 setup 问题。对照部署文档的故障排查表修复；只有无法自行解决的缺失信息或人工步骤才询问运营者。

## 5. 验证与交接

确认 `scripts/dsh-superagent status` 返回 0，且没有 setup 问题。按已授权范围在运营者 profile 配置每小时健康检查；无法在该 profile 操作时提供可供调度的检查提示词。

交接消息说明：

- 面板 URL，以及侧栏 **Superagent** 入口。
- 白名单账号如何在目标项目的 Issue 中评论 `@<agent login> <请求>`；正常情况下约一分钟内出现工单。
- 先缩小范围、逐步减少噪声、对 Agent 的发言负责这三项运营原则。
- 多项目部署、迁移和本地 Reporter 的阅读路径，以及本地测试与真实平台验证各自的结果。
