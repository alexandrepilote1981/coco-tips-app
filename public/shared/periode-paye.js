// Les périodes de paye : des blocs de 14 jours qui commencent un lundi précis.
//
// Pourquoi ce fichier existe. La barre de période du tableau de bord offrait « 2 dernières
// semaines », qui est une fenêtre GLISSANTE : aujourd'hui moins treize jours. Ça ne
// correspond à aucune paye. Demandé ainsi : « peux-tu décoller le 2 semaines à partir d'un
// lundi précis, pour suivre le détail de la paye qui est aux 2 semaines et commence un
// lundi ». Une paye ne roule pas, elle tombe : du lundi 6 au dimanche 19, puis du 20 au 2,
// et ainsi de suite. Un total pris sur une fenêtre glissante ne se compare à aucun talon.
//
// Tout tient dans une ancre — le lundi d'une paye, n'importe laquelle — et une division. Les
// périodes AVANT l'ancre se calculent aussi bien que celles d'après : quelqu'un qui règle son
// ancre en octobre doit pouvoir revenir sur la paye de septembre, et `Math.floor` sur un
// nombre négatif fait exactement ce qu'il faut. C'est précisément ce qu'un `|0` ou un
// `Math.trunc` auraient cassé en silence, en ramenant -0,5 à 0 au lieu de -1.
//
// Le calcul passe par UTC à midi, comme `feries.js` : à minuit, un changement d'heure
// d'automne décale la journée d'un cran et la paye commencerait un dimanche.

(function (racine) {
  const JOUR = 86400000;
  const LONGUEUR = 14; // une paye aux deux semaines

  // Le gabarit NE SUFFIT PAS : « 2026-13-01 » le respecte et donne une date invalide, dont
  // le `toISOString` lève — et comme tout ça tourne dans le rendu d'une page, ça la vide au
  // complet. On exige donc que la date existe vraiment, en la relisant après coup. Attrapé
  // par le test, pas à la relecture.
  function estISO(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }

  // Midi UTC : le fuseau horaire ne peut plus faire basculer la date d'un jour.
  function versDate(iso) {
    return new Date(`${iso}T12:00:00Z`);
  }
  function versISO(d) {
    return d.toISOString().slice(0, 10);
  }
  function plusJours(iso, n) {
    return versISO(new Date(versDate(iso).getTime() + n * JOUR));
  }

  /**
   * Le lundi de la semaine de cette date. 0 = dimanche en JavaScript, donc un dimanche
   * recule de six jours et non d'un seul — l'erreur classique, qui ferait commencer la paye
   * le lendemain.
   */
  function lundiDe(iso) {
    if (!estISO(iso)) return null;
    const d = versDate(iso);
    const jour = d.getUTCDay();
    return plusJours(iso, jour === 0 ? -6 : 1 - jour);
  }

  function estLundi(iso) {
    return estISO(iso) && versDate(iso).getUTCDay() === 1;
  }

  /**
   * La période de paye qui contient `jour`, décalée de `decalage` périodes (0 = celle-là,
   * -1 = la précédente). Rend `{ debut, fin, index }` — `index` compte les périodes depuis
   * l'ancre, et peut être négatif pour une paye d'avant le réglage.
   *
   * L'ancre est ramenée à SON lundi si elle n'en est pas un : le réglage vient d'un
   * calendrier où le doigt glisse, et une paye qui commencerait un mardi fausserait tout
   * sans rien afficher d'anormal.
   */
  function periode(ancre, jour, decalage) {
    const debut0 = lundiDe(ancre);
    if (!debut0 || !estISO(jour)) return null;
    const ecart = (versDate(jour).getTime() - versDate(debut0).getTime()) / JOUR;
    // Math.floor et pas Math.trunc : une journée d'AVANT l'ancre doit tomber dans la période
    // -1, pas dans la 0. Avec trunc, les treize jours précédant l'ancre se rangeaient dans
    // la période courante et gonflaient la paye en cours.
    const index = Math.floor(ecart / LONGUEUR) + (Number(decalage) || 0);
    const debut = plusJours(debut0, index * LONGUEUR);
    return { debut, fin: plusJours(debut, LONGUEUR - 1), index };
  }

  /**
   * La journée à `decalage` jours de `jour` (négatif = dans le passé).
   *
   * Pourquoi ça vit ici plutôt que dans la page : la version d'avant repartait de l'HORLOGE
   * à chaque pas — `new Date()` puis `setDate(getDate() - n)`. Ça marche, c'est vérifié sur
   * les deux changements d'heure et le Nouvel An, mais ça dépend du fuseau de l'appareil et
   * de l'heure qu'il est au moment du clic. Ici le pas est de l'arithmétique pure sur une
   * date déjà fixée : il n'y a plus de fuseau dans l'affaire, donc plus rien à vérifier.
   * L'horloge n'est lue qu'une fois, pour savoir quel jour on est.
   */
  function decalerJour(jour, decalage) {
    if (!estISO(jour)) return null;
    return plusJours(jour, Number(decalage) || 0);
  }

  const API = { lundiDe, estLundi, periode, decalerJour, LONGUEUR };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else racine.PeriodePaye = API;
})(typeof window !== "undefined" ? window : globalThis);
