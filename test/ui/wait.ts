/** Attente sur condition pour les tests ink : on séquence sur ce qui est observable, jamais sur un délai fixe. */
export async function until(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until : condition non remplie après ${timeoutMs} ms (${cond.toString()})`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
  await settle()
}

/** Laisse React exécuter les effets déjà planifiés (ex. l'abonnement de useInput) : sans cela, un rendu déjà visible peut précéder son gestionnaire de touches. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

export const frameContains = (lastFrame: () => string | undefined, text: string): boolean => (lastFrame() ?? '').includes(text)

/** Attend que le dernier rendu contienne `text`. */
export async function waitFor(lastFrame: () => string | undefined, text: string, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => frameContains(lastFrame, text), timeoutMs)
  } catch {
    throw new Error(`waitFor : « ${text} » absent après ${timeoutMs} ms ; dernier rendu :\n${lastFrame() ?? '(aucun)'}`)
  }
}

/** Attend que le dernier rendu ne contienne plus `text`. */
export async function waitGone(lastFrame: () => string | undefined, text: string, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => !frameContains(lastFrame, text), timeoutMs)
  } catch {
    throw new Error(`waitGone : « ${text} » toujours présent après ${timeoutMs} ms ; dernier rendu :\n${lastFrame() ?? '(aucun)'}`)
  }
}

/** Attend que le dernier rendu satisfasse `re`. */
export async function waitMatch(lastFrame: () => string | undefined, re: RegExp, timeoutMs = 3000): Promise<void> {
  try {
    await until(() => re.test(lastFrame() ?? ''), timeoutMs)
  } catch {
    throw new Error(`waitMatch : ${re} sans correspondance après ${timeoutMs} ms ; dernier rendu :\n${lastFrame() ?? '(aucun)'}`)
  }
}
