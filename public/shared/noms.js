// Découpage d'un nom d'employé — SOURCE UNIQUE, utilisée par le serveur ET par le navigateur.
//
// La base ne garde qu'un seul champ `name` (« Marie Tremblay »). La grille d'horaire
// n'affichait que le premier mot, ce qui suffisait tant qu'il n'y avait qu'une seule Marie :
// dès qu'un restaurant en a deux, deux lignes identiques se suivent et plus personne ne sait
// laquelle est laquelle. Le nom de famille doit donc apparaître partout où l'horaire montre
// quelqu'un — à l'écran comme dans le PDF.
//
// Le découpage vit ici parce que la grille (navigateur) et le PDF (Node) doivent le faire
// de la même façon : si les deux divergeaient, l'employée verrait un nom sur son téléphone
// et un autre sur la feuille affichée au mur.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Noms = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Le premier mot est le prénom, tout le reste est le nom de famille. C'est volontairement
  // simple : « Jean Marc Tremblay » donnera « Jean » + « Marc Tremblay ». Un prénom composé
  // s'écrit presque toujours avec un trait d'union (« Marie-Josée »), donc il reste entier.
  function splitName(name) {
    const parts = String(name == null ? "" : name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { first: "", last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  // Nom complet nettoyé (espaces multiples réduits), pour les endroits qui l'affichent d'un bloc.
  function fullName(name) {
    const { first, last } = splitName(name);
    return last ? `${first} ${last}` : first;
  }

  return { splitName, fullName };
});
