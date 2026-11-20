# Remonter les erreurs de herness en issues GitHub : plan d'implémentation

> **Pour les agents :** chaque tâche se fait en TDD (test d'abord, rouge, code minimal, vert), puis un commit.

**But :** proposer, à `herness fermer <id>` et avec une nouvelle commande `herness signaler <id>`, de publier les
entrées de `erreurs.log` d'une mission en issues (ou commentaires d'issues) sur `MaxVzl/herness`, après aperçu et
confirmation.

**Architecture :** un module `src/errreport.ts` relit le journal texte existant (`src/errlog.ts`, inchangé), regroupe
les entrées d'une mission par signature, compare aux issues ouvertes (`gh issue list`), prépare les textes, puis envoie
avec `gh` et note chaque envoi dans `missions/<id>/issues.json`. `src/lifecycle.ts` gagne `reportMissionErrors`
(commande `signaler`) et `closeMission` l'appelle quand l'action CLI `fermer` le demande.

**Technologies :** TypeScript (ESM, exécuté par tsx), vitest, `node:crypto` (`createHash('sha256')`),
`node:fs/promises`, `node:os` (`homedir`), commander, `gh` via le `Runner` de `src/forge/github.ts`.

**Spec :** `docs/superpowers/specs/2026-11-20-20261120-1-remonter-erreurs-issues.md`

## Contraintes globales

- Dépôt cible : constante `ISSUES_REPO = 'MaxVzl/herness'`, toujours passée à `gh` par `--repo MaxVzl/herness`.
- Aucun envoi sans aperçu affiché ; sans `--oui`, aucun envoi sans réponse oui à la confirmation.
- Dans tout texte publié (titre, corps, commentaire), `os.homedir()` est remplacé par `~`.
- Signature : `herness-sig-` + les 12 premiers caractères hexadécimaux de `sha256(origine + '\n' + premièreLigne)`,
  où `origine` est sans le suffixe ` (étape …)` et `premièreLigne` est la première ligne non vide du corps masqué.
- Empreinte d'entrée : `sha256(raw)` en hexadécimal complet.
- `issues.json` (dossier de la mission) : `{ "sent": [{ "entry", "signature", "url", "at" }] }`. Jamais `state.json`.
- Pas de label sur les issues ; `src/errlog.ts`, le format du journal et le prompt de l'orchestrateur ne changent pas.
- Les tests ne lancent jamais le vrai `gh` (runner factice) et fixent `HERNESS_HOME` sur un dossier temporaire.
- Messages, commentaires et libellés en français, comme le reste du code ; style du fichier modifié (point-virgule ou
  non) respecté.

## Points d'attention pour la revue

- Pas de fichier `erreurs.log` : aucune entrée, aucun appel à `gh`, `fermer` ne dit rien de plus (tâches 2 et 4).
- Corps d'entrée avec lignes vides et bloc `cause :` : reste une seule entrée (tâche 1).
- `gh` échoue au deuxième envoi : le premier est noté dans `issues.json`, l'erreur remonte, et la préparation suivante ne
  repropose que le second (tâche 2).
- `issues.json` illisible : rien n'est envoyé, erreur claire, fichier non écrasé (tâche 2).
- Corps contenant des accents graves triples : la clôture du bloc de code est plus longue (tâche 1).
- Mission `gh1` à côté de `gh12` : seules les entrées dont la mission est exactement l'identifiant sont prises (tâche 2).

---

### Tâche 1 : Lecture du journal et textes des issues (`src/errreport.ts`, fonctions pures)

**Test :** `pnpm vitest run test/errreport.test.ts`

**Fichiers :**
- Créer : `src/errreport.ts`
- Créer : `test/errreport.test.ts`

**Interfaces produites (utilisées par les tâches 2 à 4) :**
- `export const ISSUES_REPO = 'MaxVzl/herness'`
- `export type LogEntry = { raw: string; at: string; mission?: string; version: string; origin: string; step?: string; body: string }`
- `export function parseErrorLog(text: string): LogEntry[]`
- `export function entryHash(e: LogEntry): string` : `sha256(e.raw)` hexadécimal.
- `export function maskHome(text: string, home: string = homedir()): string` : toutes les occurrences de `home`
  remplacées par `~` (rien si `home` est vide).
- `export function errorSignature(e: LogEntry, home?: string): string`
- `export type ReportGroup = { signature: string; entries: LogEntry[] }`
- `export function groupEntries(entries: LogEntry[], home?: string): ReportGroup[]` : par signature, dans l'ordre de
  première apparition, entrées dans l'ordre du journal.
- `export function issueTitle(g: ReportGroup, home?: string): string`
- `export function issueBody(missionId: string, g: ReportGroup, home?: string): string`
- `export function commentBody(missionId: string, g: ReportGroup, home?: string): string`

Le paramètre `home` (défaut `homedir()`) existe pour les tests.

**Règles :**
- Découpage : une entrée commence à une ligne qui commence par `=== ` et qui est la première du texte ou précédée d'une
  ligne vide, et dont l'en-tête se lit avec `/^=== (\S+) · (?:mission (\S+) · )?herness (\S+) · (.+)$/` ; l'origine
  lue se sépare en `origin` et `step` avec `/^(.*) \(étape ([^)]+)\)$/`. Une ligne `=== ` illisible appartient au corps
  de l'entrée en cours (ignorée s'il n'y en a pas). `raw` = texte de l'entrée sans les lignes vides de fin ; `body` =
  lignes après l'en-tête, sans les lignes vides de fin. Ne lève jamais.
- Titre : `[erreur herness] <origin> : <première ligne non vide du corps>`, masqué, tronqué à 120 caractères au total
  (les 119 premiers puis `…`) s'il dépasse.
- Corps d'issue (lignes séparées par `\n`, texte masqué) :
  1. ``Remontée automatiquement par `herness signaler` (mission <id>).``
  2. ligne vide
  3. `- Version : herness <versions distinctes jointes par ', '>`
  4. `- Origine : <origin>` suivi de ` (étape <étapes distinctes non vides jointes par ', '>)` s'il y en a
  5. `- Vue <n> fois dans la mission : <dates (at) jointes par ', '>`
  6. `- Signature : <signature>`
  7. ligne vide, puis le corps de la **première** entrée du groupe dans un bloc de code dont la clôture est faite de
     `max(3, plus longue suite d'accents graves du corps + 1)` accents graves.
- Si le corps de la première entrée dépasse 60 000 caractères, il est coupé à 60 000 et suivi d'une ligne `(tronqué)`
  dans le bloc.
- Corps de commentaire : identique, mais la ligne 1 devient `Revue dans la mission <id>.` et la ligne `- Signature`
  est absente.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/errreport.test.ts`. Les journaux de test sont écrits avec
  le vrai `logHernessError` de `src/errlog.ts` (`HERNESS_HOME` sur un `mkdtemp` en `beforeEach`, supprimé en
  `afterEach`), puis relus avec `readFile(errorLogPath(), 'utf8')`, pour rester fidèles au format réel.
  - `découpe deux entrées et lit leur en-tête` : `logHernessError({ mission: 'm1', origin: 'moteur', step: 'tasks' }, new Error('boum'))` puis `logHernessError({ origin: 'lancement du moteur' }, 'texte')` → deux entrées ; la première a `mission: 'm1'`, `origin: 'moteur'`, `step: 'tasks'`, `version: VERSION`, `body` qui commence par `Error: boum` ; la seconde n'a ni `mission` ni `step`, `body === 'texte'`.
  - `un corps avec lignes vides et cause reste une seule entrée` : `new Error('haut', { cause: new Error('bas') })` puis `logHernessError({ mission: 'm1', origin: 'signalement de l\'orchestrateur' }, 'ligne 1\n\nligne 3')` → 2 entrées ; la première contient `cause :` et `Error: bas`, la seconde a `body === 'ligne 1\n\nligne 3'`.
  - `une ligne === illisible ne crée pas d'entrée` : texte écrit à la main `=== n'importe quoi\n` seul → `[]`.
  - `entryHash diffère pour deux entrées identiques à des instants différents` (raw différents par l'horodatage).
  - `la signature ignore étape, version et pile, pas la première ligne` : deux entrées `moteur` avec étapes différentes et même message → même signature, au format `/^herness-sig-[0-9a-f]{12}$/` ; un message différent → signature différente.
  - `maskHome remplace le dossier personnel` : `maskHome('/home/x/a et /home/x/b', '/home/x')` → `'~/a et ~/b'`.
  - `groupEntries regroupe les répétitions dans l'ordre` : entrées A, B, A → deux groupes `[A(2), B(1)]`.
  - `titre tronqué à 120 caractères` : message de 300 caractères → longueur 120, finit par `…`, commence par `[erreur herness] moteur : `.
  - `corps d'issue` : groupe de 2 entrées (étapes `tasks` et `preflight`) → contient ``Remontée automatiquement par `herness signaler` (mission m1).``, `- Origine : moteur (étape tasks, preflight)`, `- Vue 2 fois dans la mission : `, `- Signature : herness-sig-`, et le corps de la première entrée entre clôtures de 3 accents graves ; le dossier personnel passé en `home` n'apparaît plus.
  - `clôture plus longue que les accents graves du corps` : corps contenant ```` ``` ```` → clôture de 4 accents graves.
  - `corps tronqué au-delà de 60 000 caractères` : corps de 70 000 caractères → `(tronqué)` présent, longueur du corps d'issue < 61 000.
  - `corps de commentaire` : commence par `Revue dans la mission m2.` et ne contient pas `Signature`.
- [ ] **Étape 2 : lancer `pnpm vitest run test/errreport.test.ts`** : rouge (module absent).
- [ ] **Étape 3 : écrire `src/errreport.ts`** avec les interfaces et règles ci-dessus.
- [ ] **Étape 4 : relancer** : vert ; `pnpm run typecheck` sans erreur.
- [ ] **Étape 5 : commit** `feat: lecture du journal des erreurs et textes des issues`.

### Tâche 2 : Préparer et envoyer les issues d'une mission (`src/errreport.ts`)

**Test :** `pnpm vitest run test/errreport-send.test.ts`

**Fichiers :**
- Modifier : `src/errreport.ts`
- Créer : `test/errreport-send.test.ts`

**Interfaces consommées :** celles de la tâche 1 ; `errorLogPath()` (`src/errlog.ts`) ; `missionDir(id)`
(`src/paths.ts`) ; `type Runner` (`src/forge/github.ts`) ; `RunResult` (`src/exec.ts`, `run` accepte `input`).

**Interfaces produites (utilisées par les tâches 3 et 4) :**
- `export type SentRecord = { entry: string; signature: string; url: string; at: string }`
- `export function issuesFilePath(id: string): string` : `join(missionDir(id), 'issues.json')`.
- `export async function readSent(id: string): Promise<SentRecord[]>` : fichier absent → `[]` ; illisible (JSON
  invalide ou sans tableau `sent`) → lève `Error('issues.json illisible (<chemin>) : <détail>')`.
- `export async function pendingEntries(id: string): Promise<LogEntry[]>` : journal absent → `[]` ; sinon entrées dont
  `mission === id` exactement, moins celles dont `entryHash` est dans `readSent(id)`.
- `export type OpenIssue = { number: number; title: string; url: string }`
- `export type PlannedSend =
    | { kind: 'issue'; title: string; body: string; group: ReportGroup }
    | { kind: 'comment'; issue: OpenIssue; body: string; group: ReportGroup }`
- `export async function planReport(id: string, runner: Runner, home?: string): Promise<PlannedSend[]>` :
  `pendingEntries` vide → `[]` **sans appeler `gh`** ; sinon `gh issue list --repo MaxVzl/herness --state open --limit 500 --json number,title,body,url`
  (stdout JSON), puis pour chaque groupe : issue ouverte dont le `body` contient la signature → `comment` (corps
  `commentBody`), sinon `issue` (`issueTitle`, `issueBody`).
- `export function previewLines(id: string, plan: PlannedSend[]): string[]` : aperçu de la spec :
  `Erreurs herness de la mission <id> à remonter sur MaxVzl/herness (dépôt public) :`, ligne vide, puis pour chaque
  envoi `── Nouvelle issue : <titre>` ou `── Commentaire sur #<n> (<titre de l'issue>)`, le corps, une ligne vide ; et
  pour finir `Relis : tout ce qui est affiché sera public.`
- `export function confirmQuestion(plan: PlannedSend[]): string` : `Envoyer <a> et <b> sur MaxVzl/herness ?` avec
  `1 issue` / `<n> issues` et `1 commentaire` / `<n> commentaires`, la partie à zéro omise (ex.
  `Envoyer 1 issue et 1 commentaire sur MaxVzl/herness ?`, `Envoyer 2 issues sur MaxVzl/herness ?`).
- `export async function sendReport(id: string, plan: PlannedSend[], runner: Runner, now: () => Date = () => new Date()): Promise<string[]>` :
  dans l'ordre, `gh issue create --repo MaxVzl/herness --title <titre> --body-file -` ou
  `gh issue comment <n> --repo MaxVzl/herness --body-file -`, le corps passé en `input` ; l'URL est le stdout sans
  espaces. Après **chaque** réussite, ajoute un `SentRecord` par entrée du groupe et réécrit `issues.json` (créer le
  dossier au besoin). Rend une ligne par envoi : `issue créée : <url>` ou `commentaire ajouté : <url>`. Un échec de
  `gh` lève (les envois précédents restent notés) ; `readSent` qui lève empêche tout envoi.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/errreport-send.test.ts` (`HERNESS_HOME` temporaire,
  entrées écrites avec `logHernessError`). Runner factice qui enregistre `{ args, input }` et répond selon `args[1]` :
  `list` → JSON d'issues ouvertes (`[]` par défaut), `create` → `https://github.com/MaxVzl/herness/issues/7\n`,
  `comment` → `https://github.com/MaxVzl/herness/issues/42#issuecomment-1\n`.
  - `sans journal, rien à préparer et gh n'est pas appelé` : `planReport('m1', runner)` → `[]`, aucun appel.
  - `seules les entrées de la mission exacte sont prises` : entrées pour `gh1` et `gh12` → `pendingEntries('gh1')` n'a que celle de `gh1`.
  - `une erreur nouvelle donne une issue, une connue un commentaire` : deux erreurs distinctes ; la liste ouverte contient `{ number: 42, title: 'T', url: 'u42', body: '… <signature de la seconde> …' }` → plan `[issue, comment sur #42]` ; l'appel `list` a exactement les arguments ci-dessus.
  - `sendReport crée, commente et note chaque entrée` : après envoi, appels `['issue','create','--repo','MaxVzl/herness','--title',<titre>,'--body-file','-']` avec `input` = corps, et `['issue','comment','42','--repo','MaxVzl/herness','--body-file','-']` ; lignes rendues `issue créée : https://github.com/MaxVzl/herness/issues/7` et `commentaire ajouté : …#issuecomment-1` ; `issues.json` contient un record par entrée (groupe de 2 répétitions → 2 records avec la même url) ; `pendingEntries` est ensuite vide.
  - `un échec au deuxième envoi garde le premier` : `comment` lève → `sendReport` rejette ; `issues.json` n'a que les entrées de l'issue ; un nouveau `planReport` ne propose plus que le commentaire.
  - `issues.json illisible : rien n'est envoyé` : fichier contenant `{` → `planReport` rejette avec `/issues.json illisible/`, le runner n'est pas appelé pour `create`, le fichier vaut toujours `{`.
  - `previewLines et confirmQuestion` : plan `[issue, comment]` → première ligne `Erreurs herness de la mission m1 à remonter sur MaxVzl/herness (dépôt public) :`, contient `── Nouvelle issue : [erreur herness]`, `── Commentaire sur #42 (T)`, dernière ligne `Relis : tout ce qui est affiché sera public.` ; question `Envoyer 1 issue et 1 commentaire sur MaxVzl/herness ?` ; plan de 2 issues → `Envoyer 2 issues sur MaxVzl/herness ?`.
- [ ] **Étape 2 : lancer `pnpm vitest run test/errreport-send.test.ts`** : rouge.
- [ ] **Étape 3 : compléter `src/errreport.ts`** avec les interfaces ci-dessus.
- [ ] **Étape 4 : relancer** : vert ; `pnpm vitest run test/errreport.test.ts` toujours vert ; `pnpm run typecheck`.
- [ ] **Étape 5 : commit** `feat: préparer et envoyer les issues des erreurs d'une mission`.

### Tâche 3 : Commande `herness signaler <id> [--oui]`

**Test :** `pnpm vitest run test/cli/lifecycle.test.ts -t signaler`

**Fichiers :**
- Modifier : `src/lifecycle.ts` (nouvelle fonction exportée)
- Modifier : `src/cli.ts` (nouvelle commande, à côté de `fermer`)
- Modifier : `test/cli/lifecycle.test.ts`

**Interfaces consommées :** `planReport`, `previewLines`, `confirmQuestion`, `sendReport` (tâche 2) ;
`LifecycleDeps` et `load(id)` existants de `src/lifecycle.ts` (`deps.e.run` sert de `Runner`, `deps.e.now` d'horloge).

**Interfaces produites (utilisées par la tâche 4) :**
- `export async function reportMissionErrors(id: string, deps: LifecycleDeps, opts: { force?: boolean } = {}): Promise<boolean>`
  1. `load(id)` (mission introuvable → l'erreur existante).
  2. `plan = await planReport(id, deps.e.run)` ; vide → `out('Aucune erreur herness à remonter pour la mission <id>.')`, rend `true`.
  3. Sans `opts.force` et sans (`deps.isTTY` et `deps.confirm`) → lève `Error("l'envoi demande une confirmation dans un terminal interactif (ou --oui)")`, avant tout aperçu et tout envoi.
  4. Affiche `previewLines` (une ligne par appel à `out`).
  5. Sans `opts.force` : `deps.confirm(confirmQuestion(plan))` ; non → `out("rien n'a été envoyé (herness signaler <id> pour le refaire)")`, rend `false`.
  6. `sendReport(id, plan, deps.e.run, () => deps.e.now())`, chaque ligne rendue passée à `out` ; rend `true`. Les erreurs de `gh` remontent.
  Ne lit ni n'écrit `state.json` au-delà du `load` initial ; ne touche ni au moteur ni au worktree.
- Commande CLI : `program.command('signaler <id>').description("Remonter en issues GitHub (MaxVzl/herness) les erreurs herness d'une mission").option('--oui', 'sans demander de confirmation')`, action via `lifecycle(...)` qui appelle `reportMissionErrors(id, deps, { force: opts.oui === true })` (même forme que `supprimer`).

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/cli/lifecycle.test.ts`, dans une section `// ---------- signaler ----------`, noms commençant par `signaler`. Mission créée comme dans les autres tests (`newState`/`saveState` ou l'aide `started` existante) ; entrées écrites avec `logHernessError({ mission: 'gh12', origin: 'moteur' }, new Error('boum'))` ; `run` factice passé par `deps({ run })` qui répond `[]` à `gh issue list` et une URL à `gh issue create`.
  - `signaler sans erreur ne contacte pas GitHub` : `out` contient `Aucune erreur herness à remonter pour la mission gh12.`, aucun appel `run` avec `gh`.
  - `signaler sur une mission inconnue échoue` : rejette avec `/introuvable/`.
  - `signaler hors terminal sans --oui refuse sans rien envoyer` : `isTTY: false` → rejette avec `/terminal interactif/` ; aucun `gh issue create`.
  - `signaler affiche l'aperçu, demande puis envoie` : `isTTY: true`, `confirm` qui enregistre la question et répond oui → `out` contient la ligne `Erreurs herness de la mission gh12 …` avant `issue créée : …` ; question `Envoyer 1 issue sur MaxVzl/herness ?` ; `issues.json` écrit ; `state.json` inchangé (même `step`).
  - `signaler refusé n'envoie rien` : `confirm` → non ; rend `false` ; `out` contient `rien n'a été envoyé` ; aucun `gh issue create`.
  - `signaler --oui envoie sans question mais avec aperçu` : `isTTY: false`, `force: true` → `confirm` jamais appelé, aperçu dans `out`, issue créée.
- [ ] **Étape 2 : lancer `pnpm vitest run test/cli/lifecycle.test.ts -t signaler`** : rouge.
- [ ] **Étape 3 : écrire `reportMissionErrors` et la commande CLI.**
- [ ] **Étape 4 : relancer** : vert ; `pnpm vitest run test/cli/lifecycle.test.ts` entier vert ; `pnpm run typecheck`.
- [ ] **Étape 5 : commit** `feat: commande herness signaler`.

### Tâche 4 : `herness fermer` propose l'envoi, et documentation

**Test :** `pnpm vitest run test/cli/lifecycle.test.ts test/ui/actions.test.ts`

**Fichiers :**
- Modifier : `src/lifecycle.ts` (`closeMission`)
- Modifier : `src/cli.ts` (action `fermer`)
- Modifier : `README.md`
- Modifier : `test/cli/lifecycle.test.ts`

**Interfaces consommées :** `reportMissionErrors` (tâche 3) ; `pendingEntries` (tâche 2).

**Comportement :**
- Signature : `closeMission(id: string, deps: LifecycleDeps, opts: { signaler?: boolean } = {}): Promise<boolean>`.
  Seule l'action CLI `fermer` passe `{ signaler: true }` ; `src/ui/actions.ts` (cockpit, panneau `tasks`) ne change pas.
- Placement : juste **après** le bloc de confirmation des risques (donc rien si l'utilisateur a répondu non :
  `fermeture annulée`, rend `false`, aucune proposition) et **avant** `stopEngine`.
- Avec `opts.signaler`, `deps.isTTY` et `deps.confirm` : `await reportMissionErrors(id, deps)` dans un `try` ; son
  résultat (refus) est ignoré ; toute erreur devient
  `out('erreurs herness non remontées (<message>) : herness signaler <id>')`. La fermeture continue dans tous les cas.
  Une mission sans erreur à remonter affiche donc `Aucune erreur herness à remonter pour la mission <id>.` : remplacer
  ce cas par le silence dans `fermer` (par exemple en ne l'appelant que si `pendingEntries(id)` n'est pas vide, une
  erreur de lecture passant alors par le message ci-dessus).
- Sinon (option absente ou hors terminal) : `n = (await pendingEntries(id)).length` dans un `try` (erreur ignorée) ; si
  `n > 0`, `out('<n> erreur(s) herness non remontée(s) : herness signaler <id>')`. Aucun appel à `gh`.
- Mission déjà `fermée` et entièrement nettoyée (retour anticipé `déjà fermée : rien à fermer`) : avant ce retour,
  seulement la ligne de rappel ci-dessus si `n > 0`, jamais de proposition d'envoi.
- README :
  - Tableau des commandes : nouvelle ligne `herness signaler <id> [--oui]` (aperçu des issues et commentaires à
    publier sur `MaxVzl/herness`, dépôt public, confirmation ; `--oui` sans question) ; la ligne de `herness fermer`
    mentionne qu'en ligne de commande elle propose d'abord de remonter les erreurs herness de la mission.
  - Section « Où vivent les missions » : un paragraphe sur `erreurs.log` (`~/.local/state/herness/erreurs.log`), sa
    remontée en issues (une par erreur distincte, commentaire si une issue ouverte porte déjà la même signature
    `herness-sig-…`, dossier personnel remplacé par `~`), et `missions/<id>/issues.json` qui retient ce qui est parti.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/cli/lifecycle.test.ts` (noms commençant par `fermer`), avec l'aide `started` existante, `unpushedCount: async () => 0`, des entrées `gh12` écrites par `logHernessError`, et un `run` factice pour `gh` (comme en tâche 3) :
  - `fermer en terminal propose l'envoi avant d'arrêter le moteur` : `closeMission('gh12', d, { signaler: true })` avec `isTTY: true` et `confirm` → oui : `gh issue create` appelé, `issues.json` écrit, et cet appel se trouve dans `fx.calls` **avant** le premier appel qui arrête le moteur (repérer l'appel herdr d'arrêt utilisé par les tests `fermer` existants) ; mission `fermée`.
  - `fermer : l'envoi refusé n'empêche pas la fermeture` : `confirm` → oui pour toute question sauf celle qui commence par `Envoyer` → mission `fermée`, aucun `gh issue create`.
  - `fermer : un échec de gh n'empêche pas la fermeture` : `gh issue list` lève `Error('gh non connecté')` → `out` contient `erreurs herness non remontées (gh non connecté) : herness signaler gh12`, mission `fermée`.
  - `fermer sans erreur à remonter ne dit rien de plus` : journal vide, `{ signaler: true }`, terminal → aucun appel `gh`, `out` ne contient ni `Aucune erreur herness` ni `herness signaler`.
  - `fermer sans l'option rappelle la commande sans contacter GitHub` : `closeMission('gh12', d)` → `out` contient `1 erreur(s) herness non remontée(s) : herness signaler gh12`, aucun appel `gh`.
  - `fermer annulé ne propose rien` : `unpushedCount: async () => 2`, `confirm` → non → rend `false`, une seule question posée (celle des commits), aucun appel `gh`.
  - `fermer sur une mission déjà fermée et nettoyée rappelle seulement la commande` : mission `fermée` sans worktree, espace ni base, entrée non envoyée → `out` contient `déjà fermée` et `herness signaler gh12`, aucun appel `gh`.
- [ ] **Étape 2 : lancer `pnpm vitest run test/cli/lifecycle.test.ts`** : les nouveaux tests sont rouges.
- [ ] **Étape 3 : modifier `closeMission`, l'action `fermer` de `src/cli.ts` (`closeMission(id, deps, { signaler: true })`) et le README.**
- [ ] **Étape 4 : relancer la commande de test de la tâche** : vert (tests `fermer` existants compris) ; `pnpm run typecheck`.
- [ ] **Étape 5 : commit** `feat: herness fermer propose de remonter les erreurs herness`.
