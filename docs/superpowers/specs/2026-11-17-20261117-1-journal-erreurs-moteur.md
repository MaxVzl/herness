# Journal des erreurs de herness

Mission 20261117-1 · feat · journal-erreurs-moteur

## Intention

Quand herness lui-même plante pendant une mission, le détail de l'erreur (message, pile d'appels) se perd aujourd'hui :
le moteur ne garde dans `state.json` que le motif de blocage d'une ligne (`erreur du moteur : <message>`), la pile ne
part que sur la sortie d'erreur du panneau du moteur, et le serveur MCP transforme ses exceptions en `Erreur : …` pour
l'orchestrateur sans rien conserver. L'utilisateur veut un fichier, écrit automatiquement, qu'il n'a plus qu'à
transmettre pour qu'on corrige herness.

## Objectifs

- Toute erreur imprévue de herness (un bug, pas un échec normal de mission) est ajoutée, automatiquement, à un fichier
  unique : `<HERNESS_HOME>/erreurs.log`, soit `~/.local/state/herness/erreurs.log` par défaut (même racine que
  `missionsRoot()`, donc `HERNESS_HOME` est respecté, ce qui isole les tests).
- Chaque entrée suffit pour diagnostiquer : horodatage, mission, version de herness, origine (et étape si connue), puis
  la pile complète de l'erreur.
- L'écriture ne fait jamais échouer herness : si le fichier ne peut pas être écrit, l'erreur d'écriture est ignorée
  (au mieux signalée sur la sortie d'erreur) et le comportement existant continue à l'identique.
- En plus, l'orchestrateur peut signaler lui-même une anomalie de herness qu'il constate sans qu'aucune exception ne
  soit levée (comportement incohérent du moteur, état contradictoire, outil qui ne fait pas ce qu'il annonce), par un
  nouvel outil MCP qui écrit dans le même fichier.

## Non-objectifs

- Les échecs normaux d'une mission ne sont pas journalisés : tests rouges, preflight rouge, agent bloqué ou arrêté,
  conflit git, base de test non supprimée, décision ignorée.
- Les incidents dégradés déjà notés dans le `log` de `state.json` (notification non affichée, message à
  l'orchestrateur non remis, herdr injoignable, commandes non interrompues) ne sont pas journalisés.
- Les erreurs imprévues sont journalisées par le code de herness lui-même : ni l'utilisateur ni l'orchestrateur n'ont à
  les signaler. L'outil de signalement ne sert qu'aux anomalies sans exception.
- Les commandes de l'utilisateur (`herness valider`, `fermer`, `cockpit`…) ne journalisent pas leurs erreurs : ce sont
  surtout des erreurs d'usage, déjà affichées dans son terminal.
- Pas de rotation ni de limite de taille : ces erreurs doivent rester rares.

## Approches envisagées

1. **Module dédié appelé aux points de capture existants** (retenue par l'utilisateur) : un module `src/errlog.ts`
   expose une fonction d'ajout ; elle est appelée là où herness rattrape déjà ses erreurs, plus des écouteurs
   d'erreurs non rattrapées dans les processus `engine` et `mcp`. Précis : chaque entrée sait d'où elle vient.
2. **Capture globale seule** (`uncaughtException` / `unhandledRejection`) : écartée, car le moteur et le serveur MCP
   rattrapent eux-mêmes leurs erreurs ; le cas principal (blocage `erreur du moteur`) ne serait jamais écrit.

## Conception

### Module `src/errlog.ts`

- `errorLogPath(): string` : `<HERNESS_HOME ou ~/.local/state/herness>/erreurs.log`, calculé comme `missionsRoot()`
  (sans le `missions`). Il est souhaitable de factoriser la racine dans `src/paths.ts` (par exemple `hernessHome()`,
  utilisé par `missionsRoot()` et `errorLogPath()`).
- `logHernessError(ctx: { mission?: string; origin: string; step?: string }, err: unknown): Promise<void>` : crée le
  dossier au besoin, ajoute (append) une entrée, ne lève jamais.
- Format d'une entrée, en texte lisible (copiable tel quel), séparée de la précédente par une ligne vide :

  ```
  === 2026-11-17T10:12:03.441Z · mission 20261117-1 · herness 0.6.0 · moteur (étape tasks)
  TypeError: Cannot read properties of undefined (reading 'n')
      at stepTasks (…/src/engine/tasks.ts:412:18)
      …
  ```

  - Ligne d'en-tête : `=== <ISO> · mission <id> · herness <VERSION> · <origine>[ (étape <step>)]` ; le segment
    mission est omis si inconnu.
  - Corps : `err.stack` si c'est une `Error` qui en a une, sinon `String(err)` ; une `Error` avec une `cause` ajoute
    la cause (sa pile) après une ligne `cause :`.

### Points de capture

| Origine (libellé d'en-tête) | Où | Ce qui est journalisé |
|---|---|---|
| `moteur` (avec l'étape lue dans l'état si possible) | `Engine.fail` (`src/engine/engine.ts`) | l'erreur qui fait bloquer la mission |
| `moteur : enregistrement du blocage` | `Engine.fail`, bloc `catch (err2)` | l'erreur qui empêche d'enregistrer le blocage |
| `moteur : démarrage (nettoyage des panneaux)` et `moteur : démarrage (arrêt des agents terminés)` | les deux `catch` de `Engine.run` | l'erreur de démarrage |
| `outil MCP <nom de l'outil>` | `guard` de `src/mcp/server.ts` (le nom de l'outil doit lui être transmis) | l'exception transformée en `Erreur : …` |
| `lancement du moteur` / `lancement du serveur MCP` | actions `engine <id>` et `mcp <id>` de `src/cli.ts` | une erreur au lancement (état ou config illisible), qui reste ensuite levée comme aujourd'hui |
| `moteur : erreur non rattrapée` / `serveur MCP : erreur non rattrapée` | écouteurs `uncaughtException` et `unhandledRejection` installés par ces deux actions | l'erreur, puis le comportement par défaut (message sur la sortie d'erreur, code de sortie non nul) |

Les messages existants sur la sortie d'erreur (`console.error`) sont conservés ; le journal s'y ajoute.

### Signalement par l'orchestrateur

- Nouvel outil MCP `signaler_anomalie(description)` dans `src/mcp/server.ts` (description non vide). Il appelle
  `logHernessError` avec l'origine `signalement de l'orchestrateur` et l'étape courante de la mission (lue dans
  l'état si possible, sinon omise) ; le corps de l'entrée est la description, sans pile. Il répond par un texte qui
  donne le chemin du journal. Il ne poste rien dans la boîte du moteur et ne change pas l'état de la mission.
- `logHernessError` accepte donc aussi un texte simple comme « erreur » (son corps est alors le texte tel quel).
- Le prompt de l'orchestrateur (`src/prompts/orchestrator.md`, section « Tes outils ») décrit l'outil : à utiliser
  quand il constate un défaut de herness lui-même (moteur incohérent, message `[herness]` contradictoire avec
  `statut`, outil qui ne fait pas ce qu'il dit), avec ce qu'il a observé, ce qu'il attendait et les identifiants utiles
  (porte, tâche) ; jamais pour un échec normal de mission (tests rouges, agent bloqué, revue négative). Il prévient
  l'utilisateur qu'il a fait un signalement.

### Motif de blocage

Le motif de blocage écrit par `Engine.fail` se termine par une ligne `détail : <chemin absolu de erreurs.log>`, pour
que l'utilisateur (et l'orchestrateur, qui reçoit le motif) sache où regarder. La première ligne du motif, utilisée
dans la notification, ne change pas.

## Contraintes

- Le serveur MCP ne doit rien écrire sur stdout (protocole) : le journal n'écrit que dans le fichier.
- Les tests utilisent `HERNESS_HOME` vers un dossier temporaire ; aucun test n'écrit dans le vrai `~/.local/state`.
- L'horodatage vient de `new Date()` dans le module ; pour le moteur, `Effects.now()` peut être passé si l'on veut un
  horodatage déterministe en test (au choix de l'implémenteur, pourvu que les tests vérifient le contenu sans dépendre
  de l'heure exacte).

## Laissé à l'implémenteur

- Le détail de l'écriture (`appendFile` après `mkdir -p`).
- La forme exacte de la transmission du nom de l'outil à `guard`.
- L'installation des écouteurs de processus (fonction utilitaire dans `src/errlog.ts`, par exemple
  `installProcessErrorLog(ctx)`), pourvu qu'elle soit testable sans tuer le processus de test.
