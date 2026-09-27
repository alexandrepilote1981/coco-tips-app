// Disponibilités des employés — SOURCE UNIQUE, serveur ET navigateur.
//
// Ce que ça répond : « le lundi je peux rentrer à 5h30, le mardi pas avant 9h, le jeudi pas
// pantoute ». C'est l'HABITUDE de la personne, pas sa semaine. Elle la remplit une fois et
// n'y retouche presque jamais — un formulaire à remplir chaque semaine, personne ne le
// remplit, et au bout d'un mois la grille est à moitié vide et ne veut plus rien dire.
//
// Les congés (absences.js) servent aux exceptions : « mais pas la semaine du 20 juillet ».
// Les deux ne se marchent pas sur les pieds — l'un dit la règle, l'autre dit l'exception.
//
// LA RÈGLE À NE PAS CASSER : une disponibilité n'INTERDIT rien. Un samedi matin où une
// serveuse lâche à 5h, le gérant appelle celle qui avait écrit « pas le samedi » et elle dit
// oui pour cette fois. Si l'app bloquait, il faudrait aller modifier la disponibilité de la
// personne pour pouvoir la placer — donc falsifier ce qu'elle a déclaré, juste pour
// contourner l'app. La grille avertit, elle ne refuse pas. Voir `conflit()`.
//
// Le défaut est « disponible toute la journée, tous les jours ». Quelqu'un qui n'a jamais
// ouvert la page n'est donc jamais barré. Pour savoir qui n'a jamais répondu, on regarde
// l'ABSENCE de lignes en base (`aRepondu`), pas le contenu — sinon « j'ai dit oui à tout »
// et « j'ai jamais ouvert la page » seraient impossibles à distinguer.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Disponibilites = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // 0 = lundi, comme les grilles d'horaire partout dans l'app. Ce n'est PAS l'ordre de
  // getDay() (qui met dimanche à 0) : passer par `jourDeSemaine()` plutôt que de convertir
  // à la main à chaque endroit.
  const JOURS = [0, 1, 2, 3, 4, 5, 6];

  const NOMS = {
    fr: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
    en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  };

  const T = {
    fr: {
      touteLaJournee: "Toute la journée",
      pasDispo: "Pas disponible",
      de: "de",
      a: "à",
      apartir: (h) => `À partir de ${h}`,
      jusqua: (h) => `Jusqu'à ${h}`,
      plage: (d, f) => `De ${d} à ${f}`,
    },
    en: {
      touteLaJournee: "All day",
      pasDispo: "Not available",
      de: "from",
      a: "to",
      apartir: (h) => `From ${h}`,
      jusqua: (h) => `Until ${h}`,
      plage: (d, f) => `From ${d} to ${f}`,
    },
  };

  function estHeure(valeur) {
    return typeof valeur === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(valeur);
  }

  function minutes(hhmm) {
    if (!estHeure(hhmm)) return null;
    return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10);
  }

  // Lundi = 0. On passe par UTC à midi pour la même raison que partout ailleurs : une date
  // construite en heure locale recule d'un jour selon le fuseau, et un mardi qui devient un
  // lundi fait lire la mauvaise ligne de disponibilité.
  function jourDeSemaine(dateISO) {
    if (typeof dateISO !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
    const d = new Date(Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10), 12));
    const j = d.getUTCDay(); // 0 = dimanche
    return j === 0 ? 6 : j - 1;
  }

  /**
   * Remet une ligne d'aplomb. Une ligne « disponible » sans heures veut dire toute la
   * journée ; des heures à l'envers se remettent dans l'ordre plutôt que d'être refusées.
   */
  function normaliser(ligne) {
    const jour = parseInt(ligne && ligne.jour, 10);
    if (!JOURS.includes(jour)) return null;
    const disponible = !ligne || ligne.disponible === undefined ? true : !!ligne.disponible;
    if (!disponible) return { jour, disponible: false, heure_debut: "", heure_fin: "" };

    let debut = estHeure(ligne.heure_debut) ? ligne.heure_debut : "";
    let fin = estHeure(ligne.heure_fin) ? ligne.heure_fin : "";
    if (debut && fin && minutes(debut) > minutes(fin)) [debut, fin] = [fin, debut];
    // Une plage qui commence et finit à la même minute ne couvre rien : c'est une faute de
    // frappe, pas une disponibilité de zéro seconde.
    if (debut && fin && debut === fin) return { jour, disponible: true, heure_debut: "", heure_fin: "" };
    return { jour, disponible: true, heure_debut: debut, heure_fin: fin };
  }

  // La semaine complète, sept lignes, défaut compris. C'est ce que l'affichage consomme :
  // il n'a jamais à se demander si une ligne manque.
  function semaine(lignes) {
    const par = {};
    for (const l of lignes || []) {
      const n = normaliser(l);
      if (n) par[n.jour] = n;
    }
    return JOURS.map((jour) => par[jour] || { jour, disponible: true, heure_debut: "", heure_fin: "" });
  }

  // A-t-elle déjà répondu ? On regarde s'il existe des lignes, pas ce qu'elles disent.
  function aRepondu(lignes) {
    return (lignes || []).some((l) => normaliser(l) !== null);
  }

  function duJour(lignes, dateISO) {
    const jour = jourDeSemaine(dateISO);
    if (jour === null) return null;
    return semaine(lignes)[jour];
  }

  /**
   * Ce qui cloche entre un quart et la disponibilité déclarée, s'il y a quelque chose.
   * @returns {null | {raison: "absent"|"heures", dispo: object}}
   *
   * On ne retourne JAMAIS « interdit » : c'est un avertissement, et la décision appartient
   * au gérant. Seul l'affichage décide quoi en faire.
   */
  function conflit(lignes, quart) {
    if (!quart) return null;
    const dispo = duJour(lignes, quart.date);
    if (!dispo) return null;
    if (!dispo.disponible) return { raison: "absent", dispo };

    const debutQuart = minutes(quart.start_time);
    if (debutQuart === null) return null;

    // On compare sur l'HEURE DE DÉBUT seulement. La salle n'a pas d'heure de fin fiable —
    // une serveuse part quand la salle est vide — alors une comparaison de fin donnerait des
    // avertissements faux en permanence. La fin déclarée sert quand même : un quart qui
    // commence après l'heure de fin de la personne est signalé.
    const debutDispo = minutes(dispo.heure_debut);
    const finDispo = minutes(dispo.heure_fin);
    if (debutDispo !== null && debutQuart < debutDispo) return { raison: "heures", dispo };
    if (finDispo !== null && debutQuart >= finDispo) return { raison: "heures", dispo };
    return null;
  }

  function libelle(dispo, lang) {
    const t = T[lang === "en" ? "en" : "fr"];
    const d = normaliser(dispo);
    if (!d) return "";
    if (!d.disponible) return t.pasDispo;
    if (d.heure_debut && d.heure_fin) return t.plage(d.heure_debut, d.heure_fin);
    if (d.heure_debut) return t.apartir(d.heure_debut);
    if (d.heure_fin) return t.jusqua(d.heure_fin);
    return t.touteLaJournee;
  }

  function nomDuJour(jour, lang) {
    return NOMS[lang === "en" ? "en" : "fr"][jour] || "";
  }

  return {
    JOURS,
    estHeure,
    minutes,
    jourDeSemaine,
    normaliser,
    semaine,
    aRepondu,
    duJour,
    conflit,
    libelle,
    nomDuJour,
  };
});
