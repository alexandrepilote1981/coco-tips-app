# Déclara — suivi des pourboires et horaires

Application web pour un petit groupe de restaurants au Québec. Chaque employé déclare ses
ventes et ses pourboires par un lien privé ; le gérant voit l'ensemble, suit les virements
dus et publie l'horaire de la semaine. Interface bilingue français/anglais, le français
étant la langue par défaut.

En production sur Railway, à `declara.tips`, depuis la branche `main`.

## Démarrer et vérifier

```bash
npm install
npm start                 # écoute sur PORT, 3000 par défaut
npm test                  # node --test : tout ce qui est sous test/
```

Variables d'environnement (toutes avec une valeur de repli, l'app démarre sans configuration) :

| Variable            | Défaut                 | Rôle                                              |
| ------------------- | ---------------------- | ------------------------------------------------- |
| `PORT`              | `3000`                 | port d'écoute                                     |
| `ADMIN_PASSWORD`    | `changeme`             | accès à `/admin`                                  |
| `SCHEDULE_PASSWORD` | `horaire2026`          | accès à `/horaire` (horaire seulement, sans les montants) |
| `DB_PATH`           | `./data.sqlite`        | fichier SQLite ; sur Railway, il vit sur le volume |
| `PHOTOS_DIR`        | `<dossier de DB_PATH>/photos` | justificatifs téléversés                   |

Pour lancer une instance jetable sans toucher aux données locales :

```bash
DB_PATH=/tmp/essai.sqlite PORT=3999 ADMIN_PASSWORD=changeme node server.js
```

La base se crée et se migre toute seule au démarrage (`db.js`), il n'y a aucune étape de
migration manuelle.

## Ce qui existe

```
server.js                 toutes les routes HTTP, un seul fichier
db.js                     ouverture SQLite, schéma, migrations idempotentes
backup.js                 archive .zip téléchargeable (base + CSV lisibles)
pdf-horaire.js            PDF de l'horaire hebdomadaire (pdfkit)
rate-limit.js             plafond de tentatives en mémoire, sur les échecs seulement
public/admin.html         tableau de bord du gérant
public/employee.html      page d'un employé, atteinte par /e/<code>
public/horaire.html       horaire seul, atteint par /horaire/<code>
public/landing.html       page de présentation publique
public/shared/tip-math.js calcul des pourboires — chargé par le serveur ET le navigateur
public/shared/schedule-ui.js  grille d'horaire — partagée par /admin et /horaire
public/shared/noms.js     découpage prénom / nom de famille
public/shared/horaire-mise-en-page.js  mise en page de la feuille — dessinée en PDF et en image
public/shared/horaire-image.js  export de la feuille en PNG (surface canvas)
public/shared/cout-main-oeuvre.js  masse salariale d'une semaine (cuisine seulement)
public/shared/tirer-pour-actualiser.js  « tirer pour actualiser », les trois écrans
test/                     tests node:test
```

### Les pages sont des fichiers autonomes

Chaque page de `public/` contient son HTML, son CSS et son JavaScript dans un seul fichier.
Il n'y a **ni build, ni bundler, ni framework** : le serveur sert `public/` en statique, et
ce qui est dans le dépôt est exactement ce que le navigateur reçoit. Un changement dans une
page est donc en ligne dès le déploiement, sans étape de compilation.

Chaque page suit le même patron :

- un objet `I18N = { fr: {...}, en: {...} }` et une fonction `t(cle, ...args)` ; une valeur
  peut être une chaîne ou une fonction pour les phrases à trous ;
- la langue est gardée dans `localStorage` (`coco-lang-admin` pour l'admin, `coco-lang`
  ailleurs) ;
- une fonction `render()` qui construit **toute** la page dans une chaîne de gabarit, l'écrit
  dans `#app`, puis rebranche les écouteurs d'événements ;
- l'état vit dans quelques variables au niveau du module (`overview`, `period`, `messages`…).

Conséquence à garder en tête : après un `render()`, tous les nœuds sont neufs. Une référence
DOM gardée d'avant ne pointe plus sur rien, et tout écouteur doit être rebranché. `render()`
mémorise et restaure la position de défilement, sinon chaque rafraîchissement renverrait en
haut de page.

### Ne jamais dupliquer un calcul entre le serveur et le navigateur

`public/shared/tip-math.js` est chargé par les deux côtés — `require()` sous Node,
`window.TipMath` dans le navigateur. Ce fichier existe précisément parce que le calcul avait
déjà été écrit en double et que les deux versions avaient divergé en silence : la page
affichait un montant, la base en gardait un autre. Même principe pour
`public/shared/schedule-ui.js`, partagé par `/admin` et `/horaire`.

Si une logique doit vivre des deux côtés, elle va dans `public/shared/`, avec des tests.

## Salle et cuisine

Chaque employé porte un `secteur` : `salle` ou `cuisine`. Tout en découle.

La **salle** déclare des pourboires ; son horaire n'affiche que l'heure de début, parce qu'une
serveuse part quand la salle est vide et que l'heure écrite serait une promesse fausse.

La **cuisine** ne déclare rien. Son horaire affiche `début → fin`, parce qu'un cuisinier finit
à l'heure — et c'est cette heure de fin qui rend possible le calcul de la masse salariale
(`public/shared/cout-main-oeuvre.js`). C'est le coût du PLAN, pas du réel : personne ne
poinçonne. Les postes diffèrent aussi (Cuisinier / Plongeur contre Serveur / Hôtesse).

Chaque quart de cuisine peut aussi porter une **tâche** (« Prép », « Commande à défaire »).
Elle s'ajoute SOUS le poste, elle ne le remplace pas : on avait d'abord misé sur la couleur
de la pastille pour dire le poste, mais dans une grille de quatorze personnes on lit les
mots, pas les teintes. À l'écran, trois lignes ; sur la feuille imprimée, où une case fait
26 points de haut, les deux partagent une ligne (« Cuisinier · Prép ») et c'est le poste qui
cède quand l'ensemble déborde — sa couleur le dit encore, la tâche n'est écrite nulle part
ailleurs. Sa longueur maximale (`TACHE_MAX`) vit dans `horaire-mise-en-page.js` parce que
c'est la largeur d'une colonne de jour qui la dicte ; le champ de saisie et le serveur s'y
réfèrent tous les deux.

Les taux horaires ne sont jamais envoyés aux portes qui n'y ont pas droit — ils ne sont pas
seulement cachés à l'écran. Voir `porteParCode()` dans `server.js`, couvert par
`test/portes-horaire.test.mjs`.

## Accès et authentification

Cinq portes d'entrée, sans compte utilisateur :

- **Employé** : `/e/<access_code>` — code de 6 caractères, aucun mot de passe. Le code sert
  de jeton pour tous les appels `/api/employee/<code>/…`.
- **Gérant** : `/admin`, protégé par `ADMIN_PASSWORD`. Le jeton est le mot de passe lui-même,
  gardé dans `sessionStorage` sous `adminToken` et envoyé en en-tête `X-Admin-Token`.
- **Horaire salle** : `/horaire/<schedule_code>` ou `/horaire` avec `SCHEDULE_PASSWORD` —
  donne l'horaire sans jamais exposer les montants.
- **Horaire cuisine, gérant** : `/horaire/<schedule_code_cuisine>` — modifie l'horaire de la
  cuisine ET montre les salaires. Ce lien ne se partage pas à l'équipe.
- **Horaire cuisine, cuisiniers** : `/horaire/<schedule_code_cuisine_lecture>` — le même
  horaire en lecture seule, sans un montant. C'est ce lien qu'on envoie dans le groupe.

`rate-limit.js` ne compte que les échecs : rafraîchir une page avec un code valide n'est
jamais pénalisé, enchaîner des codes faux l'est. C'est ce qui rend un code de 6 caractères
acceptable ; ne pas affaiblir ce principe.

Pour piloter `/admin` dans un test sans passer par l'écran de connexion :

```js
sessionStorage.setItem("adminToken", "changeme"); // puis recharger la page
```

## Conventions du code

**Les commentaires expliquent le pourquoi, pas le quoi.** C'est la convention la plus
visible du dépôt : presque chaque fichier s'ouvre sur le problème concret qui l'a fait
naître, et les passages délicats disent quelle erreur ils évitent. Un commentaire qui
paraphrase la ligne suivante n'a pas sa place ; un commentaire qui explique pourquoi le
calcul du retard passe par `created_at` plutôt que `updated_at`, oui.

**Tout est en français** : commentaires, messages de commit, noms des tests. Le code lui-même
mélange français et anglais selon l'usage établi dans chaque fichier — suivre ce qui est déjà
là plutôt qu'uniformiser.

**Toute chaîne visible passe par `t()`**, avec son entrée dans les deux dictionnaires. Une
chaîne écrite en dur dans le HTML est un bogue de traduction en attente.

**Les couleurs suivent la palette existante** : fond `#10151D`, cartes `#161C26`, texte
`#F1EFEA`, gris `#8993A4`, vert `#6FBF93`, or `#D4A857`, rouge `#E2685A`. Titres en Fraunces,
texte en IBM Plex Sans.

**Pas de dépendance nouvelle sans raison forte.** Le projet tient sur express, better-sqlite3,
nanoid, pdfkit et adm-zip. Les tests n'utilisent que `node:test`, intégré à Node.

## Tests

`npm test` lance `node --test`, qui ramasse tout ce qui est sous `test/`.

- `test/tip-math.test.js` — le calcul des pourboires, sans navigateur.
- `test/noms.test.js` — découpage prénom / nom de famille.
- `test/cout-main-oeuvre.test.js` — la masse salariale, dont l'exemple chiffré du gérant.
- `test/horaire-mise-en-page.test.js` — la mise en page, vérifiée par une fausse surface qui
  note les ordres de dessin au lieu de les exécuter : c'est ainsi qu'on sait que rien ne sort
  de la feuille et que personne ne disparaît de la liste.
- `test/pdf-horaire.test.js` — le PDF réellement produit, relu dans son flux.
- `test/schedule-ui.test.js` — ce que la grille calcule sans toucher au DOM (liste d'heures,
  postes, échappement) ; le fichier est chargé avec un faux `window`.
- `test/portes-horaire.test.mjs` — les cinq portes sur le vrai serveur HTTP. C'est ici qu'on
  vérifie qu'aucun salaire ne sort vers une porte qui n'y a pas droit.
- `test/effacer-semaine.test.mjs` — l'effacement en lot et ses bornes.
- `test/ui-smoke.test.mjs` — démarre le serveur sur une base jetable et pilote les pages dans
  un vrai navigateur (voir l'en-tête du fichier). Se saute tout seul, sans échouer, quand
  aucun Chrome/Chromium n'est installé.

Une modification dans `admin.html` ou `employee.html` mérite d'être vérifiée dans un vrai
navigateur, pas seulement relue : c'est là que vit l'essentiel de la logique, et rien d'autre
ne la couvre.

## Déploiement

Railway déploie automatiquement chaque commit poussé sur `main` — pas de fichier de
configuration dans le dépôt, tout est réglé côté Railway. La base vit sur un volume monté,
elle survit aux redéploiements.

`data.sqlite` et le dossier `photos/` sont ignorés par git ; ne jamais les committer.
