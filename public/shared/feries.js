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
// Deux familles, et elles ne servent pas à la même chose :
//
//   « ferie »    les huit jours fériés du Québec (Loi sur les normes du travail, plus la
//                Fête nationale). Ils touchent la paie.
//   « occasion » une journée où la salle se remplit sans que la loi ait son mot à dire. La
//                fête des Mères est la plus grosse de l'année en restauration : c'est
//                précisément celle qu'on ne veut pas découvrir le vendredi d'avant.

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
      feteNationale: "St-Jean",
      feteDuCanada: "Canada Day",
      feteDuTravail: "Labour Day",
      actionDeGrace: "Thanksgiving",
      noel: "Christmas",
    },
  };

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
      { date: iso(an, 1, 1), cle: "jourDeLAn", type: "ferie" },
      // La loi laisse l'employeur choisir entre les deux ; la grille montre les deux et le
      // gérant sait lequel son restaurant observe. En cacher un ferait manquer le bon.
      { date: isoDe(decaler(p, -2)), cle: "vendrediSaint", type: "ferie" },
      { date: isoDe(decaler(p, 1)), cle: "lundiPaques", type: "ferie" },
      { date: isoDe(lundiPrecedant(an, 5, 25)), cle: "patriotes", type: "ferie" },
      { date: isoDe(nieme(an, 5, 0, 2)), cle: "feteDesMeres", type: "occasion" },
      { date: iso(an, 6, 24), cle: "feteNationale", type: "ferie" },
      { date: iso(an, 7, 1), cle: "feteDuCanada", type: "ferie" },
      { date: isoDe(nieme(an, 9, 1, 1)), cle: "feteDuTravail", type: "ferie" },
      { date: isoDe(nieme(an, 10, 1, 2)), cle: "actionDeGrace", type: "ferie" },
      { date: iso(an, 12, 25), cle: "noel", type: "ferie" },
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
    libelle,
    libelleCourt,
  };
});
