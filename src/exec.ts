import { execa } from 'execa'

export interface RunOptions {
  cwd?: string
  input?: string
  reject?: boolean
  env?: Record<string, string>
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await execa(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    reject: opts.reject ?? true,
    env: opts.env,
  })
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 }
}
