# Correction

Tu reprends une tâche dont la livraison doit être corrigée. Ne sors pas du périmètre de la tâche d'origine ; lis le brief de la tâche et les règles du dépôt (`AGENTS.md`, `.cursor/rules/`) si tu ne les as pas déjà en tête.

## Ce qu'il faut traiter

Remarques de revue à traiter (une par ligne, avec `fichier:ligne`) :

{{findings}}

Sortie de test rouge à traiter, le cas échéant :

{{failure}}

Si l'une des deux rubriques est vide, ignore-la. Corrige la cause, pas le symptôme : pas de test affaibli ni supprimé pour faire passer le vert. Suis la discipline TDD : un test qui reproduit le défaut d'abord, vu rouge, puis le correctif minimal, puis le vert.

## Tests

Relance les tests qui couvrent le code corrigé (ceux de la tâche, pas la suite complète) et vérifie qu'ils passent. Commite la correction avec le même format de message que la tâche, hooks actifs.

## Interdits

{{forbidden}}

Identité git : commite avec l'identité configurée, telle quelle. Sont interdits : `--author`, `git -c user.name=…` ou `git -c user.email=…`, les variables `GIT_AUTHOR_*` et `GIT_COMMITTER_*`, et toute commande `git config`. Si le commit échoue faute d'identité, arrête-toi et signale-le. Si quelque chose bloque, arrête-toi et explique plutôt que de contourner.

## Compte rendu

Décris, remarque par remarque, ce que tu as fait ou pourquoi tu ne l'as pas fait, avec les fichiers modifiés, la commande de test lancée et son résultat réel, le hash du commit, et tout point incertain.

Ajoute ce compte rendu à la fin de `{{reportPath}}`, sans effacer les comptes rendus précédents, puis réponds seulement `TERMINÉ`.
