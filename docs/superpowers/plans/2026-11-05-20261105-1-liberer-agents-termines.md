# Arrêter les agents dès que leur travail est fini — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le moteur arrête le processus d'un agent de l'onglet `agents` dès que son travail est fini, en gardant le panneau, son historique et sa marque.

**Architecture :** `src/herdr/layout.ts` expose l'arrêt existant d'un panneau (`retire` : double ctrl+c, SIGTERM, SIGKILL) sous deux fonctions publiques, `release` (un panneau) et `releaseTab` (balayage de l'onglet). Le moteur les appelle par deux fonctions de `src/engine/tasks.ts` qui journalisent et ne lèvent jamais : `stopAgent` (un agent nommé) et `stopAgentsTab` (balayage). Elles sont branchées aux endroits où le moteur pose déjà ✓ (tâche validée, tours de fin de mission), au changement de génération des boucles de fin, à l'ouverture de la PR, à l'abandon validé et au démarrage du moteur.

**Tech Stack :** TypeScript (ESM, `tsx`), vitest, doublures `test/herdr/fake.ts` et `test/fakes.ts`.

**Spec :** `docs/superpowers/specs/2026-11-05-20261105-1-liberer-agents-termines.md`

## Contraintes globales

- Ne jamais fermer ni supprimer un panneau, ne jamais le renommer pour l'arrêter : seul le processus de l'agent s'arrête, le panneau revient à son shell avec son libellé (marque ✓ comprise).
- Ne jamais toucher à l'onglet `master` (l'orchestrateur n'est jamais arrêté) : seul l'onglet `s.herdr.tabs['agents']` est concerné.
- Un échec d'arrêt ne lève jamais d'erreur dans le moteur : il est écrit dans `s.log` (via `log(s, e, …)` de `src/engine/engine.ts`) et l'étape continue.
- Un panneau déjà libre ne produit ni action (aucun `paneSendKeys`) ni ligne de journal.
- Les implémenteurs et relecteurs d'une tâche ne sont **pas** arrêtés entre deux tours de correction ; seulement quand la tâche passe en `done`.
- Journaux en français, style existant. Formats exacts : `<quoi> : agent <nom> arrêté` et `<quoi> : agent <nom> non arrêté (<message d'erreur>)` ; pour un balayage : `<pourquoi> : agent(s) arrêté(s) dans <libellés séparés par « , »>` et `<pourquoi> : arrêt impossible (<message>)` par échec.
- Le recyclage de `slot()` et la taille de grille (6) ne changent pas.
- Commits au format du projet (`fix(liberer-agents-termines): …`), sans `--no-verify`, sans `git stash`.

## Points d'attention pour la revue

- Tâche en cours de correction (tests rouges ou revue « CORRECTIONS ») : l'implémenteur et le relecteur restent vivants ; test dans la tâche 2.
- Échec d'arrêt (panneau sourd à ctrl+c, SIGTERM et SIGKILL) : la tâche passe quand même en `done`, l'échec est journalisé ; test dans la tâche 2.
- Agent dont le panneau n'est pas enregistré dans `s.herdr.panes` (mission ancienne) ou panneau disparu : aucun arrêt, aucune erreur ; test dans la tâche 1 (`release` sur un panneau inconnu rend `false`) et dans la tâche 2.
- Démarrage du moteur sur une mission bloquée : les panneaux ✓ sont arrêtés, les autres non ; test dans la tâche 4.
- Le test existant « au démarrage du moteur, les commandes restées en cours… » (`test/engine/engine.test.ts`) part d'une mission `pr-ouverte` avec un agent vivant : après ce correctif, cet agent est arrêté ; la tâche 4 met à jour ses attentes.

---

### Tâche 1 : Exposer l'arrêt d'un panneau et le balayage de l'onglet agents

**Test :** `pnpm vitest run test/herdr/layout.test.ts`

**Fichiers :**
- Modifier : `src/herdr/layout.ts` (à côté de la fonction privée `retire`)
- Modifier : `test/herdr/fake.ts` (méthode `paneSendKeys` de `FakeHerdr`)
- Modifier : `test/fakes.ts` (`FakeEngineHerdr` et en-tête du module)
- Test : `test/herdr/layout.test.ts` (nouveaux `describe('release')` et `describe('releaseTab')`)

**Interfaces :**
- Produit, dans `src/herdr/layout.ts` :
  - `export async function release(h: HerdrApi, paneId: string): Promise<boolean>` : relit le panneau par `h.paneList(<espace tiré de paneId>)` ; panneau introuvable → `false` ; panneau libre (règle privée `isFree` : pas d'`agent` et `paneIsIdle`) → `false`, sans aucun appel à `paneSendKeys` ; sinon appelle `retire(h, pane)` et rend `true`. Laisse remonter l'erreur de `retire` (message déjà existant : `le panneau … n'est pas revenu au shell après ctrl+c, SIGTERM et SIGKILL`).
  - `export async function releaseTab(h: HerdrApi, tab: string, which: 'done' | 'all'): Promise<{ released: string[]; failed: string[] }>` : panneaux de l'onglet `tab` ; avec `'done'`, seulement ceux dont le libellé contient ✓ ou ✗ (même expression que le recyclage de `slot` : `/[✓✗]/`) ; appelle `release` sur chacun, dans l'ordre de `paneList`. `released` reçoit le libellé (ou, à défaut, l'identifiant) de chaque panneau pour lequel `release` a rendu `true` ; `failed` reçoit le message de chaque erreur. Ne lève jamais pour un panneau ; continue avec les suivants.
- Produit, dans les doublures :
  - `FakeHerdr.paneSendKeys` : un `ctrl+c` sur un panneau non sourd remet `busy` à `false` **et** supprime son champ `agent` (comme herdr, qui efface l'agent du panneau quand il se termine).
  - `FakeEngineHerdr` (`test/fakes.ts`) : quand un `ctrl+c` efface l'agent d'un panneau, ce nom est retiré de `started` (donc `agentGet(nom)` rend `null` ensuite). Surcharger `paneSendKeys` dans `FakeEngineHerdr` en lisant `this.pane(pane).agent` avant d'appeler `super.paneSendKeys`.
  - `fakeEffects` : `agents.start(name, role, pane)` marque le panneau occupé : `herdr.pane(pane).busy = true` et `herdr.pane(pane).agent = name`, en plus de `herdr.started.add(name)`.
  - En tête de `test/fakes.ts` (exécuté à l'import) : `timing.retireDelayMs = 0`, `timing.pollMs = 0`, et `signals.kill` remplacé par une fonction qui lève `signal réel interdit dans les tests` (import depuis `../src/herdr/layout.ts`), pour que les tests du moteur n'attendent pas et n'envoient jamais de vrai signal.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/herdr/layout.test.ts` (le `beforeEach` existant met déjà `timing` à 0 et interdit les signaux), en important `release` et `releaseTab` :
  - `release : un panneau occupé reçoit deux ctrl+c et revient au shell, libellé inchangé` : panneau libellé `T1 · grok ✓`, `busy = true`, `agent = 'ct-1-t1'` → `release` rend `true`, `h.calls.filter((c) => c === 'paneSendKeys ctrl+c')` a 2 éléments, `h.pane(p).busy === false`, `h.pane(p).agent === undefined`, libellé toujours `T1 · grok ✓`, nombre de panneaux inchangé.
  - `release : un panneau déjà libre ne reçoit rien` : `busy = false`, pas d'agent → `false`, aucun appel `paneSendKeys`.
  - `release : un panneau inconnu rend false` : identifiant `w1:p999` sur un espace existant → `false`, aucun appel `paneSendKeys`.
  - `release : l'échec final remonte avec le panneau, l'agent et les PID` : panneau sourd (`deaf = true`, `busy = true`, `agent = 'claude'`), `signals.kill = () => {}` → rejette avec le message existant de `retire` (`n'est pas revenu au shell après ctrl+c, SIGTERM et SIGKILL`).
  - `releaseTab done : arrête seulement les panneaux ✓, garde les autres` : panneaux `T1 · grok ✓` (occupé), `T2 · grok` (occupé), `T1 · opus ✓` (déjà libre) → `released` vaut `['T1 · grok ✓']`, `failed` vaut `[]`, `T2 · grok` toujours occupé.
  - `releaseTab all : arrête tous les panneaux occupés de l'onglet, jamais ceux d'un autre onglet` : deux panneaux occupés dans l'onglet visé, un panneau occupé dans un autre onglet du même espace → les deux premiers libres, le troisième toujours occupé.
  - `releaseTab : un échec n'empêche pas les suivants` : premier panneau sourd (`signals.kill = () => {}`), second occupé normal → `failed` a 1 message contenant `n'est pas revenu au shell`, `released` contient le libellé du second.
- [ ] **Étape 2 : lancer les tests et constater l'échec** : `pnpm vitest run test/herdr/layout.test.ts` → échec (`release` / `releaseTab` non exportés).
- [ ] **Étape 3 : implémenter** `release` et `releaseTab` dans `src/herdr/layout.ts` en réutilisant `isFree` et `retire` sans les dupliquer ; adapter `test/herdr/fake.ts` et `test/fakes.ts` comme décrit dans « Interfaces ».
- [ ] **Étape 4 : lancer les tests et constater le succès** : `pnpm vitest run test/herdr/layout.test.ts` → tout vert. Lancer aussi `pnpm vitest run test/engine` pour vérifier que la doublure modifiée ne casse aucun test existant (aucun appel de production ne change encore) ; si un test existant casse à cause du panneau désormais occupé après `agents.start` (recyclage de `slot` qui envoie maintenant des ctrl+c), corriger l'attente du test, pas le code de production.
- [ ] **Étape 5 : commit** : `git add src/herdr/layout.ts test/herdr/fake.ts test/fakes.ts test/herdr/layout.test.ts` puis `git commit -m "fix(liberer-agents-termines): exposer l'arrêt d'un panneau et le balayage de l'onglet agents"`.

### Tâche 2 : Arrêter les agents d'une tâche validée

**Test :** `pnpm vitest run test/engine/tasks.test.ts`

**Fichiers :**
- Modifier : `src/engine/tasks.ts` (nouvelles fonctions exportées près de `startAgent`, et `markTaskPanes`)
- Test : `test/engine/tasks.test.ts`

**Interfaces :**
- Consomme : `release(h, paneId): Promise<boolean>` et `releaseTab(h, tab, which): Promise<{ released: string[]; failed: string[] }>` de `src/herdr/layout.ts` (tâche 1).
- Produit, dans `src/engine/tasks.ts` :
  - `export async function stopAgent(s: MissionState, e: Effects, what: string, name: string): Promise<void>` : panneau `s.herdr.panes[name]` ; absent → ne fait rien. Sinon `release(e.herdr, pane)` : `true` → `log(s, e, \`${what} : agent ${name} arrêté\`)` ; `false` → rien ; erreur → `log(s, e, \`${what} : agent ${name} non arrêté (${message})\`)`. Ne lève jamais.
  - `export async function stopAgentsTab(s: MissionState, e: Effects, which: 'done' | 'all', why: string): Promise<void>` : onglet `s.herdr.tabs['agents']` ; absent → ne fait rien. Sinon `releaseTab(e.herdr, tab, which)` ; si `released` n'est pas vide → `log(s, e, \`${why} : agent(s) arrêté(s) dans ${released.join(', ')}\`)` ; pour chaque message de `failed` → `log(s, e, \`${why} : arrêt impossible (${message})\`)` ; une erreur levée par `releaseTab` lui-même (par exemple `paneList`) → `log(s, e, \`${why} : arrêt impossible (${message})\`)`. Ne lève jamais.
- Comportement : dans `markTaskPanes`, après la pose de ✓ sur chaque panneau (implémenteur, implémenteur renforcé, relecteur de la tâche), appeler `stopAgent(s, e, \`tâche ${t.n}\`, name)`. `markTaskPanes` n'est appelée que quand la tâche passe en `done` : rien ne change pendant les tours de correction.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/engine/tasks.test.ts`, avec le `setup` et `until` existants (les agents démarrés par la doublure occupent leur panneau depuis la tâche 1) :
  - `une tâche validée arrête son implémenteur et son relecteur, panneaux gardés avec ✓` : après `until(eng, (s) => s.tasks[0]!.phase === 'done')`, les panneaux `s.herdr.panes['ct-1-t1']` et `s.herdr.panes['rt-1-t1']` ont `busy === false`, leurs libellés sont `T1 · grok-4.7-medium ✓` et `T1 · claude-opus-5-5 ✓`, `fx.herdr.agentGet('ct-1-t1')` rend `null`, et `s.log` contient `tâche 1 : agent ct-1-t1 arrêté` et `tâche 1 : agent rt-1-t1 arrêté`.
  - `pendant un tour de correction, l'implémenteur et le relecteur restent vivants` : relecteur scripté `scriptedAsk(['VERDICT: CORRECTIONS', 'VERDICT: APPROUVÉ'])` ; à l'état où `s.tasks[0]!.phase === 'fix'`, les panneaux de `ct-1-t1` et `rt-1-t1` sont encore occupés (`busy === true`) et aucune ligne `agent … arrêté` n'est dans `s.log` ; puis, une fois `done`, les deux sont arrêtés.
  - `un arrêt impossible est journalisé, la tâche passe quand même en done` : avant que la tâche finisse, rendre sourd le panneau de l'implémenteur (`fx.herdr.pane(p).deaf = true`) ; le `signals.kill` de la doublure lève → la tâche atteint `done`, `s.step` n'est pas `bloquée`, et `s.log` contient une ligne commençant par `tâche 1 : agent ct-1-t1 non arrêté (`.
  - `stopAgent sur un agent sans panneau enregistré ne fait rien` : appel direct `stopAgent(s, fx, 'tâche 9', 'inconnu')` sur un état chargé → aucun appel `herdr.paneSendKeys`, aucune ligne ajoutée à `s.log`.
- [ ] **Étape 2 : lancer les tests et constater l'échec** : `pnpm vitest run test/engine/tasks.test.ts` → les nouveaux tests échouent (panneaux toujours occupés, `stopAgent` non exporté).
- [ ] **Étape 3 : implémenter** `stopAgent`, `stopAgentsTab` et l'appel dans `markTaskPanes`.
- [ ] **Étape 4 : lancer les tests et constater le succès** : `pnpm vitest run test/engine/tasks.test.ts` → tout vert.
- [ ] **Étape 5 : commit** : `git add src/engine/tasks.ts test/engine/tasks.test.ts` puis `git commit -m "fix(liberer-agents-termines): arrêter les agents d'une tâche validée"`.

### Tâche 3 : Arrêter les agents de fin de mission à la fin de leur tour et au changement de génération

**Test :** `pnpm vitest run test/engine/finish.test.ts test/engine/tasks.test.ts`

**Fichiers :**
- Modifier : `src/engine/finish.ts` (fonction `markPane`)
- Modifier : `src/engine/tasks.ts` (fonction `resetLoops`)
- Test : `test/engine/finish.test.ts`, `test/engine/tasks.test.ts`

**Interfaces :**
- Consomme : `stopAgent(s, e, what, name)` et `stopAgentsTab(s, e, which, why)` de `src/engine/tasks.ts` (tâche 2).
- Comportement :
  - `markPane(s, e, name)` de `finish.ts` pose ✓ puis appelle `stopAgent(s, e, 'fin de mission', name)`. Elle est déjà appelée là où chaque agent de fin a fini : correcteur de revue globale après son tour (`globalFix`), relecteur global quand le preflight est terminé (`nextCheck`), diagnostic rendu (`diagnose`), correcteur de preflight après son tour (`preflightFix`). Aucun nouvel appel de `markPane` n'est ajouté.
  - Un correcteur `cg…`/`cp…` est donc arrêté au ✓, avant le contrôle de ses commits, même si ce contrôle ouvre ensuite une porte `agent-arret` (choix acté dans la spec).
  - `resetLoops(s, e)` appelle `stopAgentsTab(s, e, 'all', 'nouvelle génération des boucles de fin')` avant d'incrémenter `s.loopGeneration`. Elle n'est appelée que lorsqu'un amendement est appliqué après la fin des tâches, sans consigne en cours : tous les agents encore vivants de l'onglet sont alors des agents de fin de l'ancienne génération.

- [ ] **Étape 1 : écrire les tests qui échouent** :
  - Dans `test/engine/finish.test.ts`, compléter le test existant qui vérifie `CG1 · grok-4.7-medium ✓` : le panneau `s.herdr.panes['cgt-1-1']` a `busy === false` et `s.log` contient `fin de mission : agent cgt-1-1 arrêté` ; le relecteur global `rgt-1` reste occupé tant que le preflight n'est pas terminé (vérifier à l'état où le tour de revue globale est fini et l'étape est encore `revue-globale` ou `preflight`).
  - Nouveau test dans `test/engine/finish.test.ts` : `le relecteur global est arrêté quand le preflight est terminé` : mener la mission jusqu'à l'étape `pr` (preflight tout vert, avec les aides existantes du fichier) → le panneau de `rgt-1` a `busy === false` et `s.log` contient `fin de mission : agent rgt-1 arrêté`.
  - Nouveau test dans `test/engine/finish.test.ts` : `un diagnostic et un correcteur de preflight sont arrêtés à la fin de leur tour` : en réutilisant le montage d'un test existant du fichier où un check du preflight est rouge, un diagnostic `rdt-1-1` puis un correcteur `cpt-1-1` interviennent → leurs panneaux ont `busy === false` après leur tour et `s.log` contient `fin de mission : agent rdt-1-1 arrêté` et `fin de mission : agent cpt-1-1 arrêté`.
  - Nouveau test dans `test/engine/tasks.test.ts` : `un amendement appliqué après les tâches arrête les agents de fin de l'ancienne génération` : mission à l'étape `revue-globale` avec un panneau occupé `GR · claude-opus-5-5` dans l'onglet agents (créé par `fx.herdr.addPane`, `busy = true`, `agent = 'rgt-1'`), amendement approuvé qui ajoute la tâche 2 (montage des tests d'amendement existants du fichier) → après application, ce panneau a `busy === false`, `s.loopGeneration === 2` et `s.log` contient `nouvelle génération des boucles de fin : agent(s) arrêté(s) dans GR · claude-opus-5-5`.
- [ ] **Étape 2 : lancer les tests et constater l'échec** : `pnpm vitest run test/engine/finish.test.ts test/engine/tasks.test.ts`.
- [ ] **Étape 3 : implémenter** l'appel de `stopAgent` dans `markPane` et de `stopAgentsTab` dans `resetLoops`.
- [ ] **Étape 4 : lancer les tests et constater le succès** : même commande → tout vert.
- [ ] **Étape 5 : commit** : `git add src/engine/finish.ts src/engine/tasks.ts test/engine/finish.test.ts test/engine/tasks.test.ts` puis `git commit -m "fix(liberer-agents-termines): arrêter les agents de fin de mission après leur tour"`.

### Tâche 4 : Arrêter les agents restants à la PR, à l'abandon et au démarrage du moteur

**Test :** `pnpm vitest run test/engine/engine.test.ts test/engine/pr.test.ts`

**Fichiers :**
- Modifier : `src/engine/finish.ts` (fonction `stepPr`)
- Modifier : `src/engine/engine.ts` (fonction `abandonMission`, classe `Engine` : `run` et une nouvelle méthode privée)
- Modifier : `README.md` (ligne `- \`agents\` : implémenteurs et relecteurs` de la liste des onglets)
- Test : `test/engine/engine.test.ts`, `test/engine/pr.test.ts`

**Interfaces :**
- Consomme : `stopAgentsTab(s, e, which, why)` de `src/engine/tasks.ts` (tâche 2).
- Comportement :
  - `stepPr` : juste avant **chacun** des deux `return goto(s, e, 'pr-ouverte')` (PR déjà connue par `s.prUrl`, et PR ouverte ou retrouvée), appeler `stopAgentsTab(s, e, 'all', 'PR ouverte')`. Pour le second, l'appel se place avant `informOrchestrator`.
  - `abandonMission` : après `s.step = 'fermée'` et avant `informOrchestrator`, appeler `stopAgentsTab(s, e, 'all', 'abandon validé')`. Si les bases de test ne peuvent être supprimées (mission bloquée), aucun agent n'est arrêté.
  - `Engine.run` : juste après le bloc `try { await this.interruptStaleCommands() } catch …`, appeler une nouvelle méthode privée `releaseFinishedAgents()`, dans son propre `try/catch` qui écrit `herness <id> : arrêt des agents terminés au démarrage impossible : <message>` sur `console.error` (comme le bloc précédent). `releaseFinishedAgents` charge l'état, appelle `stopAgentsTab(s, this.e, s.step === 'pr-ouverte' || s.step === 'fermée' ? 'all' : 'done', 'démarrage du moteur')`, puis `saveState(s)`. Une mission bloquée suit la règle `'done'` : ses panneaux ✓ sont arrêtés, les autres non.
  - README : la ligne devient `- \`agents\` : implémenteurs et relecteurs ; un agent est arrêté dès que son travail est fini (tâche validée, tour terminé, PR ouverte), son panneau reste ouvert avec son historique`.

- [ ] **Étape 1 : écrire les tests qui échouent** :
  - Dans `test/engine/engine.test.ts`, mettre à jour le test existant `au démarrage du moteur, les commandes restées en cours dans checks et process sont interrompues et marquées ✗` : la mission y est `pr-ouverte`, donc l'agent occupé `a1` (`T1 · grok …`) est maintenant arrêté. Attentes nouvelles : `fx.callsOf('herdr.paneSendKeys')` vaut `[[c1, 'ctrl+c'], [c1, 'ctrl+c'], [p2, 'ctrl+c'], [p2, 'ctrl+c'], [a1, 'ctrl+c'], [a1, 'ctrl+c']]` ; `fx.herdr.pane(a1).label` reste `T1 · grok …` ; `fx.herdr.pane(a1).busy === false` ; après le `eng.tick()` suivant, la longueur reste 6 (une seule fois par démarrage).
  - Nouveau test dans `test/engine/engine.test.ts` : `au démarrage du moteur, une mission bloquée arrête les agents des panneaux ✓ et garde les autres` : mission `bloquée` (avec `blockedFrom: 'tasks'` et une raison), onglet agents avec un panneau occupé `T1 · grok ✓` et un panneau occupé `T2 · grok` ; une mission bloquée ne s'arrête jamais seule : créer le moteur avec `engine({ sleep: async () => { throw new Error('fin du test') } })` et vérifier `await expect(eng.run()).rejects.toThrow('fin du test')` (le `sleep` est appelé hors du `try` de la boucle, après le premier tour) → `T1 · grok ✓` libre, `T2 · grok` toujours occupé, `s.log` contient `démarrage du moteur : agent(s) arrêté(s) dans T1 · grok ✓`.
  - Nouveau test dans `test/engine/engine.test.ts` : `un abandon validé arrête tous les agents de l'onglet agents` : en partant du montage du test existant `abandon ouvre une porte abandon…`, ajouter un onglet agents enregistré dans `s.herdr.tabs['agents']` avec deux panneaux occupés (l'un ✓, l'autre non) → après validation de la porte, `s.step === 'fermée'`, les deux panneaux sont libres et `s.log` contient une ligne commençant par `abandon validé : agent(s) arrêté(s) dans`.
  - Nouveau test dans `test/engine/pr.test.ts` : `l'ouverture de la PR arrête tous les agents restants de l'onglet agents` : en partant du montage du test principal d'ouverture de PR du fichier, onglet agents enregistré avec un panneau occupé `GR · claude-opus-5-5` (non ✓) → après passage en `pr-ouverte`, ce panneau est libre et `s.log` contient `PR ouverte : agent(s) arrêté(s) dans GR · claude-opus-5-5` ; l'orchestrateur, hors de l'onglet agents, n'a reçu aucun `ctrl+c`.
- [ ] **Étape 2 : lancer les tests et constater l'échec** : `pnpm vitest run test/engine/engine.test.ts test/engine/pr.test.ts`.
- [ ] **Étape 3 : implémenter** les appels dans `stepPr`, `abandonMission` et `Engine.run` (méthode `releaseFinishedAgents`), puis la ligne du README.
- [ ] **Étape 4 : lancer les tests et constater le succès** : même commande → tout vert ; puis `pnpm run typecheck` → aucune erreur.
- [ ] **Étape 5 : commit** : `git add src/engine/finish.ts src/engine/engine.ts README.md test/engine/engine.test.ts test/engine/pr.test.ts` puis `git commit -m "fix(liberer-agents-termines): arrêter les agents restants à la PR, à l'abandon et au démarrage du moteur"`.
