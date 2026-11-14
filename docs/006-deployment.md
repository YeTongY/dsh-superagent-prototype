# 006 部署

## 多项目与内网 GitLab 接入

新项目目前通过本地管理 API 创建；已有实例可继续在 Sources 页面编辑。`POST /orchestrator/api/projects` 请求体为 `{ provider, config, enabled }`，Provider 取 `github` 或 `gitlab`。服务生成稳定的项目 ID，并按项目单独检查 CLI 身份和项目访问。GitLab Setup 会用项目 API 返回的 Developer 及以上角色作为具备推送能力的判断，不会执行真实推送；分支保护和项目规则仍可能拒绝具体写入。不要在请求中放 Token；认证由宿主 CLI 配置负责。

```json
{
  "provider": "gitlab",
  "enabled": true,
  "config": {
    "host": "gitlab.internal.example",
    "repository": "team/service-a",
    "cli": "/usr/local/bin/glab",
    "configDir": "/srv/superagent/auth/service-a",
    "environment": { "SSL_CERT_FILE": "/etc/ssl/certs/internal-ca.pem" }
  }
}
```

在宿主安装 `glab 1.50.0` 或更新版本，并在启动服务前建立 VPN。Runtime、Worker 与 `glab` 继承宿主路由；本项目不安装、配置或轮换 VPN。每个 ProjectSource 使用独立的 `GLAB_CONFIG_DIR`，在该目录登录并确认身份：

```sh
mkdir -p /srv/superagent/auth/service-a
GLAB_CONFIG_DIR=/srv/superagent/auth/service-a glab auth login --hostname gitlab.internal.example
GLAB_CONFIG_DIR=/srv/superagent/auth/service-a glab auth status --hostname gitlab.internal.example
GLAB_CONFIG_DIR=/srv/superagent/auth/service-a glab api user --hostname gitlab.internal.example
```

不要让不同项目共用配置目录；这样可以分别使用不同账号，也不会把 Token 保存到运行时设置或数据库。自签 CA 可通过 `SSL_CERT_FILE`、`SSL_CERT_DIR` 或 `NODE_EXTRA_CA_CERTS` 配置，代理可通过 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与相应的 `NO_PROXY` 变量配置；代理 URL 中不能包含用户名或密码。GitLab 的 TLS 校验必须保持开启。Setup 会拒绝 `glab` 配置中的 `skip_tls_verify`，不要设置 TLS 绕过变量；先修复宿主证书信任或网络路由。

创建后，使用返回的项目 ID 在 Policy 中配置允许的账号与接收规则；权限不跨项目继承。Worker 自动绑定所属项目的 CLI、Git 配置和执行变量，其他项目故障不会阻止健康项目轮询。旧 `sources.github` 配置仍可直接运行；统一命名空间的停机预览、备份和迁移步骤见文档 `009-multi-project-migration.md`。


本指南介绍如何安装、配置和运维 dsh-superagent，涵盖账号、启动检查、升级和故障排除，并以[001 领域模型](001-domain.md)至[005 管理面板](005-panel.md)为基础。

## 运行内容

- **独立的 DeepSeek Harness profile**，本指南将其称为 `superagent`。请使用 Web profile 模板创建该 profile。它会加载 bundle，并在 `127.0.0.1` 上提供管理面板。请将它与日常使用的 profile 分开：插件会修改整个进程的 `PATH` 和 git 设置，而且该进程需要单独重启和升级。
- **Agent GitHub 账号。** Agent 使用此账号发表评论、推送分支和创建拉取请求；对应的 GitHub CLI 只能登录此账号。
- **可选：**用于接收聊天请求的飞书机器人。

插件配置保存状态目录和机器限制。其他设置都在管理面板中完成：在 Sources 中配置仓库和账号，在 Policy 中配置允许列表，在 Execution 中配置 Worker 目录和命令。

### 权限与隔离

bundle 为 Executor 定义了 `dsh-superagent-worker`，为主 Session 定义了 `dsh-superagent-router`。它们会显示在 DeepSeek Harness preset 列表中，但仅供 dsh-superagent 使用。不要在个人 Session 中选择它们，也不要禁用对应的配置项；应用依靠这些 preset 创建和恢复自己的 Session。

在 Web UI 中打开一个空白的托管 Session 时，系统可能会选择 profile 的默认 preset。dsh-superagent 会在第一轮对话前恢复该 Session 对应角色的 preset。

两个 preset 都以操作者的 OS 用户身份使用 `danger-full-access` 运行，并读取已订阅 Thread 中的消息。账号 wrapper 默认选择 Agent 凭据，但不会隔离进程。Worker 可以按路径执行程序，也可以读取操作者的主目录。若需隔离，请使用专用 OS 账号，并且该账号中只保留 Agent 凭据。

## 前置条件

- Node.js 22.19 或更新的 24.x、pnpm、Git 2.32+、Python 3.8+ 和 tmux。
- GitHub 项目需要 GitHub CLI（`gh`）2.48 或更新版本；GitHub Provider 目前只支持 `github.com`，不支持 GitHub Enterprise Server。
- GitLab 项目需要 `glab` 1.50.0 或更新版本，可连接 GitLab.com 或自托管 GitLab CE/EE。访问内网实例时，宿主必须已经连上 VPN 并能解析、路由到 GitLab host。
- Source 设置中的 CLI 分别使用 GitHub 的 `gh`、GitLab 的 `glab` 和飞书的 `lark-cli`，也可以指定适配对应命令接口的 wrapper。
- 每张 Ticket 使用独立 checkout 时，需要保留可由 prepare 命令创建 worktree 的本地 clone。仓库使用 Git LFS 时还需安装 `git-lfs`。
- DeepSeek Harness 中需要先配置模型供应商；未单独设置 Eval 或 Execution 模型时，dsh-superagent 使用 profile 的默认模型。
- 飞书接入需要 `lark-cli`（已验证 1.0.90）以及启用了机器人的飞书或 Lark 应用。

## 账号

### Agent 的 GitHub 账号

1. 为 Agent 创建 GitHub 用户账号，并授予该账号对仓库的写入权限。不能使用 GitHub App 作为 Agent，因为 dsh-superagent 会读取该账号的通知。
2. 为该账号配置只使用其自身凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   请登录 Agent 账号；最后一条命令会输出该账号的登录名。dsh-superagent 也会用同样的方式读取登录名。

### 飞书机器人配置（可选）

1. 创建一个启用了机器人能力的自建应用。授予应用接收消息事件、读取和发送聊天消息、读取群成员的权限，然后发布应用版本。
2. 为机器人配置专用的 `lark-cli` 配置，限制为机器人身份，并创建一个 wrapper：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令会从标准输入读取应用密钥。请使用单独的配置目录：`lark-cli` 每个 app id 只允许一个 profile，而你的个人配置可能已包含该应用的用户登录信息。

   如果 CLI 可以使用用户身份，宿主会拒绝它。宿主会从机器人配置中读取 app id、Feishu/Lark 品牌和机器人的 `open_id`。

   两份配置共用应用密钥对应的 keychain 条目。若只需删除机器人配置，请删除它的目录；不要运行 `lark-cli config remove`，否则会影响共用的密钥。

## 安装

在尚未创建 `superagent` profile 的机器上执行一次以下命令：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本为公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh` 要求。

第四条命令会使用 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条命令会安装本 bundle。设置 `DSH_HOME` 可以将默认的 `~/.dsh` 目录迁移到其他位置。

仅在全新安装时运行创建 profile 的命令。如果 profile 已存在，该命令会替换它并删除其中的 `cordis.patch.yml`（包括机器配置）。升级时不要运行此命令。

## 机器配置

将 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml` 并覆盖目标文件，然后替换所有 `<placeholder>`。如需接入飞书，还要在该文件中启用 `dsh-superagent-feishu` 项。`webserver` 项用于设置管理面板的端口。

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁文件、`worker-bin` 中的命令 shim、Agent 的 git 配置，以及默认位于 `work` 中的 Ticket 目录。升级前请备份此目录。 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 已保存 Prompt 配置的最大长度，以及一次评估可以读取的 Thread 页数和超时时间。 |

首次启动后，可在 **Settings → Deployment** 或 DeepSeek Harness Plugin Manager 中修改机器限制。更改无需重启即可生效。不能在此修改 `stateDir`。如果配置值无效或包含未知键，服务将无法启动；日志会指出相关键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 会在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`；使用其他 profile 时，会话名为 `dsh-<profile>`。它最多等待一分钟，直到 Runtime 就绪或报告 Setup 要求。首次运行时，它会打印缺少的 Setup 信息。若检测到重复实例（包括通过此脚本以外的方式启动的实例），它会拒绝继续启动。

`stop` 和 `restart` 会请求正常关闭，并最多等待 Executor 五分钟。它们不会强制结束进程，也不会操作其他 tmux 会话。

`status` 会输出进程 ID、健康状态和 Setup 问题。要检查其他 profile 或端口，请使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 会以以下四种状态码之一退出：

| 代码 | 含义 |
| --- | --- |
| 0 | 服务正常运行。 |
| 1 | 服务未运行、重复运行、没有响应，或 Runtime 报告错误；重启可能解决问题。 |
| 2 | 服务正在运行，但 Runtime 以外的模块（例如 Source 或 Policy 同步 `sync:<source id>`）报告错误；重启无法解决问题。 |
| 3 | 服务正在运行，但仍在等待 Setup；重启无法解决问题。 |

仍在启动中的 Source 视为正常运行。Setup 无法检查的飞书机器人也视为正常运行。

`status` 会在 `errors` 中返回失败模块及其详细信息，并在 `setup` 中返回 Setup 要求。`start` 和 `restart` 会逐行打印这些问题；如果服务始终未能启动，则以 1 退出。只有主动执行 `stop` 才会暂停自动恢复。

每个 profile 都会在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本进程。只保留最近 20 个日志。
- 控制文件：`control/profiles/<profile>/`，其中包含停止标记、锁文件和进程 ID。

打开日志中输出的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

请在日常使用的 DeepSeek Harness profile 中创建每小时检查任务，不要在 `superagent` 中创建。即使 Agent 服务停止，该任务也必须继续运行。请让该 profile 中的 Agent 使用以下提示词创建每小时计划，并填入 checkout 路径：

```text
检查 dsh-superagent：在 <checkout> 中运行 `scripts/dsh-superagent --profile superagent status`。退出码为 0：不做任何操作，也不要发送消息。退出码为 2：不要重启；逐项告知我 `errors` 中的模块及其详细信息，已报告过的相同问题除外。退出码为 3：不要重启；告知我 `setup` 中列出的待处理事项，已报告过的相同问题除外。如果结果包含 `manually_stopped: true`，则保持停止状态。其他情况（退出码为 1）：运行 `scripts/dsh-superagent --profile superagent --respect-stop restart`，并按相同方式检查退出码：0 表示已恢复，不要发送消息；2 和 3 按上述方式报告；如果退出码为 1 或发生其他失败，则查看最新的 .artifacts/dsh-superagent-superagent-*.log 和 docs/006-deployment.md 中的“故障排除”部分，尽可能修复问题，并告诉我问题原因和处理方式。
```

`--respect-stop` 会保留主动停止状态。只有 `stop` 会写入该标记；`start` 会清除它。`restart` 不会写入标记，因此检查任务可以恢复因关闭超时而未完成的重启。

## 设置

轮询或开始工作前，Setup 必须成功。Overview 会列出缺少的条件并链接到相应设置。设置更改后会重新运行 Setup。如果你在应用之外修复了问题（例如 CLI 认证），请选择 **Check again**。

1. **Sources。** 设置 GitHub 仓库（`owner/name`）和 Agent CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过 Agent 账号的通知到达。提及该账号的新 Issue 或评论会在下一次轮询时收到；编辑已有 Issue 正文并添加提及不会触发通知，请改为发布新评论。若使用飞书，请设置机器人 CLI、聊天，以及每个聊天的接收模式（接收全部或仅接收提及）和是否接收私信。
2. **Policy。** 可以编辑或删除两条示例规则。在 **On each Source** 中添加可以发起工作的 GitHub 账号和飞书用户；允许列表中至少要有一人，请求才能成为 Ticket。飞书还可以选择一个聊天作为允许列表的同步来源，在启动时或点击 **Sync now** 时同步。
3. **Execution。** 配置目录根路径与 prepare 命令。多个项目共用这一命令，必须根据工单环境选择仓库。下面的示例为每个工单创建独立 checkout，并在来源为 PR/MR 时读取对应 head：

   ```sh
   set -eu
   if [ -n "${DSH_SUPERAGENT_GITLAB_PROJECT:-}" ]; then
     project_remote="https://$DSH_SUPERAGENT_GITLAB_HOST/$DSH_SUPERAGENT_GITLAB_PROJECT.git"
     project_ref=HEAD
     if [ -n "${DSH_SUPERAGENT_GITLAB_MR_IID:-}" ]; then
       project_ref="refs/merge-requests/$DSH_SUPERAGENT_GITLAB_MR_IID/head"
     fi
   else
     project_remote="https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git"
     project_ref="${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}"
   fi
   git init "$DSH_SUPERAGENT_DIR"
   git -C "$DSH_SUPERAGENT_DIR" remote add origin "$project_remote"
   git -C "$DSH_SUPERAGENT_DIR" fetch --no-tags origin "$project_ref"
   git -C "$DSH_SUPERAGENT_DIR" checkout -b "agent/$DSH_SUPERAGENT_NAME" FETCH_HEAD
   ```

   prepare 和 Worker 使用同一份项目 Git 配置及凭据 helper。需要复用本地 clone/worktree 时，可按 `DSH_SUPERAGENT_SOURCE` 明确映射各项目路径，避免所有工单进入同一个仓库。将个人账号的 CLI 列入禁止命令。
4. **Prompts。** 设置团队相关部分：GitHub 说明语句、Review bot、提交作者和自动合并条件。

### 管理 API

管理面板使用本地 HTTP API，Agent 也可以调用该 API。`SETUP.md` 使用它保存设置，服务脚本则读取 `GET state`。

请求发送到 `http://127.0.0.1:<port>/orchestrator/api/`，并附带 `x-orchestrator-request: 1`。Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头或请求来自其他站点的 `Origin` 时，会返回 403。

API 保存操作拥有与管理面板相同的权限。与通过主 Session 工具进行的保存不同，API 可以修改执行环境和 Setup 账号字段。

Agent 可以依赖下列路由和字段。`src/app/api.ts` 中的其他路由供管理面板使用，并可能随面板变化。

| 请求 | 返回内容 |
| --- | --- |
| `GET state` | 所有页面读取的状态：`setup` 包含 `problem` 和 `feishuProblem`，两者均为 `null` 或包含 `place`、`code`、`values` 和 `detail` 的 Setup 问题；Setup 解析完成后还会包含 `accounts`。`health` 为各模块的健康状态，见下表，每项包含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`。`load` 包含 Executor Session 的 `running` 数量、排队 Ticket 的 `queued` 数量和 `maxWorkers`。此外还包含 `paused` 和 `masterId`。 |
| `GET settings` | `blocks` 包含 `policy`、`eval` 和 `executor`，每个 block 都有 `value` 和 `revision`。`sources` 包含各 Source 实例的 `id`、`kind`、`installed`、所属 block 的 `value`、`{"enabled": …, "config": {…}}`、`revision`、该 kind 的表单，以及存在时的 Setup `problem`。此外还有 `policyVersion`，以及包含执行环境 `root` 和 `variables` 的 `environment`。 |
| `GET sources` | 每个 Source 的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、各模块的 `health`、Setup `problem`、最近一天的 `stats`、当天被 `filtered` 的 Trigger，以及当天被 `dropped` 的消息（按丢弃时间从新到旧排列）。每条丢弃消息包含 `channel`、`preview`；如关联 Ticket，则包含其 `id` 和 `title`；如果 Store 中有对应 Thread，也会包含 `thread`；还包含 `dropped.at` 及 `dropped.reason`（`channelGone` 或 `channelIgnored`）。 |
| `PUT settings/<block>`，正文为 `{"value": …, "revision": n}` | 保存一个 block，返回 `saved`、该 block 新的 `revision`、`policy_changed` 和 `restarting`。`value` 是整个 block，格式与 `GET settings` 返回的一致；缺少的键会使用默认值。 |
| `POST executor/pause`，正文为 `{"paused": true}` 或 `false` | 暂停或恢复处理，并返回 `paused`。 |
| `POST setup/check` | 通过重启 dsh-superagent 再次运行 Setup，并返回 `restarting: true`。没有待修复的 Setup 问题时会拒绝请求。 |
| `POST policy-sync/<source id>` | 立即同步该 Source 的允许列表，并返回已保存的 Source Policy 部分 `policy`。 |
| `GET prompts`；`PUT prompts`，正文为 `{"config", "baseRevision"}` | 读取 Prompt 配置时返回 `current`（包含 `revision` 和 `config`）、`defaults`、`sections`（Session 读取的团队部分顺序）、`skillName`（团队 Skill 名称格式）、`builtin`（团队 Skill 不能使用的名称）和 `skillPrefix`（Session 加载 Skill 时使用的名称前缀）；保存时返回新的 `revision`。 |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | 与管理面板相同，重试或停止 Ticket。 |

健康状态项按职责分组：

| 项目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身。 |
| `models` | 正在等待模型预算重试的 Session。 |
| `evals` | 最近一小时内不可用且之后没有重新判定或关闭的 Eval。 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md)中说明的持久化工作；`delivery` 统计等待处理的工作，`reply` 对应 Channel 消息。 |
| `worker` | Executor Session 事件处理；首次失败后才会出现。 |
| `github`、`feishu`、`history` | Source 轮询、事件和历史恢复。 |
| `sync:<source id>` | 允许列表同步。 |

拒绝响应包含 HTTP 状态码和 `error` 字段，其中 `error` 是英文错误文本：

- 400：值无效（`issues`，每项都包含 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或者请求正文不是 JSON 或超过大小限制。
- 404：目标不存在。
- 409：revision 已过期。
- 500：其他错误。

各配置 block：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 配置包含 `repository`、`cli`，以及默认关闭的 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi` 开关；开启后会接收仓库中的新 Issue、新拉取请求和评论，以及默认分支的 CI 事件。飞书配置包含 `cli`、`chats`（格式为 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，也可将 `listen` 设为 `"all"`）、`directMessages`，以及值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选项的机器人。`admission` 行按聊天 ID、飞书的 `other` 或 `direct`，以及 GitHub 的 `issues`、`pulls`、`comments` 或 `ci` 标识；未设置的单元格使用默认值（见[002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停状态通过独立设置 `paused` 管理，由 `POST executor/pause` 设置。

更改仓库或 CLI 时，会先运行对应的 Setup 检查。检查失败时返回 400，并在 `setup` 中附带详情。账号更改成功后，或者 Setup 等待处理期间保存任何设置时，响应会包含 `restarting: true`。应用重启期间 API 会暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup 检查

Setup 与 Worker shell 一样，使用 DeepSeek Harness 子进程服务运行命令。它会移除名称中包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

Setup 会验证 GitHub 仓库和 Agent 的推送权限，写入 Worker 环境，并检查 git 在访问 github.com 时是否只使用 Agent 凭据。飞书 Setup 失败时，只会禁用飞书 Source。

Setup 写入的进程环境：

- `<stateDir>/worker-bin` 中的**命令 shim**，并将该目录放在 `PATH` 首位：`gh` 调用 Agent 的 CLI；`lark-cli` 调用机器人的 CLI；被禁止的命令会执行失败。shim 在调用目标程序前，会先从 `PATH` 中移除自己的目录。
- `<stateDir>/worker-gitconfig` 中的 **git 配置**：替代操作者的全局和系统级 git 配置。它会将 Agent CLI 设为 github.com 的凭据 helper，将 GitHub SSH 地址重写为 HTTPS，并定义 Git LFS filter。个人 git 设置（例如 HTTP 代理）不会生效。这里不会设置提交身份；git 不会提示输入凭据，并且 `GH_TOKEN` 和 `GITHUB_TOKEN` 会被移除。

dsh-superagent 未写入的 `worker-bin` 或 `worker-gitconfig` 文件会导致 Setup 停止。若 Ticket 目录位于自身配置添加了凭据的 git 仓库内，该 Ticket 会执行失败。

## 试运行

使用已允许的 GitHub 账号创建 Issue，或发布包含 `@<agent login> <request>` 的评论。一个轮询周期内（默认为一分钟），Overview 中应出现对应 Ticket。Agent 会确认请求，在自己的 Session 和目录中工作，并在原对话中发送结果。使用飞书时，请在已配置的聊天中提及机器人。

## 升级

1. 等待所有 Executor 都完成当前轮次。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

重启会结束正在运行的 Assignment，并附带恢复说明启动替代任务。团队文本和已覆盖的 Prompt 部分会保留；未覆盖的部分会使用新默认值。升级后请检查标记为 **Default updated** 的部分。

经较新版本迁移的数据库不能由旧版本打开。因此回滚需要使用升级前的备份。升级 DeepSeek Harness 本身后，请重启运行中的实例，以便管理面板加载匹配的构建产物。

### Agent 预设

Worker 和 Router preset 会在 5 秒后将 shell 命令转入后台。Session 必须有对应 preset 才能加载。只要相关 Session 仍在使用，就要在 `cordis.patch.yml` 中保留 `dsh-superagent-worker` 和 `dsh-superagent-router` 配置项，否则恢复 Session 时会出现 `agent-preset/not-found`。

## 故障排除

Setup 问题会以管理面板当前语言显示在 Overview 中，并附带修复链接；日志和 API 会显示下表中的英文原文。

| 症状 | 原因与处理方法 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片中设置 Agent 的 CLI。 |
| `The agent GitHub CLI was not found.` | 设置 wrapper 的绝对路径，或设置 `PATH` 中的命令名。 |
| `The agent GitHub CLI cannot read its account` | 使用 `auth login` 登录 wrapper。 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予 Agent 账号对仓库的写入权限。 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片中设置仓库，格式为 `owner/name`。 |
| Ticket 因 `The prepare command failed: …` 执行失败 | 输出中会指出原因，例如 clone 路径错误。修复命令后重试 Ticket。 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更新版本。 |
| Ticket 因 `The git configuration of the repository in … sets …` 执行失败 | 从 clone 的 `.git/config` 中移除所指出的凭据配置或 `http.*.extraheader` 设置。 |
| `… was not written by dsh-superagent` | 将该文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或改用其他 `stateDir`。 |
| `The bot lark-cli allows user identities` | 按上文“飞书机器人”所述，为飞书 Source 指定仅限机器人的配置。 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置中的 app id 和密钥。 |
| `The Feishu bot is not a member of the chat.` | 在聊天设置中将机器人添加到该聊天；下次尝试即可成功。 |
| `status` 以 2 退出 | 某个模块报告错误，重启无法修复。`errors` 会列出各模块的详细信息，模块名称见“管理 API”；模块恢复正常后会清除自己的错误项。 |
| `status` 以 3 退出 | Setup 仍在等待处理；`setup` 会说明缺少什么条件，Overview 会链接到对应设置。 |
| `status` 以 1 退出 | 服务未运行、重复运行、没有响应，或 Runtime 报告错误；命令输出和最新日志会说明具体原因。 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 执行失败但没有说明原因。请以操作者身份手动运行指定程序，查看程序自身的错误信息。 |
| 管理面板提示 dsh-superagent 无响应 | 服务可能正在重启，或因配置问题未能启动；DeepSeek Harness 日志会说明原因。 |
| 日志出现 `dsh-superagent configuration has keys it does not use` | 移除日志指出的键；消息会说明每个值现在应配置在哪里。 |
| 日志提示插件与当前运行的 dsh 不兼容 | 安装符合 `engines.dsh` 版本范围的 DeepSeek Harness。 |
| 升级 DeepSeek Harness 后管理面板显示 "Failed to load plugins" | 重启运行中的实例。 |
| 提及 Agent 后没有任何响应 | 检查发信人是否在 Source 的允许列表中、Source 是否已启用，以及处理是否暂停。在 GitHub 上，通过编辑 Issue 正文新增的提及不会被收到；请在评论中提及 Agent。 |
