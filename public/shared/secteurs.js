// Qui travaille où — SOURCE UNIQUE, le serveur et les trois pages.
//
// Ce fichier naît d'une phrase du propriétaire : « j'ai besoin que tu joignes les horaires,
// si un employé est ouvert en cuisine et en salle ». Jusque-là, l'app posait la question au
// mauvais endroit.
//
// LE CHANGEMENT DE RÈGLE, ET POURQUOI IL FALLAIT LE FAIRE
//
// Partout, le secteur d'un QUART se déduisait du secteur de la PERSONNE : les requêtes
// filtraient sur `e.secteur`, la page employé décidait d'afficher l'heure de fin d'après
// `employee.secteur`. Tant qu'une personne appartenait à un seul bord, les deux revenaient
// au même, et personne n'avait à choisir.
//
// Dès qu'une personne travaille des deux bords, les deux se séparent — et c'est le QUART qui
// a raison. Une serveuse qui fait un midi à la plonge ne devient pas plongeuse ; c'est ce
// quart-là qui est en cuisine. Le poste du quart le dit déjà, il suffisait de le lire :
// Cuisinier et Plongeur sont en cuisine, Serveur et Hôtesse sont en salle.
//
// Ce que ça règle du même coup, sans rien ajouter :
//
//   - le lien du gérant de cuisine ne voit que les quarts de cuisine, même ceux d'un employé
//     mixte — un quart de salle ne fuit pas vers une porte qui n'y a pas droit ;
//   - la masse salariale ne compte que les heures de cuisine, parce qu'un quart de salle
//     n'a pas d'heure de fin et n'entre donc pas dans le calcul ;
//   - « effacer la semaine » dans une grille n'efface que les quarts de CETTE grille.
//
// Ce qu'on ne fait PAS : deviner. Un poste inconnu compte comme salle, jamais comme cuisine.
// Se tromper vers la salle fait apparaître un quart là où il ne devrait pas ; se tromper vers
// la cuisine le ferait entrer dans la masse salariale et fausserait un chiffre d'argent.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Secteurs = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SALLE = "salle";
  const CUISINE = "cuisine";
  // « les deux » et non un troisième lieu de travail : la personne est des deux équipes à la
  // fois, elle n'est pas ailleurs.
  const LES_DEUX = "les_deux";

  // Les postes qui font qu'un quart est un quart de cuisine. Cette liste est la seule ;
  // schedule-ui.js propose ces mêmes postes dans la grille de cuisine.
  const ROLES_CUISINE = ["cuisinier", "plongeur"];

  /** Le secteur d'un EMPLOYÉ, ramené à une valeur connue. Le défaut est la salle. */
  function valide(valeur) {
    if (valeur === CUISINE) return CUISINE;
    if (valeur === LES_DEUX) return LES_DEUX;
    return SALLE;
  }

  /** Le secteur d'un QUART, d'après son poste. C'est lui qui fait autorité. */
  function duRole(role) {
    return ROLES_CUISINE.indexOf(String(role || "")) === -1 ? SALLE : CUISINE;
  }

  /** Cette personne fait-elle partie de l'équipe de ce secteur ? */
  function travailleEn(secteurEmploye, secteur) {
    const s = valide(secteurEmploye);
    return s === LES_DEUX || s === valide(secteur);
  }

  /**
   * Cette personne déclare-t-elle des pourboires ?
   * Seule la cuisine PURE n'en déclare pas. Quelqu'un qui met le pied sur le plancher en
   * fait, donc sa page garde son formulaire — c'était la demande explicite.
   */
  function declarePourboires(secteurEmploye) {
    return valide(secteurEmploye) !== CUISINE;
  }

  // ---------------------------------------------------------------- pour les requêtes SQL
  //
  // Ces deux fragments vivent ici, et pas écrits à la main dans server.js, pour la raison
  // qui vaut partout dans ce dépôt : une liste de postes recopiée finit par diverger de
  // l'originale, et la divergence ne se voit pas — elle se lit comme un quart disparu.

  const TROUS = ROLES_CUISINE.map(() => "?").join(", ");

  /** Fragment SQL « ce quart est-il du secteur voulu ? », plus ses paramètres. */
  function conditionQuartSQL(secteur, colonneRole) {
    const col = colonneRole || "s.role";
    // COALESCE : un quart sans poste vaut « server » côté serveur, donc la salle.
    const dedans = `COALESCE(${col}, 'server') IN (${TROUS})`;
    return {
      sql: valide(secteur) === CUISINE ? dedans : `NOT ${dedans}`,
      params: ROLES_CUISINE.slice(),
    };
  }

  /** Fragment SQL « cette personne est-elle de cette équipe ? », plus ses paramètres. */
  function conditionEmployeSQL(secteur, colonneSecteur) {
    const col = colonneSecteur || "secteur";
    return { sql: `(${col} = ? OR ${col} = ?)`, params: [valide(secteur), LES_DEUX] };
  }

  return {
    SALLE,
    CUISINE,
    LES_DEUX,
    ROLES_CUISINE,
    valide,
    duRole,
    travailleEn,
    declarePourboires,
    conditionQuartSQL,
    conditionEmployeSQL,
  };
});
