# Remonter les erreurs de herness en issues GitHub

Mission 20261120-1 · feat · remonter-erreurs-issues

## Intention

Depuis la mission 20261117-1, herness écrit ses erreurs imprévues (et les anomalies signalées par l'orchestrateur avec
`signaler_anomalie`) dans un journal unique, `<HERNESS_HOME>/erreurs.log`. Il faut encore que l'utilisateur pense à le
transmettre. L'utilisateur veut qu'à la fin d'une mission, les problèmes de herness rencontrés pendant cette mission
deviennent directement des issues sur le dépôt de herness (`MaxVzl/herness`), pour que tous les problèmes soient
remontés sans effort.

## Objectifs

- À `herness fermer <id>` (en ligne de commande), si le journal contient des entrées de cette mission pas encore
  envoyées, herness affiche un aperçu des issues et commentaires qu'il va publier et demande confirmation avant
  d'envoyer quoi que ce soit.
- Une nouvelle commande `herness signaler <id>` fait la même chose à n'importe quel moment (mission en cours, bloquée,
  `pr-ouverte` ou `fermée`), par exemple si l'utilisateur a refusé ou raté l'envoi à la fermeture.
- Une issue par erreur distincte : les répétitions d'une même erreur dans la mission sont regroupées, et une erreur
  déjà connue (issue ouverte avec la même signature) donne un commentaire sur cette issue au lieu d'un doublon.
- Une entrée envoyée ne l'est jamais deux fois.
- L'envoi ne fait jamais échouer ni bloquer la fermeture.

## Non-objectifs

- Aucun envoi automatique sans confirmation : le dépôt `MaxVzl/herness` est **public**, les piles contiennent des
  chemins locaux et un signalement de l'orchestrateur peut citer un projet client. L'aperçu est le garde-fou.
- Pas d'envoi depuis le cockpit ni depuis le panneau `tasks` (touche `f`) : leur confirmation ne peut pas montrer un
  aperçu long. Ils se contentent d'indiquer la commande `herness signaler <id>` (voir plus bas).
- Pas de sélection entrée par entrée : la confirmation porte sur tout l'aperçu (oui = tout part, non = rien ne part).
- Pas de label sur les issues : poser un label demande des droits sur le dépôt, que d'autres utilisateurs de herness
  n'ont pas.
- Les entrées sans mission (segment `mission` absent de l'en-tête) ne sont jamais envoyées.
- Pas de modification du format du journal ni de `src/errlog.ts`, ni du prompt de l'orchestrateur.
- Pas de rotation ni de nettoyage du journal.

## Approches envisagées

1. **Relire le journal texte existant** (retenue par l'utilisateur) : un module découpe `erreurs.log` en entrées
   d'après la ligne d'en-tête, dont le format est fixé et testé par `src/errlog.ts`. Rien ne change dans le journal ;
   les entrées déjà écrites sont envoyables. Limite acceptée : un signalement contenant lui-même une ligne commençant
   par `=== ` après une ligne vide fausserait le découpage.
2. **Journal structuré en plus** (`erreurs.jsonl` écrit par `errlog.ts`) : écartée, deux fichiers à garder cohérents,
   la mission précédente à retoucher et les entrées déjà écrites jamais envoyées.

Pour éviter les doublons, la recherche GitHub (`in:body`) a été écartée : son index met du temps à voir une issue
neuve. herness liste les issues ouvertes et compare lui-même les signatures.

## Conception

### Rappel du journal (existant, `src/errlog.ts`)

Chaque entrée est une ligne d'en-tête, un corps, puis une ligne vide :

```
=== 2026-11-17T10:12:03.441Z · mission 20261117-1 · herness 0.6.0 · moteur (étape tasks)
TypeError: Cannot read properties of undefined (reading 'n')
    at stepTasks (…/src/engine/tasks.ts:412:18)

```

En-tête : `=== <ISO> · mission <id> · herness <version> · <origine>[ (étape <step>)]`, segment `mission` facultatif.
Le corps peut contenir des lignes vides (description d'un signalement, `cause :` suivi d'une autre pile).

### Module `src/errreport.ts`

- `parseErrorLog(text: string): LogEntry[]` : découpe le journal. Une entrée commence à une ligne qui commence par
  `=== ` et qui est la première du fichier ou précédée d'une ligne vide ; elle va jusqu'au début de l'entrée suivante
  (ou la fin du fichier). `LogEntry` : `{ raw, at, mission?, version, origin, step?, body }`, où `raw` est le texte
  exact de l'entrée (en-tête compris, lignes vides de fin retirées), `origin` l'origine sans le suffixe
  ` (étape …)`, `body` le corps sans les lignes vides de fin. Une ligne `=== ` dont l'en-tête ne se lit pas est
  ignorée (rattachée au corps de l'entrée précédente si elle existe), sans lever.
- **Empreinte d'entrée** : `sha256(raw)` en hexadécimal (l'horodatage de l'en-tête la rend unique). Sert à savoir si
  l'entrée est déjà envoyée.
- **Signature d'erreur** : les 12 premiers caractères hexadécimaux de `sha256(origin + '\n' + premièreLigne)`, où
  `premièreLigne` est la première ligne non vide du corps, après masquage (voir plus bas). L'étape et la version
  n'entrent pas dans la signature. Elle s'écrit `herness-sig-<12 hex>`.
- **Masquage** : dans tout texte publié (titre, corps, commentaire), le dossier personnel (`os.homedir()`) est
  remplacé par `~`.
- Le dépôt cible est une constante `MaxVzl/herness`, passée à `gh` par `--repo` (indépendant du dossier courant).

### Préparer l'envoi d'une mission

`prepareReport(id)` (nom libre) :

1. Lit `errorLogPath()` (fichier absent = aucune entrée), garde les entrées dont `mission === id`.
2. Retire celles dont l'empreinte figure dans `missions/<id>/issues.json`.
3. Regroupe les restantes par signature, dans l'ordre de première apparition.
4. Liste les issues ouvertes du dépôt : `gh issue list --repo MaxVzl/herness --state open --limit 500 --json
   number,title,body,url`. Un groupe dont la signature apparaît dans le corps d'une de ces issues devient un
   **commentaire** sur cette issue ; sinon une **nouvelle issue**.
5. Rend la liste des envois prévus, chacun avec son texte final (titre et corps, ou corps du commentaire) et les
   empreintes des entrées qu'il couvre.

Contenu :

- Titre d'une nouvelle issue : `[erreur herness] <origine> : <première ligne>`, tronqué à 120 caractères (avec `…`).
- Corps d'une nouvelle issue :

  ````
  Remontée automatiquement par `herness signaler` (mission 20261120-1).

  - Version : herness 0.7.0
  - Origine : moteur (étape tasks)
  - Vue 3 fois dans la mission : 2026-11-20T10:12:03.441Z, 2026-11-20T10:15:40.002Z, 2026-11-20T11:02:11.930Z
  - Signature : herness-sig-1a2b3c4d5e6f

  ```
  <corps de la première entrée du groupe>
  ```
  ````

  Si les entrées du groupe ont des versions ou des étapes différentes, toutes sont listées (séparées par des
  virgules). Le bloc de code utilise une clôture plus longue que toute suite d'accents graves présente dans le corps.
- Corps d'un commentaire : même texte, introduit par `Revue dans la mission <id>.` au lieu de la première ligne, sans
  la ligne `Signature` (déjà dans l'issue).
- Le corps publié est tronqué pour rester sous la limite de GitHub (65 536 caractères), avec une mention
  `(tronqué)`.

### Envoyer

`sendReport(id, prévus)` (nom libre) :

- Nouvelle issue : `gh issue create --repo MaxVzl/herness --title <titre> --body-file -` (corps sur l'entrée
  standard) ; la sortie est l'URL de l'issue.
- Commentaire : `gh issue comment <numéro> --repo MaxVzl/herness --body-file -`.
- Après **chaque** envoi réussi, ses empreintes sont ajoutées à `missions/<id>/issues.json` (écriture immédiate), avec
  la signature, l'URL et la date. En cas d'échec d'un envoi, on s'arrête : ce qui est parti reste noté, le reste sera
  reproposé au prochain `herness signaler`.
- `issues.json` : `{ "sent": [{ "entry": "<sha256>", "signature": "herness-sig-…", "url": "…", "at": "<ISO>" }] }`.
  C'est un fichier à part et non `state.json`, dont le moteur est le seul écrivain tant qu'il tourne. Absent ou
  illisible = rien d'envoyé (illisible : on ne l'écrase pas, on signale l'erreur et on n'envoie rien).

Les appels à `gh` passent par un `Runner` injectable (comme `src/forge/github.ts`) pour être testés sans réseau.

### Aperçu et confirmation

Commun à `fermer` et `signaler` :

```
Erreurs herness de la mission 20261120-1 à remonter sur MaxVzl/herness (dépôt public) :

── Nouvelle issue : [erreur herness] moteur : TypeError: Cannot read properties of undefined (reading 'n')
<corps complet>

── Commentaire sur #42 (<titre de l'issue>)
<corps complet>

Relis : tout ce qui est affiché sera public.
```

puis la question `Envoyer 1 issue et 1 commentaire sur MaxVzl/herness ?` (o/N, la confirmation existante `askYesNo`).
Oui : envoi, puis une ligne par envoi (`issue créée : <url>`, `commentaire ajouté : <url>`). Non : `rien n'a été
envoyé (herness signaler <id> pour le refaire)`.

### `herness signaler <id> [--oui]`

- Mission inexistante : erreur `mission <id> introuvable` (comme les autres commandes).
- Aucune entrée à envoyer : `Aucune erreur herness à remonter pour la mission <id>.`, code 0.
- Sinon aperçu, confirmation, envoi. Hors terminal interactif sans `--oui` : erreur `l'envoi demande une confirmation
  dans un terminal interactif (ou --oui)`. `--oui` : aperçu affiché quand même, envoi sans question.
- Échec de `gh` (absent, non connecté, réseau) : message d'erreur clair, code de sortie non nul, rien d'autre de
  modifié.
- Ne touche ni à `state.json`, ni au moteur, ni au worktree.

### `herness fermer <id>`

- `closeMission` reçoit une option (par exemple `{ signaler: true }`) que seule l'action CLI `fermer` passe. Le
  cockpit et le panneau `tasks` ne la passent pas.
- Avec l'option, dans un terminal interactif : juste après la confirmation des risques existante (ou son absence) et
  **avant** l'arrêt du moteur (la fin de `fermer` peut fermer le panneau d'où elle est lancée), herness prépare
  l'envoi ; s'il y a quelque chose, aperçu, confirmation, envoi. Toute erreur de préparation ou d'envoi devient une
  ligne `erreurs herness non remontées (<message>) : herness signaler <id>` et la fermeture continue. Refuser l'envoi
  ne refuse pas la fermeture.
- Sans l'option ou hors terminal interactif : rien n'est envoyé ; si la mission a des entrées non envoyées (lecture
  locale seulement, sans appel à `gh`), une ligne `N erreur(s) herness non remontée(s) : herness signaler <id>`.
  Une erreur de lecture du journal est ignorée ici.
- Une mission déjà `fermée` dont il reste quelque chose à nettoyer repasse par la même logique.
- Une mission déjà `fermée` et entièrement nettoyée (retour anticipé `déjà fermée : rien à fermer`) : rien n'est
  proposé à l'envoi ; seule la ligne `N erreur(s) herness non remontée(s) : herness signaler <id>` est ajoutée si des
  entrées restent à envoyer (lecture locale). Pour relancer un envoi, c'est `herness signaler`. *(choix de
  l'orchestrateur)*
- Si l'utilisateur refuse la confirmation des risques (`fermeture annulée`), rien n'est proposé : la fermeture n'a pas
  lieu. *(choix de l'orchestrateur)*

### Documentation

`README.md` : la commande `herness signaler` dans le tableau des commandes, et une mention dans la ligne de
`herness fermer` ; un court paragraphe (dans « Où vivent les missions » ou une section dédiée) sur `erreurs.log`, sa
remontée en issues, le dépôt public et `issues.json`.

## Contraintes

- `gh` est déjà un prérequis (`gh auth login`) ; aucune nouvelle dépendance.
- Les tests n'appellent jamais le vrai `gh` ni le réseau, et utilisent `HERNESS_HOME` vers un dossier temporaire.
- Rien n'est écrit sur stdout hors des commandes de l'utilisateur (le module n'est pas utilisé par le serveur MCP).

## Laissé à l'implémenteur

- Les noms exacts des fonctions et types, et la façon de passer le `Runner` et la sortie.
- La place exacte de l'option dans la signature de `closeMission`.
- Le texte exact des messages, pourvu qu'ils disent la même chose que ci-dessus.
