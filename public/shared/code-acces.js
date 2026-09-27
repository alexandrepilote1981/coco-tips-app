// Lire le code d'accès dans l'adresse de la page — SOURCE UNIQUE, les deux pages à code.
//
// Ce fichier existe à cause d'un vrai appel : « j'ai des codes employés qui fonctionnent
// pas ». Les codes étaient bons. C'est le LIEN qui arrivait abîmé.
//
// La page employé faisait simplement `pathname.split("/").pop()`. Avec une barre oblique au
// bout — /e/ABC123/ — le dernier morceau est vide, et une employée dont le code est
// parfaitement valide se fait répondre « Code invalide ». Une espace collée à la fin par un
// copier-coller donne la même chose.
//
// Ce qu'on nettoie, et pourquoi seulement ça :
//
//   - les morceaux vides (barre oblique finale) ;
//   - les espaces, y compris celles encodées en %20 par un client de messagerie ;
//   - la ponctuation collée AUX EXTRÉMITÉS — « va sur declara.tips/e/ABC123. » ;
//   - la casse, puisque l'alphabet des codes est en majuscules.
//
// Ce qu'on ne fait PAS : réparer le milieu. Retirer un caractère au milieu de « AB-C123 »
// donnerait « ABC123 », qui peut être le code de QUELQU'UN D'AUTRE. Un lien abîmé au milieu
// doit être refusé, pas deviné.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CodeAcces = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Le même alphabet que makeAccessCode() dans db.js : ni O, ni I, ni 0, ni 1 — les
  // caractères qu'on confond en lisant à voix haute.
  const ALPHABET = /[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/;

  function nettoyer(brut) {
    let code = String(brut == null ? "" : brut);
    try {
      code = decodeURIComponent(code);
    } catch (e) {
      // Une séquence %XX incomplète fait lever decodeURIComponent : on garde le texte tel
      // quel plutôt que de laisser l'exception vider toute la page.
    }
    code = code.trim().toUpperCase();
    // Rogner les extrémités jusqu'à tomber sur un caractère de l'alphabet.
    while (code.length && !ALPHABET.test(code[0])) code = code.slice(1);
    while (code.length && !ALPHABET.test(code[code.length - 1])) code = code.slice(0, -1);
    return code;
  }

  /**
   * Le code contenu dans un chemin d'URL, ou "" s'il n'y en a pas.
   * @param {string} chemin   window.location.pathname
   * @param {string} [prefixe] segment attendu avant le code : "e" ou "horaire". Sans lui, on
   *        prend simplement le dernier segment non vide.
   */
  function depuisChemin(chemin, prefixe) {
    const segments = String(chemin == null ? "" : chemin)
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return "";

    if (prefixe) {
      const i = segments.indexOf(prefixe);
      // Le segment juste après le préfixe, et seulement lui : /horaire/ABC123 donne ABC123,
      // /horaire tout seul ne donne rien (c'est l'entrée par mot de passe).
      if (i === -1 || i + 1 >= segments.length) return "";
      return nettoyer(segments[i + 1]);
    }
    return nettoyer(segments[segments.length - 1]);
  }

  return { depuisChemin, nettoyer, ALPHABET };
});
