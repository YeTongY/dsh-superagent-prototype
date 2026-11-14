# 010 本地 Reporter 与行为测试

本地 Reporter 用来低成本验证 Superagent 的正常行为路径。测试动作仍经 `Runtime.receive()`、Engine、策略评估、Ticket 和 Outbox 处理；Reporter 不直接写业务数据库，也不会把输出发到 GitHub、GitLab 或 Feishu。

它适合验证 Agent 是否理解请求、创建或停止正确的工作、处理追问和审查意见、在 CI 变化后采取合理动作，以及是否产生了预期回复。它不证明 GitLab API、TLS、VPN 路由或真实消息交付正常；这些要用 Fake GitLab 和少量宿主 VPN E2E 覆盖。

## 参考实现与本项目取舍

本设计参考了以下成熟项目（调研日期：2026-11-14），并结合本项目的运行边界取舍：

- [**tau2-bench**](https://github.com/sierra-research/tau2-bench)：借鉴场景、Persona、类型化用户动作与确定性状态评估分离的做法。它面向通用对话环境；本项目的动作直接适配 Superagent 的 Trigger、ProjectSource 和 Ticket。
- [**Inspect AI**](https://github.com/UKGovernmentBEIS/inspect_ai)：借鉴每个样本有稳定身份、轨迹和评分边界的做法。本项目使用自己的 JSONL 记录和现有 Runtime，不引入另一套评估框架。
- [**OpenART**](https://github.com/AI45Lab/OpenART)：借鉴隐藏 Oracle、checkpoint 和禁止副作用断言。目标 Superagent 与用户模拟器看不到 Oracle；定性 Reviewer 也不能覆盖 Oracle 结论。
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

轨迹以权限 `0600` 的 JSONL 文件保存在 `<stateDir>/reporter/`，每个场景独立一个文件。轨迹可能包含模拟用户的文字、Agent 回复、场景标识和结构化运行状态；应像测试日志一样限制访问和保留时间，不要把包含真实代码或内部讨论的轨迹公开上传。

## 场景定义

一个场景绑定一个已启用的 ProjectSource、一个目标 Thread 和一个或多个 Actor。场景必须包含至少一个确定性 Oracle 断言。Simulator 只能取得 `visible`、Actor 名单和场景基本信息；`oracle` 只进入本地结果和导出的轨迹。

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
| `GET /scenarios/:id` | 获取结果、确定性 Oracle、用量记录和完整本地证据；只给协调器或报告查看方使用 |
| `GET /scenarios/:id/review-input` | 获取不含 Oracle 的 Reviewer 证据；不要用完整场景结果构造 Reviewer 输入 |
| `POST /scenarios/:id/complete` | 标记场景终止，计算最终确定性结果 |
| `POST /scenarios/:id/review` | 记录定性 Reviewer 总结；不能更改 Oracle 断言或通过状态 |
| `POST /scenarios/:id/usage` | 记录一个角色的模型、Token、成本、时延和重试数据 |
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

## 脚本模拟器与真实行为模拟

多数回归场景应使用确定性脚本：按顺序提交用户请求、Bot 评论、Review、CI 变化、追问、重复事件和停止请求。脚本可推进模拟时间并声明某个乱序或越权动作预期被拒绝；动作语句仍由现有策略判定。`runReporterScript()` 不调用模型，Simulator 成本记录为 0，`model_calls` 为 0。

当需要更自然的对话时，可由一个外部低成本模型实现 User Simulator：它只读取 `/simulator` 和目标可见的 Reporter 输出/状态，根据 Persona 逐步产生 `action`，并通过 `/events` 提交。协调器应每步等待或观察目标可见结果，再决定下一步；不要预先把完整隐藏 Oracle 或之后的测试事件注入 Simulator。高成本模拟和审查只对高风险场景开启。

代码协调器只在调用者显式注入模型函数后才会请求模型。每次调用前都会检查剩余预算；费用或 Token 用量未知时，不会继续提交新的模拟动作。模型调用超时或抛错仍记为一次调用，成本和 Token 记为未知，实测时延单独保留，不会按零计算。预算字段必须是有限、非负且范围合理的数值：`max_calls` 为 0–200，`max_cost_usd` 为 0–1,000,000，`max_total_tokens` 为 0–10,000,000，`timeout_ms` 为 1–86,400,000；Simulator 的 `maxTurns` 为 1–200。预算耗尽后不会再发起模型调用。

公开入口为 `dsh-superagent/reporter`。在持有测试 Runtime 的协调进程中，可以复用其 `reporter`，注入选定模型和等待目标回复的函数：

```ts
import { runUserSimulator, runQualitativeReviewer } from 'dsh-superagent/reporter'

const simulation = await runUserSimulator({
  reporter, scenarioId: 'pull-request-follow-up',
  invoke: callLowCostModel,
  waitForSuperagent: waitUntilTargetResponds,
  maxTurns: 8,
  budget: { max_calls: 10, max_cost_usd: 0.1, max_total_tokens: 12000, timeout_ms: 120000 },
})
// 按场景风险或采样策略显式决定是否审查。
const review = await runQualitativeReviewer({
  reporter, scenarioId: simulation.scenario_id,
  invoke: callReviewerModel,
  budget: { max_calls: 1, max_cost_usd: 0.05, max_total_tokens: 4000 },
})
```

示例中的模型函数和等待函数由调用方实现。模型函数接收安全投影、`instructions`、`signal` 和 `remaining_budget`，返回 `{ output, usage }`；`usage` 可包含 `model`、`prompt_tokens`、`completion_tokens`、`cost_usd`、`latency_ms` 和 `retries`。等待函数应在可见回复到达或目标本轮处理结束后返回，并遵守中止信号；只等待 Trigger 入库不能说明 Agent 已完成响应。

协调器能阻止后续调用，无法撤销模型服务已经计费的请求。调用方仍需把剩余 Token/费用限制传给模型服务，并正确取消进行中的请求；单次超支或中止后的服务端费用必须如实计量。没有注入模型函数时，不会因启用 Reporter 自动产生额外模型调用。

目标 Superagent 的模型调用成本默认无法按场景自动归属，因为主 Session 可能同时处理多个场景和其他工作。只有外部 Runner 确实掌握对应 Token、时延、成本和重试时，才调用 `/usage` 记录 `role: "superagent"`。没有提供的成本保持未知，不能当作 0。脚本 Simulator 的零成本只表示它没有调用模型。

## 自主测试运行

固定脚本用于稳定回归；自主报告者接收的是产品级目标、ProjectSource、允许的测试通道和有限预算。它自行观察运行状态、选择实验、根据真实反馈调整测试，最后保存发现与复现证据。调用方不需要先为它编写完整场景。

运行接口位于 `/orchestrator/reporter/runs`，仍要求上文的 loopback、同源请求头及 capability 认证：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /runs` | 以幂等键提交测试目标、项目、权限和预算，异步返回运行状态 |
| `GET /runs` | 查看有界的运行列表 |
| `GET /runs/:id` | 查看阶段、实际调用数及结果 |
| `POST /runs/:id/cancel` | 中止后续测试动作和模型请求 |
| `POST /runs/:id/report` | 重投已存档的终态报告，不重新执行测试或调用 Reporter 模型 |
| `GET /orchestrator/api/reporter` | 管理页的只读状态投影，不含 capability、认证或隐藏 Oracle |

例如下面的启动输入只描述测试目标，不指定测试场景和操作顺序；将项目 ID 换成实际已启用的来源：

```json
{
  "idempotency_key": "explore-product-v1",
  "project_source_id": "github-0123456789abcdef01234567",
  "goal": "从首次使用的维护者视角，自主探索需求处理与后续沟通是否清楚、正确；根据实际反馈选择测试，保留疑点的复现证据。",
  "mode": "simulation",
  "permissions": { "simulation": true },
  "budget": {
    "max_model_calls": 12,
    "max_actions": 4,
    "max_experiments": 1,
    "max_total_tokens": 100000,
    "timeout_ms": 600000
  }
}
```

`mode` 可选 `simulation`、`real-service`、`browser` 或 `both`（仿真与接口）。接口测试需 `read_only_service: true`；浏览器测试需同时声明 `browser: true` 和 `read_only_service: true`。未声明的权限默认关闭。预算限制的是 Reporter 后续调用；被测 Superagent 的模型消耗单独记录，不能把 Reporter 的 Token 上限冒充整个系统的总费用上限。`max_total_tokens` 是累计已报告用量的停止阈值，本次输出另按剩余额度限制；单次输入用量在模型返回前无法精确计量，可能跨过阈值。越过时保留实际 Token，运行标为未完成并停止后续调用，不把已知用量改成未知。

仿真通道通过独立用户模拟上下文产生动作，动作仍进入真实 Runtime/Engine；每轮等待目标实际处理后，才将公开回复用于下一轮。只读服务通道访问当前实例的实际管理 HTTP 接口。浏览器通道使用可选的 Playwright Chromium，在独立上下文中观察真实页面并执行有限动作；没有安装浏览器或无法登录时明确报告不可用，不用接口结果代替页面操作证据。

探索者、Simulator 和 Reviewer 的模型请求均显式使用 `medium`，目标 Superagent 的模型配置独立。模型路由与认证复用 DSH 原生服务，不增加另一套 Responses 客户端。启动前校验模型是否支持 medium；运行中显示实际选择的模型及调用次数。费用未知保持未知，缓存读取计入输入 Token；不能由测试调用数直接推导节省了多少成本。

一次实例只运行一个自主测试。重复幂等请求返回原运行；取消、运行时关闭或预算耗尽后不再发起后续动作。重启不自动恢复付费任务。管理页将“已启用但未运行”与“正在测试”分开，并展示实验、用户动作、模型调用、摘要和发现。发现分为候选、已确认、测试本身无效；只有可验证证据支持的结果才能作为确认缺陷，模型怀疑不能直接升级为事实。

`budget.timeout_ms` 表示连续没有真实进展的观察窗口，不再表示从启动算起的总时长。Reporter 模型产生非空内容或推理增量、完成模型调用或实际操作，以及当前场景相关目标会话与领域状态发生有效变化时，重新计算无进展时间。定时轮询、一直显示“忙”、空流帧和单纯重试不算进展；仍有真实进展的研究可以跨过原来的十分钟总时长。持续无进展才标记为未完成，并保留此前动作和证据；该状态说明测试等待停滞，不能据此判定产品缺陷。用户取消和运行时关闭仍立即生效，模型调用数、动作数、实验数和 Token 预算继续限制新增测试工作。

管理页按运行卡片展示模式、状态、中文失败原因和关键计数，完整目标、模型、费用细项、实验过程及证据放在可展开的运行详情中。格式校验失败仅保留有界字段路径和错误码，不显示完整模型输出或认证数据。模拟器的字段约束由实际 Zod schema 生成，仍由模拟器自主选择动作内容。

测试结束后，Reporter 先持久化终态与报告，再直接通过本地 DSH Agent/Session 入口把报告送到 Orchestrator 主会话。报告包含公开仿真对话、浏览器逐步操作、观察、候选发现和证据定位；隐藏 Oracle 规则和原始页面快照不进入主会话。报告按纯文本标题、编号和换行组织，不依赖用户消息的 Markdown 渲染。管理页在报告确认送达且具有真实主会话 ID 后显示“在 DSH 中查看报告”，复用现有会话导航，交由 DSH 原生 Chat/Trajectory 展示。

`report_delivery.status` 为 `pending`、`delivered` 或 `failed`。`delivered` 只表示报告已进入并持久化到主会话，不代表模型已经阅读或处理。首次交付的报告固定存档；重试复用同一运行 ID 和正文，接收端按稳定消息 ID 去重。重启仅恢复待交付报告，不恢复付费测试；失败或旧版未交付报告可通过受保护的重投接口补交。此路径不创建新的平台事件、工单或测试动作，不发送 GitHub/GitLab 消息。

浏览器登录由运行时通过 DSH 官方 Connection 服务取得临时登录地址，驱动在浏览器内部交换 Cookie；认证地址、Cookie、Reporter capability 和模型密钥不进入模型或轨迹。页面驱动限制到同一 loopback 服务，禁止外站与文件传输。该约束不替代 Worker 的操作系统隔离，仿真导致的 Worker 行为仍遵守前文的独立测试环境边界。

## Oracle、Reviewer 与结果含义

Oracle 断言包括接收结果、Decision 类型、Ticket 数量和终态、Worker report 状态、本地输出数量及禁止 Ticket/输出。它根据结构化 Store 快照和本地 Sink 输出计算；Reviewer 文本不会成为这些断言的输入，也不能覆盖失败。Reporter 无法读取 Runtime 快照时会明确报告 `snapshot_available: false`，依赖快照的断言失败。

终态结果分成：

- `behavioral_pass`：场景要求的策略、Decision、Ticket 和行为断言。
- `delivery_pass`：场景要求的本地回复/输出是否出现以及次数是否正确；场景没有交付断言时为 `null`。
- `platform_pass`：本地 Reporter 固定返回 `null`，因为它没有验证真实 GitHub/GitLab 网络、字段或消息交付。

Reviewer 使用 `/review-input` 返回的可见对话、输出和结构化状态，生成简短总结、带证据的发现与异常解释。Reviewer 请求不包含隐藏 Oracle；其输出只作为定性报告附加保存。最终报告应同时保留确定性结果、Reviewer 总结及各角色独立的成本和时延数据。

`/replay` 是对不可变 Reporter JSONL 记录的确定性重建，不会重新提交 Trigger，也不会重新运行目标 Superagent 或再次调用 LLM。已注册场景的定义和版本不可原地修改；若要复跑被测 Agent，应使用新的场景 ID，并在独立状态库中运行，避免将两次结果混成一条轨迹。

## 测试层级

1. **本地行为覆盖**：Reporter 事件经过 Engine；验证策略、项目身份、重复/乱序、checkpoint、Oracle、Reviewer 边界和本地输出 Sink。
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

该测试检查真实 Provider 认证与交付，不调用 Simulator、Reviewer 或被测 Superagent 模型。Pipeline 读取会核对当前 head SHA；无 Pipeline 时不能宣称 CI 通过。它也不执行真实 `git push`，不能代替宿主 Git 凭据与分支保护的专项验证。未显式设置门控变量时，测试结果为跳过，平台与 VPN 均未验证。
