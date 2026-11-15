# 010 本地 Reporter 与行为测试

本地 Reporter 用来低成本验证 Superagent 的正常行为路径。测试动作仍经 `Runtime.receive()`、Engine、策略评估、Ticket 和 Outbox 处理；Reporter 不直接写业务数据库，也不会把输出发到 GitHub、GitLab 或 Feishu。

它适合验证 Agent 是否理解请求、创建或停止正确的工作、处理追问和审查意见、在 CI 变化后采取合理动作，以及是否产生了预期回复。它不证明 GitLab API、TLS、VPN 路由或真实消息交付正常；这些要用 Fake GitLab 和少量宿主 VPN E2E 覆盖。

## 参考实现与本项目取舍

本设计参考了以下成熟项目（调研日期：2026-11-14），并结合本项目的运行边界取舍：

- [**tau2-bench**](https://github.com/sierra-research/tau2-bench)：借鉴场景、Persona、类型化用户动作与确定性状态评估分离的做法。它面向通用对话环境；本项目的动作直接适配 Superagent 的 Trigger、ProjectSource 和 Ticket。
- [**Inspect AI**](https://github.com/UKGovernmentBEIS/inspect_ai)：借鉴每个样本有稳定身份、轨迹和评分边界的做法。本项目使用自己的 JSONL 记录和现有 Runtime，不引入另一套评估框架。
- [**OpenART**](https://github.com/AI45Lab/OpenART)：借鉴隐藏 Oracle、checkpoint 和禁止副作用断言。固定场景与目标 Superagent 看不到 Oracle；Oracle 由本地结构化证据独立计算。
- [**GitLab QA**](https://github.com/gitlab-org/gitlab-qa)：借鉴真实平台测试保持少量、可调试、可复现的做法。Reporter 的本地结果不冒充平台通过。

这里复用的是边界和验证原则，不复制这些项目的代码或目录结构。真实 GitLab 访问继续由宿主安装的 `glab` 和宿主 VPN 提供；本地 Reporter 不接触平台 Token，也不管理 VPN。

## 启用条件

Reporter 默认关闭。只在隔离的测试实例中设置以下进程环境变量并重启：

```sh
DSH_SUPERAGENT_REPORTER_ENABLED=1
DSH_SUPERAGENT_REPORTER_TOKEN=<至少 32 个随机字符>
```

Token 由宿主注入，不写入设置、数据库、Prompt、事件或日志。Reporter API 只在 Web 服务绑定 `127.0.0.1` 时可用；请求还必须通过同源校验并携带 `Authorization: Bearer <token>`。停止测试后移除这两个变量并重启。

本地 Sink 只截获 Reporter 场景的 Outbox 消息，不限制 Worker 的 shell、Git 或其他工具。运行模型驱动的完整测试时，仍需为被测实例准备一次性仓库、独立状态目录和受限测试凭据，避免工作任务写入正式项目；项目绑定属于应用层隔离，不是操作系统沙箱。

固定场景轨迹以权限 `0600` 的 JSONL 文件保存在 `<stateDir>/reporter/`，每个场景独立一个文件。轨迹可能包含模拟用户的文字、Superagent 回复、场景标识和结构化运行状态；自主 Reporter 的 DSH 会话历史单独由 DSH 保存，不复制进该 JSONL。应像测试日志一样限制访问和保留时间，不要把包含真实代码或内部讨论的轨迹公开上传。

## 场景定义

固定回归场景绑定一个已启用的 ProjectSource、一个目标 Thread 和一个或多个 Actor。场景必须包含至少一个确定性 Oracle 断言。固定脚本/API 的 Actor 输入只取得 `visible`、Actor 名单和场景基本信息；`oracle` 只进入本地结果和导出的轨迹。此输入协议不表示自主 Reporter 另有一个模型驱动的用户模拟器。

```json
{
  "id": "pull-request-follow-up",
  "version": 1,
  "project_source_id": "github-0123456789abcdef01234567",
  "thread_id": "17",
  "thread_kind": "pull",
  "title": "追问与停止行为",
  "visible": {
    "persona": "你是负责这个 PR 的维护者。",
    "goal": "先要求修复一个回归问题，看到进展后再决定是否继续。",
    "instructions": ["说话简短，像真实的代码维护者。", "不要一次把之后的追问都提前说出。"]
  },
  "actors": [
    { "id": "alice", "role": "person" },
    { "id": "renovate[bot]", "role": "bot" },
    { "id": "unit-tests", "role": "ci" }
  ],
  "oracle": {
    "assertions": [
      { "kind": "decision", "decision": "accept", "sequence": 1 },
      { "kind": "ticket-count", "count": 1 },
      { "kind": "output-count", "output": "acknowledgement", "count": 1 }
    ]
  }
}
```

`thread_kind` 可以是 `issue`、`pull`、`conversation`、`inline`、`review` 或 `ci`。GitHub 事件会生成对应的 `kind`、`number`、`isPr`、`ci` 等 Source 元数据，仍然经过目标 ProjectSource 的策略；GitLab ProjectSource 使用其 Source 适配器要求的元数据。`thread_id` 是模拟目标的原生 ID，Engine 内部 Thread 会额外加场景命名空间，避免同一仓库的真实 Issue/MR 或其他场景撞 ID。

Actor 的 `role` 为 `person`、`bot` 或 `ci`。只有 `person` 被标记为人类 Trigger；用户白名单、显式请求、停止权限和其他策略仍由现有 Engine 判断。模拟器可以选择措辞和时机，但不能指定 Oracle 结果或绕开策略。

支持的动作包括：

- `message`：普通请求、追问、澄清或停止文字；可选 `addressed` 标记提及或私聊，`location` 可指定 `issue`、`pull`、`conversation` 或 `inline` 场景。
- `review`：`approved`、`changes_requested` 或 `commented`。
- `approval`：`approved` 或 `rejected`。
- `ci`：任务名与 `queued`、`running`、`success`、`failure`、`cancelled` 状态。
- `stop`：自然语言停止请求，最终是否有效由现有策略决定。

每个动作有大小和字段限制；同一实例最多保存 100 个场景、每个场景最多 10,000 条轨迹记录、2,000 条本地输出和 16 MiB 轨迹，总容量为 128 MiB。超限输入返回结构化错误。已登记场景的本地输出若超长或超出容量，会保留待交付回执并报告 effect 错误，不会标记为已送达，也不会转发给外部 Provider；相同输出 ID 的重试仍按幂等成功处理。达到容量后，先导出所需轨迹，再停止实例并按保留策略归档/清理 Reporter 状态，或改用新的隔离状态目录运行；不要删除仍在运行场景的轨迹文件。

## 本地 API

Reporter 路径为 `/orchestrator/reporter/`，与管理面板的 `/orchestrator/api/` 分开。请求需要同源请求头，例如直接用本地客户端时：

```sh
curl --fail-with-body \
  -H 'Host: 127.0.0.1:3082' \
  -H 'Origin: http://127.0.0.1:3082' \
  -H 'x-orchestrator-request: 1' \
  -H "Authorization: Bearer $DSH_SUPERAGENT_REPORTER_TOKEN" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:3082/orchestrator/reporter/scenarios \
  --data-binary @scenario.json
```

主要接口如下：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /scenarios` | 注册场景，响应只包含 Simulator 安全投影，不含 Oracle |
| `GET /scenarios/:id/simulator` | 读取 Simulator 可见的场景和 Persona |
| `POST /events` | 提交一个带类型的 Actor 动作，响应只确认 Trigger 已经过正常接收入口 |
| `GET /scenarios/:id` | 获取固定场景结果、确定性 Oracle 和本地证据；只给测试管理方使用 |
| `POST /scenarios/:id/complete` | 标记场景终止，计算最终确定性结果 |
| `GET /scenarios/:id/trace` | 导出带摘要的完整 JSONL 轨迹 |
| `GET /scenarios/:id/replay` | 不调用模型，根据已存轨迹重建 Reporter 读模型和 checkpoint 列表 |

事件请求示例：

```json
{
  "scenario_id": "pull-request-follow-up",
  "scenario_version": 1,
  "sequence": 1,
  "idempotency_key": "pull-request-follow-up:1",
  "simulated_at": "2026-10-01T12:00:00.000Z",
  "actor_id": "alice",
  "project_source_id": "github-0123456789abcdef01234567",
  "thread_id": "17",
  "action": {
    "kind": "message",
    "text": "@superagent 请修复这个回归问题，并补一条测试。",
    "addressed": "mention"
  }
}
```

每个动作必须使用下一个单调 `sequence`。相同场景中重复提交相同 `idempotency_key` 和完全相同的事件会返回原 ACK，不会再次进入 Engine；同一个幂等键对应不同内容会返回冲突。乱序和缺号事件会被拒绝，不会改动当前序号。

Reporter 生成的 Trigger 使用目标 ProjectSource 作为 source 和 Actor source，走该项目的策略和权限；Channel 单独使用 `local-reporter`，由 Outbox 本地捕获并标记送达。此 Channel 不会转发给 Provider。模拟动作不会伪造 GitLab API 回复、真实 Approval/Pipeline 对象或外部平台状态。

## 脚本回归与原生 DSH Reporter

固定回归优先使用 `runReporterScript()`：它不调用模型，按明确的用户事件顺序验证策略、幂等、路由、Oracle 和本地回复。自主探索由独立的原生 DSH Reporter Session 承担，不再由外部协调器、嵌套 Simulator 或 Reviewer 驱动。

## 自主测试运行

固定脚本用于稳定回归；自主报告者接收产品级目标、ProjectSource 和明确授权的测试通道，在独立 DSH Session 中自行观察、选择动作、根据真实反馈继续调查并形成报告。调用方不预先指定测试步骤或缺陷。

运行接口位于 `/orchestrator/reporter/runs`，仍要求上文的 loopback、同源请求头及 capability 认证：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /runs` | 以幂等键提交测试目标、项目及权限，异步启动原生 Reporter Session |
| `GET /runs` | 查看有界的运行列表 |
| `GET /runs/:id` | 查看 Reporter Session 状态和已提交报告 |
| `POST /runs/:id/cancel` | 使用 DSH Agent 原生取消当前 Reporter Session |
| `GET /orchestrator/api/reporter` | 管理页的只读状态投影，不含 capability、认证或隐藏 Oracle |

例如下面的启动输入只描述测试目标，不指定测试场景和操作顺序；将项目 ID 换成实际已启用的来源：

```json
{
  "idempotency_key": "explore-product-v1",
  "project_source_id": "github-0123456789abcdef01234567",
  "goal": "从首次使用的维护者视角，自主探索需求处理与后续沟通是否清楚、正确；根据实际反馈选择测试，保留疑点的复现证据。",
  "mode": "simulation",
  "permissions": { "simulation": true }
}
```

`mode` 可选 `simulation`、`real-service`、`browser` 或 `both`（仿真与只读接口）。每种能力还必须在 `permissions` 中显式开启，未声明的权限默认关闭。Reporter 使用 DSH 当前默认模型与 DSH 原生会话生命周期；仅当精确模型路由声明支持时才优先使用 `xhigh`，否则沿用该路由已选或默认的推理等级。产品不另建模型循环、调用/Token/实验预算、无进展提醒或运行截止时间。显式取消、Runtime 关闭以及 DSH/模型/工具真实错误仍按各自生命周期结束。

仿真动作经现有 LocalReporter、Runtime 和 Engine；每条动作都等待真实 Superagent 目标响应，不能伪造回复。开启仿真权限时，Reporter 可按需读取当前运行公开的 Persona、允许 Actor、已有对话和下一序号；该工具绑定当前 DSH Session 所属场景，不接受模型传入场景 ID，也不返回隐藏 Oracle。只读服务能力访问固定枚举管理接口。浏览器能力使用受限 Playwright Chromium 观察和操作本地管理页面；不能用接口探测代替页面操作。

每次 Reporter 运行有一个真实、可恢复、可从 DSH 会话目录打开的 Session。superagent 页面只保留会话 ID、状态和报告投影；Session 历史、工具轮次、Inbox、用量与渲染由 DSH 持有。

运行可选绑定 `ticket_id` 以提供执行者工作区作为证据来源。服务端校验 Ticket 与 ProjectSource 后，把 Reporter Workspace 指向该工单的 `execution.directory`；工单完成后，只要目录仍存在，仍可只读复核。是否查看实现、测试或报告，以及查看哪些文件，由 Reporter 根据目标自行决定；启动提示不会规定先读什么或必须完成哪些检查。未绑定工单时不开放文件读取/搜索工具。Reporter 永远不能写文件、执行 shell、改变 Ticket 或直接派工。

Reporter 发现候选或需要澄清时调用 `reporter_candidate`，本地 relay 即时把观察送入 Orchestrator 主 Session。Orchestrator 可调用 `orchestrator_reporter_reply`，沿用执行者输入使用的 DSH steer 投递，把回复放入同一个 Reporter Session 当前轮可读取的下一步 Inbox。Reporter 读取回复后可自行决定如何继续调查。候选不等同于修复授权；是否值得修复、是否派给执行者仍由 Orchestrator 判断。

完成后 Reporter 调用 `reporter_submit_report`，提交一段摘要和自由文本完整报告；不要求 JSON 或固定模板。报告同时显示在 Superagent 管理页并经本地 relay 交给 Orchestrator。页面使用已有 `MarkdownLite` 和 `SessionButton`；完整对话历史只由 DSH Session 保存与原生呈现，不复制一份 transcript 或 renderer。

启用 Reporter 不会自动启动测试或产生模型调用。DSH Runtime 重启时，Reporter 复用同一 Session ID 和既有会话历史；长时间无输出不会产生 Reporter 专用提醒或自动停止。管理页状态来自 DSH Agent 与 Reporter 已提交的报告投影。

浏览器登录由运行时通过 DSH 官方 Connection 服务取得临时登录地址，驱动在浏览器内部交换 Cookie；认证地址、Cookie、Reporter capability 和模型密钥不进入模型或轨迹。页面驱动限制到同一 loopback 服务，禁止外站与文件传输。该约束不替代 Worker 的操作系统隔离，仿真导致的 Worker 行为仍遵守前文的独立测试环境边界。

## Oracle 与结果含义

Oracle 断言包括接收结果、Decision 类型、Ticket 数量和终态、Worker report 状态、本地输出数量及禁止 Ticket/输出。它根据结构化 Store 快照和本地 Sink 输出计算，不进入 Reporter Session，也不由 Reporter 改写。Reporter 的候选只代表待 Orchestrator 评估的观察；要确认产品状态仍需检查对应确定性证据。

固定场景的本地终态结果分成：

- `behavioral_pass`：场景要求的策略、Decision、Ticket 和行为断言。
- `delivery_pass`：场景要求的本地回复/输出是否出现以及次数是否正确；场景没有交付断言时为 `null`。
- `platform_pass`：本地 Reporter 固定返回 `null`，因为它没有验证真实 GitHub/GitLab 网络、字段或消息交付。

`/replay` 是对不可变 Reporter JSONL 记录的确定性重建，不会重新提交 Trigger，也不会重新运行目标 Superagent 或再次调用 LLM。已注册场景的定义和版本不可原地修改；若要复跑被测 Agent，应使用新的场景 ID，并在独立状态库中运行，避免将两次结果混成一条轨迹。

## 测试层级

1. **本地行为覆盖**：固定场景事件经过 Engine；验证策略、项目身份、重复/乱序、checkpoint、Oracle 和本地输出 Sink。自主 Reporter 以独立 DSH Session 运作，不另建模型协调器或对话存储。
2. **Fake GitLab 覆盖**：通过 fake `glab` 或 fake 服务验证 CLI/JSON/分页/错误处理；不需要 VPN。
3. **真实宿主 VPN 覆盖**：使用一次性内网 GitLab 项目和独立 Reporter 账号，验证认证、Issue/MR 评论交付及少量 MR/Pipeline 生命周期；VPN 路由由宿主提供。

三层分别报告，不把 Local Reporter 的 `behavioral_pass` 或 `delivery_pass` 写成真实平台通过。

## 真实 GitLab 验证入口

`tests/gitlab-vpn-e2e.spec.ts` 默认跳过。先由宿主连上 VPN、配置可信 CA/代理，并在独立 `GLAB_CONFIG_DIR` 中完成 `glab auth login --hostname <内网 host>`。真实测试必须使用有默认分支、允许创建分支和 MR 的一次性项目，再显式启用：

```sh
export DSH_SUPERAGENT_GITLAB_E2E=1
export DSH_SUPERAGENT_GITLAB_E2E_DISPOSABLE=1
export DSH_SUPERAGENT_GITLAB_E2E_HOST=gitlab.internal.example
export DSH_SUPERAGENT_GITLAB_E2E_PROJECT=test-group/superagent-e2e
export DSH_SUPERAGENT_GITLAB_E2E_CONFIG_DIR=/绝对路径/独立的-glab-配置目录
# 可选：DSH_SUPERAGENT_GITLAB_E2E_CLI 指定 glab 绝对路径。
pnpm exec vitest run tests/gitlab-vpn-e2e.spec.ts
```

测试会创建临时 Issue、带测试文件的分支和 Draft MR，分别发送并重试 Issue/MR 评论，检查每条评论只有一份，再验证 MR 从打开到关闭。最后关闭本测试创建的 Issue/MR 并删除测试分支，评论和关闭记录仍保留在一次性项目中；分支提交也可能触发项目已有的 CI。清理失败会让测试失败并提示检查测试资源。

该测试检查真实 Provider 认证与交付，不调用自主 Reporter 或被测 Superagent 模型。Pipeline 读取会核对当前 head SHA；无 Pipeline 时不能宣称 CI 通过。它也不执行真实 `git push`，不能代替宿主 Git 凭据与分支保护的专项验证。未显式设置门控变量时，测试结果为跳过，平台与 VPN 均未验证。
