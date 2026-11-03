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

Toutes se lancent depuis le dépôt du projet (ou un sous-dossier) pour `dev`, `init` et `projet`, de n'importe où pour les autres.

| Commande | Rôle |
| --- | --- |
| `herness` | Dans herdr : ouvre (ou crée) l'onglet `herness` du projet, qui affiche le cockpit (voir « Cockpit »). Hors herdr : affiche « hors herdr : lance « herness cockpit » dans un terminal » et ne fait rien d'autre. |
| `herness init` | Crée la config herness du dépôt courant (voir « Ajouter un projet »), puis demande s'il faut l'affiner avec Claude. Sur un dépôt déjà configuré, ne réécrit rien et pose seulement la question. |
| `herness projet` | Affiche la config qui s'applique au dépôt courant (nom, fichier, dépôt) et vérifie qu'elle est valide. |
| `herness cockpit` | Écran du cockpit dans le terminal courant (projet du dossier courant). Hors terminal interactif, affiche une seule image et rend la main. |
| `herness dev <demande...> [--note <texte>]` | Démarre une mission : lien Wrike, issue GitHub ou texte libre ; `--note` ajoute des précisions qui complètent la demande (écrites dans `note.md`, elles l'emportent en cas de contradiction). Crée l'espace herdr, le worktree et la branche `herness/<id>`, lance moteur, tableau et orchestrateur. |
| `herness reprendre <id> [--redemarrer]` | Rouvre l'espace d'une mission et relance ce qui ne tourne plus (moteur, tableau, visionneuses spec et plan, orchestrateur). Une mission bloquée ouvre une porte de reprise (`reprise-bloquee`) : validée, elle repart de l'étape bloquée avec un budget de tours neuf. Une mission `pr-ouverte` ou `fermée` : affiche son état, ne relance rien. `--redemarrer` : arrête (double ctrl+c) puis relance moteur, tableau et visionneuses même s'ils tournent, sans rien envoyer aux agents. |
| `herness statut [id]` | État de toutes les missions, ou détail d'une mission. |
| `herness tasks <id>` | Tableau de bord d'une mission (celui du panneau `tasks`) : tâches, portes, journal, avec les gestes du cockpit sur cette mission (`v`, `r`, `n`, `p`, `R`, `f`, `o`, `←/→` pour choisir la porte), `c` retour au cockpit, `q` quitter. |
| `herness voir <spec\|plan> <id>` | Visionneuse du panneau `spec` ou `plan` de l'onglet `docs` : affiche le document avec `bat` (à défaut `less -R`) et le recharge dès qu'il change. Une proposition d'amendement en attente (`<spec\|plan>.proposed.md` du dossier de mission) a la priorité, signalée par un en-tête ; sinon le fichier du worktree ; sinon un message d'attente. `q` quitte l'affichage, Entrée le rouvre. Lecture seule : n'écrit jamais `state.json`. |
| `herness valider <id> [--porte <gateId>] [--note <texte>]` | Valide une porte en attente (par défaut la plus ancienne). |
| `herness refuser <id> --note <texte> [--porte <gateId>]` | Refuse une porte ; `--note` (motif) est obligatoire. |
| `herness fermer <id>` | Ferme la mission : base de test, moteur, worktree et espace herdr (confirmation s'il reste du travail). Sur une mission déjà `fermée` (abandon validé), nettoie ce qui reste. La branche locale est supprimée seulement si tout son contenu est déjà sur `origin` (jamais la branche distante ni la PR). |
| `herness supprimer <id> [--oui]` | Efface le dossier d'une mission `fermée` (état, spec, plan, journaux) après confirmation (`--oui` : sans). Refuse tant qu'il reste un worktree, un espace herdr ou une base : relancer `herness fermer` d'abord. |

`valider` et `refuser` exigent un vrai terminal interactif (confirmation `o/N`) : un agent ne peut pas valider à ta place. Dans le cockpit et le panneau `tasks`, `v` (valider) et `r` (refuser, note obligatoire) font la même chose après confirmation en deux touches (voir « Cockpit »). Toutes ces commandes restent disponibles : le cockpit ne les remplace pas.

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

## Cockpit

`herness` (sans argument), lancé dans un panneau herdr depuis le dépôt du projet, ouvre l'onglet `herness` de l'espace courant, ou le remet au premier plan s'il existe déjà. Cet onglet lance `herness cockpit` : toutes les missions du projet, une par ligne, avec leur statut (porte en attente en ambre, mission bloquée en rouge, active normale, terminée grisée), et à côté le détail de la mission sélectionnée (en dessous si le terminal fait moins de 100 colonnes). Les missions les plus urgentes sont en tête : portes en attente, puis bloquées, actives, terminées ; à égalité, la plus récente d'abord. L'écran se rafraîchit chaque seconde ; la sélection reste sur la même mission même si l'ordre change.

Hors herdr, `herness` n'ouvre rien et indique de lancer `herness cockpit` dans un terminal ; `herness cockpit` marche partout.

| Touche | Effet |
| --- | --- |
| `↑` / `↓` | Choisir la mission |
| `←` / `→` (ou `tab`) | Choisir la porte en attente de la mission (si elle en a plusieurs) |
| `v` | Valider la porte choisie |
| `r` | Refuser la porte choisie : note obligatoire |
| `n` | Valider ou refuser avec une note : saisie de la note, puis `v` ou `r` |
| `p` | Reprendre la mission (`herness reprendre`) ; indisponible sur une mission terminée |
| `R` | Redémarrer moteur, tableau et visionneuses (`herness reprendre --redemarrer`) |
| `f` | Fermer la mission (`herness fermer`) ; confirmation, et une seconde s'il reste du travail |
| `o` | Ouvrir l'espace herdr de la mission |
| `x` | Supprimer une mission fermée (`herness supprimer`), après confirmation ; absent du panneau `tasks` |
| `+` | Nouvelle mission : saisir un lien Wrike, une issue GitHub ou du texte, Entrée ; puis une note facultative (plusieurs lignes, `ctrl+e` éditeur), `ctrl+s` démarre, Échap annule |
| `a` | Afficher ou masquer les missions terminées masquées |
| `q` | Quitter |

Les touches inutilisables (pas de porte en attente, mission terminée…) sont grisées dans la ligne d'aide en bas d'écran. Depuis le cockpit, `p` et `R` laissent le cockpit à l'écran (`o` ouvre l'espace de la mission). Pendant une fermeture, les autres gestes et `+` sont refusés (« action en cours ») jusqu'à sa fin.

**Messages.** Un succès s'affiche 5 secondes ; un message d'erreur reste jusqu'à la touche suivante. Un échec garde ses lignes `KO` et l'erreur finale (8 lignes au plus).

**Décisions en deux touches.** `v` ne valide pas tout de suite : une confirmation « Valider <porte> (<type>) de <mission> ? » s'affiche, Entrée confirme, Échap annule. `r` demande d'abord la note de refus (vide, elle est refusée), puis la même confirmation. `n` demande la note, puis `v` (valider avec la note) ou `r` (refuser ; la note est alors obligatoire), puis la confirmation. Une décision déjà envoyée pour une porte n'est pas renvoyée tant que l'état la montre en attente.

**Saisie d'une note.** Entrée passe à la ligne, `ctrl+s` valide la note, `ctrl+e` l'ouvre dans l'éditeur du terminal (`$VISUAL`, sinon `$EDITOR`, sinon `nano` ou `vi`) et reprend son contenu au retour, Échap annule.

**Panneau `tasks`.** Dans l'onglet `master`, `tasks` est le même écran limité à la mission (`herness tasks <id>`), avec les mêmes touches sauf `↑`/`↓`, `+` et `a`, plus `c` qui ramène au cockpit du projet (onglet `herness`, recréé s'il a été fermé). Ici `R` redémarre en arrière-plan (processus détaché, sortie dans `logs/redemarrage-<horodatage>.log` du dossier de mission) : le redémarrage survit à l'arrêt du panneau, qui est relancé.

**Missions terminées masquées.** Par défaut, le cockpit cache : une mission `pr-ouverte` dont la PR est fusionnée ; une mission `fermée` avec PR dont la PR est fusionnée ; une mission `fermée` sans PR ou dont la PR est fermée sans fusion, sept jours après sa fermeture (une `pr-ouverte` dont la PR est fermée reste affichée). Une ligne « N missions terminées masquées (a) » le rappelle ; `a` montre tout. L'état des PR vient de `gh`, rafraîchi au plus toutes les 5 minutes par PR, et seulement pour les missions affichées dont la PR n'est ni fusionnée, ni fermée d'une mission masquée ; un `gh` en échec n'est pas rappelé avant 5 minutes.

## Disposition herdr

Un espace par mission, avec les onglets (en plus de l'onglet `herness` du cockpit, créé dans l'espace où tu lances `herness`) :

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

Pour ajouter un projet, lance `herness init` depuis son dépôt. Il écrit `~/.config/herness/projects/<nom>/` en déduisant du dépôt :

- `name` (nom du dossier), `repoPath` (racine git) et `mainBranch` (branche par défaut d'`origin`, sinon `main` ou `master`) ;
- le gestionnaire de paquets (`packageManager` de `package.json`, sinon le lockfile) ;
- `preflight` : les scripts `typecheck`, `lint`, `format:check` et `test` de `package.json` qui existent ;
- `commitFormat` d'après les 50 derniers commits (avec ou sans portée, avec ou sans suffixe `[{id}]`) ;
- un `prepare-worktree.sh` qui copie `.env` et `.env.local` du checkout principal et installe les dépendances.

Le reste prend les valeurs par défaut du modèle `projects/exemple/`. `init` demande ensuite s'il faut affiner la config avec Claude : Claude s'ouvre dans le terminal, à la racine du dépôt, explore la CI, les scripts et les services, ajuste preflight, préparation, base de test et chemins interdits, te pose ses questions et ne modifie que le dossier de config. À sa sortie, herness revalide la config. Relancer `herness init` sur un projet déjà configuré repropose seulement l'affinage.

À la main, ça revient à :

1. `mkdir -p ~/.config/herness/projects/mon-projet && cp projects/exemple/* ~/.config/herness/projects/mon-projet/`
2. Adapter `config.ts` (au minimum `name` et `repoPath`) et les scripts.
3. Lancer `herness projet` depuis le dépôt : il affiche la config choisie (celle dont `repoPath` contient le dossier courant) ou l'erreur, avec les dossiers cherchés.

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

## Publier une version

Les versions sont gérées par [release-please](https://github.com/googleapis/release-please), à partir des titres de PR au format conventionnel (`feat:` → version mineure, `fix:` → correctif ; avant 1.0, un changement cassant ne monte que la mineure).

1. Fusionner `dev` dans `main` par une PR, avec un commit de fusion (pas de squash).
2. À chaque arrivée sur `main`, release-please ouvre ou met à jour une PR « chore(main): release x.y.z » qui monte `package.json`, le manifeste et `CHANGELOG.md`.
3. Fusionner cette PR : release-please crée le tag `vx.y.z` et la release GitHub.
4. Ramener `main` dans `dev` (`git checkout dev && git pull && git merge origin/main && git push`) pour que `dev` ait la nouvelle version.

## Limites actuelles

- herdr est indispensable pour mener une mission : seul l'écran `herness cockpit` se lance hors herdr.
- Le premier jalon (un vrai ticket jusqu'à la PR) n'a pas encore été exécuté.
