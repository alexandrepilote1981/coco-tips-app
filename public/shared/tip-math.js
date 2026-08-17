// Calcul des pourboires — SOURCE UNIQUE, utilisée par le serveur ET par le navigateur.
//
// Ce fichier existait auparavant en deux exemplaires : computeEntry() dans server.js et
// recomputeEntry() dans employee.html. Les deux avaient déjà divergé — le serveur faisait
// `e.ventes || 0` (une saisie non numérique donnait NaN) là où le navigateur faisait
// `parseFloat(...) || 0` (qui donnait 0). L'employée voyait donc un montant et la base en
// gardait un autre, sans que rien ne le signale. D'où ce fichier unique, couvert par des
// tests dans test/tip-math.test.js.
//
// L'enveloppe ci-dessous le rend utilisable des deux côtés : `require()` sous Node,
// et `window.TipMath` dans le navigateur.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TipMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Les champs arrivent tantôt en nombre (base de données), tantôt en texte (champ de
  // formulaire). Tout ce qui n'est pas un nombre exploitable vaut zéro — jamais NaN, qui
  // se propagerait ensuite dans tous les totaux.
  function toNumber(value) {
    const n = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  // Retourne une COPIE de la journée, enrichie des champs calculés.
  function computeEntry(entry) {
    const ventes = toNumber(entry.ventes);
    const clients = toNumber(entry.clients);
    const pct = toNumber(entry.pct);
    const remis = toNumber(entry.remis);

    const pourboireBrut = ventes * (pct / 100);
    return {
      ...entry,
      ventes,
      clients,
      pct,
      remis,
      pourboireBrut,
      // Le net peut être négatif : c'est le cas où l'employée a remis plus que son
      // pourboire brut, donc l'employeur lui doit un virement.
      net: pourboireBrut - remis,
      // Aucune division par zéro : une journée sans client n'a pas de moyenne.
      moyenne: clients > 0 ? ventes / clients : 0,
    };
  }

  // Même calcul, mais appliqué SUR PLACE. Le navigateur en a besoin pour rafraîchir
  // l'affichage instantanément sans remplacer l'objet déjà accroché à la carte affichée.
  function applyComputed(entry) {
    Object.assign(entry, computeEntry(entry));
    return entry;
  }

  return { toNumber, computeEntry, applyComputed };
});
