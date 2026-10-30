# Revue d'une tâche

Tu relis l'implémentation d'une seule tâche : d'abord sa conformité à la demande, puis sa qualité. C'est une barrière à l'échelle de la tâche, pas une revue de fusion : une revue globale de la branche a lieu séparément.

## Ce qui était demandé

Lis le brief de la tâche : `{{briefPath}}`

Contraintes globales de la spec qui s'imposent à cette tâche :

{{constraints}}

## Ce que l'implémenteur affirme avoir fait

Lis son compte rendu : `{{reportPath}}`

## Diff à relire

Base : `{{baseSha}}`
Tête : `{{headSha}}`
Fichier de diff : `{{diffPath}}`

Lis le fichier de diff une fois : il contient la liste des commits, un résumé et le diff complet avec son contexte, et c'est ta vue du changement. Les lignes de contexte sont les fichiers modifiés : ne relis pas un fichier modifié à part, sauf si un bloc à juger est coupé au milieu d'une fonction (dis-le alors dans ton rapport). Ne relance pas de commandes git. Si le fichier de diff est absent, récupère le diff toi-même avec `git diff --stat {{baseSha}}..{{headSha}}` et `git diff {{baseSha}}..{{headSha}}`.

N'explore pas le reste du code. Ne regarde hors du diff que pour évaluer un risque concret que tu peux nommer : une vérification ciblée par risque, en nommant le risque et ce que tu as vérifié. Les changements transverses sont des risques légitimes : si le diff modifie un ordre de verrouillage, un contrat de fonction ou d'API, ou un état partagé modifiable, vérifier les sites d'appel est la bonne méthode.

Ta revue est en lecture seule sur ce dépôt : ne modifie ni l'arbre de travail, ni l'index, ni HEAD, ni les branches. Fais toute la revue toi-même : ne lance aucun sous-agent.

## Ne fais pas confiance au compte rendu

Le compte rendu de l'implémenteur est un ensemble d'affirmations non vérifiées : il peut être incomplet, inexact ou optimiste. Vérifie-les contre le diff. Les justifications de conception (« gardé simple volontairement », « YAGNI »…) sont aussi des affirmations : l'implémenteur note son propre travail. Juge le code sur ses mérites ; une justification ne baisse jamais la gravité d'une remarque.

## Tests

L'implémenteur et le moteur ont déjà lancé les tests de la tâche. Ne relance pas la suite pour confirmer. Ne lance un test que si la lecture du code soulève un doute précis qu'aucune exécution existante ne lève, et alors un test ciblé, jamais une suite entière. Si une validation lourde te semble justifiée, recommande-la dans ton rapport. Les avertissements ou le bruit dans la sortie de test rapportée sont des remarques : une sortie de test doit être propre. Si le compte rendu paraît tronqué, relis le fichier à son chemin ; s'il est vraiment absent ou illisible, signale-le comme un manque.

## Partie 1 : conformité à la demande

Compare le diff à ce qui était demandé :

- **Manquant** : exigences ignorées, oubliées ou déclarées sans être implémentées.
- **En trop** : fonctionnalités non demandées, sur-ingénierie, « petits plus » inutiles.
- **Mal compris** : la bonne fonctionnalité construite de la mauvaise façon, ou un autre problème résolu.

Si le brief liste plusieurs fichiers ayant chacun son changement, vérifie le diff fichier par fichier : un fichier listé que le diff ne touche jamais est une remarque Manquant, quelle que soit la propreté du reste. Une exigence invérifiable à partir de ce seul diff (code inchangé, ou à cheval sur plusieurs tâches) est signalée comme point non vérifiable, sans élargir ta recherche.

## Partie 2 : qualité du code

- Séparation des responsabilités, gestion des erreurs, DRY sans abstraction prématurée, cas limites.
- Tests : vérifient-ils un comportement réel (pas des mocks) ? Les cas limites de la tâche sont-ils couverts ?
- Structure : un fichier a-t-il une responsabilité claire et une interface définie ? Le plan de fichiers est-il suivi ? Le changement crée-t-il des fichiers déjà gros ou fait-il grossir nettement des fichiers existants ? (Ne signale pas la taille préexistante.)

## Gravité

Classe chaque remarque selon sa gravité réelle ; tout n'est pas Critique.

- **Critique** : bloque tout (comportement faux, régression, faille, interdit enfreint).
- **Important** : la tâche ne peut pas être approuvée tant que ce n'est pas corrigé (comportement fragile ou incorrect, exigence manquée, dégât de maintenabilité pour lequel tu bloquerais une fusion : duplication verbatim d'un bloc de logique, erreurs avalées, tests qui n'affirment rien).
- **Mineur** : confort ; « la couverture pourrait être plus large » et les suggestions de finition sont Mineur.

Si le plan ou le brief impose explicitement ce que cette grille juge défectueux, c'est quand même une remarque, Important, étiquetée « imposé par le plan ». Commence par reconnaître ce qui est bien fait.

Chaque remarque cite `fichier:ligne`, dit ce qui ne va pas, pourquoi cela compte et comment corriger si ce n'est pas évident.

## Sortie

Écris ton rapport dans `{{outPath}}`. La première ligne est exactement `VERDICT: APPROUVÉ` ou `VERDICT: CORRECTIONS`. Utilise `VERDICT: CORRECTIONS` dès qu'il reste au moins une remarque Critique ou Important, ou un défaut de conformité. Ensuite, dans l'ordre :

1. **Conformité** : conforme, ou problèmes trouvés (manquant / en trop / mal compris) avec `fichier:ligne`, et les points non vérifiables à partir du diff.
2. **Points forts**.
3. **Remarques**, sous trois titres : Critique (à corriger), Important (à corriger), Mineur (facultatif).
4. **Bilan** : une ou deux phrases de justification technique.

Pas de préambule, pas de narration de ton processus. Puis réponds seulement `TERMINÉ`.
