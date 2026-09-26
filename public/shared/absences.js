// Congés et vacances — SOURCE UNIQUE, utilisée par le serveur ET par le navigateur.
//
// À quoi ça sert : poser d'avance les congés demandés et les semaines de vacances, pour ne
// pas les oublier en montant l'horaire. Une liste qu'on consulte ne suffit pas — personne ne
// va la relire à chaque quart. Ce qui compte, c'est que la grille le dise elle-même au
// moment où on place quelqu'un.
//
// Une absence est une PLAGE, pas une date : une semaine de vacances est une seule entrée, pas
// sept. Une journée de congé est simplement une plage dont les deux bouts sont le même jour.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Absences = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // L'ordre est celui du menu déroulant : du plus courant au plus rare.
  const TYPES = ["conge", "vacances", "maladie", "cnesst"];

  const LIBELLES = {
    fr: { conge: "Congé", vacances: "Vacances", maladie: "Maladie", cnesst: "CNESST" },
    en: { conge: "Time off", vacances: "Vacation", maladie: "Sick leave", cnesst: "CNESST" },
  };

  // Quand deux absences se chevauchent, on affiche la plus lourde de conséquences : un
  // accident de travail passe avant une maladie, qui passe avant des vacances. C'est celle
  // qu'on veut voir en montant l'horaire, pas celle qui a été saisie en premier.
  const PRIORITE = ["cnesst", "maladie", "vacances", "conge"];

  const MOIS = {
    fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  };

  function estISO(valeur) {
    return typeof valeur === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valeur);
  }

  function typeValide(valeur) {
    return TYPES.includes(valeur) ? valeur : "conge";
  }

  /**
   * Remet une absence d'aplomb : dates valides, bornes dans le bon ordre, type connu.
   * Retourne null si les dates ne sont pas exploitables — mieux vaut refuser une entrée que
   * d'en garder une qui ne couvrira jamais aucune journée.
   */
  function normaliser(absence) {
    const debut = absence && absence.date_debut;
    // Une fin laissée vide veut dire « une seule journée » : c'est le cas le plus courant,
    // et obliger à retaper la même date deux fois ferait rater des congés d'un jour.
    const finBrute = absence && absence.date_fin ? absence.date_fin : debut;
    if (!estISO(debut) || !estISO(finBrute)) return null;
    // Bornes inversées : on ne refuse pas, on remet dans l'ordre. La personne voulait
    // manifestement la période entre les deux.
    const [date_debut, date_fin] = debut <= finBrute ? [debut, finBrute] : [finBrute, debut];
    return {
      ...absence,
      date_debut,
      date_fin,
      type: typeValide(absence.type),
      note: String((absence && absence.note) || "").trim(),
    };
  }

  // Les dates ISO se comparent comme du texte : 2026-07-05 < 2026-07-20. Pas de fuseau
  // horaire dans l'affaire, donc pas de décalage d'un jour.
  function couvre(absence, jourISO) {
    if (!absence || !estISO(jourISO)) return false;
    return jourISO >= absence.date_debut && jourISO <= absence.date_fin;
  }

  // L'absence qui couvre cette personne ce jour-là, s'il y en a une. En cas de
  // chevauchement, les vacances l'emportent : c'est l'information la plus forte à afficher.
  function absenceDuJour(absences, employeeId, jourISO) {
    const candidates = (absences || []).filter((a) => a.employee_id === employeeId && couvre(a, jourISO));
    if (candidates.length === 0) return null;
    for (const type of PRIORITE) {
      const trouvee = candidates.find((a) => typeValide(a.type) === type);
      if (trouvee) return trouvee;
    }
    return candidates[0];
  }

  // Les quarts cédulés pendant une absence. C'est LE cas qu'on veut voir : le congé était
  // noté, et quelqu'un a quand même été placé ce jour-là.
  function conflits(absences, quarts) {
    const trouves = [];
    for (const q of quarts || []) {
      const a = absenceDuJour(absences, q.employee_id, q.date);
      if (a) trouves.push({ quart: q, absence: a });
    }
    return trouves;
  }

  // Les absences à venir, la plus proche d'abord. Une période déjà commencée mais pas
  // terminée reste « à venir » — on est en plein dedans, c'est le moment où elle compte le plus.
  function prochaines(absences, aujourdhuiISO) {
    return (absences || [])
      .filter((a) => !estISO(aujourdhuiISO) || a.date_fin >= aujourdhuiISO)
      .slice()
      .sort((a, b) => (a.date_debut < b.date_debut ? -1 : a.date_debut > b.date_debut ? 1 : 0));
  }

  function jour(iso) {
    return String(parseInt(iso.slice(8), 10));
  }

  // Le français met le mois après le jour, l'anglais avant : « 4 juillet » contre « July 4 ».
  function jourEtMois(iso, lang) {
    const mois = MOIS[lang][parseInt(iso.slice(5, 7), 10) - 1];
    return lang === "fr" ? `${jour(iso)} ${mois}` : `${mois} ${jour(iso)}`;
  }

  // « 4 juillet 2026 » pour une journée, « 20 au 26 juillet 2026 » pour une période. Le mois
  // ne s'écrit qu'une fois quand la période tient dans un seul mois — le répéter alourdit une
  // liste qu'on parcourt du regard. Le mois se colle à la date qui le porte naturellement :
  // la dernière en français, la première en anglais.
  function fmtPeriode(absence, lang) {
    const L = lang === "en" ? "en" : "fr";
    const a = normaliser(absence);
    if (!a) return "";
    const annee = a.date_fin.slice(0, 4);

    if (a.date_debut === a.date_fin) {
      return L === "fr" ? `${jourEtMois(a.date_debut, L)} ${annee}` : `${jourEtMois(a.date_debut, L)}, ${annee}`;
    }

    const memeMois = a.date_debut.slice(0, 7) === a.date_fin.slice(0, 7);
    if (L === "fr") {
      const debut = memeMois ? jour(a.date_debut) : jourEtMois(a.date_debut, L);
      return `${debut} au ${jourEtMois(a.date_fin, L)} ${annee}`;
    }
    const fin = memeMois ? jour(a.date_fin) : jourEtMois(a.date_fin, L);
    return `${jourEtMois(a.date_debut, L)} to ${fin}, ${annee}`;
  }

  function libelleType(type, lang) {
    return LIBELLES[lang === "en" ? "en" : "fr"][typeValide(type)];
  }

  // Nombre de journées couvertes, bornes comprises. Sert à dire « 7 jours » à côté d'une
  // semaine de vacances.
  function nombreDeJours(absence) {
    const a = normaliser(absence);
    if (!a) return 0;
    const ms = Date.parse(`${a.date_fin}T12:00:00Z`) - Date.parse(`${a.date_debut}T12:00:00Z`);
    return Math.round(ms / 86400000) + 1;
  }

  return {
    TYPES,
    PRIORITE,
    estISO,
    typeValide,
    normaliser,
    couvre,
    absenceDuJour,
    conflits,
    prochaines,
    fmtPeriode,
    libelleType,
    nombreDeJours,
  };
});
