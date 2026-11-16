# herness — trois défauts vus en mission (contrôle après rebase, nom de branche, diagnostiqueur)

Date : 2026-11-16 · Auteur : Maxime Vozelle (avec Claude) · Issue : MAX-6

Spec validée le 2026-11-16.

## Intention

Trois défauts ont été relevés pendant une mission. Le premier bloque des
missions à tort : il s'est produit sur au moins cinq missions. Les deux autres
obligent l'utilisateur à intervenir, ou rendent le travail d'un agent fragile.

## Objectifs

1. Un rebase fait par un correcteur (preflight ou revue globale) ne fait plus
   échouer le contrôle des commits. Une mission déjà bloquée de cette façon
   repart avec `herness reprendre`, sans modifier `state.json` à la main.
2. L'orchestrateur connaît toujours le nom réel de la branche de la mission,
   avant comme après l'ouverture de la PR.
3. Le diagnostiqueur du preflight peut interroger git en lecture seule
   (merge-base, rev-parse, reflog…) au lieu de reconstruire l'état à la main.

## Non-objectifs

- Changer le moment ou la forme du renommage de branche (`stepClassify`).
- Permettre au diagnostiqueur de relancer un check, d'écrire dans le worktree
  ou de faire un `git fetch`.

## Approches retenues

### 1. Contrôle des commits après rebase (MAX-7)

Cause : `controlCommits` (`src/git/git.ts`) travaille sur la plage
`fixBase..HEAD`, pour le nombre de commits, les auteurs et les fichiers
interdits (`git diff`). Après un rebase, `fixBase` ne fait plus partie de la
branche, et la plage contient les commits de main entrés par le rebase. La
revue globale (`G.fixBase`) a le même défaut. `touchedTasks` utilise aussi
`fixBase`.

- **Retenue (A)** : `controlCommits` reçoit la référence de main et exclut ses
  commits : `rev-list fixBase..HEAD --not origin/<main>`. Les fichiers
  contrôlés viennent de ces mêmes commits (`log --name-only`), et plus de
  `git diff fixBase..HEAD`. Sans rebase, le résultat ne change pas. Les trois
  appelants (tâches, preflight, revue globale) passent la référence de main.
  `touchedTasks` applique la même exclusion.
- Écartée (B) : remplacer `fixBase` par `merge-base(origin/main, HEAD)` quand
  il ne fait plus partie de la branche. Cela ajoute un cas particulier, qu'il
  faudrait aussi reporter dans `touchedTasks`.

### 2. Nom de branche connu de l'orchestrateur (MAX-8)

Cause : `orchestrator.md` est écrit une seule fois, à la création de la
mission (`src/lifecycle.ts`), avec `herness/<id>`. La branche est ensuite
renommée au classement (`<préfixe>/<id>-<slug>`), et le prompt n'est jamais mis
à jour.

- **Retenue (A)** : le prompt ne donne plus de nom en dur. Il donne la règle :
  la branche est renommée au classement, et son nom actuel se lit avec
  `git branch --show-current`. Le moteur prévient l'orchestrateur au
  renommage, et le message « La PR est ouverte » rappelle le nom exact de la
  branche.
- Écartée (B) : réécrire `orchestrator.md` après le renommage. Le prompt n'est
  relu qu'au lancement de l'orchestrateur, il faudrait de toute façon le
  prévenir.

### 3. Bash pour le diagnostiqueur (MAX-9)

Cause : le diagnostiqueur est lancé avec le rôle `reviewer`
(`src/agents/adapters.ts`), en `dontAsk`, avec seulement `git diff`,
`git log`, `git show`. Sa consigne lui demande pourtant de comparer avec
`origin/main`. Les règles comparent le début de la commande :
`git -C <chemin> diff` est donc refusé.

- **Retenue (A)** : un rôle `diagnostic`, qui ajoute aux droits du relecteur
  des commandes git en lecture seule : `rev-parse`, `merge-base`, `status`,
  `rev-list`, `ls-files`, `blame`, `cat-file`, `for-each-ref`, `reflog` sans
  argument et `reflog show`. `git branch` et `git reflog` avec arguments sont
  exclus, parce que `branch -D/-m` et `reflog expire/delete` écrivent. Pas de
  `fetch`. La consigne dit de lancer git depuis le worktree, sans `-C`.
- Écartée (B) : autoriser aussi la relance du check rouge. Elle écrit dans le
  worktree (build, base de test).

## Laissé à l'implémentation

- Le texte exact des messages à l'orchestrateur et du prompt.
- Les numéros de ligne cités correspondent au code du 2026-11-16 : les
  revérifier avant de commencer.
