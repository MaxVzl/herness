# Revue globale de la branche

Tu relis toute la branche, c'est-à-dire les commits `{{baseSha}}..{{headSha}}`, contre la spec. Les tâches ont déjà été relues une à une : tu cherches ce qui n'apparaît qu'à l'échelle de l'ensemble (incohérences entre tâches, exigence de la spec jamais couverte, doublons, contrats incompatibles, dette introduite, tests qui ne couvrent pas le comportement d'ensemble).

## Ce qui était demandé

Spec : `{{specPath}}`
Plan : `{{planPath}}`

Contraintes globales qui s'imposent à la branche :

{{constraints}}

## Diff à relire

Base : `{{baseSha}}`
Tête : `{{headSha}}`
Fichier de diff : `{{diffPath}}`

Lis le fichier de diff ; s'il est absent, utilise `git diff --stat {{baseSha}}..{{headSha}}` et `git diff {{baseSha}}..{{headSha}}`. Tu peux lire le code hors du diff pour vérifier un risque concret que tu peux nommer (site d'appel, contrat partagé). Ta revue est en lecture seule : ne modifie ni l'arbre de travail, ni l'index, ni HEAD, ni les branches. Fais tout toi-même : ne lance aucun sous-agent.

## Méthode

Ne fais pas confiance aux comptes rendus des implémenteurs : vérifie contre le code. D'abord la conformité à la spec (manquant, en trop, mal compris), puis la qualité (séparation des responsabilités, gestion des erreurs, cas limites, tests qui vérifient un comportement réel). Ne relance pas la suite de tests ; ne lance un test ciblé que pour lever un doute précis.

## Gravité

- **Critique** : comportement faux, régression, faille, interdit enfreint.
- **Important** : la branche ne peut pas être fusionnée tant que ce n'est pas corrigé (exigence de la spec manquée, comportement fragile, dégât de maintenabilité).
- **Mineur** : confort, finition.

Chaque remarque cite `fichier:ligne`, ce qui ne va pas, pourquoi cela compte et comment corriger si ce n'est pas évident.

## Sortie

Écris ton rapport dans `{{outPath}}`. La première ligne est exactement `VERDICT: APPROUVÉ` ou `VERDICT: CORRECTIONS` (CORRECTIONS dès qu'il reste une remarque Critique ou Important). Ensuite : conformité à la spec, points forts, remarques sous les titres Critique / Important / Mineur, bilan en une ou deux phrases. Pas de préambule. Puis réponds seulement `TERMINÉ`.
