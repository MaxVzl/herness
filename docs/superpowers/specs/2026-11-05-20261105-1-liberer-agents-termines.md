# herness — arrêter les agents dès que leur travail est fini

Date : 2026-11-05 · Auteur : Maxime Vozelle (avec Claude)

## Intention

Le 04/11/2026, la machine (31 Go de RAM, 8 Go de swap) a saturé sa mémoire et
GNOME Shell a été tué trois fois avant un arrêt forcé. Les principaux
consommateurs étaient les processus `cursor-agent` (60 à 63 processus, 14 à
19 Go), lancés dans herdr et restés ouverts après avoir fini leur travail ; la
plupart prenaient ~230 Mo, certains montaient à 3 Go.

Ce plantage venait surtout du skill dev-ticket, mais herness a le même défaut :

- quand une tâche est validée, son implémenteur, son implémenteur renforcé et
  son relecteur reçoivent seulement la marque ✓ dans leur panneau
  (`markTaskPanes`, `src/engine/tasks.ts`) ; le processus `cursor-agent` ou
  `claude` reste vivant ;
- un panneau ✓ n'est libéré (fonction privée `retire`, `src/herdr/layout.ts` :
  double ctrl+c, puis SIGTERM, puis SIGKILL) que par `slot()`, quand l'onglet
  `agents` a atteint ses 6 panneaux ; une mission garde ainsi jusqu'à 6 agents
  vivants alors qu'un seul travaille ;
- le relecteur global, les correcteurs de la revue globale et du preflight et
  les diagnostics (`markPane`, `src/engine/finish.ts`) restent vivants après
  l'ouverture de la PR ou un abandon validé, jusqu'à `herness fermer` ;
- avec 2 ou 3 missions en parallèle, le nombre d'agents inutiles se multiplie.

L'utilisateur veut qu'**un agent s'arrête dès que son travail est fini**.

## Objectifs

1. Un agent lancé par le moteur dans l'onglet `agents` est arrêté dès qu'il
   n'est plus utile, sans attendre que l'onglet soit plein ni `herness fermer`.
2. Le panneau reste ouvert, avec son historique et sa marque ✓ : l'utilisateur
   peut toujours relire ce que l'agent a fait. Seul le processus de l'agent est
   arrêté ; le panneau revient à son shell.
3. Après une mission terminée (PR ouverte ou abandon validé), aucun agent de
   l'onglet `agents` ne tourne encore.

## Quand un agent est arrêté

Décidé avec l'utilisateur :

| Agent | Moment de l'arrêt |
|---|---|
| Implémenteur, implémenteur renforcé, relecteur d'une tâche | Quand la tâche passe en `done` (au moment où leurs panneaux reçoivent ✓). **Pas** entre deux tours de correction : ils restent vivants pendant les corrections pour garder le contexte de la tâche. |
| Correcteur d'un tour de revue globale (`cg…`) | Quand son tour est fini (là où son panneau reçoit ✓). |
| Correcteur d'un tour de preflight (`cp…`) | Quand son tour est fini (là où son panneau reçoit ✓). |
| Diagnostic du preflight (`rd…`) | Quand il a rendu son diagnostic (là où son panneau reçoit ✓). |
| Relecteur global (`rg…`) | Quand le preflight est terminé (là où son panneau reçoit ✓). S'il faut le rappeler ensuite (preflight rejoué après un rebase), le mécanisme existant (`ensureAgent`) le relance : il repart sans contexte, c'est accepté. |
| Tout agent restant dans l'onglet `agents` | Quand la mission passe en `pr-ouverte`, et quand un abandon est validé (mission `fermée`). |
| Agents de la génération précédente (relecteur global, correcteurs, diagnostics d'une boucle de fin remise à zéro par `resetLoops`) | Quand la génération change : ces agents ne sont plus jamais réutilisés. |

Au **démarrage du moteur** (`Engine.run`, à côté de `interruptStaleCommands`) :

- mission en `pr-ouverte` ou `fermée` : tous les agents encore vivants de
  l'onglet `agents` sont arrêtés (cas rare : moteur arrêté entre le passage en
  `pr-ouverte` et l'arrêt des agents) ;
- sinon, **y compris pour une mission bloquée** : les agents des panneaux
  marqués ✓ de l'onglet `agents` sont arrêtés.

Cela nettoie aussi, à leur prochaine reprise, les missions en cours lancées
avant ce correctif.

**Missions déjà terminées avant ce correctif** (`pr-ouverte` ou `fermée`) : le
moteur ne redémarre jamais pour elles. Décidé avec l'utilisateur : leurs agents
restants sont arrêtés par `herness fermer`, comme aujourd'hui ; ni
`herness reprendre` ni le cockpit ne changent.

**L'orchestrateur n'est jamais arrêté** : il vit dans l'onglet `master`, hors
de l'onglet `agents`, et reste l'interlocuteur de l'utilisateur après la PR.

**Agents non marqués ✓ d'une mission bloquée, ou avec une porte
`agent-bloque` ou `agent-arret` en attente :** on ne touche à rien. Un agent
bloqué attend peut-être une intervention dans son panneau, et l'implémenteur
d'une tâche arrêté sans commit reçoit ensuite la décision de l'utilisateur avec
son contexte. Un agent marqué ✓, lui, a fini son travail et n'est jamais
réutilisé avec son contexte : il est arrêté même si la mission est bloquée
(choix de Claude).

**Correcteur de revue globale ou de preflight arrêté sans commit :** il est
arrêté au moment du ✓, avant le contrôle qui ouvre la porte `agent-arret`. Le
tour suivant lance de toute façon un nouveau correcteur, et l'historique reste
lisible dans son panneau (choix de Claude).

## Comportement en cas d'échec

Arrêter un agent ne doit jamais bloquer la mission ni faire échouer une étape.
Si l'arrêt échoue (le panneau n'est pas revenu au shell après ctrl+c, SIGTERM
et SIGKILL, ou herdr répond une erreur), le moteur l'écrit dans le journal de
la mission avec le panneau, le nom de l'agent et les PID (le message d'erreur
de `retire` les donne déjà), puis continue.

Un panneau déjà libre (agent déjà arrêté, ou jamais lancé) ne produit ni action
ni message.

## Contraintes

- Réutiliser le mécanisme d'arrêt existant de `src/herdr/layout.ts` (double
  ctrl+c, SIGTERM, SIGKILL, jamais au shell du panneau) : l'exposer plutôt que
  le dupliquer. Le recyclage de `slot()` reste tel quel.
- Toujours passer par `Effects` / `EngineHerdr` : les tests du moteur
  utilisent les doublures existantes (`test/herdr/fake.ts`, `fakeEffects`).
- L'arrêt prend jusqu'à une dizaine de secondes (délais de `timing`) : c'est
  acceptable, il n'a lieu qu'aux fins de tâche ou de boucle.
- Les journaux restent en français, dans le style existant (« tâche 2 : agent
  c…-t2 arrêté »).

## Non-objectifs

- Vérifier la mémoire disponible avant de lancer un agent, ou plafonner le
  nombre d'agents entre missions.
- Modifier le skill dev-ticket (hors de ce dépôt).
- Nettoyer les missions déjà terminées avant ce correctif autrement que par
  `herness fermer` (pas de changement de `herness reprendre` ni du cockpit).
- Régler la protection mémoire du système (systemd-oomd, earlyoom,
  `systemd-run --scope -p MemoryMax=…` autour de herdr).
- Changer la taille de la grille de l'onglet `agents` ou la règle de
  recyclage de `slot()`.
- Arrêter les agents entre deux tours de correction d'une même tâche.

## Anti-objectifs

- Arrêter un agent qui travaille encore ou qui sera réutilisé avec son
  contexte (implémenteur ou relecteur d'une tâche en cours de correction).
- Arrêter l'orchestrateur.
- Fermer ou supprimer des panneaux : l'historique d'un agent doit rester
  lisible.
- Bloquer une mission parce qu'un arrêt a échoué.

## Laissé à l'implémenteur

- Le nom et la forme de la fonction exposée par `layout.ts` (par exemple
  `release(h, paneId)`) et de l'éventuel balayage de l'onglet `agents`.
- Le regroupement de « marquer ✓ » et « arrêter » en une seule fonction ou
  non, tant que chaque point listé plus haut arrête l'agent.
- Le découpage des tests, du moment que chaque moment d'arrêt du tableau, le
  démarrage du moteur, l'échec d'un arrêt et la non-interruption entre deux
  tours de correction sont couverts.
- Une phrase dans le README (section des onglets, ligne `agents`) indiquant
  que les agents sont arrêtés dès leur travail fini, panneau conservé.
