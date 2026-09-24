// Coût de la main-d'œuvre d'une semaine d'horaire — SOURCE UNIQUE, serveur ET navigateur.
//
// À quoi ça sert, dans les mots du gérant qui l'a demandé : « Lokassa est payé 18,50 $/h,
// 3 jours de 5 h 30 à 1 h 30. Si on le fait rentrer à 6 h 30 ces 3 mêmes jours, on économise
// 55,50 $. » Ce fichier est ce qui répond à cette question, pendant qu'on bâtit l'horaire.
//
// Deux choses à garder en tête en lisant les chiffres qui en sortent :
//
// 1. C'est le coût du PLAN, pas du réel. Personne ne poinçonne : on calcule ce que l'horaire
//    écrit va coûter s'il est respecté. C'est exactement ce qu'il faut pour arbitrer une
//    heure d'entrée, et ce n'est pas la paie.
// 2. Ça ne vaut que pour la cuisine. En salle, une serveuse finit quand la salle est vide,
//    pas à l'heure inscrite : le chiffre serait systématiquement trop beau, et un chiffre
//    toujours trop beau, on cesse de s'y fier.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoutMainOeuvre = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function minutesDe(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // Durée d'un quart, en heures. Un quart qui finit « avant » son début a franchi minuit
  // (5 h 30 → 1 h 30) : on ajoute 24 h plutôt que de retourner un négatif, sinon une
  // fermeture de cuisine compterait en moins dans la masse salariale.
  function heuresDuQuart(quart) {
    const debut = minutesDe(quart && quart.start_time);
    const fin = minutesDe(quart && quart.end_time);
    if (debut === null || fin === null) return 0;
    const diff = fin >= debut ? fin - debut : fin + 24 * 60 - debut;
    return diff / 60;
  }

  function nombre(valeur) {
    const n = typeof valeur === "number" ? valeur : parseFloat(valeur);
    return Number.isFinite(n) ? n : 0;
  }

  // Le taux horaire ne suffit pas à dire ce qu'une heure coûte : par-dessus viennent les
  // vacances, la CNESST, le RRQ… `chargesPct` est ce supplément, en pourcentage du salaire.
  // Il vaut 0 tant que le comptable n'a pas donné le vrai chiffre — mieux vaut un coût
  // visiblement incomplet qu'un coût inventé.
  function tauxEffectif(employe, chargesPct) {
    return nombre(employe && employe.taux_horaire) * (1 + nombre(chargesPct) / 100);
  }

  /**
   * Coût d'une liste d'employés sur une liste de journées.
   * @param {Array<{id:string,taux_horaire?:number}>} employes
   * @param {Array<{employee_id:string,date:string,start_time:string,end_time:string}>} quarts
   * @param {string[]} datesISO  les journées à compter (une semaine, en général)
   * @param {number} chargesPct
   * @returns {{heures:number, cout:number, parEmploye:Object, sansTaux:number}}
   */
  function coutSurPeriode(employes, quarts, datesISO, chargesPct) {
    const jours = new Set(datesISO || []);
    const parEmploye = {};
    let heures = 0;
    let cout = 0;
    let sansTaux = 0;

    for (const emp of employes || []) {
      const siens = (quarts || []).filter((q) => q.employee_id === emp.id && jours.has(q.date));
      const h = siens.reduce((somme, q) => somme + heuresDuQuart(q), 0);
      const taux = tauxEffectif(emp, chargesPct);
      const montant = h * taux;

      parEmploye[emp.id] = { heures: h, cout: montant, quarts: siens.length };
      heures += h;
      cout += montant;
      // Un employé cédulé sans taux fait mentir le total vers le bas, sans rien afficher.
      // On les compte pour pouvoir le dire à l'écran plutôt que de laisser croire au chiffre.
      if (h > 0 && nombre(emp.taux_horaire) <= 0) sansTaux += 1;
    }

    return { heures, cout, parEmploye, sansTaux };
  }

  // Écart avec une autre période — c'est ce chiffre-là qui crée le réflexe : un total tout
  // seul ne dit rien, un total qui baisse se regarde.
  function ecart(courant, precedent) {
    return {
      heures: courant.heures - precedent.heures,
      cout: courant.cout - precedent.cout,
    };
  }

  function fmtHeures(h, lang) {
    const arrondi = Math.round(nombre(h) * 100) / 100;
    const texte = Number.isInteger(arrondi) ? String(arrondi) : arrondi.toFixed(2).replace(/0$/, "");
    return `${lang === "en" ? texte : texte.replace(".", ",")} h`;
  }

  // Les montants s'écrivent toujours aux cents : un coût de main-d'œuvre arrondi au dollar
  // ferait disparaître exactement le genre d'écart qu'on cherche à voir.
  function fmtMontant(montant, lang) {
    const n = nombre(montant);
    const signe = n < 0 ? "-" : "";
    const abs = Math.abs(n).toFixed(2);
    if (lang === "en") return `${signe}$${abs}`;
    return `${signe}${abs.replace(".", ",")} $`;
  }

  // Écart signé, pour l'afficher tel quel : « + 120,00 $ » ou « − 210,00 $ ».
  function fmtEcart(montant, lang) {
    const n = nombre(montant);
    if (Math.abs(n) < 0.005) return lang === "en" ? "$0.00" : "0,00 $";
    return `${n > 0 ? "+ " : "− "}${fmtMontant(Math.abs(n), lang)}`;
  }

  return {
    minutesDe,
    heuresDuQuart,
    tauxEffectif,
    coutSurPeriode,
    ecart,
    fmtHeures,
    fmtMontant,
    fmtEcart,
  };
});
