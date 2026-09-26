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
// Une journée marquée répond à DEUX questions, et il ne faut pas les confondre :
//
//   type        « ferie » = la paie n'est pas la même (Loi sur les normes du travail, plus
//               la Fête nationale). « occasion » = la loi n'a rien à dire sur cette journée.
//   affluence   la salle va se remplir, donc il faut plus de monde au plancher.
//
// Les deux sont indépendantes, et c'est tout l'intérêt. La fête des Mères remplit la salle
// sans être un férié. Le Vendredi saint est un férié sans être une grosse journée. Et
// l'Action de grâce est les DEUX : la paie change ET la salle est pleine. Un seul champ
// aurait forcé à choisir laquelle des deux vérités afficher — donc à en cacher une.

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

  // Ce qu'on écrit à côté du nom d'une journée qui est à la fois un férié et une grosse
  // journée. Sans ça, l'Action de grâce teintée « salle pleine » n'aurait plus rien qui
  // rappelle que la paie change ce jour-là.
  const MENTION_FERIE = { fr: "férié", en: "holiday" };

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
      { date: iso(an, 1, 1), cle: "jourDeLAn", type: "ferie", affluence: false },
      { date: iso(an, 2, 14), cle: "saintValentin", type: "occasion", affluence: true },
      // La loi laisse l'employeur choisir entre Vendredi saint et lundi de Pâques ; la
      // grille montre les deux et le gérant sait lequel son restaurant observe. En cacher un
      // ferait manquer le bon. Le dimanche entre les deux n'est pas un férié du tout, mais
      // c'est lui qui remplit la salle — d'où les trois journées d'affilée.
      { date: isoDe(decaler(p, -2)), cle: "vendrediSaint", type: "ferie", affluence: false },
      { date: isoDe(p), cle: "dimanchePaques", type: "occasion", affluence: true },
      { date: isoDe(decaler(p, 1)), cle: "lundiPaques", type: "ferie", affluence: false },
      { date: isoDe(lundiPrecedant(an, 5, 25)), cle: "patriotes", type: "ferie", affluence: false },
      { date: isoDe(nieme(an, 5, 0, 2)), cle: "feteDesMeres", type: "occasion", affluence: true },
      { date: isoDe(nieme(an, 6, 0, 3)), cle: "feteDesPeres", type: "occasion", affluence: true },
      { date: iso(an, 6, 24), cle: "feteNationale", type: "ferie", affluence: false },
      { date: iso(an, 7, 1), cle: "feteDuCanada", type: "ferie", affluence: false },
      { date: isoDe(nieme(an, 9, 1, 1)), cle: "feteDuTravail", type: "ferie", affluence: false },
      // La seule journée du lot qui est les deux à la fois : la paie change ET la salle se
      // remplit. C'est exactement le cas qui a fait naître le champ « affluence ».
      { date: isoDe(nieme(an, 10, 1, 2)), cle: "actionDeGrace", type: "ferie", affluence: true },
      { date: iso(an, 12, 25), cle: "noel", type: "ferie", affluence: false },
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
    if (typeof dateISO !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
    return indexDeLAnnee(parseInt(dateISO.slice(0, 4), 10))[dateISO] || null;
  }

  // La teinte suit l'AFFLUENCE, pas le statut légal : la couleur est là pour dire « monte
  // plus de monde ce jour-là », et c'est l'action qu'on veut déclencher en bâtissant
  // l'horaire. Un férié tranquille garde l'or, une grosse journée prend le corail.
  function teinte(fete) {
    if (!fete) return null;
    return fete.affluence ? "occasion" : "ferie";
  }

  // Vrai seulement pour une journée qui est les deux : sa teinte dit « salle pleine », donc
  // il faut autre chose pour rappeler que la paie change aussi.
  function rappelerFerie(fete) {
    return !!fete && fete.type === "ferie" && !!fete.affluence;
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
    ferieDuJour,
    teinte,
    rappelerFerie,
    mentionFerie,
    libelle,
    libelleCourt,
  };
});
