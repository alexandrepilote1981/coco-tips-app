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
public/shared/code-acces.js  lit le code dans l'adresse, en tolérant un lien abîmé en chemin
public/shared/secteurs.js  qui travaille où ; c'est le POSTE d'un quart qui dit son secteur
public/shared/horaire-mise-en-page.js  mise en page de la feuille — dessinée en PDF et en image
public/shared/horaire-image.js  export de la feuille en PNG (surface canvas)
public/shared/cout-main-oeuvre.js  masse salariale d'une semaine (cuisine seulement)
public/shared/absences.js  congés et vacances : plages, conflits, mise en forme des dates
public/shared/disponibilites.js  l'habitude déclarée par chaque employé, et ses accrocs
public/shared/feries.js    fériés du Québec et grosses journées de restaurant — calculés, pas saisis
public/shared/alerte-ferie.js  la fenêtre qui rappelle la commande avant un férié
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

Chaque employé — **de cuisine comme de salle** — peut porter un **plafond d'heures par
semaine** (`employees.heures_max`, 0 = aucun plafond). Quand la semaine cédulée le dépasse, toute la
rangée de la personne rougit dans la grille, et ses heures s'écrivent sous son nom sous la
forme `24 h / 20 h`. Les heures s'affichent pour toute la grille et pas seulement pour ceux
qui ont un plafond : sinon les rangées n'auraient pas la même hauteur. Être pile au plafond
n'est pas un dépassement.

**Le défaut est 40 h**, et c'est la paie qui le dicte : au-delà de 40 h dans une semaine, les
heures se paient en temps supplémentaire. Tomber dedans sans s'en apercevoir coûte de
l'argent, alors « aucun plafond » (0) devient l'exception qu'on choisit. Les employés déjà en
place y sont passés par une migration marquée dans `PRAGMA user_version` — **une seule fois** :
sans ce garde, quelqu'un qu'on remet volontairement à 0 repasserait à 40 h au prochain
redéploiement et le réglage ne tiendrait jamais.

**Le plafond est un total par NUMÉRO d'employé**, pas par fiche. Quelqu'un inscrit des deux
bords a deux fiches ; son 20 h de visa ne se divise pas en deux. Le serveur recopie donc la
valeur sur toutes les fiches du même numéro (`ecrirePlafondSurToutesSesFiches`), en se servant
du numéro qui vient d'être enregistré et non de l'ancien — sinon changer le numéro et le
plafond du même coup écrirait sur les fiches de quelqu'un d'autre. Côté grille, `plafondDe()`
retient le plus PETIT plafond non nul parmi ses fiches, pour les données antérieures à cette
règle : un plafond de visa est une limite légale, et se tromper vers le haut la ferait
dépasser en silence.

**Le plafond compte les heures des DEUX équipes.** Dans les mots du propriétaire : « si un
employé dit qu'il peut faire 20 h, c'est 20 h total, c'est souvent des restrictions de visa
étudiant, et le reste est indiqué à 40 h vu que je veux pas payer de overtime ». Un plafond
porte donc sur la PERSONNE, pas sur un poste : une limite de visa ne se divise pas entre la
cuisine et la salle, et l'overtime non plus.

Ça oblige chaque grille à connaître des heures qu'elle n'affiche pas. Une porte par code ne
reçoit que les quarts de son secteur ; le serveur lui envoie donc, à côté, `heuresAilleurs` —
`{employee_id, date, heures}` et rien d'autre, seulement pour les employés `les_deux`. La
porte apprend que la personne a travaillé 7 h ailleurs ce jour-là, jamais ce qu'elle y
faisait. Sans ça, quelqu'un à 15 h de cuisine et 16 h de salle s'affichait « 15 h / 20 h »,
en vert, alors qu'il était à 31 h — et on lui ajoutait un quart en croyant qu'il restait de
la place.

La barre du haut, elle, reste à 15 h : c'est la masse salariale de la CUISINE, des heures
qu'on multiplie par un taux. Les deux chiffres ne mesurent pas la même chose — l'un est un
budget, l'autre est une personne.

Les heures et les montants sont deux permissions séparées (`avecHeures` et `voitMontants`
dans `renderWeekGrid`). Le tableau de bord montre les heures de la salle sans lui inventer de
masse salariale ; le lien de salle, partagé à toute l'équipe, n'en montre aucune — « 15 h /
20 h » sur la rangée de quelqu'un dirait à ses collègues qu'il est limité, et pourquoi.

La page d'un EMPLOYÉ n'en reçoit pas non plus (`ficheEmploye()`), et ce n'est pas pour le
protéger de lui-même : c'est sa fiche, ouverte avec son code, et personne n'y voit le taux
d'un collègue. Mais sa page ne les a jamais affichés — ils partaient parce que la requête
fait `SELECT *`, donc chaque colonne ajoutée à la table se mettait à voyager toute seule.
Un lien personnel se fait suivre plus souvent qu'on pense.

Les taux horaires et les plafonds ne sont jamais envoyés aux portes qui n'y ont pas droit — ils ne sont pas
seulement cachés à l'écran. Voir `porteParCode()` dans `server.js`, couvert par
`test/portes-horaire.test.mjs`.

## Travailler des deux bords

Certaines personnes font la cuisine ET la salle. Un employé porte donc un `secteur` qui vaut
`salle`, `cuisine` ou **`les_deux`**, et `public/shared/secteurs.js` tient toute la règle.

### Le changement de règle, et pourquoi il fallait le faire

Partout, le secteur d'un QUART se déduisait du secteur de la PERSONNE : les requêtes
filtraient sur `e.secteur`, la page employé décidait d'afficher l'heure de fin d'après
`employee.secteur`. Tant qu'une personne n'était que d'un bord, les deux revenaient au même.

Dès qu'elle est des deux, ils se séparent — et **c'est le QUART qui a raison**. Une serveuse
qui fait un midi à la plonge ne devient pas plongeuse ; c'est ce quart-là qui est en cuisine.
Le poste du quart le disait déjà : `Secteurs.duRole()` le lit, et plus rien ne devine.

Ce que ça règle du même coup, sans rien ajouter :

- le lien du gérant de cuisine ne reçoit que les quarts de cuisine, **même ceux d'un employé
  mixte** — un quart de salle ne fuit pas vers une porte qui n'y a pas droit ;
- la masse salariale ne compte que les heures de cuisine, parce qu'un quart de salle n'a pas
  d'heure de fin ;
- **« effacer la semaine » n'efface que les quarts de SA grille.** C'est le piège du lot :
  un effacement en lot n'a aucune annulation possible, et filtrer sur le secteur de la
  personne aurait emporté les quarts de salle d'un employé mixte sans que personne ne s'en
  aperçoive avant le service. Vérifié dans `test/portes-horaire.test.mjs`.

Un poste inconnu compte comme **salle**, jamais comme cuisine : se tromper vers la salle fait
apparaître un quart au mauvais endroit, se tromper vers la cuisine le ferait entrer dans un
calcul d'argent.

### Deux façons d'être des deux bords, et pourquoi les deux existent

`les_deux` sur **une seule fiche** est la façon la plus propre : un code, un lien, un
plafond, rien à rapprocher.

Mais le propriétaire travaille autrement, et c'est sa demande explicite : « il faut en créer
2, sinon la cuisine voit pas son nom dispo pour horaire… je veux que la personne soit
indiquée dans les 2, et toi tu fais les horaires perso en fonction de la collecte d'info des
numéros d'employé. » Une fiche par équipe, **le même matricule de paie sur les deux**.

`fichesDeLaMemePersonne()` dans `server.js` réunit donc les fiches par
`employee_number`, et `/api/employee/:code/shifts` rend les quarts de toutes. Les deux liens
de la personne donnent alors le MÊME horaire complet, et sa page l'écrit sous la bande —
sans cette ligne, voir apparaître des quarts qu'on n'a jamais reçus par ce lien-là ressemble
à une erreur.

**Trois bornes, parce qu'un rapprochement qui se trompe montre à quelqu'un l'horaire d'un
autre :** jamais sur un numéro vide (sinon toutes les fiches sans matricule n'en feraient
qu'une), jamais entre deux restaurants (deux commerces numérotent à partir de 1), et sur le
texte exact du numéro. Les quatre cas sont dans `test/portes-horaire.test.mjs`.

Le plafond d'heures suit la même règle : `heuresAilleursDe()` couvre les DEUX façons — les
quarts de l'autre équipe sur une fiche `les_deux`, et tout ce que fait la fiche jumelle.
Sans ça, chaque fiche resterait sous son plafond pendant que la personne le double.

Ce qui reste vrai avec deux fiches, et qu'il faut savoir : deux codes, deux liens, et les
déclarations de pourboires vivent sur la fiche de SALLE.

### Ce que ça donne à l'écran

Un employé `les_deux` apparaît dans les DEUX listes du tableau de bord et les DEUX grilles,
avec une marque « Les deux » sur sa fiche — sans elle, le voir deux fois se lirait comme un
doublon. Son secteur se change par un menu à trois choix plutôt que par les anciens boutons
« → Cuisine » / « → Salle », qu'il aurait fallu multiplier.

Sur **sa page à lui**, une seule bande d'horaire porte ses deux sortes de quarts : chacun
s'affiche d'après SON poste, donc un quart de cuisine montre `05:30 → 15:00` et un quart de
salle montre `16:00` tout court. La bande montre TOUS les quarts d'une journée et non le
premier trouvé : quelqu'un peut faire la cuisine le matin et la salle le soir, et n'en
montrer qu'un se lirait comme un quart annulé.

Et il **garde son formulaire de déclaration** (`Secteurs.declarePourboires()`) : seule la
cuisine PURE n'en a pas. Quelqu'un qui met le pied sur le plancher fait des pourboires.

### Les liens personnels

Le lien du gérant de cuisine porte les codes d'accès de son équipe, **employés mixtes
compris** — demande explicite du propriétaire : « je veux que les gérants soient en mesure de
distribuer les liens perso des employés ».

Le lien de la SALLE, lui, n'en reçoit toujours aucun, et c'est une décision, pas un oubli :
la cuisine a deux liens (gérant et lecture), la salle n'en a qu'un, partagé à toute l'équipe.
Y mettre les codes donnerait à chaque serveuse la page de ses collègues, pourboires déclarés
compris. Le propriétaire a tranché : « le code gérant salle doit pouvoir juste gérer
l'horaire, je vais gérer par mon code admin perso ».

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

## Disponibilités

`public/shared/disponibilites.js`. Ce que ça répond : « le lundi je peux rentrer à 5h30, le
mardi pas avant 9h, le jeudi pas pantoute ».

C'est **l'habitude** d'une personne, pas sa semaine. Elle la remplit une fois sur son lien
personnel et n'y retouche presque jamais — un formulaire à remplir chaque semaine, personne
ne le remplit, et au bout d'un mois la grille est à moitié vide. Les **congés** servent aux
exceptions. L'un dit la règle, l'autre dit l'exception, et les deux ne se marchent pas sur
les pieds.

Une ligne par jour de semaine (0 = lundi), trois états : pas disponible, toute la journée
(heures vides), ou une plage. La case « toute la journée » existe parce que c'est le cas de
la majorité : sans elle, il faudrait choisir deux heures sept fois pour dire « je suis
toujours là ».

### La règle à ne pas casser

**Une disponibilité n'interdit rien.** Un samedi matin où quelqu'un lâche, le gérant appelle
la personne qui avait écrit « pas le samedi » et elle dit oui pour cette fois. Si l'app
bloquait, il faudrait aller modifier sa disponibilité déclarée pour pouvoir la placer — donc
falsifier ce qu'elle a dit, juste pour contourner l'app. Et une disponibilité vieillit : une
session de cours finit, personne ne met à jour.

La grille **avertit** : la case pâlit, et à l'enregistrement d'un quart en accroc une
question sort — « Marie Tremblay a indiqué ne pas être disponible le mercredi. L'ajouter
quand même ? ». La même question sort pour un **congé**, qui est plus fort qu'une
disponibilité générale ; ce serait bizarre d'avertir pour le petit et pas pour le gros.

La question se pose **à l'enregistrement, pas au clic** : tant que l'heure n'est pas choisie,
on ne peut pas savoir s'il y a un accroc. Une seule règle, un seul moment.

### Déjà cédulé de l'autre bord

Troisième cas, né de « les deux » : la grille de cuisine ne montre pas les quarts de salle et
l'inverse, donc **rien à l'écran ne dit qu'on inscrit quelqu'un deux fois le même jour**.
Enregistrer un quart pendant qu'il y en a déjà un dans l'autre équipe sort la question
« Noémie a déjà un quart dans l'autre équipe le 28 septembre (9,5 h). L'ajouter quand même ? »

L'ordre des trois questions n'est pas arbitraire — **congé, puis double quart, puis
disponibilité**. Un congé veut dire que la personne ne rentre pas du tout, dans aucune des
deux équipes ; un double quart est un fait de CETTE semaine ; une disponibilité n'est qu'une
habitude. On ne pose qu'une question à la fois, la plus forte.

Comme les deux autres, elle n'interdit rien : un 05:30-15:00 en cuisine puis un souper en
salle, ça arrive. `quartsAilleursLeMemeJour()` lit les quarts que la grille a déjà plus les
`heuresAilleurs` des portes par code, et ne compte évidemment pas comme un double le quart
qu'on est en train de modifier.

**Et il faut réunir les fiches jumelles**, sinon l'avertissement ne sort jamais dans le cas
le plus courant. Rapporté ainsi : « Try était cédulée mardi cuisine. Je l'ai ajoutée
serveuse et ça rien fait. » Ses deux fiches portent le même matricule mais ont deux id
différents, et la grille ne cherchait que l'id de la fiche ouverte — le quart de mardi vivait
sur l'autre.

`autresFichesDe()` retrouve les fiches de même numéro dans l'effectif que le host expose. Ça
ne marche que là où l'effectif COMPLET est connu, c'est-à-dire le tableau de bord ; une porte
par code ne reçoit que son secteur, et c'est le serveur qui lui envoie `heuresAilleurs`. Les
deux chemins ne se recouvrent jamais, donc rien n'est compté deux fois. Le plafond d'heures
passe par la même fonction, pour la même raison.

### Le défaut, et « qui n'a jamais répondu »

Sans aucune ligne en base, la personne est **disponible partout**. Quelqu'un qui n'a jamais
ouvert sa page n'est donc jamais barré ni questionné.

Du coup « a dit oui à tout » et « n'a jamais ouvert la page » donneraient la même
disponibilité effective. On les distingue par l'**existence** des lignes (`aRepondu`), pas
par leur contenu — c'est ce qui permet d'afficher au gérant la liste de ceux qu'il reste à
relancer, au-dessus de la grille.

### Ce qui n'est PAS marqué

La **pâleur** plutôt qu'une couleur : la grille porte déjà les congés, les fériés, les
rangées rouges du plafond d'heures et les conflits. Une cinquième couleur en ferait un arbre
de Noël. La pâleur est un canal encore libre.

Et **rien sur la feuille imprimée**. « Placé malgré sa disponibilité » est une affaire entre
le gérant et la personne, pas une affaire de babillard.

### Le gérant distribue les liens

Les disponibilités ne servent à rien si personne ne reçoit son lien. Le lien du **gérant de
cuisine** porte donc une section dépliante « Liens de l'équipe » : chaque cuisinier, son lien
personnel, un bouton Copier, et une pastille « pas rempli » pour ceux qu'il reste à relancer.

C'est la SEULE porte qui reçoit les `access_code`, et c'est délibéré :

- **pas le lien de lecture des cuisiniers** — n'importe quel cuisinier pourrait sinon ouvrir
  la page d'un collègue et changer ses disponibilités à sa place ;
- **pas le côté salle** — le gérant n'y a pas accès (décision du propriétaire), et la page
  d'une serveuse montre ses pourboires déclarés. Un code d'accès EST la clé de la page de
  quelqu'un : le donner, c'est donner ce qu'il y a derrière.

Le serveur n'envoie les codes qu'à cette porte (`avecCodes()` dans `server.js`) ; la page ne
décide de rien, elle affiche la section seulement si les codes sont arrivés. Couvert par
`test/portes-horaire.test.mjs`, qui vérifie aussi qu'aucun code ne traîne dans le texte brut
des autres portes.

### La page d'un employé, allégée

Elle portait un bandeau de quatre totaux de période — ventes, pourboires nets, % moyen,
moyenne par client. **Retiré à la demande du propriétaire** : l'équipe ne s'en servait pas et
ça alourdissait l'écran. Le détail n'est pas perdu pour autant, chaque carte de journée porte
déjà ses ventes, ses clients, son % et son net.

Le bouton **Message** est monté dans l'en-tête, à côté du bouton de langue : c'est ce que
l'équipe cherche en premier.

Le **sélecteur de période** (2 semaines / 30 jours / Tout) est parti avec les totaux : il ne
servait qu'à les cadrer. Ce qui limite la longueur de la page, maintenant, c'est l'**état**
de la journée :

- **« À envoyer (n) »** — les journées non envoyées, ouvertes. C'est le travail à faire.
- **« Déjà envoyées (n) »** — repliées dans une section qu'on déplie au besoin.

Replié veut dire **non construit** : les cartes de la section fermée ne sont pas créées du
tout. Après un an, ça fait trois cents cartes avec leurs champs — les bâtir pour rien à
chaque ouverture rendrait l'app lente sur un téléphone. Mesuré sur douze journées envoyées :
1 594 px de page repliée contre 7 146 px dépliée, et zéro carte construite tant que c'est
fermé.

Une journée envoyée ou modifiée pendant la visite **ne saute pas** d'une section à l'autre
sous le doigt : le déplacement se fait au prochain rendu. Une carte qui disparaît à l'instant
où on tape « Envoyer » est désorientante.

### Les fiches d'employé sont repliées

Chaque fiche ne montre d'abord qu'une ligne : le **nom** à gauche, l'**argent** à droite — le
pourboire net, et le montant en attente quand il y en a un. Le reste (code, lien, secteur,
plafond, chiffres, tableau par jour) s'ouvre d'une tape.

Pourquoi : l'onglet Déclarations faisait **10,6 écrans de téléphone** avec dix-huit
personnes, et les onglets n'y changeaient rien — ils avaient réglé le TRAJET, pas la
longueur. Ce qu'on vient y chercher est presque toujours UNE personne.

Le résumé de la ligne repliée n'est pas décoratif : c'est ce qu'on parcourt du pouce. Les
montants ne rétrécissent jamais (`flex: 0 0 auto`), un nom long s'ellipse plutôt que de les
pousser hors de l'écran.

**Le piège qu'il fallait fermer d'abord**, et c'est le propriétaire qui l'a vu : « quand je
reçois une alerte d'argent, ça m'amène direct à la bonne place ? » Les pastilles des bandeaux
sautent à une personne ou à une journée. Sur une fiche repliée, le clic aurait amené sur une
ligne fermée — ce qui se lit comme un bouton qui ne fait rien. `ouvrirEtSauter()` déplie
d'abord, redessine, ET ENSUITE défile : après un `render()` tous les nœuds sont neufs, et
une référence prise avant ne pointerait plus sur rien.

L'état vit dans `fichesOuvertes` au niveau du module, comme `fichesEnEdition` — et une fiche
en cours de modification est forcément dépliée (`ficheOuverte()`). La replier referme aussi
son édition : faire disparaître une saisie sans rien dire serait pire.

### Qui apparaît dans la liste des déclarations

`equipeSalle` ramasse les gens de salle, les mixtes — **et quiconque a déjà déclaré une
journée**, quel que soit son secteur actuel. Ce dernier cas est de l'argent, pas une
coquetterie.

Déplacer une serveuse vers la cuisine la sortait de la liste, mais ses déclarations restent
en base — donc sa pastille aussi, dans le bandeau des virements dus. La pastille pointait
alors vers une fiche qui n'existait plus : le clic ne faisait rien, et le montant dû ne
pouvait **plus jamais** être marqué comme viré. Un bandeau qui réclame de l'argent doit
toujours mener quelque part.

Les bandeaux eux-mêmes se construisent à partir de `e.entries`. Un cuisinier ne déclare rien,
n'a donc aucune entrée, et ne peut donc produire aucune pastille — remplir la cuisine n'en
crée pas une seule.

### Corriger un nom ou un numéro

Chaque fiche porte un bouton **Modifier** qui ouvre deux champs : le nom et le numéro
d'employé. Ça n'existait nulle part — le numéro se saisissait à la création et plus jamais,
le nom pas du tout, et la cuisine n'avait même pas de champ numéro.

Ce que ça évite vaut plus que le champ lui-même : pour corriger une faute de frappe, il
fallait **retirer la personne et la recréer**, ce qui lui donnait un nouveau `access_code` et
cassait le lien qu'elle avait déjà reçu. `test/ui-smoke.test.mjs` vérifie donc surtout que le
code ne bouge pas.

Un nom vidé est refusé à l'écran : le serveur garderait l'ancien, mais laisser croire que
c'est passé est pire que de le dire. Le numéro est borné à 20 caractères (`numeroValide()`),
parce que c'est un matricule de paie et qu'un copier-coller malheureux ferait déborder la
fiche et la grille.

L'état des fiches ouvertes vit dans `fichesEnEdition` au niveau du module : `render()`
reconstruit toute la page, et un attribut posé sur un nœud ne survivrait pas au premier
rafraîchissement — la saisie en cours serait perdue. La fiche ne se referme qu'après un
enregistrement réussi, sinon une coupure réseau ferait croire que la correction est passée.

### La page d'un cuisinier

`employee.html` connaît maintenant le secteur : un cuisinier n'y voit ni ventes, ni
pourboires, ni bouton « Ajouter » — seulement son horaire, ses disponibilités et sa
messagerie. Les codes d'accès existaient déjà pour tout le monde ; c'est le tableau de bord
qui ne montrait pas le lien des cuisiniers, et la page qui leur présentait un formulaire de
pourboires n'ayant aucun sens pour eux.

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

## L'alerte de commande avant un férié

Le problème, dans les mots du gérant : « pendant nos fériés, les horaires de livraison de nos
fournisseurs peuvent changer… si on manque de bananes, nous sommes dans la schnoutte! »

L'app **ne sait pas** si Dufour & Fils est fermé le lundi — personne ne le lui a dit. Elle ne
répond donc pas à la question. Ce qu'elle fait, c'est s'assurer que la question se POSE à
temps : l'oubli visé n'est pas « je ne savais pas », c'est « j'ai pas pensé à vérifier ».

### Le moment, et pourquoi il n'est pas négociable

`Feries.alertes(aujourdhui)` rend une alerte **par semaine** qui contient une ou plusieurs
journées marquées. Elle sort le **samedi, neuf jours avant le lundi de cette semaine-là**.

Ce n'est pas un délai choisi au hasard, c'est le cycle du restaurant : **la commande se passe
une fois par semaine, la semaine d'avant**. Le samedi, c'est la veille du dimanche où
l'horaire de la semaine de commande se monte — l'alerte est donc déjà à l'écran quand le
gérant s'assoit pour bâtir cette semaine, et il lui reste un lundi-au-samedi complet pour
commander. Une alerte qui sortirait « X jours avant le férié » tomberait tantôt avant, tantôt
après la commande, selon le jour où tombe la fête.

Elle s'arrête à la dernière journée marquée de la semaine, pas à la fin de la semaine : une
fois le férié passé, « commande d'avance » ne veut plus rien dire.

Une semaine = une commande = une alerte, même si elle porte trois journées. Le regroupement
tombe donc juste tout seul : le Vendredi saint et le dimanche de Pâques partagent une alerte,
le lundi de Pâques a la sienne une semaine plus tard, parce qu'il relève d'une autre commande.

### Ce qu'il ne faut pas défaire

- Elle **réapparaît à chaque ouverture de l'app** tant que le férié n'est pas passé. Pas de
  « ne plus afficher », pas de cases à cocher qui la font taire. Une alerte qu'on peut
  éteindre pour de bon, c'est une alerte qu'on éteint le samedi et qu'on oublie le jeudi.
- **Aucun son.** Jamais. C'est une demande explicite du propriétaire.
- Un seul gros bouton FERMER, pleine largeur — on le cherche sur un téléphone, d'une main, à
  cinq heures du matin.

### Ce qu'elle dit

Trois messages, composés à partir des faits de la journée (`type`, `affluence`, `ferme`) :
fournisseurs peut-être fermés → commande d'avance ; salle pleine → prévois le stock ;
restaurant fermé (le 25 décembre, seule journée de fermeture) → la commande doit couvrir
jusqu'à la réouverture. L'Action de grâce en donne deux à la fois.

### Les rappels

`restaurants.rappels_ferie`, du texte libre, une ligne par rappel (« Appeler Dufour & Fils »).
Écrit une fois, réaffiché à chaque alerte. C'est du texte et pas une table parce que ce sont
trois ou quatre phrases qu'on ne trie ni ne compte jamais. Ça s'écrit depuis la fenêtre
elle-même — la liste vit là où elle sert.

Seuls **`/admin` et le lien du gérant de cuisine** voient la fenêtre et écrivent les rappels :
ce sont les deux qui commandent. C'est le **serveur** qui refuse les autres portes (403), pas
la page — `porteGerant()` dans `server.js`, couvert par `test/portes-horaire.test.mjs`.

## Le tableau de bord, en trois onglets

`/admin` était une seule page. Avec une équipe de 12 en salle et 6 en cuisine, elle faisait
**onze écrans de téléphone** : la grille d'horaire de la cuisine commençait à 8 241 px du
haut, soit près de dix écrans de défilement pour l'atteindre — à refaire chaque fois qu'on
monte une semaine.

Trois onglets, collés en haut : **Déclarations**, **Horaire salle**, **Horaire cuisine**.
Mesuré sur la même équipe : 1,6 écran pour l'horaire de salle, 1,4 pour celui de la cuisine.

**Des onglets et non des raccourcis vers des ancres.** Un raccourci laisserait la page
longue, et une fois au fond d'une grille il faudrait remonter tout en haut pour changer de
section. La barre est `position: sticky` pour la même raison : c'est elle qui règle le
problème, pas les icônes.

Deux choix qui ne sont pas cosmétiques :

- la **pastille rouge** sur Déclarations compte les journées en retard et les virements dus.
  Les bandeaux d'alerte vivent maintenant dans un onglet qu'on n'ouvre plus tous les jours ;
  sans la pastille, une semaine passée dans l'horaire de la cuisine les ferait manquer.
- l'**onglet actif** est gardé dans `localStorage` (`coco-onglet-admin`). Un gérant qui monte
  son horaire rafraîchit vingt fois ; le renvoyer aux déclarations à chaque fois lui coûterait
  le trajet à refaire. En revanche, CHANGER d'onglet remet le défilement à zéro — `render()`
  restaure la position, ce qui est juste pour un rafraîchissement et faux pour une section
  neuve.

**Le piège à ne pas rouvrir** : les écouteurs des déclarations (période, export, sauvegarde,
ajout de restaurant, messagerie) sont sous un `if (onglet === "declarations")`. Sans ce garde,
ouvrir un horaire lèverait sur le premier `getElementById` venu et laisserait la page à moitié
branchée — les grilles s'afficheraient sans répondre au doigt. Couvert par
`test/ui-smoke.test.mjs`, qui revient aux déclarations et vérifie qu'un bouton de période
répond encore.

**Le découpage suit le SENS, pas l'ancienne disposition.** Le premier essai avait déplacé
les deux grilles et laissé tout le reste où il était — l'équipe de cuisine, ses liens, ses
taux, ses plafonds et les charges de l'employeur restaient donc dans l'onglet des
déclarations. La cuisine ne déclare rien : tout ce qui la concerne vit avec son horaire, et
les charges y nourrissent la masse salariale affichée juste au-dessus. La salle, elle, reste
dans Déclarations, parce que ses cartes SONT les déclarations. Vérifié dans
`test/ui-smoke.test.mjs`, dans les deux sens : présent dans l'onglet cuisine, absent des
déclarations.

L'onglet Déclarations reste long (8,6 écrans) : c'est la liste des employés de salle, pas la
navigation. Un repli par employé reste à faire si le besoin revient.

## Accès et authentification

Cinq portes d'entrée, sans compte utilisateur :

- **Employé** : `/e/<access_code>` — code de 6 caractères, aucun mot de passe. Le code sert
  de jeton pour tous les appels `/api/employee/<code>/…`.

  Le code se lit par `CodeAcces.depuisChemin()` et **jamais** par un `split("/").pop()`. Ça
  vient d'un vrai incident : des employées recevaient « Code invalide » avec un code
  parfaitement bon, parce que le lien arrivait avec une barre oblique au bout et que le
  dernier morceau du chemin était vide. Une espace, un `%20` ou un point collé à la fin
  faisaient pareil. On rogne donc les extrémités — mais **jamais le milieu** : réparer
  « AB-C234 » en « ABC234 » ouvrirait la page de quelqu'un d'autre.
- **Gérant** : `/admin`, protégé par `ADMIN_PASSWORD`. Le jeton est le mot de passe lui-même,
  gardé dans `sessionStorage` sous `adminToken` et envoyé en en-tête `X-Admin-Token`.
- **Horaire salle** : `/horaire/<schedule_code>` ou `/horaire` avec `SCHEDULE_PASSWORD` —
  donne l'horaire sans jamais exposer les montants.
- **Horaire cuisine, gérant** : `/horaire/<schedule_code_cuisine>` — modifie l'horaire de la
  cuisine, montre les salaires, et reçoit les **codes d'accès personnels de la cuisine** pour
  que le gérant distribue les liens à son équipe. Ce lien ne se partage pas à l'équipe.
- **Horaire cuisine, cuisiniers** : `/horaire/<schedule_code_cuisine_lecture>` — le même
  horaire en lecture seule, sans un montant. C'est ce lien qu'on envoie dans le groupe.

`rate-limit.js` ne compte que les échecs : rafraîchir une page avec un code valide n'est
jamais pénalisé, enchaîner des codes faux l'est. C'est ce qui rend un code de 6 caractères
acceptable ; ne pas affaiblir ce principe.

**Un message d'erreur ne doit jamais mentir sur sa cause.** Les pages à code affichaient
« Code invalide » pour TOUTE erreur — y compris un 429 du plafond de tentatives. Une employée
au code parfaitement valide lisait donc « Vérifie le lien reçu », recommençait, et faisait
chercher pendant une heure un problème de code qui n'existait pas. `api()` transporte
maintenant le statut HTTP sur l'erreur (`erreur.statut`), et `renderErreurAcces()` distingue
trois cas : **429** → « Trop de tentatives » avec le délai, **404** → « Code invalide » avec
le code lu, **le reste** → « Connexion impossible ». Verrouillé par le dernier test de
`test/ui-smoke.test.mjs` — qui doit rester le dernier du fichier, puisqu'il bloque
volontairement 127.0.0.1 pour quinze minutes.

**Le piège du WiFi partagé.** Le compte se fait par adresse Internet, et toute l'équipe d'un
restaurant partage la même. Dix codes faux en quinze minutes bloquaient donc tout le monde,
codes valides compris. Deux mécaniques corrigent ça sans rien céder :

- **Seuls les codes DISTINCTS comptent.** Une employée dont Messenger a coupé le lien en deux
  réessaie huit fois le même mauvais code : un échec, pas huit. Une force brute change de
  code à chaque coup, donc elle atteint le plafond aussi vite qu'avant.
- **Un code déjà utilisé avec succès depuis cette adresse passe toujours** (`noteSuccess` /
  `estConnu`), même pendant un blocage. Ça ne donne rien à un attaquant : pour qu'un code soit
  « connu » de son adresse, il faut qu'il l'ait déjà utilisé — donc qu'il l'ait déjà.

Les deux portes par code (`/api/employee/:code`, `/api/schedule/by-code/:code`) vérifient donc
le code AVANT de regarder le compteur, puis appellent `noteSuccess` ou `noteFailure`. Les deux
portes par mot de passe gardent le `guard()` en middleware : il n'y a rien à vérifier avant
d'essayer un mot de passe.

**Ce qu'il ne faut surtout pas faire** : laisser passer un code valide pendant un blocage sans
la mémoire des codes connus. Répondre 200 pour un bon code et 429 pour un mauvais, c'est offrir
un « oui / non » à volonté, et le plafond ne sert plus à rien. Pendant un blocage, un code
inconnu reçoit toujours la même réponse, quel qu'il soit — vérifié dans
`test/verrou-codes.test.mjs`.

La limite assumée : quelqu'un qui ouvre son lien pour la **première** fois pendant que son WiFi
est bloqué doit attendre la fin du blocage.

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
- `test/feries.test.js` — les dates des fériés (dont Pâques sur plusieurs années) et le
  moment où l'alerte de commande sort.
- `test/disponibilites.test.js` — le défaut, la détection d'accroc, et la différence entre
  « a dit oui à tout » et « n'a jamais répondu ».
- `test/portes-horaire.test.mjs` — les cinq portes sur le vrai serveur HTTP. C'est ici qu'on
  vérifie qu'aucun salaire ne sort vers une porte qui n'y a pas droit.
- `test/code-acces.test.js` — chaque façon dont un lien s'abîme en chemin, et la limite
  volontaire : un lien abîmé au milieu est refusé, pas deviné.
- `test/secteurs.test.js` — le secteur d'un quart se lit sur son poste, « les deux » est des
  deux équipes, et un poste inconnu penche toujours vers la salle.
- `test/rate-limit.test.js` — la mécanique du plafond, chaque test sur son propre guichet.
- `test/verrou-codes.test.mjs` — la promesse vécue par une employée : mon lien marche-t-il ?
  C'est ici qu'on vérifie qu'un WiFi bloqué ne ferme pas la porte à quelqu'un dont le code
  est bon, et qu'il la ferme quand même à qui essaie de deviner.
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
