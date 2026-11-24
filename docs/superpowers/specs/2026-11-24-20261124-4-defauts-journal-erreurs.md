# Trois défauts du journal d'erreurs

Mission `20261124-4` · fix · 2026-11-24

## Intention

Corriger les trois défauts de herness signalés par des orchestrateurs dans `~/.local/state/herness/erreurs.log` (missions 4610277370, 4611139758 et 20261124-3). Chacun a fait prendre au moteur une mauvaise décision : correctif inutile, mission bloquée, arbitrage injustifié.

## 1. Preuve sur main faussée par le cache turbo

**Constat.** `proveOnMain` (`src/engine/finish.ts`) relance la commande du check rouge dans un worktree détaché sur `origin/<main>`. Turbo partage son cache local entre les worktrees d'un même dépôt : la preuve a rejoué un ancien succès (« FULL TURBO », 10 tâches en cache), d'un test qui dépend de la date. Le moteur a conclu « vert sur main, rouge dû à la branche » et lancé un correctif, au lieu d'ouvrir la porte `pr-malgre-main`.

**Correction.** La commande de preuve sur main est toujours exécutée avec la variable d'environnement `TURBO_FORCE=1` (préfixe `env TURBO_FORCE=1` devant la commande du check, après substitution des variables). Sans effet sur un projet sans turbo, et aucune configuration à ajouter.

**Hors périmètre.** Les étapes de préparation et de base de test de la preuve ne changent pas. Le preflight sur la branche n'est pas forcé : son rouge venait d'une vraie exécution.

## 2. Consigne tapée mais jamais envoyée à un agent

**Constat.** Pour le correcteur Cursor `cp4611139758-1`, herdr a tapé « Lis et exécute intégralement le fichier … » dans la zone de saisie, mais l'Entrée a été absorbée par une fenêtre d'autocomplétion (« No matches »). Herdr a répondu en 5 s, vraisemblablement `stalled`. `AgentRunner.settle` (`src/agents/adapters.ts`) range `stalled` avec `timeout`, et la mission a été bloquée (« agent … sans réponse (preflight) »). Une Entrée tapée à la main a suffi à lancer l'agent.

**Correction.** Quand l'envoi d'une consigne (`ask`) se termine par `stalled`, le moteur :

1. lit la fin du panneau de l'agent (`agentRead`) ;
2. si la consigne envoyée (`Lis et exécute intégralement le fichier <fichier>`) y figure, appuie **une seule fois** sur Entrée dans le panneau de l'agent (`paneSendKeys(<pane>, 'Enter')`, panneau trouvé dans `s.herdr.panes[<agent>]`), puis attend l'agent comme une consigne normale (`agentWait`, même délai) ;
3. sinon, ou si cette attente n'aboutit pas, garde le comportement actuel (mission bloquée, « sans réponse »).

Le texte de la consigne n'est jamais renvoyé : la règle « jamais de renvoi à l'aveugle » tient. Chaque Entrée de secours est journalisée dans le journal de mission.

**Hors périmètre.** Les issues `timeout` (délai réellement écoulé) ne changent pas. La consigne n'est pas reformulée : la cause exacte du popup reste inconnue.

## 3. Faux arbitrage « imposé par le plan »

**Constat.** `CONTRADICTS_PLAN = /imposé par le plan/i` (`src/engine/tasks.ts`) est testé sur chaque ligne de la revue. Une revue qui cite le libellé pour décrire un bug (dans une regex, entre guillemets) a ouvert une porte `arbitrage` avec 4 « remarques » qui n'en étaient pas.

**Correction.**

- `src/prompts/review.md` demande au relecteur de **commencer** chaque remarque imposée par le plan par le marqueur `[plan]`, qui remplace l'étiquette « imposé par le plan ». Le marqueur ne dépend pas de la langue : il reste valable après le passage des prompts en anglais (mission 20261124-3, en cours).
- Le moteur ne reconnaît plus que ce marqueur, en tête de ligne (après `trim`), éventuellement précédé d'une puce (`-`, `*`) ou d'une numérotation (`1.`), et éventuellement en gras (`**[plan]**`). Le libellé « imposé par le plan » ne déclenche plus rien, et `[plan]` au milieu d'une phrase non plus.
- Les commentaires et tests existants qui parlent d'« imposé par le plan » passent au marqueur.

**Conflit connu.** La mission 20261124-3 modifie les mêmes fichiers (`review.md`, `CONTRADICTS_PLAN`). La PR fusionnée en second s'adapte au rebase en gardant le marqueur `[plan]`.

## Approches écartées

- Cache turbo : une option `proofEnv` par projet. Écartée parce qu'elle se configure projet par projet et s'oublie, alors que le défaut vient de herness.
- Consigne non envoyée : reformuler la consigne pour éviter l'autocomplétion. Écartée parce que la cause du popup n'est pas établie.
- Faux arbitrage : garder le libellé et l'ancrer en début de remarque. Écartée parce que le libellé dépend de la langue et que la mission anglaise en cours le change.

## Critères de réussite

- Un test montre que la commande de preuve sur main part avec `TURBO_FORCE=1`, et que le check de la branche n'en a pas.
- Un test montre qu'un `stalled` avec la consigne visible donne une Entrée puis une attente qui aboutit (`done`). Sans consigne visible, ou si l'attente échoue, la mission est bloquée comme aujourd'hui, sans Entrée.
- Un test reproduit le faux positif (libellé cité dans une remarque ou une regex) : aucune porte n'est ouverte. Une remarque `- [plan] …` ou `1. **[plan]** …` en ouvre une.
- `pnpm run typecheck` et `pnpm run test` sont verts.
