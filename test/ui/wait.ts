/** Wait on a condition for ink tests: sequence on what is observable, never on a fixed delay. */
export async function until(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until: condition not met after ${timeoutMs} ms (${cond.toString()})`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
  await settle()
}

/** Let React run effects already scheduled (for example the useInput subscription): without this, a visible render can precede its key handler. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

export const frameContains = (lastFrame: () => string | undefined, text: string): boolean => (lastFrame() ?? '').includes(text)

/** Wait until the latest render contains `text`. */
export async function waitFor(lastFrame: () => string | undefined, text: string, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => frameContains(lastFrame, text), timeoutMs)
  } catch {
    throw new Error(`waitFor: "${text}" missing after ${timeoutMs} ms; last render:\n${lastFrame() ?? '(none)'}`)
  }
}

/** Wait until the latest render no longer contains `text`. */
export async function waitGone(lastFrame: () => string | undefined, text: string, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => !frameContains(lastFrame, text), timeoutMs)
  } catch {
    throw new Error(`waitGone: "${text}" still present after ${timeoutMs} ms; last render:\n${lastFrame() ?? '(none)'}`)
  }
}

/** Wait until the latest render matches `re`. */
export async function waitMatch(lastFrame: () => string | undefined, re: RegExp, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => re.test(lastFrame() ?? ''), timeoutMs)
  } catch {
    throw new Error(`waitMatch: ${re} did not match after ${timeoutMs} ms; last render:\n${lastFrame() ?? '(none)'}`)
  }
}
