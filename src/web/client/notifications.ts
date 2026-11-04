interface BrowserNote {
  onclick: (() => void) | null
}

interface BrowserNotification {
  permission: string
  requestPermission(): Promise<string>
  new (title: string, options?: { body?: string; tag?: string }): BrowserNote
}

function browser() {
  return globalThis as unknown as {
    document: { visibilityState: string; addEventListener(type: string, listener: () => void): void }
    location: { hash: string }
    focus(): void
    addEventListener(type: string, listener: () => void): void
    dispatchEvent(ev: object): void
    Event: new (type: string) => object
    Notification?: BrowserNotification
  }
}

const CHANNEL = 'herness-notifications'
const CLAIM_MS = 30

interface Claim {
  id: string
  at: number
  visible: boolean
}

interface Wire {
  type: 'claim' | 'done'
  key: string
  id?: string
  at?: number
  visible?: boolean
}

const seen = new Set<string>()
const inflight = new Set<string>()
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
let lastActive = Date.now()
let bound = false
let channel: BroadcastChannel | undefined

function bus(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel !== 'function') return undefined
  try {
    if (!channel) {
      channel = new BroadcastChannel(CHANNEL)
      channel.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data as Wire | undefined
        if (data?.type === 'done' && typeof data.key === 'string') seen.add(data.key)
      })
    }
  } catch {
    return undefined
  }
  return channel
}

function bindActivity(): void {
  if (bound) return
  bound = true
  const root = browser()
  const bump = () => {
    lastActive = Date.now()
  }
  try {
    root.addEventListener('focus', bump)
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.visibilityState === 'visible') bump()
    })
  } catch {
    // pas de DOM
  }
}

/** L'onglet visible l'emporte ; sinon le plus récent. À égalité, l'identifiant le plus grand. */
export function shouldNotify(self: Claim, others: readonly Claim[]): boolean {
  const rank = (claim: Claim): [number, number, string] => [claim.visible ? 1 : 0, claim.at, claim.id]
  const best = [self, ...others].reduce((left, right) => {
    const a = rank(left)
    const b = rank(right)
    if (a[0] !== b[0]) return a[0] > b[0] ? left : right
    if (a[1] !== b[1]) return a[1] > b[1] ? left : right
    return a[2] > b[2] ? left : right
  })
  return best.id === self.id
}

function show(event: { key: string; missionId: string; title: string; body: string }): void {
  const Ctor = browser().Notification
  if (!Ctor || Ctor.permission !== 'granted') return
  const note = new Ctor(event.title, { body: event.body, tag: event.key })
  note.onclick = () => {
    const root = browser()
    root.location.hash = `#/${encodeURIComponent(event.missionId)}`
    root.dispatchEvent(new root.Event('hashchange'))
    root.focus()
  }
}

export function deliverNotification(
  event: { key: string; missionId: string; title: string; body: string },
  selectedId: string | undefined,
): void {
  if (seen.has(event.key) || inflight.has(event.key)) return
  const Ctor = browser().Notification
  if (!Ctor || Ctor.permission !== 'granted') return
  bindActivity()
  inflight.add(event.key)
  const root = browser()
  const self: Claim = {
    id: tabId,
    at: lastActive,
    visible: root.document.visibilityState === 'visible',
  }
  if (self.visible && selectedId === event.missionId) {
    seen.add(event.key)
    bus()?.postMessage({ type: 'done', key: event.key } satisfies Wire)
    return
  }
  const link = bus()
  if (!link) {
    seen.add(event.key)
    show(event)
    return
  }
  const others: Claim[] = []
  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as Wire | undefined
    if (!data || data.key !== event.key) return
    if (data.type === 'done') {
      seen.add(event.key)
      return
    }
    if (data.type === 'claim' && typeof data.id === 'string' && typeof data.at === 'number') {
      others.push({ id: data.id, at: data.at, visible: data.visible === true })
    }
  }
  link.addEventListener('message', onMessage)
  link.postMessage({ type: 'claim', key: event.key, id: self.id, at: self.at, visible: self.visible } satisfies Wire)
  setTimeout(() => {
    link.removeEventListener('message', onMessage)
    if (seen.has(event.key) || !shouldNotify(self, others)) {
      seen.add(event.key)
      return
    }
    seen.add(event.key)
    link.postMessage({ type: 'done', key: event.key } satisfies Wire)
    show(event)
  }, CLAIM_MS)
}

export function notificationPermission(): string | undefined {
  return browser().Notification?.permission
}

export function requestNotificationPermission(): Promise<string> | undefined {
  const Ctor = browser().Notification
  if (!Ctor) return undefined
  return Ctor.requestPermission()
}
