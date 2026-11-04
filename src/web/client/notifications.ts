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
    document: { visibilityState: string }
    location: { hash: string }
    focus(): void
    dispatchEvent(ev: object): void
    Event: new (type: string) => object
    Notification?: BrowserNotification
  }
}

const seen = new Set<string>()

export function deliverNotification(
  event: { key: string; missionId: string; title: string; body: string },
  selectedId: string | undefined,
): void {
  if (seen.has(event.key)) return
  const Ctor = browser().Notification
  if (!Ctor || Ctor.permission !== 'granted') return
  seen.add(event.key)
  const root = browser()
  if (root.document.visibilityState === 'visible' && selectedId === event.missionId) return
  const note = new Ctor(event.title, { body: event.body, tag: event.key })
  note.onclick = () => {
    const root = browser()
    root.location.hash = `#/${encodeURIComponent(event.missionId)}`
    root.dispatchEvent(new root.Event('hashchange'))
    root.focus()
  }
}

export function notificationPermission(): string | undefined {
  return browser().Notification?.permission
}

export function requestNotificationPermission(): Promise<string> | undefined {
  const Ctor = browser().Notification
  if (!Ctor) return undefined
  return Ctor.requestPermission()
}
