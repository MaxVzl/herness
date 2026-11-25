# Trois défauts du journal d'erreurs : plan d'implémentation

> **Pour les agents :** exécuter tâche par tâche, en TDD (test d'abord, rouge, code minimal, vert). Les étapes utilisent des cases `- [ ]`.

**But :** corriger trois défauts relevés en mission :
1. la preuve sur main rejoue le cache turbo ;
2. une consigne reste dans la zone de saisie de l'agent sans être envoyée ;
3. la simple citation du libellé « imposé par le plan » ouvre un arbitrage.

**Architecture :** trois corrections indépendantes, une par tâche :
1. `proveOnMain` (`src/engine/finish.ts`) préfixe la commande du check par `env TURBO_FORCE=1`.
2. `AgentRunner` (`src/agents/adapters.ts`) distingue `stalled` et offre `nudge`, une Entrée de secours. `askAgent` (`src/engine/tasks.ts`) s'en sert et le note dans le journal de mission.
3. `CONTRADICTS_PLAN` (`src/engine/tasks.ts`) ne reconnaît plus que le marqueur `[plan]` en tête de remarque, et `src/prompts/review.md` demande ce marqueur.

**Stack :** TypeScript exécuté par tsx (Node ≥ 24), vitest.

**Spec :** `docs/superpowers/specs/2026-11-24-20261124-4-defauts-journal-erreurs.md`

## Contraintes globales

- Variable de contournement du cache : exactement `TURBO_FORCE=1`. Elle ne s'applique qu'à la commande du check rejouée dans la preuve sur main. Préparation, base de test et preflight de la branche sont inchangés.
- Le texte d'une consigne n'est **jamais** renvoyé à un agent. Seule une touche `Enter` peut être envoyée, une seule fois par consigne.
- Marqueur d'une remarque imposée par le plan : exactement `[plan]`. Le libellé « imposé par le plan » ne déclenche plus rien.
- Commits au format `{type}: {description}` en français, par exemple `fix: …`. Ne jamais toucher `CHANGELOG.md` ni `.release-please-manifest.json`.
- Tests lancés avec `pnpm exec vitest run <fichiers>`.

## Points de vigilance pour la revue

1. Consigne `stalled` sans panneau connu pour l'agent (`s.herdr.panes[agent]` absent) : pas d'Entrée, la mission est bloquée comme aujourd'hui (« sans réponse »), et rien ne lève.
2. `stalled`, puis attente après l'Entrée qui revient `stalled` ou `timeout` : la mission est bloquée, et il n'y a **pas** de deuxième Entrée.
3. `stalled`, puis attente qui revient `blocked` : une porte `agent-bloque` s'ouvre comme pour une consigne normale.
4. Remarque qui cite `[plan]` au milieu d'une phrase, ou entre accents graves (`` `[plan]` ``) : aucune porte.
5. Commande de check qui contient déjà des variables (`fill` des `{id}`, `{worktree}`) : le préfixe `env TURBO_FORCE=1` se place **avant** la commande substituée, sans altérer ses arguments.

---

### Tâche 1 : La preuve sur main contourne le cache turbo

**Test :** `pnpm exec vitest run test/engine/finish.test.ts -t "CAUSE: MAIN"`

**Fichiers :**
- Modifier : `src/engine/finish.ts`, fonction `proveOnMain`, à la ligne `if (!failure) proof = await e.runInPane(... `preuve main · ${f.label}` ..., fill(check.command, vars), logs)`.
- Tests : `test/engine/finish.test.ts`, test `CAUSE: MAIN prouvée ouvre la porte pr-malgre-main et supprime le worktree temporaire` (vers la ligne 321).

**Comportement attendu :** dans la preuve sur main, la commande du check rouge est lancée sous la forme `['env', 'TURBO_FORCE=1', ...fill(check.command, vars)]`. Le reste ne change pas : préparation, base de test, arrêt de la base, et le même check lancé sur la branche (`preflight · <label>`).

- [ ] **Étape 1 : adapter le test (rouge)**

Dans le test `CAUSE: MAIN prouvée …`, remplacer la ligne attendue de la preuve par :

```ts
[s.herdr.tabs['process'], MAIN_WT(), 'preuve main · lint', ['env', 'TURBO_FORCE=1', 'pnpm', 'lint']],
```

et ajouter, après l'assertion `proof.map(...)` :

```ts
// Le check de la branche n'est pas forcé : seul le rejeu sur main contourne le cache turbo.
const branch = fx.callsOf('runInPane').filter((c) => c[3] === 'preflight · lint')
expect(branch.map((c) => c[4])).toEqual([['pnpm', 'lint']])
```

Ajouter un commentaire d'une ligne au-dessus de la ligne attendue de la preuve : le cache turbo est partagé entre worktrees et rejouerait un ancien succès.

- [ ] **Étape 2 : lancer le test, il échoue** sur la commande de preuve, encore `['pnpm', 'lint']`.

- [ ] **Étape 3 : code minimal.** Dans `proveOnMain`, passer `['env', 'TURBO_FORCE=1', ...fill(check.command, vars)]` à la place de `fill(check.command, vars)` pour l'appel `preuve main · ${f.label}`. Mettre à jour le commentaire JSDoc de `proveOnMain` : « … puis la même commande, avec `TURBO_FORCE=1` (le cache turbo est partagé entre worktrees et rejouerait un ancien succès) ».

- [ ] **Étape 4 : relancer le test, il passe.** Lancer aussi tout `test/engine/finish.test.ts`, qui doit rester vert. Si un autre test attend l'ancienne commande de preuve, l'adapter de la même façon.

- [ ] **Étape 5 : commit** `fix: preuve sur main lancée avec TURBO_FORCE=1 pour ne pas rejouer le cache turbo`

### Tâche 2 : Entrée de secours quand une consigne reste dans la saisie de l'agent

**Test :** `pnpm exec vitest run test/agents/adapters.test.ts test/engine/tasks.test.ts -t "stalled|nudge|Entrée de secours"`

**Fichiers :**
- Modifier : `src/agents/adapters.ts` (`AgentApi`, `AgentRunner.ask`, nouvelle méthode `AgentRunner.nudge`).
- Modifier : `src/engine/effects.ts` (type `Agents` : ajouter `'nudge'` au `Pick`).
- Modifier : `src/engine/tasks.ts` (`askAgent`).
- Modifier : `test/fakes.ts` (doublure `agents` : `nudge: async () => 'absent'` par défaut).
- Tests : `test/agents/adapters.test.ts`, `test/engine/tasks.test.ts`.

**Interfaces produites :**
- `AgentApi = Pick<Herdr, 'agentStart' | 'agentPrompt' | 'agentWait' | 'agentGet' | 'agentRead' | 'paneSendKeys'>`.
- `AgentRunner.ask(name: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout' | 'stalled'>`. Elle rend `'stalled'` quand `agentPrompt` rend `'stalled'`, après avoir journalisé l'état et la fin du panneau comme aujourd'hui (`this.log`). Les autres issues ne changent pas : `wait` continue de ranger `stalled` avec `timeout`.
- `AgentRunner.nudge(name: string, pane: string, promptFile: string, timeoutMs: number): Promise<'done' | 'blocked' | 'timeout' | 'absent'>` :
  1. lit `agentRead(name, 40)` ;
  2. si le texte lu ne contient pas `basename(promptFile)`, rend `'absent'` sans rien envoyer ;
  3. sinon, `paneSendKeys(pane, 'Enter')`, puis rend `this.wait(name, timeoutMs)`.

  Le nom de fichier seul suffit à reconnaître la consigne, et un chemin long peut être coupé par l'affichage de l'agent.

**Comportement attendu dans `askAgent`** (`src/engine/tasks.ts`) :
1. `ask` rend `'stalled'` et l'agent a un panneau connu (`s.herdr.panes[pending.agent]`) : appeler `nudge(pending.agent, pane, pending.file, ASK_TIMEOUT_MS[role])`.
2. Si `nudge` ne rend pas `'absent'`, journaliser dans la mission (`log(s, e, …)`) `` `${what} : consigne de ${agent} restée dans la saisie, Entrée envoyée` ``, et poursuivre avec l'issue de `nudge` (`done`, `blocked` ou `timeout`).
3. `'absent'`, ou pas de panneau : poursuivre avec `'timeout'`. La mission est alors bloquée comme aujourd'hui.
4. Dans tous les cas, l'issue finale passe par `proven(...)` puis `settle(...)` comme maintenant. Leur type d'entrée reste `'done' | 'blocked' | 'timeout'`.

- [ ] **Étape 1 : tests de l'adaptateur (rouge).** Dans `test/agents/adapters.test.ts`, étendre la doublure `fake(outcome, state, tail = 'sortie')` avec `paneSendKeys: async (p, ...k) => void calls.push(`keys ${p} ${k.join(' ')}`)` et `agentRead` qui rend `tail`. Faire en sorte que `agentWait` puisse rendre une issue distincte de `agentPrompt` (paramètre `waitOutcome = outcome`). Puis :
  - Renommer et adapter `ask rend timeout après un stalled sans renvoyer le prompt` en `ask rend stalled sans renvoyer le prompt`. Il attend `'stalled'`, et garde les assertions sur le prompt unique, `get a`, `read a` et le journal qui contient `sortie`.
  - Ajouter `nudge envoie une Entrée quand la consigne est encore dans la saisie, puis attend l'agent` : tail `'> Lis et exécute intégralement le fichier /p/x/brief.md'`, `waitOutcome` `'idle'`. Il attend `'done'`, `calls` contient `'keys w:p1 Enter'` puis `'wait a idle,done,blocked 5000'`, et aucun appel ne commence par `prompt`.
  - Ajouter `nudge n'envoie rien quand la consigne n'est pas visible` : tail `'autre chose'`. Il attend `'absent'`, sans appel `keys` ni `wait`.
  - Ajouter `nudge rend timeout si l'agent reste stalled après l'Entrée` : `waitOutcome` `'stalled'`. Il attend `'timeout'`, avec une seule Entrée.

- [ ] **Étape 2 : tests du moteur (rouge).** Dans `test/engine/tasks.test.ts`, près des tests de consigne, en s'appuyant sur `setup({ over: { agents: { ask, nudge } } })` :
  - `Entrée de secours : une consigne stalled encore visible est envoyée et la tâche continue`. La première consigne de l'implémenteur (`ask`) rend `'stalled'`, `nudge` rend `'done'`. On attend : la tâche avance au-delà de l'implémentation (pas de `step === 'bloquée'`), `agents.nudge` est appelé une fois avec `(agent, s.herdr.panes[agent], fichier de consigne, ASK_TIMEOUT_MS.implementer)`, et `s.log` contient `consigne de <agent> restée dans la saisie, Entrée envoyée`.
  - `Entrée de secours : stalled sans consigne visible bloque la mission comme avant`. `ask` rend `'stalled'`, `nudge` rend `'absent'`. On attend `s.step === 'bloquée'` et un journal qui contient `sans réponse`, sans la ligne « Entrée envoyée ».
  - `Entrée de secours : stalled puis timeout après l'Entrée bloque la mission`. `nudge` rend `'timeout'`. On attend `s.step === 'bloquée'` et un seul appel à `agents.nudge`.

- [ ] **Étape 3 : lancer les tests, ils échouent** : `nudge` n'existe pas, et `ask` rend `timeout`.

- [ ] **Étape 4 : code minimal** dans l'ordre : `AgentApi` et `AgentRunner` (`ask`, `nudge`), puis le type `Agents` dans `src/engine/effects.ts`, puis la doublure de `test/fakes.ts`, puis `askAgent`. Mettre à jour le JSDoc de `ask` (« `stalled` rendu tel quel : l'appelant peut tenter `nudge` ») et documenter `nudge` en une phrase : jamais de renvoi du texte, une seule Entrée.

- [ ] **Étape 5 : relancer les tests ciblés, ils passent**, puis `pnpm exec vitest run test/agents test/engine` et `pnpm run typecheck`, tous verts.

- [ ] **Étape 6 : commit** `fix: Entrée de secours quand une consigne reste dans la saisie de l'agent`

### Tâche 3 : Arbitrage ouvert par le seul marqueur `[plan]` en tête de remarque

**Test :** `pnpm exec vitest run test/engine/tasks.test.ts test/engine/finish.test.ts -t "plan"`

**Fichiers :**
- Modifier : `src/engine/tasks.ts` (`CONTRADICTS_PLAN` et le JSDoc d'`onCorrections`).
- Modifier : `src/prompts/review.md` (ligne 61).
- Tests : `test/engine/tasks.test.ts` (test vers la ligne 595), `test/engine/finish.test.ts` (test vers la ligne 634).

**Comportement attendu :**
- `CONTRADICTS_PLAN = /^(?:[-*]|\d+\.)?\s*(?:\*\*)?\[plan\]/i`, testé sur chaque ligne déjà rognée (`trim`) du corps de la revue. La logique d'`onCorrections` ne change pas par ailleurs : lignes retenues dans la porte, notification, message à l'orchestrateur.
- Reconnus : `- [plan] …`, `* [plan] …`, `1. [plan] …`, `1. **[plan]** …`, `**[plan]** …`, `[plan] …`.
- Ignorés : « imposé par le plan » où qu'il soit, `` `[plan]` `` entre accents graves, `[plan]` au milieu d'une phrase.
- `src/prompts/review.md`, ligne 61, devient : « Si le plan ou le brief impose explicitement ce que cette grille juge défectueux, c'est quand même une remarque, Important, qui commence par le marqueur `[plan]` (juste après la puce ou le numéro). N'écris ce marqueur que pour ces remarques. Commence par reconnaître ce qui est bien fait. »
- JSDoc d'`onCorrections` : remplacer « (« imposé par le plan ») » par « (marqueur `[plan]` en tête de remarque) ».

- [ ] **Étape 1 : tests (rouge).**
  - `test/engine/tasks.test.ts` : renommer le test `une remarque « imposé par le plan » ouvre une porte arbitrage …` en `une remarque marquée [plan] ouvre une porte arbitrage et suspend les correctifs ; chaque CORRECTIONS est signalé`. Sa revue simulée devient `'VERDICT: CORRECTIONS\n\n## Remarques\n- src/a.ts:3 nom de variable\n- [plan] src/b.ts:9 colonne supprimée (tâche 1)\n'`, et l'assertion `toContain('src/b.ts:9 colonne supprimée')` reste.
  - Ajouter dans le même fichier `le libellé « imposé par le plan » cité dans une revue n'ouvre pas d'arbitrage`, sur le modèle du test `un verdict CORRECTIONS sans contradiction du plan …`. La première revue est `VERDICT: CORRECTIONS` avec ces lignes, puis la deuxième est `VERDICT: APPROUVÉ` :
    - ``1. **`src/engine/tasks.ts:73` : l'arbitrage « imposé par le plan » ne se déclenche plus.**``
    - ``   - Correction : passer la regex à `/imposed by the plan/i`.``
    - ``- le marqueur `[plan]` n'est pas écrit ici``
    - `- remarque Imposé par le plan (tâche 1)`

    On attend `s.gates` sans porte `arbitrage`.
  - Ajouter le test `CONTRADICTS_PLAN reconnaît [plan] en tête de remarque seulement` : exporter `CONTRADICTS_PLAN` depuis `src/engine/tasks.ts`. Vérifier qu'il reconnaît chacune des six formes listées ci-dessus, et qu'il ignore `` le marqueur `[plan]` ici `` et `- texte [plan] au milieu`.
  - `test/engine/finish.test.ts`, test `revue globale : une remarque « imposé par le plan » …` : le renommer en `revue globale : une remarque marquée [plan] …`. La revue simulée devient `'VERDICT: CORRECTIONS\n\n- [plan] src/a.ts:3 incohérent\n'`, et l'assertion devient `toContain('[plan] src/a.ts:3 incohérent')`.

- [ ] **Étape 2 : lancer les tests, ils échouent** : la regex actuelle ignore `[plan]` et réagit au libellé cité.

- [ ] **Étape 3 : code minimal.** Exporter et remplacer `CONTRADICTS_PLAN`, puis mettre à jour le JSDoc d'`onCorrections` et la ligne 61 de `src/prompts/review.md` (texte exact ci-dessus).

- [ ] **Étape 4 : relancer les tests ciblés, ils passent**, puis `pnpm exec vitest run test/engine test/prompts` et `pnpm run typecheck`, tous verts. Vérifier avec `grep -rn "imposé par le plan" src test` qu'il ne reste que les occurrences du nouveau test de non-déclenchement.

- [ ] **Étape 5 : commit** `fix: arbitrage ouvert par le seul marqueur [plan] en tête de remarque`
