# Factures — capture et suivi des dépenses

Voir `README.md` pour démarrer, la liste des variables d'environnement et le parcours complet.
Ce fichier ne contient que ce qu'il faut savoir avant de modifier le code.

**Projet distinct de Déclara** (suivi des pourboires, `declara.tips`). Les patrons viennent de
là — capture photo, liste blanche d'extensions, plafond de tentatives, pages autonomes — mais
aucun fichier n'est partagé et les deux bases sont séparées.

## La règle qui prime sur tout

**Rien n'entre dans les dépenses sans confirmation humaine.** L'extraction pré-remplit une
fiche ; c'est la validation qui inscrit. Une modification qui court-circuiterait cette étape —
même « juste quand l'analyse est très sûre » — corromprait la comptabilité en silence, parce
que personne ne relit un registre de dépenses.

Corollaire dans `extraction.js` : le modèle ne recalcule **jamais** une taxe absente du reçu,
il renvoie `null`. Les montants imprimés font foi pour les CTI/RTI.

## Les pages sont des fichiers autonomes

Chaque page de `public/` contient son HTML, son CSS et son JavaScript dans un seul fichier.
**Ni build, ni bundler, ni framework** : le serveur sert `public/` en statique, et ce qui est
dans le dépôt est exactement ce que le navigateur reçoit.

Chaque page suit le même patron : une fonction `render()` qui reconstruit **toute** la page
dans une chaîne de gabarit, l'écrit dans `#app`, puis rebranche les écouteurs. L'état vit dans
quelques variables au niveau du module.

Conséquence : après un `render()`, tous les nœuds sont neufs. Une référence DOM gardée d'avant
ne pointe plus sur rien, et tout écouteur doit être rebranché. `render()` mémorise et restaure
la position de défilement, sinon chaque rafraîchissement renverrait en haut de page.

## Ne jamais dupliquer un calcul entre le serveur et le navigateur

`public/shared/taxes.js` est chargé par les deux côtés — `require()` sous Node,
`window.Taxes` dans le navigateur. Même principe pour `public/shared/capture-photo.js`,
partagé par `index.html` et `capture.html`.

Si une logique doit vivre des deux côtés, elle va dans `public/shared/`, avec des tests.

## Conventions

**Les commentaires expliquent le pourquoi, pas le quoi.** Chaque fichier s'ouvre sur le
problème concret qui l'a fait naître, et les passages délicats disent quelle erreur ils
évitent. Un commentaire qui paraphrase la ligne suivante n'a pas sa place.

**Tout est en français** : commentaires, messages de commit, noms des tests.

**Français seulement à l'écran** — pas de dictionnaire bilingue, contrairement à Déclara.
L'utilisateur principal est unique. Si l'anglais devient nécessaire, reprendre le patron
`I18N` / `t()` de Déclara plutôt que d'improviser.

**Les couleurs suivent la palette** : fond `#10151D`, cartes `#161C26`, texte `#F1EFEA`, gris
`#8993A4`, vert `#6FBF93`, or `#D4A857`, rouge `#E2685A`. Titres en Fraunces, texte en IBM
Plex Sans.

**Pas de dépendance nouvelle sans raison forte.** Le projet tient sur express, better-sqlite3,
nanoid et `@anthropic-ai/sdk`. Les tests n'utilisent que `node:test`, sauf le test navigateur
qui demande Playwright en option et se saute sans lui.

## Sécurité — deux points à ne pas affaiblir

1. **La liste blanche d'extensions d'image** (`server.js`). Sans elle, un
   `data:image/html;base64,…` était écrit en `.html` puis reservi en `text/html` — donc du
   script exécuté sur le domaine. Le type MIME est imposé depuis la liste, jamais déduit.
2. **Le lien privé `/c/<code>` ne donne accès qu'au dépôt.** Il vit dans les favoris d'un
   téléphone qui peut se perdre. Aucun montant, aucun accès au registre. Un test le vérifie.

Le mot de passe ne doit jamais transiter par une URL — ni pour l'export, ni pour les vignettes
(elles sont chargées par `fetch` puis affichées depuis un blob, précisément pour ça).

## Vérifier une modification d'interface

Une modification dans `depenses.html`, `index.html` ou `capture.html` mérite d'être vérifiée
dans un vrai navigateur, pas seulement relue :

```bash
npm install --no-save playwright && npm test
```
