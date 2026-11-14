# 011 Docker 部署与自举

本文说明如何将 dsh-superagent 作为容器运行，并把部署仓库登记为第一个项目。已选目标环境是 Netcatty 中的 Linux 911pro；方案使用 Linux host 网络，需要 Docker Engine 与 Docker Compose v2。

## 设计取舍

调研了 Docker 官方 Node.js 容器指南和多阶段构建文档，以及 OpenHands 的 Agent 镜像。采用锁文件安装、构建与运行依赖分层、健康探针和非 root 运行等原则。OpenHands 面向多服务和沙箱工作流，本项目只需一个 DSH Web profile 和一个 Agent bundle，因此没有引入它的 Supervisor、入口网关或沙箱机制。

- Docker Node.js 容器指南：https://docs.docker.com/guides/nodejs/containerize/
- Docker 多阶段构建：https://docs.docker.com/build/building/multi-stage/
- OpenHands Agent 镜像：https://github.com/All-Hands-AI/OpenHands/blob/main/docker/Dockerfile
- DSH CLI：https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.3

实际检查 DSH 0.2.1-rc.3 的 CLI 后确定：首次创建 superagent Web profile 并链接 bundle；后续启动不能再次使用会替换 profile 的 from-default-profile 选项。容器入口检测已有 profile，遇到不完整目录或来源不同的 bundle 会停止并提示检查。

## 数据与网络

镜像固定为 Node 24 Debian slim，内含 DSH CLI、pnpm、Git、Python、tmux、GitHub CLI 和 glab。GitHub 与 GitLab CLI 使用固定版本，并在构建时核对 SHA-256。运行用户 UID/GID 为 1000:1000。

持久数据放在同一个宿主目录中：

| 路径 | 内容 |
| --- | --- |
| /data/dsh | DSH profile、Session 与模型凭据 |
| /data/superagent | Superagent SQLite、命令环境、Ticket 状态与 Worker 工作目录 |
| /data/gh | GitHub CLI 登录目录；首个自举项目使用 /data/gh/self |
| /data/glab | GitLab CLI 登录目录 |
| /data/work | 项目可配置的独立 clone/worktree 目录 |

Compose 使用 network_mode: host，容器没有 ports 映射。管理 Web 服务固定监听 127.0.0.1:3082，Reporter 入口沿用同一 loopback 限制。host 网络使容器共享 911pro 的网络命名空间、DNS 和 VPN 路由，不需要在容器里运行 VPN 客户端；HTTP 代理环境变量仍需通过 Compose 环境或 ProjectSource 设置显式传入。需从别的机器访问面板时，用 911pro 的 SSH/Netcatty 端口转发；不要把 DSH Web 或 Reporter 改成 0.0.0.0。

## 在 911pro 构建与启动

先把本仓库干净工作树传到 911pro 的独立部署目录。目录应包含 Dockerfile、.dockerignore、compose.yaml、docker/、项目 package.json、pnpm-lock.yaml、源码、构建配置及 cordis.patch.yml。不要传 .git、node_modules、.data、模型或 CLI 凭据、真实 runtime.env。

    cd /home/yetongy/services/superagent-bootstrap/release
    DATA=/home/yetongy/services/superagent-bootstrap/shared/data
    sudo install -d -o 1000 -g 1000 -m 0750 "$DATA" "$DATA/dsh" "$DATA/superagent" \
      "$DATA/gh/self" "$DATA/glab" "$DATA/work"
    export DSH_SUPERAGENT_DATA_DIR="$DATA"
    docker compose build
    docker compose up -d
    docker compose ps
    docker compose exec superagent /usr/local/bin/dsh-superagent-entrypoint doctor
    docker compose exec superagent /usr/local/bin/dsh-superagent-entrypoint status

docker compose build 使用多阶段构建，容器镜像保留已构建的产品 bundle 与运行依赖。若构建主机要求代理，使用 Docker 支持的 HTTP_PROXY、HTTPS_PROXY BuildKit 参数临时传入；这些参数不会成为应用默认代理配置。运行时代理则放在 docker/runtime.env 或项目 Source 的环境设置中。

最终运行镜像安装 DSH CLI 时，Dockerfile 使用 npm 11 的 `--allow-scripts` 显式许可经过检查的安装生命周期脚本。npm 默认可能跳过未许可依赖的脚本，导致安装看似完成但 native 依赖或子进程 helper 不完整。当前允许列表对应 DSH `0.2.1-rc.3` 的依赖：`@deepseek-ai/dsh-subprocess-local` 恢复 node-pty helper 的可执行位，`koffi` 安装 native 绑定，`node-pty` 检查预构建或回退编译并完成安装清理，`protobufjs` 检查依赖版本兼容性；`@google/genai` 的 `preinstall` 仅是 no-op。更换 DSH 版本或依赖树后，应先检查 npm 报告的脚本并审查具体内容，再按需调整允许列表；不要无差别开放所有依赖脚本。

docker compose ps 的 Docker health 表示 Runtime 的 ready 或 paused，不会把 setup 等待误报成服务宕机。doctor 检查 CLI 和 profile 安装，status 展示 Runtime 健康与 setup 问题。模型没配置、ProjectSource 未注册或 CLI 未登录时，服务可以正常启动等待设置；这不表示 Agent 已能接单。

DSH 启动日志可能打印带 `?token=...` 的登录 URL，因此 `docker compose logs` 的输出可能包含可用于登录的临时凭据。只在本人受控的终端查看日志；分享日志、截图或错误上下文前，先删除或替换 URL 中的 token 值及其他凭据，并复查脱敏结果。

确认 profile 后，首次在 DeepSeek Harness 的 Settings → Models 配置并选择模型。DSH 的 Models 页面会将 API key 放在 /data/dsh/.credentials.yaml，这是持久数据；同时保护宿主数据目录的读取权限。模型 key 也可由 Docker 运行时 Secret/环境变量提供，但不要放入 Dockerfile、Git 或被提交的 Compose 文件。

## 首个项目：本项目的 GitHub fork

先在容器里登录专用 Agent GitHub 身份：

    docker compose exec -it -e GH_CONFIG_DIR=/data/gh/self superagent \
      gh auth login --hostname github.com
    docker compose exec -e GH_CONFIG_DIR=/data/gh/self superagent \
      gh api user --jq .login

用 GH_CONFIG_DIR=/data/gh/self 创建 GitHub ProjectSource，repository 填写当前用户有写权限的 fork，例如 YeTongY/dsh-superagent-prototype，configDir 填相同绝对路径 /data/gh/self，CLI 使用 gh。然后按返回的 ProjectSource ID 单独设置 Policy 允许名单，并从状态/来源页面确认身份、项目读取和写入能力。不要把只读官方仓库 deepseek-ai/dsh-superagent-prototype 当成首个工作仓库。

以下管理 API 必须通过本机或 SSH 转发访问，示例展示创建项目的调用形状：

    curl --fail-with-body \
      -H 'Host: 127.0.0.1:3082' \
      -H 'x-orchestrator-request: 1' \
      -H 'Content-Type: application/json' \
      http://127.0.0.1:3082/orchestrator/api/projects \
      --data '{"provider":"github","enabled":true,"config":{"repository":"YeTongY/dsh-superagent-prototype","cli":"gh","configDir":"/data/gh/self"}}'

初始化模型后，可由真实 DSH Main Session 路由一条有范围、可审查的请求，验证它能为该 fork 创建 Ticket 并启动 Worker。Worker 应使用独立 clone/worktree；运行中的 /opt/dsh-superagent 是发布目录，不能把它当作工单工作树覆盖。

## 本地 Reporter 自举验证

Reporter 默认关闭。确认自己通过 loopback 或 SSH 隧道访问后，创建未跟踪的 docker/runtime.env 并填入随机 Reporter capability，然后重启 Compose 服务：

    {
      printf '%s\n' 'DSH_SUPERAGENT_REPORTER_ENABLED=1'
      printf 'DSH_SUPERAGENT_REPORTER_TOKEN=%s\n' "$(openssl rand -hex 32)"
    } > docker/runtime.env
    chmod 600 docker/runtime.env
    docker compose up -d

通过 POST /orchestrator/reporter/scenarios 注册以首个 GitHub 项目 ID 为 project_source_id 的场景，再用 POST /orchestrator/reporter/events 提交动作；细节见[本地 Reporter 文档](010-local-reporter.md)。Reporter 动作走真实 Runtime/Engine，场景回复由本地 Sink 捕获。运行 LLM User Simulator 或 Reviewer 仍需外部调用方注入模型函数；启用 Reporter 不会自动发起付费调用。

检查行为和配置后移除 Reporter 开关与 Token 并重启。platform_pass 在本地 Reporter 中保持 null。真实 GitHub 评论交付、git push、分支保护和模型驱动自举是不同的验收步骤；不要把容器健康或本地 Reporter 通过当成它们已经通过。

## 更新、备份与回滚

发布新版本前，先确认没有 Executor 正在执行工作，并为当前镜像和完整持久数据目录创建可对应的备份。保留发布镜像标签；只记录源码版本或镜像摘要不足以恢复旧镜像。以下 `<旧版标签>` 和 `<新版标签>` 使用自行保存的发布记录中登记的实际标签。操作均在 911pro 的发布目录中执行，并确认 `DSH_SUPERAGENT_DATA_DIR` 指向共享数据目录。备份放到源码和 Docker 构建上下文之外，例如共享目录下的 `backups/`；不要将备份放进 `release/`。

```sh
# 先为当前运行镜像保存不会被下一次构建覆盖的标签
docker image tag dsh-superagent:local dsh-superagent:<旧版标签>

# 正常停止容器后，再备份所有持久状态
docker compose down
BACKUP_DIR=/home/yetongy/services/superagent-bootstrap/shared/backups
umask 077
install -d -m 0700 "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/data-<旧版标签>.tar.gz"
tar -C "$(dirname "$DSH_SUPERAGENT_DATA_DIR")" \
  -czf "$BACKUP_FILE" "$(basename "$DSH_SUPERAGENT_DATA_DIR")"

# 构建并启动新版本
docker compose build
docker image tag dsh-superagent:local dsh-superagent:<新版标签>
docker compose up -d --no-build
docker compose ps
docker compose exec superagent /usr/local/bin/dsh-superagent-entrypoint status
```

验证新版本健康后，将镜像标签、源码包 SHA-256、配置版本和数据备份的绝对路径记入发布记录。备份应包含完整 `data` 目录，这样 DSH profile、SQLite、Reporter 轨迹、CLI 配置和 Worker 工作目录保持为同一时间点。备份文件、`docker/runtime.env`、GH、glab 或模型凭据都不得提交到 Git、构建上下文或镜像；临时 `compose.override.yml` 也不得包含凭据。

需要回滚时，先停止容器并临时创建 `compose.override.yml`，将服务固定到已保留的旧镜像标签：

```sh
docker compose down
BACKUP_DIR=/home/yetongy/services/superagent-bootstrap/shared/backups
BACKUP_FILE="$BACKUP_DIR/data-<旧版标签>.tar.gz"
cat > compose.override.yml <<'EOF'
services:
  superagent:
    image: dsh-superagent:<旧版标签>
EOF
docker compose up -d --no-build
docker compose ps
docker compose exec superagent /usr/local/bin/dsh-superagent-entrypoint status
```

只有旧版本明确支持当前 SQLite schema 时，才能直接复用当前数据目录。如果旧版本因 schema 版本较新而拒绝启动，或状态兼容性未经确认，应再次停止容器，将当前数据目录移到一旁留作诊断，再恢复与 `<旧版标签>` 配套的完整备份：

```sh
docker compose down
BACKUP_DIR=/home/yetongy/services/superagent-bootstrap/shared/backups
BACKUP_FILE="$BACKUP_DIR/data-<旧版标签>.tar.gz"
mv "$DSH_SUPERAGENT_DATA_DIR" "${DSH_SUPERAGENT_DATA_DIR}.failed-<新版标签>"
tar -C "$(dirname "$DSH_SUPERAGENT_DATA_DIR")" -xzf "$BACKUP_FILE"
sudo chown -R 1000:1000 "$DSH_SUPERAGENT_DATA_DIR"
docker compose up -d --no-build
docker compose exec superagent /usr/local/bin/dsh-superagent-entrypoint status
```

恢复后用旧镜像启动并检查状态。不要让旧版本打开已被新版本迁移、且没有对应备份的数据。回滚验证完成后，可移除 `compose.override.yml`；该文件只用于本次回滚，下一次发布前应确认 Compose 指向预期镜像。

如只需停止服务，运行 `docker compose down`；数据仍保留在宿主目录中。不要执行 `docker compose down -v`，也不要删除 `/data`。从备份恢复时保持属主 1000:1000；容器不会覆盖现有 DSH profile。

| 现象 | 检查方法 |
| --- | --- |
| Compose 报数据目录缺失 | 确认 DSH_SUPERAGENT_DATA_DIR 是存在的绝对路径；Compose 禁止悄悄创建 root 属主目录。 |
| permission denied 写入 /data | 将整个持久目录及其子目录修正为 UID/GID 1000:1000，再启动容器。 |
| 服务状态 unhealthy | 运行 docker compose logs --tail=150 superagent 和容器内 status；Runtime error 会让健康检查失败，setup 等待不会。 |
| profile 不完整或 bundle 来源冲突 | 先备份数据目录，检查 /data/dsh/profiles/superagent/package.json；入口会拒绝覆盖或移除任何 profile。 |
| GH/glab 认证失败 | 在容器内用与 Source 相同的 GH_CONFIG_DIR 或 GLAB_CONFIG_DIR 运行 CLI 身份检查，并检查宿主代理、VPN、CA。 |
| 面板或 API 无法访问 | 检查 911pro 的 127.0.0.1:3082 及本机端口转发；Compose 故意不发布端口到非 loopback 网卡。 |

宿主 VPN、DNS 和代理仍由 911pro 运维，不由镜像接管。若容器 health 通过而 Source 仍报网络或权限错误，应查看对应 CLI 与 Source 诊断；健康检查只判断 Runtime 是否可用。
