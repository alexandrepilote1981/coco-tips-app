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
public/shared/absences.js  congés et vacances : plages, conflits, mise en forme des dates
public/shared/feries.js    fériés du Québec et grosses journées de restaurant — calculés, pas saisis
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
Elle s'ajoute au poste sans le remplacer : on avait d'abord misé sur la couleur de la
pastille pour dire le poste, mais dans une grille de quatorze personnes on lit les mots, pas
les teintes. Les deux partagent **une seule ligne** (« Cuisinier · Prép »), à l'écran comme
sur la feuille — une case ne doit pas s'allonger parce qu'on a écrit une tâche, sinon la
grille ne tient plus sur un écran.

À l'écran, la tâche a sa propre ligne sous le poste, et les corps de texte de la pastille
sont serrés exprès pour que les trois lignes tiennent dans la hauteur que la case avait
déjà : écrire une tâche ne doit pas allonger la grille. Ni le poste ni la tâche ne reviennent
à la ligne (`white-space: nowrap` + ellipsis).

Les colonnes de jour ont une largeur minimale (`COLONNE_MIN` dans `schedule-ui.js` : 62 px en
salle, 100 px en cuisine) et la grille glisse latéralement en dessous. Les laisser rétrécir
librement coupait tout sur un téléphone — « 08:00 » devenait « 08:0 », « Serveur » devenait
« Ser… ». Les 100 px de la cuisine ne sont pas un chiffre rond : c'est ce qu'il faut pour
qu'une plage horaire tienne sur une ligne et qu'une tâche de longueur maximale s'écrive en
entier.

Sur la feuille imprimée il n'y a de place que pour deux lignes (une case fait 26 points de
haut), alors le poste et la tâche partagent la seconde : « Cuisinier · Prép ». Quand les deux
ne rentrent pas dans la colonne, mesurée par `surface.mesurer`, c'est le POSTE qui cède — sa
couleur le dit encore, la tâche n'est écrite nulle part ailleurs. Sa longueur maximale (`TACHE_MAX`) vit dans `horaire-mise-en-page.js` parce que
c'est la largeur d'une colonne de jour qui la dicte ; le champ de saisie et le serveur s'y
réfèrent tous les deux.

Chaque employé de cuisine peut aussi porter un **plafond d'heures par semaine**
(`employees.heures_max`, 0 = aucun plafond). Quand la semaine cédulée le dépasse, toute la
rangée de la personne rougit dans la grille, et ses heures s'écrivent sous son nom sous la
forme `24 h / 20 h`. Les heures s'affichent pour toute la grille et pas seulement pour ceux
qui ont un plafond : sinon les rangées n'auraient pas la même hauteur. Être pile au plafond
n'est pas un dépassement.

Les taux horaires et les plafonds ne sont jamais envoyés aux portes qui n'y ont pas droit — ils ne sont pas
seulement cachés à l'écran. Voir `porteParCode()` dans `server.js`, couvert par
`test/portes-horaire.test.mjs`.

## Congés et absences

Quatre types : `conge`, `vacances`, `maladie`, `cnesst`. Quand deux absences se chevauchent,
c'est la plus lourde de conséquences qui s'affiche (`PRIORITE` dans `absences.js`) — un
accident de travail passe avant une maladie, qui passe avant des vacances. Chacune a sa
teinte dans la grille et dans la liste.

Une absence est une PLAGE (`absences.date_debut` → `date_fin`), pas une date : une semaine de
vacances est une seule entrée, pas sept. Une fin laissée vide veut dire « une seule journée »,
le cas le plus courant.

Une liste qu'on consulte ne suffit pas — personne ne la relit à chaque quart. Ce qui compte
est le marquage dans la grille : une journée d'absence s'y affiche à la place du « + », et un
quart cédulé pendant une absence notée reçoit un contour rouge. C'est précisément l'oubli
qu'on cherche à empêcher.

La section est dépliante, au-dessus de chaque grille : menu déroulant des employés, deux
calendriers, type, et la liste des absences à venir. Elle vit dans `schedule-ui.js`, donc elle
apparaît d'elle-même dans le tableau de bord ET sur les liens horaire. Les portes en lecture
seule voient les absences mais n'ont ni formulaire ni bouton pour les retirer : savoir qui est
en vacances n'est un secret pour personne dans un restaurant.

Une période déjà commencée mais pas terminée reste « à venir » — on est en plein dedans.

## Jours fériés et grosses journées

`public/shared/feries.js` calcule les journées marquées d'une année — rien n'est en base, et
il n'y a pas de table à remplir chaque année. Pâques passe par l'algorithme de
Meeus/Jones/Butcher ; le reste s'en déduit ou se décrit en une phrase (« 2e dimanche de
mai »). Tout le calcul de dates passe par UTC à midi, sinon un fuseau horaire décale un férié
d'un jour.

**Toutes les journées marquées portent LA MÊME couleur, le rouge.** Il y a eu une version à
deux teintes — or pour les fériés, corail pour les grosses journées — et elle demandait au
gérant de décoder une couleur avant de comprendre sa semaine. Une grille se lit d'un coup
d'œil : une seule couleur dit « cette journée-là n'est pas ordinaire », et le **nom** écrit en
dessous dit laquelle. C'est le nom qui porte le détail, pas la teinte. Ne pas réintroduire de
deuxième couleur ici.

Chaque journée garde quand même deux champs, parce que ce sont deux faits différents qui ne
se déduisent pas l'un de l'autre :

| champ       | ce qu'il dit                                               |
| ----------- | ---------------------------------------------------------- |
| `type`      | `ferie` = la paie n'est pas la même ; `occasion` = la loi n'a rien à dire |
| `affluence` | la salle va se remplir, donc il faut plus de monde au plancher |

La fête des Mères remplit la salle sans être un férié. Le Vendredi saint est un férié sans
être une grosse journée. L'**Action de grâce est les deux**. Seul `type` se voit encore, et
seulement en mots : l'infobulle d'un férié ajoute « · férié » (`Feries.estFerie()`), là où ça
ne coûte pas un pixel dans une colonne déjà étroite.

Vendredi saint ET lundi de Pâques sont affichés : la loi laisse l'employeur choisir, en
cacher un ferait manquer le bon. Le dimanche entre les deux n'est pas un férié du tout, mais
c'est lui qui remplit la salle.

À l'écran, le nom s'écrit dans l'en-tête du jour et la teinte descend sur toute la colonne —
un en-tête coloré seul se perd au bas d'une grille de quatorze personnes. Le nom peut passer
sur deux lignes mais jamais élargir la colonne (`overflow-wrap: anywhere`).

Sur la feuille imprimée, la teinte l'emporte sur celle de la fin de semaine : la fête des
Mères tombe toujours un dimanche, et elle disparaîtrait dans le gris du week-end. Le nom
complet s'écrit s'il rentre dans la colonne, mesuré par `surface.mesurer` ; sinon c'est le
nom court (`libelleCourt`). On ne tronque jamais : « Journée des patri… » ne dit plus rien à
personne. L'en-tête de la feuille fait 42 points au lieu de 34 pour porter cette ligne ; ces
8 points se prennent une fois sur la page, pas une fois par rangée.

Ajouter une journée, c'est une ligne dans `feriesDeLAnnee` plus son libellé (long et court)
dans les deux dictionnaires.

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
- `test/feries.test.js` — les dates des fériés, dont Pâques sur plusieurs années.
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
