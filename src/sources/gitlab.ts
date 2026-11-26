/** GitLab Source: glab-backed polling, project-scoped policy, context, delivery, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { CliError } from '../infra/commands.ts'
import { glabFor, GitlabProjectConfigSchema } from '../infra/gitlab.ts'
import { projectPoll } from './poll.ts'
import { family, record } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { sourceContext, health, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { sendGitlab, gitlabAddressAllowed, gitlabLink } from './gitlab-channel.ts'
import { gitlabCiCounts, gitlabCiFact, gitlabCiSummary, gitlabThreadContext, readGitlabCi, readGitlabMergeRequestPipelines,
  readGitlabPipelines } from './gitlab-read.ts'
import { approvalTrigger, gitlabThreadId, issueTrigger, GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, mergeRequestTrigger,
  noteTrigger, pipelineTrigger, SOURCE, type GitlabIssue, type GitlabMergeRequest, type GitlabResourceKind } from './gitlab-trigger.ts'
import { mergeRequestsOf, observeGitlabMergeRequest, readGitlabMergeRequestForContext } from './gitlab-pull.ts'

const GitlabConfigSchema = GitlabProjectConfigSchema.safeExtend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false), observePipelines: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const GitlabObservedConfigSchema = z.object({
  observeIssues: z.boolean().optional(), observeMergeRequests: z.boolean().optional(),
  observeComments: z.boolean().optional(), observePipelines: z.boolean().optional(),
})
const OBSERVED = { issues: 'observeIssues', merge_requests: 'observeMergeRequests', comments: 'observeComments', ci: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'approval') return 'comments'
  if (meta.projectPipeline === true) return 'ci'
  if (meta.ci === true || meta.kind === 'pipeline') return undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'merge_request' || meta.isMr === true || meta.isPr === true) return 'merge_requests'
  return undefined
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '使用 glab 监听 GitLab 项目的 Issue、合并请求、讨论与流水线。每个项目使用独立的 glab 配置目录。',
    en: 'Uses glab to watch a GitLab project for Issues, Merge Requests, discussions, and pipelines. Each project has an isolated glab configuration directory.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'repository', type: 'text', label: { zh: '监听的项目路径', en: 'Project to watch' },
      hint: { zh: '写作 group/subgroup/project。保存时通过 glab 检查当前账号的读取与推送权限。', en: 'Use group/subgroup/project. Saving checks project read and push access through glab.' } },
    { key: 'host', type: 'text', label: { zh: 'GitLab 域名', en: 'GitLab host' },
      hint: { zh: '只填主机名和可选端口，不带 https:// 或路径。内网 VPN 路由由宿主机提供。', en: 'Enter the hostname and optional port, without https:// or a path. The host provides VPN routing.' } },
    { key: 'cli', type: 'text', label: { zh: 'glab 可执行文件', en: 'glab executable' }, hint: { zh: '命令名或绝对路径。需要 glab 1.50 或更新版本。', en: 'A command name or absolute path. Requires glab 1.50 or newer.' } },
    { key: 'configDir', type: 'text', label: { zh: '独立 glab 配置目录', en: 'Isolated glab config directory' },
      hint: { zh: '绝对路径；留空时按状态目录、域名和项目自动生成。不同 GitLab 项目不能共用目录。', en: 'Absolute path; when empty it is derived from the state directory, host, and project. GitLab projects cannot share this directory.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '内网 GitLab 繁忙时可调大，各项目独立轮询互不影响。', en: 'Increase this for a busy self-managed GitLab; each project has its own poll loop and health.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报错', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次 VPN 或网络波动会在下一轮自动重试。', en: 'A one-off VPN or network interruption retries on the next poll.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的全部新 Issue', en: 'Receive all new project Issues' },
      hint: { zh: '开启后，未 @ 智能体的新 Issue 也会进入触发权限判断。', en: 'When enabled, new Issues without an agent mention also reach AI assessment.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的全部新合并请求', en: 'Receive all new project Merge Requests' },
      hint: { zh: '开启后，未 @ 智能体的新合并请求也会进入触发权限判断。', en: 'When enabled, new Merge Requests without an agent mention also reach AI assessment.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收全部讨论和审批变化', en: 'Receive all discussions and approvals' },
      hint: { zh: '开启后，未 @ 智能体的新评论和审批变化也会进入触发权限判断。', en: 'When enabled, new comments and approval changes without an agent mention also reach AI assessment.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收项目流水线变化', en: 'Receive project pipeline changes' },
      hint: { zh: '接收项目流水线状态变化；已关联工单的合并请求流水线始终会自动跟踪。', en: 'Receive pipeline status changes; pipelines for Merge Requests bound to tickets are observed regardless of this switch.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...(row ? { row } : {}) }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink, allowed: gitlabAddressAllowed },
  threadContext: gitlabThreadContext,
  find: query => {
    const link = /https?:\/\/[^/\s]+\/.+?\/-\/(issues|merge_requests)\/([1-9]\d*)(?=[/?#\s]|$)/i.exec(query)
    if (link) return { threads: [`${SOURCE}:${link[1]!.toLowerCase() === 'issues' ? 'issue' : 'mr'}:${link[2]}`], terms: [] }
    const number = /^#?!?([1-9]\d*)$/.exec(query.trim())
    return number ? { threads: [`${SOURCE}:issue:${number[1]}`, `${SOURCE}:mr:${number[1]}`], terms: [] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+(?:\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许直接派活的 GitLab 账号', en: 'Allowlisted GitLab accounts' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'GitLab 用户名', en: 'Username' }, pattern: '[A-Za-z0-9_.-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '允许触发 AI 判断的机器人', en: 'Bots whose comments AI may assess' },
      hint: { zh: '白名单中的机器人评论会交给 AI 判断是否接单，不能直接下指令或停止工单。', en: 'Comments from listed bots are sent to AI assessment, and cannot directly start or stop a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '机器人用户名', en: 'Bot username' }, pattern: '[A-Za-z0-9_.-]+(\\[bot\\])?' }] }],
    explicit: { zh: '白名单成员在 Issue 或合并请求描述、评论中 @ 智能体时，始终直接接单。', en: 'An allowlisted GitLab user mentioning the agent in an Issue or Merge Request always starts a Ticket directly.' },
    rows(stored) {
      const config = GitlabObservedConfigSchema.parse(stored)
      const row = (id: Scope, label: Localized) => ({ id, label, note: config[OBSERVED[id]] ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merge_requests', { zh: '新合并请求', en: 'New Merge Requests' }),
        row('comments', { zh: '讨论和审批', en: 'Discussions and approvals' }),
        { id: 'ci', label: { zh: '项目流水线', en: 'Project pipelines' }, note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '此工单 GitLab 来源的主机名。', en: 'GitLab host of this ticket source.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '此工单 GitLab 项目的 group/subgroup/project 路径。', en: 'group/subgroup/project path of this ticket source.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '当前 glab 配置目录登录的 GitLab 用户名。所有 GitLab 操作都用此项目身份。', en: 'GitLab username authenticated in this glab config directory. Use this project identity for all GitLab operations.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。优先使用设置中的公开邮箱，否则用 GitLab noreply 格式。', en: 'Commit email for the agent. The public email is preferred; otherwise a GitLab noreply address is used.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ISSUE_IID', description: { zh: '接下工单的 Issue IID；不是 Issue 工单时为空。', en: 'IID of the Issue that started the ticket; empty otherwise.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_IID', description: { zh: '接下工单的合并请求 IID；不是 MR 工单时为空。', en: 'IID of the Merge Request that started the ticket; empty otherwise.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR head 分支；不是 MR 工单时为空。', en: 'Source branch of the Merge Request that started the ticket; empty otherwise.' } },
    ],
    values: ({ deployment, trigger }) => {
      const project = deployment.activeProject
      const kind = trigger?.meta.isMr === true || trigger?.meta.isPr === true ? 'merge_request' : trigger?.meta.kind === 'issue' ? 'issue' : undefined
      const iid = Number(trigger?.meta.iid ?? trigger?.meta.number) || 0
      const mr = kind === 'merge_request' && iid > 0
      const issue = kind === 'issue' && iid > 0
      return {
        DSH_SUPERAGENT_GITLAB_HOST: project?.provider === 'gitlab' ? project.host : '',
        DSH_SUPERAGENT_GITLAB_PROJECT: project?.provider === 'gitlab' ? project.project : '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: project?.provider === 'gitlab' ? project.login : '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: project?.provider === 'gitlab' ? project.noreply : '',
        DSH_SUPERAGENT_GITLAB_ISSUE_IID: issue ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_IID: mr ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: mr && typeof trigger?.meta.sourceBranch === 'string' ? trigger.meta.sourceBranch : '',
      }
    },
  },
  facts: (deployment): Record<string, string | Localized> => deployment?.activeProject?.provider === 'gitlab' ? {
    cli: { zh: `当前账号 @${deployment.activeProject.login}`, en: `Current account @${deployment.activeProject.login}` },
    host: deployment.activeProject.host,
  } : {},
}

export { GitlabConfigSchema }
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const sources = ctx.orchestrator.sources.instances().filter(instance => instance.kind === SOURCE && instance.installed)
    const running = sources.map(instance => {
      const source = sourceContext(ctx.orchestrator, { ...gitlabKind, id: instance.id })
      const controller = new AbortController()
      return { source, controller, promise: watch(source, controller.signal).catch((error: unknown) => {
        source.report('gitlab', { state: 'error', detail: String(error) })
      }) }
    })
    return async () => { for (const item of running) item.controller.abort(); await Promise.all(running.map(item => item.promise)) }
  })
}

const CURSOR = record<string>('gitlab-since')
const ISSUE_CI = family<{ sha: string; fingerprint: string; revision: number }, [iid: number]>('gitlab-mr-ci:')
const MR_APPROVAL = family<{ approved: boolean; revision: number }, [iid: number]>('gitlab-mr-approval:')
const PIPELINES = record<Record<string, { status: string; sha: string; revision: number }>>('gitlab-pipelines')
const RETRY_WINDOW_MS = 24 * 3600_000

/** Reports after `threshold` consecutive failures; a one-off host/VPN failure retries quietly. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60, failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) {
        interval = await projectPoll(() => pollRound(ctx, signal), signal)
        failures = 0
      } else ctx.report(SOURCE, health('paused', 'sourceOff'))
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface PollRound { started: string; since: string; failures: string[]; dropped: string[]; tally: { skipped: number } }
function apiProjectPath(ctx: SourceContext): string { return glabFor(ctx.commands).projectPath }
function configOf(ctx: SourceContext): GitlabConfig | undefined { return ctx.config<GitlabConfig>(SOURCE) }
function stopped(ctx: SourceContext, round: PollRound, signal: AbortSignal): boolean { return signal.aborted || !ctx.config(SOURCE) }
function query(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
  return `${path}?${params.toString()}`
}

/** One project-local poll round: updated Issues/MRs, notes, MR lifecycle/approvals/CI, project pipelines and subscribed threads. */
export async function pollRound(ctx: SourceContext, signal = new AbortController().signal): Promise<number> {
  const started = new Date().toISOString()
  const previous = ctx.state.get(CURSOR)
  const since = previous ?? started
  const round: PollRound = { started, since, failures: [], dropped: [], tally: { skipped: 0 } }
  const config = configOf(ctx)
  if (!config) return 60
  const commands = ctx.commands.withSignal(signal)
  const runner = glabFor(commands)
  try {
    const issueItems = await runner.pages(GitlabIssueSchema, query(`${apiProjectPath(ctx)}/issues`, { state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc', per_page: 100 }), round.tally)
    for (const issue of issueItems) {
      if (stopped(ctx, round, signal)) return config.pollSeconds
      if (!sameName(issue.author.username, ctx.deployment.activeProject?.login ?? '')) {
        if (Date.parse(issue.created_at) >= Date.parse(since)) {
          await ctx.receive(issueTrigger(issue, ctx.deployment.activeProject?.login ?? '', runner.options.host, runner.options.project))
          nameThread(ctx, 'issue', issue.iid, issue.title, issue.web_url)
        }
      }
      await intakeNotes(ctx, round, 'issue', issue, signal)
    }
    const mergeRequests = await runner.pages(GitlabMergeRequestSchema, query(`${apiProjectPath(ctx)}/merge_requests`,
      { state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc', per_page: 100 }), round.tally)
    for (const mr of mergeRequests) {
      if (stopped(ctx, round, signal)) return config.pollSeconds
      const login = ctx.deployment.activeProject?.login ?? ''
      if (!sameName(mr.author.username, login) && Date.parse(mr.created_at ?? '') >= Date.parse(since)) {
        await ctx.receive(mergeRequestTrigger(mr, login, runner.options.host, runner.options.project))
        nameThread(ctx, 'merge_request', mr.iid, mr.title, mr.web_url)
      }
      await intakeNotes(ctx, round, 'merge_request', mr, signal)
      if (await observeGitlabMergeRequest(ctx, mr)) continue
    }
    await pollTicketMergeRequests(ctx, round, mergeRequests, signal)
    if (config.observePipelines) await pollProjectPipelines(ctx, round, mergeRequests, signal)
    await pollSubscribedThreads(ctx, round, signal)
  } catch (error) {
    if (!signal.aborted) round.failures.push(String(error))
  }
  if (signal.aborted || !ctx.config(SOURCE)) return config.pollSeconds
  if (round.failures.length) {
    if (previous === undefined) ctx.state.set(CURSOR, since)
    throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  }
  ctx.state.set(CURSOR, cursorAt(started))
  const dropped = round.dropped.length ? `; deleted resources: ${round.dropped.slice(0, 5).join(', ')}` : ''
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report(SOURCE, { state: 'ready', detail: `GitLab ${runner.options.host}/${runner.options.project}; poll ≥ ${config.pollSeconds}s${dropped}${skipped}`, at: started })
  return config.pollSeconds
}

async function intakeNotes(ctx: SourceContext, round: PollRound, kind: GitlabResourceKind, item: GitlabIssue | GitlabMergeRequest, signal: AbortSignal): Promise<void> {
  const runner = glabFor(ctx.commands.withSignal(signal))
  const endpointKind = kind === 'issue' ? 'issues' : 'merge_requests'
  const login = ctx.deployment.activeProject?.login ?? ''
  const notes = await runner.pages(GitlabNoteSchema,
    `${apiProjectPath(ctx)}/${endpointKind}/${item.iid}/notes?sort=asc&order_by=created_at&per_page=100`, round.tally)
  for (const note of notes) {
    if (stopped(ctx, round, signal)) return
    if (note.system || sameName(note.author.username, login)) continue
    const at = Date.parse(note.updated_at ?? note.created_at ?? '')
    if (!Number.isFinite(at) || at < Date.parse(round.since)) continue
    const trigger = noteTrigger(note, { iid: item.iid, kind, url: item.web_url }, { host: runner.options.host, project: runner.options.project }, login)
    if (trigger.text || trigger.addressed) await ctx.receive(trigger)
  }
  nameThread(ctx, kind, item.iid, item.title, item.web_url)
}

/** Reports MR changes to each open ticket's followed MRs and diffs pipeline state only within the current MR head SHA. */
async function pollTicketMergeRequests(ctx: SourceContext, round: PollRound, current: GitlabMergeRequest[], signal: AbortSignal): Promise<void> {
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))]
  const runner = glabFor(ctx.commands.withSignal(signal))
  for (const iid of iids) {
    if (stopped(ctx, round, signal)) return
    try {
      const mr = current.find(item => item.iid === iid) ?? await readGitlabMergeRequestForContext(ctx, iid, signal)
      await observeGitlabMergeRequest(ctx, mr)
      if (mr.state !== 'opened') continue
      await pollApproval(ctx, round, mr, signal)
      const snapshot = await readGitlabCi(ctx.commands.withSignal(signal), mr, round.tally)
      // A new MR head establishes a fresh baseline; only transitions for that same SHA notify the worker.
      if (!snapshot.head) continue
      const fingerprint = key(JSON.stringify(snapshot.pipelines))
      const old = ctx.state.get(ISSUE_CI(iid))
      if (old?.sha === snapshot.head && old.fingerprint !== fingerprint) {
        const revision = old.revision + 1
        const summary = gitlabCiSummary(snapshot, `MR !${iid}`, `gitlab/merge_request/${iid}/checks`)
        const pipeline = (await readGitlabMergeRequestPipelines(ctx.commands.withSignal(signal), iid, round.tally)).find(item => item.sha === snapshot.head)
        if (pipeline) await ctx.receive({ ...pipelineTrigger(pipeline, revision, runner.options.host, runner.options.project, mr), text: summary })
      }
      ctx.state.set(ISSUE_CI(iid), { sha: snapshot.head, fingerprint, revision: old?.sha === snapshot.head ? old.revision + (old.fingerprint !== fingerprint ? 1 : 0) : 0 })
      ctx.threads.describe(`gitlab:${gitlabThreadId('merge_request', iid)}`, { facts: { ci: gitlabCiFact(gitlabCiCounts(snapshot)) } })
    } catch (error) { if (!signal.aborted) round.failures.push(`!${iid}: ${String(error)}`) }
  }
}

async function pollApproval(ctx: SourceContext, round: PollRound, mr: GitlabMergeRequest, signal: AbortSignal): Promise<void> {
  const runner = glabFor(ctx.commands.withSignal(signal))
  const approval = await runner.api(z.looseObject({ approved: z.boolean(), approved_by: z.array(z.looseObject({ user: z.looseObject({ username: z.string(), bot: z.boolean().optional() }) })).optional() }),
    `${runner.projectPath}/merge_requests/${mr.iid}/approvals`)
  const previous = ctx.state.get(MR_APPROVAL(mr.iid))
  const revision = previous ? previous.revision + (previous.approved !== approval.approved ? 1 : 0) : 0
  if (previous && previous.approved !== approval.approved) {
    const user = approval.approved_by?.at(-1)?.user
    await ctx.receive(approvalTrigger(mr, approval.approved, revision, runner.options.host, runner.options.project, user))
  }
  ctx.state.set(MR_APPROVAL(mr.iid), { approved: approval.approved, revision })
}

async function pollProjectPipelines(ctx: SourceContext, round: PollRound, mergeRequests: GitlabMergeRequest[], signal: AbortSignal): Promise<void> {
  const runner = glabFor(ctx.commands.withSignal(signal))
  const list = await readGitlabPipelines(ctx.commands.withSignal(signal), undefined, round.tally, round.since)
  const prior = { ...ctx.state.get(PIPELINES) }
  const next: Record<string, { status: string; sha: string; revision: number }> = { ...prior }
  const mrs = new Map(mergeRequests.filter(mr => mr.state === 'opened').map(mr => [mr.sha, mr]))
  for (const pipeline of list) {
    if (stopped(ctx, round, signal)) return
    const before = prior[String(pipeline.id)]
    if (before && before.sha === pipeline.sha && before.status !== pipeline.status) {
      const revision = before.revision + 1
      const mr = mrs.get(pipeline.sha)
      await ctx.receive(pipelineTrigger(pipeline, revision, runner.options.host, runner.options.project, mr, true))
      next[String(pipeline.id)] = { status: pipeline.status, sha: pipeline.sha, revision }
    } else if (!before) next[String(pipeline.id)] = { status: pipeline.status, sha: pipeline.sha, revision: 0 }
  }
  const ids = Object.keys(next).sort((a, b) => Number(b) - Number(a)).slice(0, 200)
  ctx.state.set(PIPELINES, Object.fromEntries(ids.map(id => [id, next[id]!])) )
}

async function pollSubscribedThreads(ctx: SourceContext, round: PollRound, signal: AbortSignal): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round, signal), async thread => {
    try {
      const parts = /^(issue|mr):([1-9]\d*)$/.exec(thread.ref.id)
      if (!parts) return
      const kind = parts[1] === 'issue' ? 'issue' : 'merge_request'
      const iid = Number(parts[2])
      const runner = glabFor(ctx.commands.withSignal(signal))
      const item = kind === 'issue'
        ? await runner.api(GitlabIssueSchema, `${runner.projectPath}/issues/${iid}`)
        : await readGitlabMergeRequestForContext(ctx, iid, signal)
      if (kind === 'merge_request') await observeGitlabMergeRequest(ctx, item as GitlabMergeRequest)
      await intakeNotes(ctx, round, kind, item, signal)
    } catch (error) {
      // The shared poller records per-thread errors and continues. Also fail this round so its global cursor stays put.
      if (stopped(ctx, round, signal)) throw error
      if (error instanceof CliError && error.code === 410) round.dropped.push(thread.ref.id)
      else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => !/^(issue|mr):[1-9]\d*$/.test(thread.ref.id))
}
function nameThread(ctx: SourceContext, kind: GitlabResourceKind, iid: number, title: string, url: string): void {
  const thread = gitlabThreadId(kind, iid)
  ctx.threads.patch(`gitlab:${thread}`, { iid, number: iid, kind, isPr: kind === 'merge_request', isMr: kind === 'merge_request', title, url })
  ctx.threads.describe(`gitlab:${thread}`, { label: `${kind === 'issue' ? '#' : '!'}${iid} ${title}`, url,
    facts: { number: { value: `${kind === 'issue' ? '#' : '!'}${iid}` } } })
}
