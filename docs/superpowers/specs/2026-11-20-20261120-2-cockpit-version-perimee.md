# Cockpit périmé : lancer la version installée et signaler la mise à jour

## Intention

La mission Funeo 4610277367 s'est bloquée au preflight sur « contrôle du commit en échec, auteur(s) ≠ … : …noreply.github.com ». Le défaut du contrôle (après un rebase, `base..HEAD` contenait les commits de main) est corrigé depuis la 0.6.1 (`d6c01c6`). La mission a pourtant tourné en **0.6.0** : elle avait été ouverte depuis un `herness cockpit` lancé le 10 novembre et jamais relancé.

Cause : tout ce que herness démarre (moteur, panneau tasks, visionneuses, serveur MCP, redémarrage détaché, cockpit) est lancé avec `<racine du paquet du processus>/bin/herness.js`. Un cockpit lancé avant une mise à jour ouvre donc toutes les nouvelles missions avec son ancienne version, sans les correctifs. Le cockpit exécute aussi dans son propre processus la création d'une mission et les validations de portes.

Ce qu'on veut : une mise à jour installée s'applique aux processus lancés ensuite, quel que soit l'âge du cockpit, et un cockpit périmé le signale.

## Objectifs

1. **Lancer la version installée.** Une fonction unique fournit la commande qui lance herness :
   - si le processus courant tourne depuis une version installée (le chemin réel de sa racine de paquet est sous `<dossier d'installation>/versions/`) et que le lanceur stable `installedBin()` (`<dossier d'installation>/current/bin/herness`, déjà dans `src/update.ts`) existe, c'est ce lanceur. Il est résolu au moment du lancement, donc c'est la version active à cet instant ;
   - sinon (exécution depuis les sources, tests, pas d'installation), c'est le `bin/herness.js` du processus courant lancé par `node`, comme aujourd'hui.
2. Cette fonction remplace les chemins codés en dur pour :
   - `src/lifecycle.ts` : moteur, tasks, visionneuses spec et plan, au démarrage et à la reprise ;
   - `src/ui/actions.ts` : `restartDetached` (`reprendre <id> --redemarrer`) ;
   - `src/mcp/server.ts` : la commande écrite dans `mcp.json` ;
   - `src/ui/location.ts` : le lancement du cockpit dans son onglet.
3. **Reprise** : une mission reprise ou redémarrée prend la version installée au moment de la reprise, comme `herness reprendre` tapé dans le terminal et `herness mise-a-jour`.
4. **Bandeau du cockpit.** Au rythme de son rafraîchissement, le cockpit lit la version installée (le `package.json` de `<dossier d'installation>/current`). Si elle existe et diffère de la sienne (`VERSION`), il affiche sous le titre une ligne jaune :
   `herness <installée> installé, ce cockpit tourne en <la sienne> : quitte-le et relance herness`.
   Pas de bandeau si aucune version n'est installée, si elle est illisible, si les versions sont identiques ou si le cockpit tourne depuis les sources.

## Non-objectifs

- Le contrôle des auteurs (`controlCommits`) : déjà corrigé en 0.6.1.
- La relance automatique du cockpit par lui-même : fragile depuis son propre panneau herdr.
- Le panneau tasks et les visionneuses d'une mission déjà lancée : `herness mise-a-jour` les redémarre déjà.
- `src/config/init.ts` (vérification `herness projet` après `init`) : ponctuelle, elle reste sur le code de l'appelant.
- `install.sh` : inchangé.

## Contraintes

- Le développement local (lancer herness depuis le dépôt) doit garder son comportement : les processus lancés utilisent le code du dépôt.
- Le dossier d'installation est calculé comme dans `installedBin()` (`HERNESS_INSTALL_DIR`, sinon `XDG_DATA_HOME/herness`, sinon `~/.local/share/herness`) : une seule source pour ce calcul.
- Le lanceur stable est un script shell exécutable : il se lance directement, pas via `node`. Les commandes tapées dans les panneaux herdr gardent leurs guillemets (`shq`).
- Testable sans installation réelle : l'environnement (`HERNESS_INSTALL_DIR`) et la racine du paquet sont injectables.

## Approches considérées

1. **Lancer via le lanceur installé** : corrige les processus lancés, mais pas ce que le cockpit exécute dans son propre processus (création de mission, validations).
2. **Bandeau seul** : signale le problème, mais une mission ouverte avant la relance du cockpit reste sur l'ancienne version.
3. **Les deux** (retenue par l'utilisateur) : les processus lancés prennent toujours la version active, et le bandeau fait relancer le cockpit pour les actions qu'il exécute lui-même.

## Laissé à l'implémenteur

Le nom et l'emplacement du module du lanceur et de la lecture de la version installée (`src/update.ts` les accueille naturellement), la forme exacte des tests, la manière d'intégrer la lecture de version au cycle de rafraîchissement du cockpit.
