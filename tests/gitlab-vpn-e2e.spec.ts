/** 显式门控的真实 GitLab 测试；会写入一次性项目，VPN、glab 和认证完全由宿主提供。 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { GlabRunner, resolveGitlabProject } from '../src/infra/gitlab.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { readGitlabCi, readGitlabMergeRequest } from '../src/sources/gitlab-read.ts'
import { gitlabChannel, GitlabNoteSchema } from '../src/sources/gitlab-trigger.ts'
import { testMachine } from './fixtures/deployment.ts'

const enabled = process.env.DSH_SUPERAGENT_GITLAB_E2E === '1'
const exec = promisify(execFile)
const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`真实 GitLab 测试已启用，但缺少 ${name}`)
  return value
}
const IssueSchema = z.object({ iid: z.number().int().positive() })
const ProjectSchema = z.object({ default_branch: z.string().min(1) })

describe.skipIf(!enabled)(enabled ? '真实宿主 VPN GitLab E2E' : '真实 GitLab E2E：未设置 DSH_SUPERAGENT_GITLAB_E2E=1，未验证平台与 VPN', () => {
  it('验证宿主认证、Issue/MR 评论幂等交付和 MR 创建关闭生命周期，并清理测试资源', async () => {
    if (required('DSH_SUPERAGENT_GITLAB_E2E_DISPOSABLE') !== '1') throw new Error('只允许对显式标记为一次性的 GitLab 项目运行写入测试')
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-gitlab-e2e-'))
    const lifetime = new AbortController()
    const errors: unknown[] = []
    let runner: GlabRunner | undefined, branch: string | undefined, issueIid: number | undefined, mrIid: number | undefined
    try {
      const machine = testMachine({ stateDir })
      const project = await resolveGitlabProject({ host: required('DSH_SUPERAGENT_GITLAB_E2E_HOST'),
        repository: required('DSH_SUPERAGENT_GITLAB_E2E_PROJECT'), configDir: required('DSH_SUPERAGENT_GITLAB_E2E_CONFIG_DIR'),
        cli: process.env.DSH_SUPERAGENT_GITLAB_E2E_CLI || 'glab' }, async argv => {
        const { stdout } = await exec(argv[0]!, argv.slice(1), { cwd: stateDir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
        return stdout
      }, machine)
      const deployment = { ...machine, repository: project.project, activeProject: project, projects: { [project.id]: project },
        github: { cli: project.cli, login: project.login, noreply: project.noreply } }
      const commands = new Commands(() => deployment, { GLAB_CONFIG_DIR: project.configDir, GITLAB_HOST: project.host }, lifetime.signal)
      runner = new GlabRunner({ executable: project.cli, host: project.host, project: project.project,
        execute: (program, args) => commands.run(program, args) })
      const api = runner, runId = randomUUID().slice(0, 12)
      const post = async (endpoint: string, payload: unknown) => {
        const input = join(stateDir, `${randomUUID()}.json`)
        writeFileSync(input, JSON.stringify(payload), { mode: 0o600 })
        return JSON.parse(await api.raw(endpoint, '--method', 'POST', '--header', 'Content-Type: application/json', '--input', input)) as unknown
      }
      const metadata = await api.api(ProjectSchema, api.projectPath)
      issueIid = IssueSchema.parse(await post(`${api.projectPath}/issues`, { title: `Superagent E2E ${runId}`, description: '自动化测试创建的临时 Issue。' })).iid
      branch = `superagent-e2e-${runId}`
      await post(`${api.projectPath}/repository/commits`, { branch, start_branch: metadata.default_branch, commit_message: `Superagent E2E ${runId}`,
        actions: [{ action: 'create', file_path: `superagent-e2e/${runId}.txt`, content: '真实 GitLab 集成测试。\n' }] })
      mrIid = IssueSchema.parse(await post(`${api.projectPath}/merge_requests`, { source_branch: branch, target_branch: metadata.default_branch,
        title: `Draft: Superagent E2E ${runId}`, remove_source_branch: true })).iid
      for (const [kind, iid] of [['issue', issueIid], ['merge_request', mrIid]] as const) {
        const message = { id: `vpn-e2e-${runId}-${kind}`, channel: gitlabChannel(project.host, project.project, kind, iid),
          text: 'Superagent 真实交付测试；此评论由自动化程序创建。', kind: 'notice' as const }
        expect(await sendGitlab({ commands }, message)).toBe('sent')
        expect(await sendGitlab({ commands }, message)).toBe('sent')
        const notes = await api.pages(GitlabNoteSchema, `${api.projectPath}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}/notes?per_page=100`)
        expect(notes.filter(note => note.body?.includes(`<!-- dsh-superagent:${message.id} -->`))).toHaveLength(1)
      }
      const opened = await readGitlabMergeRequest(commands, mrIid)
      expect(opened.state).toBe('opened')
      // Pipeline 是否存在由一次性项目 CI 配置决定；无 Pipeline 不记作 CI 通过。
      const ci = await readGitlabCi(commands, opened)
      expect(ci.pipelines.every(pipeline => pipeline.sha === ci.head)).toBe(true)
      await api.raw(`${api.projectPath}/merge_requests/${mrIid}`, '--method', 'PUT', '--field', 'state_event=close')
      expect((await readGitlabMergeRequest(commands, mrIid)).state).toBe('closed')
    } catch (error) { errors.push(error) }
    finally {
      // 只清理由本测试创建的资源；关闭 MR 不会删除其历史记录。
      if (runner) {
        const cleanup: Promise<unknown>[] = []
        if (mrIid) cleanup.push(runner.raw(`${runner.projectPath}/merge_requests/${mrIid}`, '--method', 'PUT', '--field', 'state_event=close'))
        if (issueIid) cleanup.push(runner.raw(`${runner.projectPath}/issues/${issueIid}`, '--method', 'PUT', '--field', 'state_event=close'))
        if (branch) cleanup.push(runner.raw(`${runner.projectPath}/repository/branches/${encodeURIComponent(branch)}`, '--method', 'DELETE'))
        const results = await Promise.allSettled(cleanup)
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      }
      lifetime.abort()
      rmSync(stateDir, { recursive: true, force: true })
    }
    if (errors.length) throw new AggregateError(errors, '真实 GitLab 验证或资源清理失败；请检查一次性项目中的测试分支与 Draft MR')
  }, 360_000)
})
