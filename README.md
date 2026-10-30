# herness

herness orchestre des agents de code sur un ticket, de la demande à la Pull Request : un orchestrateur Claude Code, des implémenteurs Cursor et des relecteurs Claude. Le déroulé est piloté par une machine à états en code (le moteur, seul écrivain de `state.json`), visible en direct dans un espace herdr par mission. Les décisions humaines passent par des portes (spec, plan, amendements, arbitrages, abandon, reprise d'une mission bloquée, PR malgré un check rouge aussi sur main) que l'on valide ou refuse depuis un terminal. Il n'y a pas de porte finale avant la PR : elle est poussée et ouverte automatiquement après un preflight vert.

## Prérequis

- herdr lancé, avec `HERDR_ENV` défini (herness doit tourner dans un panneau herdr)
- `claude` (Claude Code) connecté
- `cursor-agent login` effectué
- `gh auth login` effectué
- docker
- node 24 et pnpm
- lazygit

`herness dev` vérifie l'environnement (identité git, docker, `cursor-agent`, serveur herdr joignable, `gh`, node/pnpm) et s'arrête sur tout `KO`. `HERDR_ENV` et lazygit ne sont pas vérifiés automatiquement : à toi de lancer herness depuis un panneau herdr et d'avoir lazygit dans le `PATH`.

## Installation

```sh
pnpm install
ln -s "$PWD/bin/herness.js" ~/.local/bin/herness   # ~/.local/bin doit être dans le PATH
```

pnpm 12 n'a plus `pnpm link --global` : un lien symbolique vers `bin/herness.js` suffit.

Après une mise à jour de herness, lance `herness reprendre <id> --redemarrer` sur chaque mission en cours : le moteur, le tableau et les visionneuses tournent sinon avec l'ancien code. L'orchestrateur n'est pas relancé ; son serveur MCP garde l'ancien code jusqu'à ce que sa session soit relancée.

## Commandes

Toutes se lancent depuis le dépôt du projet (ou un sous-dossier) pour `dev`, de n'importe où pour les autres.

| Commande | Rôle |
| --- | --- |
| `herness dev <demande...>` | Démarre une mission : lien Wrike, issue GitHub ou texte libre. Crée l'espace herdr, le worktree et la branche `herness/<id>`, lance moteur, tableau et orchestrateur. |
| `herness reprendre <id> [--redemarrer]` | Rouvre l'espace d'une mission et relance ce qui ne tourne plus (moteur, tableau, visionneuses spec et plan, orchestrateur). Une mission bloquée ouvre une porte de reprise (`reprise-bloquee`) : validée, elle repart de l'étape bloquée avec un budget de tours neuf. Une mission `pr-ouverte` ou `fermée` : affiche son état, ne relance rien. `--redemarrer` : arrête (double ctrl+c) puis relance moteur, tableau et visionneuses même s'ils tournent, sans rien envoyer aux agents. |
| `herness statut [id]` | État de toutes les missions, ou détail d'une mission. |
| `herness tasks <id>` | Tableau de bord d'une mission (celui du panneau `tasks`) : tâches, portes, journal ; `v` valider, `r` refuser, `q` quitter. |
| `herness voir <spec\|plan> <id>` | Visionneuse du panneau `spec` ou `plan` de l'onglet `docs` : affiche le document avec `bat` (à défaut `less -R`) et le recharge dès qu'il change. Une proposition d'amendement en attente (`<spec\|plan>.proposed.md` du dossier de mission) a la priorité, signalée par un en-tête ; sinon le fichier du worktree ; sinon un message d'attente. `q` quitte l'affichage, Entrée le rouvre. Lecture seule : n'écrit jamais `state.json`. |
| `herness valider <id> [--porte <gateId>] [--note <texte>]` | Valide une porte en attente (par défaut la plus ancienne). |
| `herness refuser <id> --note <texte> [--porte <gateId>]` | Refuse une porte ; `--note` (motif) est obligatoire. |
| `herness fermer <id>` | Ferme la mission : base de test, moteur, worktree et espace herdr (confirmation s'il reste du travail). Sur une mission déjà `fermée` (abandon validé), nettoie ce qui reste. |

`valider` et `refuser` exigent un vrai terminal interactif (confirmation `o/N`) : un agent ne peut pas valider à ta place. Dans le panneau `tasks`, `v` (valider), `r` (refuser) et `q` (quitter) font la même chose.

## Le cycle d'une mission

1. `herness dev` crée l'espace et lance l'orchestrateur, qui lit la demande.
2. L'orchestrateur propose une spec puis un plan ; chacun passe par une porte.
3. Les implémenteurs (Cursor) codent en TDD par tâche, les relecteurs (Claude) relisent, avec des tours de correction bornés.
4. Le preflight local complet tourne dans le worktree, avec une base de test dédiée.
5. Preflight vert : le moteur rebase si besoin sur la branche principale (un rebase automatique au plus, preflight rejoué), pousse la branche et ouvre la Pull Request automatiquement, sans porte. Seul un check rouge aussi sur la branche principale demande une décision (porte `pr-malgre-main`).
6. `herness fermer` nettoie.

## Portes

Chaque décision humaine est une porte, validée (`herness valider`) ou refusée (`herness refuser`) par l'utilisateur seul.

| Porte | Ouverte quand | Validée | Refusée |
| --- | --- | --- | --- |
| `spec`, `plan` | L'orchestrateur demande la validation | Le document est commité, l'étape suivante démarre | L'orchestrateur corrige et redemande |
| `amendement` | L'orchestrateur propose un plan amendé | Appliqué dès qu'aucune consigne n'est en cours chez un agent (voir plus bas) | Rien ne change |
| `arbitrage` | Une revue contredit le plan, ou l'orchestrateur demande un arbitrage | La note entre dans le prochain fichier de correctifs ; sans correction en attente, la porte est sans effet (l'orchestrateur en est prévenu) | Idem, avec la note du refus |
| `agent-bloque` | Un agent attend une intervention dans son panneau | Le moteur attend la fin de l'agent, sans renvoyer la consigne | Mission bloquée |
| `agent-arret` | Un implémenteur s'est arrêté sans commit en laissant un compte rendu (tâche, revue globale ou preflight) ; l'orchestrateur l'explique et propose un amendement si le plan est en cause | Tour de correction (mêmes règles que des tests rouges : tours bornés, modèle fort au 3e) avec « Décision de l'utilisateur : <note ou continue> » | Mission bloquée |
| `reprise-bloquee` | `herness reprendre` sur une mission bloquée | Retour à l'étape bloquée, budget de tours neuf | La mission reste bloquée |
| `pr-malgre-main` | Un check du preflight est rouge aussi sur la branche principale | PR ouverte malgré tout | Mission bloquée |
| `abandon` | L'orchestrateur demande l'abandon | Bases de test supprimées, mission `fermée` | La mission continue |

Un amendement validé s'applique dès qu'aucun agent n'a de consigne en cours ni de porte `agent-bloque` en attente ; la porte `agent-arret` de la tâche en cours ne le retient pas (c'est le cas qu'il vient corriger). S'il change le texte de la tâche en cours, son brief est réécrit avec une section « Reprise » (garder le travail présent dans l'arbre, l'adapter, tester, commiter) et l'implémenteur est relancé au même tour ; la porte `agent-arret` qu'elle attendait devient `caduque` : elle n'est plus en attente, ne retient aucun amendement, et une décision sur elle est ignorée. Un amendement validé alors que la mission est bloquée dans la boucle des tâches est appliqué aussitôt. Il ne débloque la mission (comme une reprise validée) que si la tâche en cause bloque elle-même la mission (contrôle, arrêt sans commit, tours épuisés…) et que l'amendement change son texte ; sinon la mission reste bloquée (`herness reprendre <id>`). Le résumé de la porte le dit dès son ouverture : « (mission bloquée : valider cet amendement relancera la tâche <n>) » ou « (mission bloquée : valider n'enlève pas le blocage) ». Un amendement qui modifie une tâche déjà validée reste refusé.

Un arrêt sans commit et sans compte rendu, ou tout autre échec du contrôle des commits (identité, auteur, arbre non propre, fichier interdit), bloque la mission.

## Disposition herdr

Un espace par mission, avec les onglets :

- `master` : orchestrator à gauche ; à droite `tasks` en haut et `lazygit` (sur le worktree) en bas
- `docs` (créé juste après `master`) : `spec` à gauche, `plan` à droite, chacun lançant `herness voir` ; `herness reprendre` recrée l'onglet s'il manque et relance les visionneuses au repos
- `agents` : implémenteurs et relecteurs
- `checks` : tests et preflight
- `process` : processus longs (conteneurs, base de test, apps)

## Où vivent les missions

`~/.local/state/herness/missions/<id>/` (`state.json`, `demande.md`, `orchestrator.md`…). La variable `HERNESS_HOME` remplace `~/.local/state/herness`.

## Ajouter un projet

Les configs de projet vivent **hors du dépôt**, une par dossier :

```
~/.config/herness/projects/<nom>/config.ts      # ou $XDG_CONFIG_HOME/herness/projects
~/.config/herness/projects/<nom>/*.sh           # scripts du projet (préparation, base de test…)
```

`HERNESS_PROJECTS_DIR` remplace ce dossier (pratique pour les tests). herness lit aussi le dossier `projects/` du dépôt, qui ne contient que `projects/exemple/` — un modèle commenté, jamais chargé, qui vise un chemin factice.

Pour ajouter un projet :

1. `mkdir -p ~/.config/herness/projects/mon-projet && cp projects/exemple/* ~/.config/herness/projects/mon-projet/`
2. Adapter `config.ts` (au minimum `name` et `repoPath`) et les scripts.
3. Lancer herness depuis le dépôt : il choisit le projet dont `repoPath` contient le dossier courant. Sinon, l'erreur liste les dossiers cherchés.

Le fichier exporte par défaut un objet simple, sans import vers les sources de herness : herness le valide avec son schéma au chargement. Les chemins des scripts se calculent depuis l'emplacement de la config (`import.meta.url`).

| Champ | Rôle |
| --- | --- |
| `name`, `repoPath`, `mainBranch` | Identité, chemin du dépôt, branche principale |
| `branchPrefixes` | Type de commit vers préfixe de branche |
| `commitFormat` | Format de commit, ex. `{type}({scope}): {description} [{id}]` |
| `forbiddenPaths`, `forbiddenCommands` | Fichiers et commandes interdits aux agents |
| `prepare` | Commande de préparation du worktree (`{worktree}`) |
| `testDb` | Optionnel : `up` / `down` de la base de test (`{id}`, `{worktree}`) |
| `preflight` | Liste ordonnée `{ label, command }` |
| `falsePositives` | Échecs connus : `pattern`, `action` (`retry`, `ignore`, `cleanup`), `cleanup` (commande, pour `cleanup`), `label` optionnel, `explanation` |
| `orchestratorPermissionMode` | Optionnel, `auto` par défaut : mode de permissions de l'orchestrateur |
| `models` | `orchestrator`, `reviewer`, `implementer`, `implementerStrong` |

## Limites actuelles

- herdr est indispensable : pas de mode sans herdr.
- Le premier jalon (un vrai ticket jusqu'à la PR) n'a pas encore été exécuté.
