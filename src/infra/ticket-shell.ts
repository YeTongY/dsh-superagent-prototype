/** 保留宿主 shell 工具的协议，在每条命令的子进程内绑定工单环境。 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function ticketShell(definition: ToolDefinition, environment: () => Record<string, string>, directory?: string): ToolDefinition {
  return { ...definition, execute: (input, execution) => {
    if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string') throw new Error('Shell command is required')
    const entries = Object.entries(environment())
    if (entries.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid ticket environment key')
    const exports = definition.name === 'pwsh'
      ? entries.map(([name, value]) => `$env:${name} = '${value.replaceAll("'", "''")}'`).join('; ')
      : entries.map(([name, value]) => `export ${name}=${posixQuote(value)}`).join('\n')
    let prefix = exports
    if (directory) {
      // 宿主 shell 可能把命令显示为后台任务名称；命令只引用受保护文件，避免把代理凭据写入任务标题。
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const digest = createHash('sha256').update(exports).digest('hex')
      const file = join(directory, `${digest}.${definition.name === 'pwsh' ? 'ps1' : 'sh'}`)
      const temporary = join(directory, `${randomUUID()}.tmp`)
      writeFileSync(temporary, `${exports}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      prefix = definition.name === 'pwsh' ? `. '${file.replaceAll("'", "''")}'` : `. ${posixQuote(file)}`
    }
    return definition.execute({ ...input, command: `${prefix}\n${input.command}` }, execution)
  } }
}
