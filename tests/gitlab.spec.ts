import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, type Commands } from '../src/infra/commands.ts'
import { GlabRunner, GitlabProjectConfigSchema, gitlabConfigDirConflicts, resolveGitlabProject, sanitizeGitlabDiagnostic, validateGitlabConfigDirs } from '../src/infra/gitlab.ts'
import type { Machine, Probe } from '../src/deployment.ts'
import { readGitlabCi, readGitlabRepositoryPath, gitlabCiCounts, gitlabCiFact, gitlabCiSummary } from '../src/sources/gitlab-read.ts'
import { gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { GitlabMergeRequestSchema, GitlabPipelineSchema, gitlabChannel, pipelineTrigger } from '../src/sources/gitlab-trigger.ts'
import type { Thread } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Deployment } from '../src/deployment.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { startRuntime } from './fixtures/host.ts'

const HOST = 'gitlab.internal.example'
const PROJECT = 'team/subgroup/service'
const PATH = 'projects/team%2Fsubgroup%2Fservice'

describe('GitLab settings rendering', () => {
  it('renders policy rows on the first settings request with GitHub and GitLab registered', async () => {
    const host = await startRuntime()
    try {
      host.runtime.sources.register(gitlabKind)
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
        gitlab: { enabled: true, config: { repository: PROJECT, host: HOST, cli: 'glab', observeIssues: true } } } })

      const response = await host.api('GET', 'settings')
      expect(response.status).toBe(200)
      expect(response.body.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'github', installed: true }),
        expect.objectContaining({ id: 'gitlab', installed: true, policy: expect.objectContaining({ rows: expect.arrayContaining([
          expect.objectContaining({ id: 'issues', note: { zh: '全部', en: 'All' }, cells: { listedUnaddressed: true,
            unlistedAddressed: true, unlistedUnaddressed: true } }),
          expect.objectContaining({ id: 'merge_requests' }),
          expect.objectContaining({ id: 'comments' }),
          expect.objectContaining({ id: 'ci' }),
        ]) }) }),
      ]))
    } finally { await host.stop() }
  })
})

function pollHarness(run: (args: string[]) => Promise<string>, disableOnMergeRequests = false, subscribed: Thread[] = [], observePipelines = false) {
  const project = { id: 'gitlab-test', provider: 'gitlab', host: HOST, project: PROJECT, cli: 'glab', login: 'agent', noreply: 'agent@example.test' } as const
  const deployment = testDeployment({ activeProject: project, projects: { [project.id]: project as never } }) as Deployment
  const runCommand = async (_program: string, args: string[]) => {
    if (args[0] === 'config') return 'false'
    if (disableOnMergeRequests && (args[1] ?? '').includes('/merge_requests?')) enabled = false
    return run(args)
  }
  let enabled = true
  let commands: Commands
  commands = { deployment, run: runCommand, withSignal: () => commands } as unknown as Commands
  const state = new Map<string, unknown>()
  const config = gitlabKind.schema.parse({ repository: PROJECT, host: HOST, cli: 'glab', observeComments: true, observePipelines })
  const context = {
    deployment, commands, ready: Promise.resolve(), configured: () => true, config: (kind: string) => kind === 'gitlab' && enabled ? config : undefined,
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => value === undefined ? state.delete(key) : state.set(key, value),
      keys: () => [] },
    threads: { get: () => undefined, subscribed: () => subscribed, patch: vi.fn(), describe: vi.fn() },
    tickets: { get: () => undefined, open: () => [], bindThread: vi.fn(), threadClosed: vi.fn() },
    receive: vi.fn(), report: vi.fn(), notify: vi.fn(), atomic: (work: () => unknown) => work(),
  } as unknown as SourceContext
  const setDisabled = () => { enabled = false }
  return { context, state, setDisabled }
}

describe('glab project adapter', () => {
  it('pins requests to the configured host and encoded project path', async () => {
    const execute = vi.fn(async (_program: string, args: string[]) => args[0] === 'config' ? 'false\n' : '{"iid":12}')
    const runner = new GlabRunner({ executable: 'glab', host: HOST, project: PROJECT, execute })

    await expect(runner.api(z.object({ iid: z.number() }), `${runner.projectPath}/issues/12`)).resolves.toEqual({ iid: 12 })
    expect(execute.mock.calls[0]?.[1]).toEqual(['config', 'get', 'skip_tls_verify', '--host', HOST])
    expect(execute.mock.calls[1]?.[1]).toEqual(['api', `${PATH}/issues/12`, '--hostname', HOST])
  })

  it('rejects foreign projects, absolute endpoints, traversal and encoded traversal', async () => {
    const execute = vi.fn(async () => 'false')
    const runner = new GlabRunner({ executable: 'glab', host: HOST, project: PROJECT, execute })
    for (const endpoint of [
      'projects/other%2Frepo/issues/12',
      '/projects/team/service/issues/12',
      'https://gitlab.example/api/v4/projects/12/issues',
      `${PATH}/issues/../12`,
      `${PATH}/issues/%2e%2e/12`,
      `${PATH}/issues/%2Fother`,
    ]) await expect(runner.api(z.unknown(), endpoint)).rejects.toThrow('restricted to the configured project')
    expect(execute).not.toHaveBeenCalled()
  })

  it('reads explicit pages to the first short page and counts malformed rows', async () => {
    const execute = vi.fn(async (_program: string, args: string[]) => {
      if (args[0] === 'config') return 'false'
      if (args[1]?.endsWith('?per_page=2&page=1')) return '[{"id":1},{"id":"invalid"}]'
      if (args[1]?.endsWith('?per_page=2&page=2')) return '[{"id":2}]'
      throw new Error(`Unexpected fake glab request: ${args.join(' ')}`)
    })
    const runner = new GlabRunner({ executable: 'glab', host: HOST, project: PROJECT, execute })
    const tally = { skipped: 0 }

    await expect(runner.pages(z.object({ id: z.number() }), `${PATH}/issues?per_page=2`, tally)).resolves.toEqual([{ id: 1 }, { id: 2 }])
    expect(tally).toEqual({ skipped: 1 })
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      ['config', 'get', 'skip_tls_verify', '--host', HOST],
      ['api', `${PATH}/issues?per_page=2&page=1`, '--hostname', HOST],
      ['api', `${PATH}/issues?per_page=2&page=2`, '--hostname', HOST],
    ])
  })

  it('rejects disabled TLS verification and redacts common credential formats', async () => {
    const runner = new GlabRunner({ executable: 'glab', host: HOST, project: PROJECT,
      execute: async (_program, args) => args[0] === 'config' ? 'true' : '{}' })
    await expect(runner.api(z.unknown(), `${PATH}/issues/1`)).rejects.toThrow('TLS verification is disabled')

    const diagnostic = sanitizeGitlabDiagnostic('Bearer supersecret glpat-abcdefghij private_token=other https://user:password@gitlab.internal')
    for (const secret of ['supersecret', 'abcdefghij', 'other', 'user:password']) expect(diagnostic).not.toContain(secret)
    expect(GitlabProjectConfigSchema.safeParse({ repository: PROJECT, environment: { HTTPS_PROXY: 'https://user:password@proxy.internal' } }).success).toBe(false)
  })

  it('reads nested repository paths whose encoded endpoint segment contains a slash', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (_program: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'config') return 'false'
      if (args[1] === PATH) return '{"default_branch":"main"}'
      if (args[1] === `${PATH}/repository/files/src%2Fapp.ts/raw?ref=main`) return 'export const value = 1'
      throw new Error(`Unexpected fake glab request: ${args.join(' ')}`)
    })
    const project = { id: 'gitlab-test', provider: 'gitlab', host: HOST, project: PROJECT, cli: 'glab', login: 'agent', noreply: 'agent@example.test' }
    const commands = { deployment: { activeProject: project }, run } as unknown as Commands

    await expect(readGitlabRepositoryPath(commands, 'src/app.ts', 'file')).resolves.toBe('export const value = 1')
    expect(calls.at(-1)?.[1]).toBe(`${PATH}/repository/files/src%2Fapp.ts/raw?ref=main`)
  })

  it('uses an isolated config directory, unsets credential and TLS bypass overrides, and checks project push access', async () => {
    const calls: string[][] = []
    const config = { repository: PROJECT, host: HOST, cli: process.execPath, environment: { HTTPS_PROXY: 'https://proxy.internal:8443' } }
    const probe: Probe = async argv => {
      calls.push(argv)
      const executableIndex = argv.lastIndexOf(process.execPath)
      const args = argv.slice(executableIndex + 1)
      if (args[0] === 'version') return 'glab 1.50.0'
      if (args[0] === 'config') return 'false'
      if (args[0] === 'auth') return 'Logged in'
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ id: 19, username: 'agent', public_email: 'agent@example.test' })
      if (args[0] === 'api' && args[1] === PATH) return JSON.stringify({ id: 32, path_with_namespace: PROJECT,
        permissions: { project_access: { access_level: 30 } } })
      throw new Error(`Unexpected fake glab command: ${args.join(' ')}`)
    }

    const result = await resolveGitlabProject(config, probe, { stateDir: '/tmp/dsh-superagent-test' } as Machine, '')
    expect(result).toMatchObject({ host: HOST, project: PROJECT, login: 'agent', configDir: join('/tmp/dsh-superagent-test', 'glab', HOST, 'team', 'subgroup', 'service') })
    expect(result.noreply).toBe('agent@example.test')
    const versionCall = calls.find(argv => argv.at(-1) === 'version')!
    expect(versionCall).toContain('GLAB_CONFIG_DIR=' + result.configDir)
    expect(versionCall).toContain('HTTPS_PROXY=https://proxy.internal:8443')
    for (const name of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'GLAB_TOKEN', 'CI_JOB_TOKEN', 'OAUTH_TOKEN',
      'GIT_SSL_NO_VERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GLAB_SKIP_TLS_VERIFY', 'SKIP_TLS_VERIFY', 'GITLAB_SKIP_TLS_VERIFY']) {
      expect(versionCall).toEqual(expect.arrayContaining(['-u', name]))
      expect(versionCall).not.toContain(`${name}=true`)
    }
    expect(calls.some(argv => argv.includes('projects/team%2Fsubgroup%2Fservice'))).toBe(true)
  })

  it('fails setup when glab has TLS verification disabled and rejects shared config directories', async () => {
    const probe: Probe = async argv => {
      const args = argv.slice(argv.lastIndexOf(process.execPath) + 1)
      if (args[0] === 'version') return 'glab 1.50.0'
      if (args[0] === 'config') return 'true'
      throw new Error(`Unexpected fake glab command: ${args.join(' ')}`)
    }
    await expect(resolveGitlabProject({ repository: PROJECT, host: HOST, cli: process.execPath }, probe,
      { stateDir: '/tmp/dsh-superagent-test' } as Machine, '')).rejects.toMatchObject({ code: 'gitlabTlsVerificationDisabled' })

    const directory = mkdtempSync(join(tmpdir(), 'dsh-glab-config-'))
    try {
      const projects = [
        { id: 'gitlab-a', host: HOST, project: 'team/a', configDir: directory },
        { id: 'gitlab-b', host: HOST, project: 'team/b', configDir: directory },
        { id: 'gitlab-c', host: HOST, project: 'team/c', configDir: directory },
      ]
      expect(gitlabConfigDirConflicts(projects).map(conflict => conflict.project.id)).toEqual(['gitlab-b', 'gitlab-c'])
      expect(() => validateGitlabConfigDirs([
        ...projects,
      ])).toThrow('same glab configuration directory')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('maps a GitLab HTTP 401 to an actionable authentication setup error', async () => {
    const probe: Probe = async argv => {
      const args = argv.slice(argv.lastIndexOf(process.execPath) + 1)
      if (args[0] === 'version') return 'glab 1.50.0'
      if (args[0] === 'config') return 'false'
      if (args[0] === 'auth') throw new Error('glab: authentication failed (HTTP 401)')
      throw new Error(`Unexpected fake glab command: ${args.join(' ')}`)
    }
    await expect(resolveGitlabProject({ repository: PROJECT, host: HOST, cli: process.execPath }, probe,
      { stateDir: '/tmp/dsh-superagent-test' } as Machine, '')).rejects.toMatchObject({ code: 'gitlabAuthFailed' })
  })
})

describe('GitLab CI evidence', () => {
  it('keeps only the current MR head SHA and treats skipped pipelines as neutral', async () => {
    const current = 'a'.repeat(40), previous = 'b'.repeat(40)
    const pipelines = [
      { id: 1, status: 'failed', ref: 'agent/work', sha: previous },
      { id: 2, status: 'success', ref: 'agent/work', sha: current },
      { id: 3, status: 'skipped', ref: 'agent/work', sha: current },
    ]
    const run = vi.fn(async (_program: string, args: string[]) => args[0] === 'config' ? 'false' : JSON.stringify(pipelines))
    const commands = { deployment: { activeProject: { provider: 'gitlab', cli: 'glab', host: HOST, project: PROJECT, login: 'agent' } }, run } as unknown as Commands
    const mr = GitlabMergeRequestSchema.parse({ iid: 12, title: 'CI status', state: 'opened', web_url: `https://${HOST}/${PROJECT}/-/merge_requests/12`,
      author: { username: 'requester' }, source_branch: 'agent/work', sha: current })
    const snapshot = await readGitlabCi(commands, mr)

    expect(snapshot.pipelines.map(item => item.sha)).toEqual([current, current])
    expect(gitlabCiCounts(snapshot)).toEqual({ failed: 0, running: 0, passed: 1, neutral: 1 })
    expect(gitlabCiFact(gitlabCiCounts(snapshot))).toMatchObject({ label: { zh: 'CI 未完成' } })
    expect(gitlabCiSummary(snapshot, 'MR !12', 'gitlab/merge_request/12/checks')).toContain('CI incomplete 1/2 passed, 1 neutral')
    expect(GitlabPipelineSchema.safeParse(pipelines[0]).success).toBe(true)
  })

  it('treats manual and blocked pipelines as pending and an empty pipeline list as not run', () => {
    const item = (status: string) => ({ id: 1, status, ref: 'main', sha: 'a'.repeat(40) })
    expect(gitlabCiCounts({ head: 'a'.repeat(40), pipelines: [item('manual'), item('blocked')] })).toMatchObject({ running: 2, failed: 0 })
    const empty = { head: 'a'.repeat(40), pipelines: [] }
    expect(gitlabCiFact(gitlabCiCounts(empty))).toMatchObject({ label: { zh: 'CI 状态' }, value: { zh: '未运行' } })
    expect(gitlabCiSummary(empty, 'MR !12', 'gitlab/merge_request/12/checks')).toContain('CI has no pipelines')
  })

  it('routes MR conversation, inline review, and approval events through the comments scope', () => {
    const config = gitlabKind.schema.parse({ observeComments: true, observeMergeRequests: false })
    for (const kind of ['conversation', 'inline', 'approval']) {
      expect(gitlabKind.scope!({ meta: { kind, isMr: true } }, config)).toMatchObject({ row: 'comments', observed: true })
    }
  })

  it('resolves self-hosted GitLab Issue/MR links and keeps bare IIDs ambiguous by resource kind', () => {
    expect(gitlabKind.find!('https://gitlab.internal.example/team/subgroup/service/-/issues/12'))
      .toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('review: https://gitlab.internal.example/team/subgroup/service/-/merge_requests/12#note_5'))
      .toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12', 'gitlab:mr:12'], terms: [] })
  })
})

describe('GitLab polling and delivery', () => {
  it('keeps transitions of different pipelines on the same branch distinct, including reruns of one SHA', async () => {
    let pipeline = { id: 1, status: 'running', ref: 'main', sha: 'a'.repeat(40) }
    const harness = pollHarness(async args => JSON.stringify(args[1]?.startsWith(`${PATH}/pipelines?`) ? [pipeline] : []), false, [], true)
    for (const id of [1, 2]) {
      pipeline = { ...pipeline, id, status: 'running' }
      await pollRound(harness.context)
      pipeline = { ...pipeline, status: 'failed' }
      await pollRound(harness.context)
    }
    const triggers = vi.mocked(harness.context.receive).mock.calls.map(([trigger]) => trigger)
    expect(triggers.map(trigger => trigger.meta.status)).toEqual(['failed', 'failed'])
    expect(new Set(triggers.map(trigger => trigger.id)).size).toBe(2)
  })

  it('separates MR head and observation revisions while retaining retry deduplication', () => {
    const pipeline = { id: 1, status: 'failed', ref: 'feature', sha: 'a'.repeat(40) }
    const mr = GitlabMergeRequestSchema.parse({ iid: 12, title: 'CI', state: 'opened', web_url: `https://${HOST}/${PROJECT}/-/merge_requests/12`,
      author: { username: 'alice' }, source_branch: 'feature', sha: pipeline.sha })
    const event = (fields = {}, observed = false, revision = 1) => pipelineTrigger({ ...pipeline, ...fields }, revision, HOST, PROJECT, mr, observed)
    const first = event()
    expect(event().id).toBe(first.id)
    expect(new Set([first, event({ id: 2 }), event({ sha: 'b'.repeat(40) }), event({}, true), event({}, false, 2)].map(trigger => trigger.id)).size).toBe(5)
  })

  it('skips a subscribed Reporter Thread and continues polling a real Issue Thread', async () => {
    const at = new Date().toISOString()
    const reporter: Thread = { key: 'gitlab-test:reporter:bootstrap:12', ref: { source: 'gitlab-test', id: 'reporter:bootstrap:12' },
      createdAt: at, lastAt: at, subscriptions: ['reporter-ticket'], correlated: [], pending: [], meta: { pollError: 'old Reporter poll error' } }
    const issue: Thread = { key: 'gitlab-test:issue:12', ref: { source: 'gitlab-test', id: 'issue:12' }, createdAt: at, lastAt: at,
      subscriptions: ['issue-ticket'], correlated: [], pending: [], meta: {} }
    const reads: string[] = []
    const harness = pollHarness(async args => {
      const endpoint = args[1] ?? ''
      reads.push(endpoint)
      if (endpoint === `${PATH}/issues/12`) return JSON.stringify({ iid: 12, title: 'Issue 12', description: '', state: 'opened',
        created_at: at, updated_at: at, web_url: `https://${HOST}/${PROJECT}/-/issues/12`, author: { username: 'alice' } })
      return '[]'
    }, false, [reporter, issue])

    await pollRound(harness.context)

    expect(reads).toContain(`${PATH}/issues/12`)
    expect(reads.some(endpoint => endpoint.includes('reporter:'))).toBe(false)
    expect(harness.context.threads.patch).toHaveBeenCalledWith(reporter.key, { pollError: undefined })
    expect(harness.context.threads.patch).toHaveBeenCalledWith(issue.key, { pollError: undefined })
  })

  it('retries from the same start after the first poll fails with HTTP 503', async () => {
    const issueReads: string[] = []
    let fail = true
    const harness = pollHarness(async args => {
      const endpoint = args[1] ?? ''
      if (endpoint.includes('/issues?')) {
        issueReads.push(endpoint)
        if (fail) { fail = false; throw new CliError('Service Unavailable (HTTP 503)', 503, 1) }
      }
      return '[]'
    })

    await expect(pollRound(harness.context)).rejects.toThrow('GitLab reads failed')
    const since = new URL(issueReads[0]!, `https://${HOST}/`).searchParams.get('updated_after')
    expect(harness.state.get('gitlab-since')).toEqual(since)
    await expect(pollRound(harness.context)).resolves.toBe(60)
    expect(issueReads).toEqual([issueReads[0], issueReads[0]])
    expect(harness.state.get('gitlab-since')).toEqual(expect.any(String))
  })

  it('keeps the project cursor when a subscribed thread read fails, then retries the note next round', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const noteAt = new Date().toISOString()
    let fail = true
    const thread: Thread = { key: 'gitlab-test:issue:12', ref: { source: 'gitlab-test', id: 'issue:12' }, createdAt: since,
      lastAt: noteAt, subscriptions: ['ticket-12'], correlated: [], pending: [], meta: { iid: 12, kind: 'issue' } }
    const harness = pollHarness(async args => {
      const endpoint = args[1] ?? ''
      if (endpoint.includes('/issues/12/notes?')) {
        if (fail) throw new CliError('Service Unavailable (HTTP 503)', 503, 1)
        return JSON.stringify([{ id: 7, body: '@agent please fix this', author: { username: 'alice' }, created_at: noteAt }])
      }
      if (endpoint.endsWith('/issues/12')) return JSON.stringify({ iid: 12, title: 'Issue 12', description: '', state: 'opened',
        created_at: since, updated_at: since, web_url: `https://${HOST}/${PROJECT}/-/issues/12`, author: { username: 'alice' } })
      return '[]'
    }, false, [thread])
    harness.state.set('gitlab-since', since)

    await expect(pollRound(harness.context)).rejects.toThrow('GitLab reads failed')
    expect(harness.state.get('gitlab-since')).toBe(since)
    expect(harness.context.threads.patch).toHaveBeenCalledWith(thread.key, { pollError: expect.stringContaining('503') })

    fail = false
    await expect(pollRound(harness.context)).resolves.toBe(60)
    expect(harness.context.receive).toHaveBeenCalledWith(expect.objectContaining({ text: '@agent please fix this', meta: expect.objectContaining({ noteId: 7 }) }))
    expect(harness.state.get('gitlab-since')).not.toBe(since)
  })

  it('records a subscribed issue returning 410 and advances the project cursor', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const thread: Thread = { key: 'gitlab-test:issue:12', ref: { source: 'gitlab-test', id: 'issue:12' }, createdAt: since,
      subscriptions: ['ticket-12'], correlated: [], pending: [], meta: {} }
    const harness = pollHarness(async args => {
      if (args[1] === `${PATH}/issues/12`) throw new CliError('Gone (HTTP 410)', 410, 1)
      return '[]'
    }, false, [thread])
    harness.state.set('gitlab-since', since)

    await expect(pollRound(harness.context)).resolves.toBe(60)
    expect(Date.parse(harness.state.get('gitlab-since') as string)).toBeGreaterThan(Date.parse(since))
    expect(harness.context.threads.patch).toHaveBeenCalledWith(thread.key, { pollError: expect.stringContaining('410') })
    expect(harness.context.report).toHaveBeenCalledWith('gitlab', expect.objectContaining({ state: 'ready', detail: expect.stringContaining('deleted resources: issue:12') }))
  })

  it('reads human follow-up notes on Issues opened by the agent itself', async () => {
    const harness = pollHarness(async args => {
      const endpoint = args[1] ?? ''
      if (endpoint.includes('/issues?')) return JSON.stringify([{ iid: 5, title: 'Agent issue', description: '', state: 'opened',
        created_at: new Date(Date.now() + 1000).toISOString(), updated_at: new Date(Date.now() + 1000).toISOString(),
        web_url: `https://${HOST}/${PROJECT}/-/issues/5`, author: { username: 'agent' } }])
      if (endpoint.includes('/issues/5/notes?')) return JSON.stringify([{ id: 7, body: '@agent please add a test', author: { username: 'alice' },
        created_at: new Date(Date.now() + 2000).toISOString() }])
      return '[]'
    })

    await pollRound(harness.context)
    expect(harness.context.receive).toHaveBeenCalledTimes(1)
    expect(harness.context.receive).toHaveBeenCalledWith(expect.objectContaining({ text: '@agent please add a test', human: true }))
  })

  it('does not advance a poll cursor after the Source is disabled during the last API read', async () => {
    const harness = pollHarness(async () => '[]', true)

    await expect(pollRound(harness.context)).resolves.toBe(60)
    expect(harness.state.get('gitlab-since')).toBeUndefined()
  })

  it.each(['read', 'post'])('retries a GitLab reply after a 404 on %s', async failedRequest => {
    const notesPath = `${PATH}/issues/12/notes`
    let denied = true
    const post = vi.fn()
    const run = async (_program: string, args: string[]) => {
      if (args[0] === 'config') return 'false'
      if (args[1]?.startsWith(`${notesPath}?`)) {
        if (denied && failedRequest === 'read') throw new CliError('404 Project Not Found', 404)
        return '[]'
      }
      if (args[1] === notesPath && args.includes('POST')) {
        if (denied) throw new CliError('404 Project Not Found', 404)
        post()
        return '{}'
      }
      throw new Error(`Unexpected fake glab request: ${args.join(' ')}`)
    }
    const project = { id: 'gitlab-test', provider: 'gitlab', host: HOST, project: PROJECT, cli: 'glab', login: 'agent' }
    const commands = { deployment: { activeProject: project }, run } as unknown as Commands
    const message = { id: 'retry-reply', channel: gitlabChannel(HOST, PROJECT, 'issue', 12), text: 'Reply text', kind: 'reply' as const }

    await expect(sendGitlab({ commands }, message)).rejects.toMatchObject({ code: 404 })
    denied = false
    await expect(sendGitlab({ commands }, message)).resolves.toBe('sent')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('ends GitLab reply delivery when the target returns 410', async () => {
    const project = { id: 'gitlab-test', provider: 'gitlab', host: HOST, project: PROJECT, cli: 'glab', login: 'agent' }
    const run = async (_program: string, args: string[]) => {
      if (args[0] === 'config') return 'false'
      throw new CliError('Gone (HTTP 410)', 410)
    }
    const commands = { deployment: { activeProject: project }, run } as unknown as Commands
    const message = { id: 'gone-reply', channel: gitlabChannel(HOST, PROJECT, 'issue', 12), text: 'Reply text', kind: 'reply' as const }
    await expect(sendGitlab({ commands }, message)).resolves.toBe('gone')
  })

  it('posts one idempotent reply through a discussion endpoint and rejects a foreign host', async () => {
    const discussion = `${PATH}/merge_requests/12/discussions/discussion-1`
    const discussionNotes = `${discussion}/notes`
    const notes: { id: number; body: string; author: { username: string } }[] = []
    const run = vi.fn(async (_program: string, args: string[]) => {
      if (args[0] === 'config') return 'false'
      if (args[1] === discussion) return JSON.stringify({ id: 'discussion-1', notes })
      if (args[1] === discussionNotes && args.includes('--method')) {
        const field = args[args.indexOf('--field') + 1]!
        notes.push({ id: 1, body: field.slice('body='.length), author: { username: 'agent' } })
        return '{}'
      }
      throw new Error(`Unexpected fake glab request: ${args.join(' ')}`)
    })
    const project = { id: 'gitlab-test', provider: 'gitlab', host: HOST, project: PROJECT, cli: 'glab', login: 'agent', noreply: 'agent@example.test' }
    const commands = { deployment: { activeProject: project }, run } as unknown as Commands
    const message = { id: 'reply-1', channel: gitlabChannel(HOST, PROJECT, 'merge_request', 12, { discussionId: 'discussion-1' }),
      text: 'Review reply', kind: 'reply' as const }

    expect(await sendGitlab({ commands }, message)).toBe('sent')
    expect(await sendGitlab({ commands }, message)).toBe('sent')
    expect(run.mock.calls.filter(([, args]) => args[1] === discussionNotes && args.includes('--method'))).toHaveLength(1)
    expect(notes[0]?.body).toContain('<!-- dsh-superagent:reply-1 -->')
    const foreign = { ...message, channel: gitlabChannel('other.internal', PROJECT, 'merge_request', 12, { discussionId: 'discussion-1' }) }
    await expect(sendGitlab({ commands }, foreign)).rejects.toThrow('does not belong to the active ProjectSource')
  })
})
