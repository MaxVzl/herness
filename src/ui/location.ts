import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProjectConfig, type ProjectConfig } from '../config/project.ts'
import type { HerdrApi } from '../herdr/client.ts'
import { missionsRoot } from '../paths.ts'

const LABEL = 'herness'
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'herness.js')
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

interface Spot { workspace: string; tab: string }

export const cockpitFile = (): string => join(dirname(missionsRoot()), 'cockpit.json')

async function readSpots(file: string): Promise<Record<string, Spot>> {
  const out: Record<string, Spot> = {}
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        const s = v as Partial<Spot> | null
        if (s && typeof s.workspace === 'string' && typeof s.tab === 'string') out[k] = { workspace: s.workspace, tab: s.tab }
      }
    }
  } catch {
    // fichier absent ou invalide : rien d'enregistré
  }
  return out
}

async function saveSpot(file: string, repoPath: string, spot: Spot): Promise<void> {
  const all = await readSpots(file)
  all[repoPath] = spot
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(all, null, 2))
  await rename(tmp, file)
}

async function createTab(repoPath: string, workspace: string, h: HerdrApi, file: string): Promise<void> {
  const { tabId, rootPaneId } = await h.tabCreate({ workspace, cwd: repoPath, label: LABEL })
  try {
    await h.paneRun(rootPaneId, `node ${shq(BIN)} cockpit`)
  } catch (e) {
    await h.tabClose(tabId).catch(() => undefined)
    throw e
  }
  await h.tabFocus(tabId)
  await saveSpot(file, repoPath, { workspace, tab: tabId })
}

export async function openCockpit(
  cwd: string,
  h: HerdrApi,
  file: string = cockpitFile(),
  loadConfig: (cwd: string) => Promise<ProjectConfig> = loadProjectConfig,
): Promise<'ouvert' | 'créé'> {
  const cfg = await loadConfig(cwd)
  const { workspaceId } = await h.paneCurrent()
  const existing = (await h.tabList(workspaceId)).find((t) => t.label === LABEL)
  if (existing) {
    await h.tabFocus(existing.tabId)
    await saveSpot(file, cfg.repoPath, { workspace: workspaceId, tab: existing.tabId })
    return 'ouvert'
  }
  await createTab(cfg.repoPath, workspaceId, h, file)
  return 'créé'
}

export async function focusCockpit(repoPath: string, h: HerdrApi, file: string = cockpitFile()): Promise<void> {
  const spot = (await readSpots(file))[repoPath]
  if (!spot) throw new Error("aucun cockpit pour ce projet : lance herness dans l'espace du projet")
  const gone = new Error("cockpit introuvable : relance herness dans l'espace du projet")
  const tabs = await h.tabList(spot.workspace).catch(() => [])
  const tab = tabs.find((t) => t.tabId === spot.tab)
  try {
    await h.workspaceFocus(spot.workspace)
    if (tab) await h.tabFocus(tab.tabId)
    else await createTab(repoPath, spot.workspace, h, file)
  } catch {
    throw gone
  }
}
