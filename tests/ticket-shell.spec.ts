/** 真实子进程验证多工单环境与 shell 转义，避免只检查字符串拼接。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ticketShell } from '../src/infra/ticket-shell.ts'

const exec = promisify(execFile)
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const bash: ToolDefinition = {
  name: 'bash', description: '测试 shell', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
  execute: async input => {
    const { command } = input as { command: string }
    const result = await exec('bash', ['-c', command])
    return { stdout: result.stdout }
  },
}

it('binds each concurrent ticket to its own project and preserves literal environment values', async () => {
  const original = process.env.DSH_SUPERAGENT_SOURCE
  const value = "CA path 'quoted'\n$(printf unexpected) `printf unexpected`"
  const directory = mkdtempSync(join(tmpdir(), 'ticket-shell-')); directories.push(directory)
  const commands: string[] = []
  const definition = { ...bash, execute: (input: unknown, context: Parameters<ToolDefinition['execute']>[1]) => {
    commands.push((input as { command: string }).command)
    return bash.execute(input, context)
  } }
  const make = (id: string) => ticketShell(definition, () => ({ DSH_SUPERAGENT_SOURCE: id, TEST_CA: value }), directory)
  const input = Object.freeze({ command: 'node -e \'process.stdout.write(JSON.stringify([process.env.DSH_SUPERAGENT_SOURCE, process.env.TEST_CA]))\'' })
  const result = await Promise.all(['project-one', 'project-two'].map(id => make(id).execute(input, {} as never))) as { stdout: string }[]
  expect(result.map(row => JSON.parse(row.stdout))).toEqual([['project-one', value], ['project-two', value]])
  expect(process.env.DSH_SUPERAGENT_SOURCE).toBe(original)
  expect(input.command.startsWith('node')).toBe(true)
  expect(commands.every(command => !command.includes('unexpected') && !command.includes('quoted'))).toBe(true)
  expect(readdirSync(directory).every(file => (statSync(join(directory, file)).mode & 0o777) === 0o600)).toBe(true)
})

it('refuses an invalid variable name before executing a shell', async () => {
  const shell = ticketShell(bash, () => ({ 'INVALID;echo': 'value' }))
  expect(() => shell.execute({ command: 'true' }, {} as never)).toThrow('Invalid ticket environment key')
})
