# herness — cockpit : design

Date : 2026-11-02 · Auteur : Maxime Vozelle (avec Claude)

## Intention

Aujourd'hui, piloter herness demande de taper des commandes dans un terminal :
`herness valider <id> --porte <g> --note "…"`, `herness reprendre <id>`,
`herness reprendre <id> --redemarrer`, `herness fermer <id>`, `herness dev "…"`.
L'utilisateur fait tourner **2 ou 3 missions en parallèle** et pilote depuis
**l'espace herdr du projet**, pas depuis l'espace d'une mission. Chaque geste
l'oblige à retrouver un ID de mission, parfois un numéro de porte, et à écrire
une note entre guillemets dans un shell.

Le **cockpit** est une interface terminal (TUI) qui reste ouverte dans un onglet
dédié de l'espace du projet, voit toutes les missions du projet et fait tous ces
gestes au clavier, sans ID ni numéro de porte à taper.

## Objectifs

- Un onglet `herness` dans l'espace herdr du projet, ouvert par `herness` (sans
  argument), qui affiche le cockpit.
- Le cockpit liste les missions du projet, met en évidence celles qui attendent
  une décision ou sont bloquées, et montre le détail de la mission sélectionnée.
- Depuis le cockpit, sur la mission sélectionnée : valider / refuser une porte
  avec ou sans note, reprendre, redémarrer, fermer, ouvrir l'espace de la
  mission ; et démarrer une nouvelle mission.
- Le panneau `tasks` de chaque mission devient la même interface, limitée à sa
  mission.
- Les commandes existantes restent disponibles (scripts, usage hors herdr).

## Non-objectifs

- Interface web ou graphique.
- Piloter plusieurs projets dans un même cockpit (un cockpit par projet).
- Remplacer la conversation avec l'orchestrateur.
- Nouveaux raccourcis globaux herdr (herness ne configure pas herdr).

## Anti-objectifs

- Un cockpit qui permettrait à un agent de franchir une porte : les décisions
  restent des actions clavier de l'utilisateur dans un terminal réel, exactement
  comme `v` / `r` du panneau `tasks` aujourd'hui.
- Un cockpit qui écrit `state.json` d'une mission dont le moteur tourne : le
  moteur reste le seul écrivain ; le cockpit passe par la boîte de réception et
  par les fonctions de cycle de vie existantes, qui respectent déjà cette règle.
- Une décision envoyée deux fois pour la même porte (même garde que le panneau
  `tasks` actuel : rien pendant qu'une décision part, porte décidée ignorée
  jusqu'à ce qu'elle quitte l'état « en attente »).
- Une fermeture sans confirmation.

## Ce qui a été décidé

### Lancement et emplacement

- `herness` sans argument, lancé depuis un panneau herdr d'un projet configuré :
  s'il n'existe pas d'onglet `herness` dans l'espace herdr courant, il le crée,
  y lance le cockpit et lui donne le focus ; sinon il donne le focus à l'onglet
  existant. *(Décision de l'utilisateur : onglet dédié dans l'espace du projet.)*
- `herness cockpit` lance l'interface elle-même (c'est ce que l'onglet exécute ;
  utilisable aussi hors herdr).
- Le cockpit enregistre où il vit (espace et onglet herdr) pour qu'on puisse y
  revenir depuis une mission (voir « Revenir au cockpit »).

### Ce que montre le cockpit

- **Liste des missions du projet** (projet déterminé depuis le dossier courant,
  comme `herness dev`). Ordre : missions qui attendent une décision (porte en
  attente) puis bloquées, puis actives, puis terminées. Par ligne : ID court,
  slug, et un état coloré : porte en attente (ambre), bloquée (rouge), étape et
  avancement (« tâche 2/3 », « preflight »…), PR ouverte (lien).
- **Missions terminées** (`pr-ouverte`, `fermée`) : repliées en bas avec le lien
  de la PR ; masquées automatiquement quand la PR est mergée. Une touche affiche
  aussi les masquées. *(Décision de l'utilisateur.)*
- **Détail de la mission sélectionnée** : ID, branche, étape, tâche courante et
  tour, raison du blocage, portes en attente avec leur résumé, dernières lignes
  du journal, lien de PR.
- Rafraîchissement automatique (lecture des états toutes les secondes, comme le
  panneau `tasks`).

### Gestes au clavier (sur la mission sélectionnée)

| Touche | Geste | Équivalent actuel |
|---|---|---|
| ↑ / ↓ | changer de mission | — |
| `v` | valider la porte en attente la plus ancienne | `herness valider` |
| `r` | refuser (note obligatoire) | `herness refuser --note` |
| `n` | écrire une note puis choisir valider / refuser | `--note` |
| `ctrl+e` (dans une note) | écrire la note dans `$EDITOR` | — |
| `o` | ouvrir l'espace herdr de la mission (focus) | navigation herdr |
| `p` | reprendre | `herness reprendre` |
| `R` | redémarrer moteur et panneaux | `herness reprendre --redemarrer` |
| `f` | fermer, après confirmation dans le cockpit | `herness fermer` |
| `+` | nouvelle mission : coller un lien ou un texte | `herness dev` |
| `a` | afficher / masquer les missions terminées | — |
| `q` | quitter | — |

La touche exacte de chaque geste est laissée au constructeur s'il trouve mieux,
mais tous ces gestes doivent exister et une aide en bas d'écran les liste.

- Une note se saisit sur plusieurs lignes dans le cockpit ; les notes longues
  passent par `$EDITOR` (fichier temporaire, contenu repris à la fermeture de
  l'éditeur).
- Quand plusieurs portes sont en attente sur une mission, on peut choisir
  laquelle (par défaut la plus ancienne).
- Chaque geste affiche un retour dans le cockpit (« g3 validée », « fermeture
  annulée », message d'erreur en français) ; les sorties texte des fonctions de
  cycle de vie sont affichées dans le cockpit, pas dans le terminal brut.
- Les gestes qui demandent une confirmation aujourd'hui (fermer avec du travail
  non poussé ou un worktree sale) la demandent dans le cockpit.

### Nouvelle mission depuis le cockpit

`+` ouvre un champ où l'utilisateur colle un lien Wrike, un lien d'issue GitHub
ou un texte libre ; la mission démarre comme avec `herness dev` (mêmes
contrôles d'environnement, même disposition herdr). Une erreur (contrôle KO,
mission déjà existante) s'affiche dans le cockpit.

### Panneau `tasks` d'une mission

Il devient le cockpit limité à sa mission : même détail, mêmes gestes sur cette
mission (sans la liste ni `+`), plus une touche pour revenir au cockpit du
projet.

### Revenir au cockpit

- Depuis le panneau `tasks` d'une mission : une touche donne le focus à l'onglet
  `herness` du projet.
- Les notifications herdr existantes (porte ouverte, mission bloquée) restent le
  signal ; le cockpit les reflète par la couleur et l'ordre de la liste.

### Détection des PR mergées

Pour les missions avec une PR, le cockpit interroge GitHub (`gh`) au plus toutes
les quelques minutes et retient le résultat dans un cache hors des états de
mission (il n'écrit jamais `state.json`). Sans `gh` ou hors connexion, la
mission reste simplement affichée.

## Contraintes

- TypeScript / Node, ink (déjà utilisé par le panneau `tasks`), herdr requis
  pour l'onglet (le cockpit lui-même tourne aussi hors herdr, sans `o` ni retour).
- Les gestes réutilisent le code existant : `decide` (portes), `resumeMission`
  (reprendre / redémarrer), `closeMission` (fermer), `startMission` (nouvelle
  mission), `missionStatus` / `loadState` (affichage). Le cockpit ne duplique pas
  leur logique.
- Le dépôt est public : aucune référence à un projet ou une entreprise réels
  dans le code, les tests ou la documentation.

## Précisions (choix de Claude après relecture)

- **Espace herdr courant** : `herdr pane current` (ou `HERDR_PANE_ID` +
  `herdr pane get`) donne `workspace_id` et `tab_id` du panneau où l'on tape
  `herness` ; à ajouter au client herdr (`paneCurrent()`).
- **Missions du projet** : celles dont `state.repoPath` égale `cfg.repoPath` du
  projet trouvé depuis le dossier courant. Le panneau `tasks` d'une mission
  n'a pas besoin de la config du dossier courant : il connaît sa mission.
- **Emplacement du cockpit** : enregistré par projet (clé `repoPath`) dans
  `~/.local/state/herness/cockpit.json` (`{workspace, tab}`). Si l'onglet
  enregistré n'existe plus, la touche « retour au cockpit » le recrée dans
  l'espace herdr du projet (même logique que `herness`). Un seul cockpit par
  projet : `herness` donne le focus à l'existant au lieu d'en ouvrir un second.
- **`p` (reprendre)** : désactivé (grisé dans l'aide) sur les missions
  terminées. Sur une mission bloquée, il ouvre la porte de reprise, comme
  `herness reprendre`. Il ne lève pas une pause (c'est l'orchestrateur qui la
  gère).
- **`R` et `f` depuis le panneau `tasks` d'une mission** : autorisés. `R`
  relance aussi ce panneau, et `f` ferme son propre espace : le retour s'affiche
  avant que le panneau disparaisse, sans garantie qu'on ait le temps de le lire.
- **`decide`** : reçoit une fonction de sortie (comme les fonctions de cycle de
  vie) au lieu d'écrire avec `console.log`, pour que le cockpit affiche ses
  messages ; la CLI garde son affichage actuel.
- **Missions terminées** : `pr-ouverte` masquée quand la PR est mergée ;
  `fermée` sans PR masquée 7 jours après la fermeture ; `a` montre tout.
  Vérification des PR toutes les 5 minutes au plus.
- **Mission bloquée avec une porte en attente** : classée « attend ta
  décision » (ambre), car c'est l'action à faire ; la raison du blocage reste
  visible dans le détail.
- **Confirmation en deux touches** *(décision de l'utilisateur)* : `v` et `r`
  n'envoient rien directement ; ils affichent « Valider g3 (plan) de 02-4 ?
  Entrée / Échap » (ou « Refuser … ») et seule Entrée envoie la décision. Même
  chose dans le panneau `tasks` d'une mission.
- **Choix de la porte** : `v`, `r` et `n` s'appliquent à la porte sélectionnée
  dans le détail (par défaut la plus ancienne). La garde contre les doubles
  décisions est tenue par (mission, porte).
- **Note** : saisie multi-ligne maison dans ink (pas de nouvelle dépendance) ;
  `ctrl+e` suspend ink, ouvre `$VISUAL`, sinon `$EDITOR`, sinon `nano` s'il
  existe, sinon `vi`, puis reprend le contenu.

## Laissé au constructeur

- Mise en page exacte, couleurs, largeurs, défilement de la liste.
- Choix final des touches (dans le respect de la table ci-dessus).
- Format et emplacement du cache des PR mergées et de l'emplacement du cockpit
  (sous `~/.local/state/herness/`).
- Comment rediriger proprement les sorties et confirmations des fonctions de
  cycle de vie vers l'interface.
