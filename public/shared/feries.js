// Jours fériés et grosses journées — SOURCE UNIQUE, serveur ET navigateur.
//
// Pourquoi c'est dans l'horaire et pas dans un calendrier à côté : un férié se planifie à
// l'envers des autres semaines. Il faut plus de monde, pas moins, et la paie n'est pas la
// même. Un gérant qui monte sa semaine le mercredi ne va pas ouvrir un calendrier pour
// vérifier si le lundi suivant est la Journée des patriotes — il faut que la grille le dise
// d'elle-même, au moment où il place les quarts.
//
// Rien de tout ça n'est en base : une date de férié se CALCULE. Pâques tombe où elle tombe,
// la fête des Mères est le deuxième dimanche de mai, et ce sera encore vrai dans dix ans.
// Une table à remplir chaque année serait une table qu'on oublie de remplir.
//
// Toutes les journées marquées portent LA MÊME couleur, le rouge. Il y a eu une version à
// deux teintes — or pour les fériés, corail pour les grosses journées — et elle demandait au
// gérant de décoder une couleur avant de comprendre sa semaine. Une grille se lit d'un coup
// d'œil : une seule couleur dit « cette journée-là n'est pas ordinaire », et le NOM écrit en
// dessous dit laquelle. C'est le nom qui porte le détail, pas la teinte.
//
// Chaque journée garde quand même deux champs, parce que ce sont deux faits différents et
// qu'ils ne se déduisent pas l'un de l'autre :
//
//   type        « ferie » = la paie n'est pas la même (Loi sur les normes du travail, plus
//               la Fête nationale). « occasion » = la loi n'a rien à dire sur cette journée.
//   affluence   la salle va se remplir, donc il faut plus de monde au plancher.
//
// La fête des Mères remplit la salle sans être un férié. Le Vendredi saint est un férié sans
// être une grosse journée. L'Action de grâce est les DEUX. Seul `type` se voit encore, et
// seulement en mots : l'infobulle d'un férié ajoute « · férié ».

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Feries = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LIBELLES = {
    fr: {
      jourDeLAn: "Jour de l'An",
      vendrediSaint: "Vendredi saint",
      lundiPaques: "Lundi de Pâques",
      patriotes: "Journée des patriotes",
      feteDesMeres: "Fête des Mères",
      feteDesPeres: "Fête des Pères",
      saintValentin: "Saint-Valentin",
      dimanchePaques: "Dimanche de Pâques",
      feteNationale: "Fête nationale",
      feteDuCanada: "Fête du Canada",
      feteDuTravail: "Fête du Travail",
      actionDeGrace: "Action de grâce",
      noel: "Noël",
    },
    en: {
      jourDeLAn: "New Year's Day",
      vendrediSaint: "Good Friday",
      lundiPaques: "Easter Monday",
      patriotes: "National Patriots' Day",
      feteDesMeres: "Mother's Day",
      feteDesPeres: "Father's Day",
      saintValentin: "Valentine's Day",
      dimanchePaques: "Easter Sunday",
      feteNationale: "Québec National Holiday",
      feteDuCanada: "Canada Day",
      feteDuTravail: "Labour Day",
      actionDeGrace: "Thanksgiving",
      noel: "Christmas",
    },
  };

  // Dans une colonne de grille il n'y a pas la place d'écrire « Journée des patriotes ». Le
  // nom court n'est pas une abréviation paresseuse : c'est celui que le monde emploie.
  const COURTS = {
    fr: {
      jourDeLAn: "Jour de l'An",
      vendrediSaint: "Vendredi saint",
      lundiPaques: "Lundi de Pâques",
      patriotes: "Patriotes",
      feteDesMeres: "Fête des Mères",
      feteDesPeres: "Fête des Pères",
      saintValentin: "St-Valentin",
      dimanchePaques: "Pâques",
      feteNationale: "St-Jean",
      feteDuCanada: "Canada",
      feteDuTravail: "Fête du Travail",
      actionDeGrace: "Action de grâce",
      noel: "Noël",
    },
    en: {
      jourDeLAn: "New Year",
      vendrediSaint: "Good Friday",
      lundiPaques: "Easter Monday",
      patriotes: "Patriots' Day",
      feteDesMeres: "Mother's Day",
      feteDesPeres: "Father's Day",
      saintValentin: "Valentine's",
      dimanchePaques: "Easter",
      feteNationale: "St-Jean",
      feteDuCanada: "Canada Day",
      feteDuTravail: "Labour Day",
      actionDeGrace: "Thanksgiving",
      noel: "Christmas",
    },
  };

  // Ce qu'on ajoute à l'infobulle d'un férié. La couleur ne le dit plus — elle est la même
  // pour toutes les journées marquées — alors le mot le dit, là où il ne coûte pas un pixel
  // dans une colonne déjà étroite.
  const MENTION_FERIE = { fr: "férié", en: "holiday" };

  function estISO(valeur) {
    return typeof valeur === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valeur);
  }

  function deuxChiffres(n) {
    return n < 10 ? `0${n}` : String(n);
  }

  function iso(annee, mois, jour) {
    return `${annee}-${deuxChiffres(mois)}-${deuxChiffres(jour)}`;
  }

  // Tout le calcul de dates passe par UTC à midi. Une date construite en heure locale se
  // décale d'un jour dès qu'on change de fuseau ou d'heure avancée — et un férié décalé d'un
  // jour est pire que pas de férié du tout.
  function jourUTC(annee, mois, jour) {
    return new Date(Date.UTC(annee, mois - 1, jour, 12, 0, 0));
  }

  function isoDe(d) {
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  function decaler(d, jours) {
    return new Date(d.getTime() + jours * 86400000);
  }

  /**
   * Dimanche de Pâques (calendrier grégorien), algorithme de Meeus/Jones/Butcher.
   * C'est la seule date du lot qu'on ne peut pas décrire en une phrase : elle dépend de la
   * pleine lune. Vendredi saint et lundi de Pâques se déduisent d'elle.
   */
  function paques(annee) {
    const a = annee % 19;
    const b = Math.floor(annee / 100);
    const c = annee % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mois = Math.floor((h + l - 7 * m + 114) / 31);
    const jour = ((h + l - 7 * m + 114) % 31) + 1;
    return jourUTC(annee, mois, jour);
  }

  // Le n-ième jour de semaine d'un mois : « 2e dimanche de mai », « 1er lundi de septembre ».
  // jourSemaine suit getUTCDay : 0 = dimanche, 1 = lundi.
  function nieme(annee, mois, jourSemaine, n) {
    const premier = jourUTC(annee, mois, 1);
    const ecart = (jourSemaine - premier.getUTCDay() + 7) % 7;
    return decaler(premier, ecart + (n - 1) * 7);
  }

  // Le lundi qui précède une date donnée. La Journée des patriotes est « le lundi précédant
  // le 25 mai » : elle tombe donc toujours entre le 18 et le 24.
  function lundiPrecedant(annee, mois, jour) {
    const cible = jourUTC(annee, mois, jour);
    const recul = (cible.getUTCDay() + 6) % 7 || 7;
    return decaler(cible, -recul);
  }

  /**
   * Les journées marquées d'une année, en ordre de date.
   * @returns {Array<{date: string, cle: string, type: "ferie"|"occasion"}>}
   */
  function feriesDeLAnnee(annee) {
    const an = parseInt(annee, 10);
    if (!Number.isFinite(an)) return [];
    const p = paques(an);

    const liste = [
      { date: iso(an, 1, 1), cle: "jourDeLAn", type: "ferie", affluence: false, ferme: false },
      { date: iso(an, 2, 14), cle: "saintValentin", type: "occasion", affluence: true, ferme: false },
      // La loi laisse l'employeur choisir entre Vendredi saint et lundi de Pâques ; la
      // grille montre les deux et le gérant sait lequel son restaurant observe. En cacher un
      // ferait manquer le bon. Le dimanche entre les deux n'est pas un férié du tout, mais
      // c'est lui qui remplit la salle — d'où les trois journées d'affilée.
      { date: isoDe(decaler(p, -2)), cle: "vendrediSaint", type: "ferie", affluence: false, ferme: false },
      { date: isoDe(p), cle: "dimanchePaques", type: "occasion", affluence: true, ferme: false },
      { date: isoDe(decaler(p, 1)), cle: "lundiPaques", type: "ferie", affluence: false, ferme: false },
      { date: isoDe(lundiPrecedant(an, 5, 25)), cle: "patriotes", type: "ferie", affluence: false, ferme: false },
      { date: isoDe(nieme(an, 5, 0, 2)), cle: "feteDesMeres", type: "occasion", affluence: true, ferme: false },
      { date: isoDe(nieme(an, 6, 0, 3)), cle: "feteDesPeres", type: "occasion", affluence: true, ferme: false },
      { date: iso(an, 6, 24), cle: "feteNationale", type: "ferie", affluence: false, ferme: false },
      { date: iso(an, 7, 1), cle: "feteDuCanada", type: "ferie", affluence: false, ferme: false },
      { date: isoDe(nieme(an, 9, 1, 1)), cle: "feteDuTravail", type: "ferie", affluence: false, ferme: false },
      // La seule journée du lot qui est les deux à la fois : la paie change ET la salle se
      // remplit.
      { date: isoDe(nieme(an, 10, 1, 2)), cle: "actionDeGrace", type: "ferie", affluence: true, ferme: false },
      // `ferme` n'est pas une propriété du férié, c'est la politique du restaurant : le 25
      // décembre est la SEULE journée de l'année où il n'ouvre pas. Ça vit ici parce que
      // c'est ici qu'on décide quoi dire d'une journée ; si un jour vous ouvrez, c'est cette
      // ligne qu'on change.
      { date: iso(an, 12, 25), cle: "noel", type: "ferie", affluence: false, ferme: true },
    ];

    return liste.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Les années déjà calculées. Une grille redessine ses sept jours à chaque rendu, et un
  // rendu suit chaque clic : recalculer Pâques des dizaines de fois par seconde pour toujours
  // obtenir la même réponse ne sert à rien.
  const cache = {};
  function indexDeLAnnee(annee) {
    if (!cache[annee]) {
      cache[annee] = {};
      for (const f of feriesDeLAnnee(annee)) cache[annee][f.date] = f;
    }
    return cache[annee];
  }

  /**
   * La journée marquée qui tombe ce jour-là, s'il y en a une.
   * @param {string} dateISO  AAAA-MM-JJ
   */
  function ferieDuJour(dateISO) {
    if (!estISO(dateISO)) return null;
    return indexDeLAnnee(parseInt(dateISO.slice(0, 4), 10))[dateISO] || null;
  }

  function deISO(valeur) {
    return jourUTC(parseInt(valeur.slice(0, 4), 10), parseInt(valeur.slice(5, 7), 10), parseInt(valeur.slice(8, 10), 10));
  }

  // Le lundi de la semaine qui contient cette date. Les semaines d'horaire vont du lundi au
  // dimanche partout dans l'app ; celles-ci suivent, sinon une alerte ne tomberait pas sur
  // la même semaine que la grille qu'elle concerne.
  function lundiDe(dateISO) {
    const d = deISO(dateISO);
    const j = d.getUTCDay(); // 0 = dimanche
    return decaler(d, j === 0 ? -6 : 1 - j);
  }

  // Neuf jours avant le lundi de la semaine visée — donc toujours un SAMEDI.
  //
  // Ce n'est pas un chiffre choisi au hasard, c'est le cycle de commande du restaurant : la
  // commande se passe UNE FOIS PAR SEMAINE, la semaine d'avant. L'alerte doit donc être là
  // le samedi, la veille du dimanche où l'horaire de cette semaine-là se monte. Elle arrive
  // ainsi avant la commande, et il reste un lundi-au-samedi complet pour la passer.
  //
  // Une alerte qui sortirait « X jours avant le férié » se retrouverait tantôt avant, tantôt
  // après la commande, selon le jour de la semaine où tombe la fête. Celle-ci tombe toujours
  // au bon endroit du cycle.
  function samediDAlerte(lundiSemaineISO) {
    return isoDe(decaler(deISO(lundiSemaineISO), -9));
  }

  /**
   * Les alertes actives aujourd'hui : une par SEMAINE qui contient une ou plusieurs journées
   * marquées. Une semaine = une commande, donc une alerte — même si elle porte trois
   * journées, comme la semaine du Vendredi saint et du dimanche de Pâques.
   *
   * Deux alertes peuvent être actives en même temps : à la mi-décembre, la semaine de Noël
   * et celle du Jour de l'An se préparent en parallèle. Les deux sortent, dans l'ordre.
   *
   * @param {string} aujourdhuiISO
   * @returns {Array<{lundiISO, debutISO, finISO, journees}>}
   */
  /**
   * Les alertes actives aujourd'hui.
   *
   * `filtre` restreint les journées retenues. Il existe parce que deux portes posent deux
   * questions différentes sur les mêmes journées : la cuisine veut savoir quand COMMANDER
   * (toutes les journées marquées), la salle veut savoir quand il faudra PLUS DE MONDE
   * (seulement celles qui remplissent la salle). Le Vendredi saint regarde la première et
   * pas la seconde ; la fête des Mères, l'inverse.
   *
   * Le filtre s'applique AVANT le regroupement par semaine : sinon la fenêtre de la salle
   * s'arrêterait à la dernière journée marquée de la semaine plutôt qu'à sa dernière grosse
   * journée, et resterait ouverte après que l'affluence soit passée.
   */
  function alertes(aujourdhuiISO, filtre) {
    if (!estISO(aujourdhuiISO)) return [];
    const an = parseInt(aujourdhuiISO.slice(0, 4), 10);
    // L'année d'avant et celle d'après : une semaine à cheval sur le Nouvel An appartient à
    // l'année suivante, et son alerte sort en décembre.
    const brutes = [...feriesDeLAnnee(an - 1), ...feriesDeLAnnee(an), ...feriesDeLAnnee(an + 1)];
    const toutes = typeof filtre === "function" ? brutes.filter(filtre) : brutes;

    const parSemaine = new Map();
    for (const f of toutes) {
      const lundi = isoDe(lundiDe(f.date));
      if (!parSemaine.has(lundi)) parSemaine.set(lundi, []);
      parSemaine.get(lundi).push(f);
    }

    const actives = [];
    for (const [lundiISO, journees] of parSemaine) {
      const debutISO = samediDAlerte(lundiISO);
      // L'alerte s'arrête à la DERNIÈRE journée marquée de la semaine, pas à la fin de la
      // semaine : une fois le férié passé, « commande d'avance » ne veut plus rien dire.
      const finISO = journees[journees.length - 1].date;
      if (aujourdhuiISO >= debutISO && aujourdhuiISO <= finISO) {
        actives.push({ lundiISO, debutISO, finISO, journees });
      }
    }
    return actives.sort((a, b) => (a.lundiISO < b.lundiISO ? -1 : a.lundiISO > b.lundiISO ? 1 : 0));
  }

  function estFerie(fete) {
    return !!fete && fete.type === "ferie";
  }

  function mentionFerie(lang) {
    return MENTION_FERIE[lang === "en" ? "en" : "fr"];
  }

  function libelle(cle, lang) {
    return LIBELLES[lang === "en" ? "en" : "fr"][cle] || "";
  }

  function libelleCourt(cle, lang) {
    return COURTS[lang === "en" ? "en" : "fr"][cle] || libelle(cle, lang);
  }

  return {
    LIBELLES,
    paques,
    feriesDeLAnnee,
    estISO,
    ferieDuJour,
    lundiDe,
    samediDAlerte,
    alertes,
    estFerie,
    mentionFerie,
    libelle,
    libelleCourt,
  };
});
