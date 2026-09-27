// Lire le code dans l'adresse de la page.
//
// Ce fichier garde la trace d'un vrai incident : des employées recevaient « Code invalide »
// avec un code parfaitement bon, parce que le lien arrivait avec une barre oblique au bout.
// Chaque cas ci-dessous est une façon dont un lien s'abîme en chemin.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/shared/code-acces.js");

test("un lien propre donne le code", () => {
  assert.equal(C.depuisChemin("/e/ABC234", "e"), "ABC234");
  assert.equal(C.depuisChemin("/horaire/XYZ789", "horaire"), "XYZ789");
});

test("une barre oblique au bout ne casse plus rien", () => {
  // LE cas de l'incident. Avant, le dernier morceau était vide.
  assert.equal(C.depuisChemin("/e/ABC234/", "e"), "ABC234");
  assert.equal(C.depuisChemin("/horaire/XYZ789/", "horaire"), "XYZ789");
});

test("une espace collée par un copier-coller ne casse plus rien", () => {
  assert.equal(C.depuisChemin("/e/ABC234 ", "e"), "ABC234");
  assert.equal(C.depuisChemin("/e/%20ABC234%20", "e"), "ABC234");
  assert.equal(C.depuisChemin("/e/ ABC234 /", "e"), "ABC234");
});

test("de la ponctuation collée au bout ne casse plus rien", () => {
  // « va sur declara.tips/e/ABC234. » — le point part avec le copier-coller.
  assert.equal(C.depuisChemin("/e/ABC234.", "e"), "ABC234");
  assert.equal(C.depuisChemin("/e/ABC234,", "e"), "ABC234");
  assert.equal(C.depuisChemin("/e/(ABC234)", "e"), "ABC234");
});

test("les minuscules passent — c'est le même code", () => {
  assert.equal(C.depuisChemin("/e/abc234", "e"), "ABC234");
  assert.equal(C.depuisChemin("/e/AbC234/", "e"), "ABC234");
});

test("un lien abîmé AU MILIEU est refusé, pas deviné", () => {
  // C'est la limite volontaire : « AB-C234 » réparé en « ABC234 » pourrait désigner
  // quelqu'un d'autre. Mieux vaut un refus franc qu'une page ouverte sur le mauvais compte.
  assert.equal(C.depuisChemin("/e/AB-C234", "e"), "AB-C234");
  assert.equal(C.depuisChemin("/e/ABC 234", "e"), "ABC 234");
});

test("sans code, on ne rend rien plutôt que n'importe quoi", () => {
  assert.equal(C.depuisChemin("/e/", "e"), "");
  assert.equal(C.depuisChemin("/e", "e"), "");
  assert.equal(C.depuisChemin("/", "e"), "");
  assert.equal(C.depuisChemin("", "e"), "");
});

test("la page horaire sans code reste la page horaire", () => {
  // /horaire tout court, c'est l'entrée par mot de passe : elle ne doit surtout pas se
  // croire en mode lien direct.
  assert.equal(C.depuisChemin("/horaire", "horaire"), "");
  assert.equal(C.depuisChemin("/horaire/", "horaire"), "");
});

test("le préfixe est respecté : on ne prend pas un segment au hasard", () => {
  assert.equal(C.depuisChemin("/admin", "e"), "", "pas de segment « e » dans ce chemin");
  assert.equal(C.depuisChemin("/e/ABC234", "horaire"), "");
});

test("une adresse abîmée ne fait pas planter la page", () => {
  // depuisChemin est appelé au tout premier instant du script : s'il lève, la page reste
  // blanche et l'employée ne voit même pas de message d'erreur.
  for (const valeur of [null, undefined, 12345, {}, "%E0%A4%A", "///"]) {
    assert.doesNotThrow(() => C.depuisChemin(valeur, "e"), JSON.stringify(valeur));
  }
  assert.equal(C.depuisChemin("%E0%A4%A", "e"), "");
});

test("nettoyer ne garde jamais de caractère hors alphabet aux extrémités", () => {
  for (const brut of ["  abc234  ", "/ABC234/", "«ABC234»", "ABC234\n", "\tABC234"]) {
    assert.equal(C.nettoyer(brut), "ABC234", JSON.stringify(brut));
  }
});

test("l'alphabet est bien celui des codes générés", () => {
  // Si db.js changeait d'alphabet sans que celui-ci suive, on se remettrait à rogner des
  // caractères légitimes.
  for (const lettre of "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
    assert.ok(C.ALPHABET.test(lettre), lettre);
  }
  for (const exclue of "IO01 .-_/") {
    assert.ok(!C.ALPHABET.test(exclue), `« ${exclue} » ne devrait pas être dans l'alphabet`);
  }
});
