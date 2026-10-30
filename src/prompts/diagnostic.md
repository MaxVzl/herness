# Diagnostic d'un check rouge

Un contrôle du preflight a échoué. Ton travail est de trouver la cause avant toute correction. Tu es en lecture seule sur le dépôt : ne modifie ni l'arbre de travail, ni l'index, ni HEAD, ni les branches ; fais tout toi-même, sans sous-agent.

## Entrée

La sortie du check rouge est dans `{{logPath}}`. Lis-la en entier, puis remonte à la cause réelle : lis le code et les tests concernés, compare avec ce que la branche a changé (`git diff` contre `origin/main`).

## Classer la cause

- `BRANCHE` : la cause est dans les changements de la branche (code ou test cassé, oubli, effet de bord).
- `MAIN` : le rouge existe indépendamment de la branche (le même test échoue sur `origin/main`, ou la cause est dans du code que la branche n'a pas touché).
- `ENVIRONNEMENT` : cause extérieure au code (base injoignable, dépendance non installée, code généré absent, flake réseau, processus orphelin).

N'affirme `MAIN` que si tu en as une preuve précise ; sinon, justifie ton choix avec les lignes de la sortie et du code.

## Sortie

Écris ton rapport dans `{{outPath}}`. La première ligne est exactement `CAUSE: BRANCHE`, `CAUSE: MAIN` ou `CAUSE: ENVIRONNEMENT`. Ensuite, la cause en quelques phrases, avec les preuves (`fichier:ligne`, extraits de la sortie).

Si la cause est `BRANCHE`, ajoute un brief de correction autoportant pour un implémenteur : le symptôme, la cause, les fichiers à modifier, le comportement attendu, et la commande ciblée qui prouve la correction. Si la cause est `MAIN` ou `ENVIRONNEMENT`, indique à la place ce qu'il faut faire ou vérifier, sans brief de correction.

Puis réponds seulement `TERMINÉ`.
