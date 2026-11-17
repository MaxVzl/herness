import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hernessHome } from './paths.ts'
import { VERSION } from './version.ts'

export type ErrorContext = { mission?: string; origin: string; step?: string }

export function errorLogPath(): string {
  return join(hernessHome(), 'erreurs.log')
}

function formatBody(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    const head = err.stack ?? `${err.name}: ${err.message}`
    if (err.cause !== undefined) return `${head}\ncause :\n${formatBody(err.cause)}`
    return head
  }
  return String(err)
}

function formatEntry(ctx: ErrorContext, err: unknown): string {
  const origin = ctx.step ? `${ctx.origin} (étape ${ctx.step})` : ctx.origin
  const segments = [`=== ${new Date().toISOString()}`]
  if (ctx.mission) segments.push(`mission ${ctx.mission}`)
  segments.push(`herness ${VERSION}`, origin)
  return `${segments.join(' · ')}\n${formatBody(err)}\n\n`
}

export async function logHernessError(ctx: ErrorContext, err: unknown): Promise<void> {
  try {
    await mkdir(hernessHome(), { recursive: true })
    await appendFile(errorLogPath(), formatEntry(ctx, err))
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    console.error(`herness : journal des erreurs inaccessible : ${message}`)
  }
}

export async function withErrorLog<T>(ctx: ErrorContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    await logHernessError(ctx, err)
    throw err
  }
}

export type ErrorProcess = {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => Promise<void>): unknown
  exit(code: number): void
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.stack) return err.stack
  return String(err)
}

export function installProcessErrorLog(ctx: ErrorContext, proc: ErrorProcess = process as unknown as ErrorProcess): void {
  const listener = async (err: unknown) => {
    await logHernessError(ctx, err)
    console.error(`herness : ${errorText(err)}`)
    proc.exit(1)
  }
  proc.on('uncaughtException', listener)
  proc.on('unhandledRejection', listener)
}
