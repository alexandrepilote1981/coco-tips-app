// Découpage prénom / nom de famille. Le nom de famille est ce qui distingue deux employées
// qui portent le même prénom, à l'écran comme dans le PDF : il ne doit jamais disparaître.
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitName, fullName } = require("../public/shared/noms.js");

test("un nom complet se sépare en prénom et nom de famille", () => {
  assert.deepEqual(splitName("Marie Tremblay"), { first: "Marie", last: "Tremblay" });
});

test("deux employées du même prénom restent distinguables", () => {
  const a = splitName("Marie Tremblay");
  const b = splitName("Marie Bergeron");
  assert.equal(a.first, b.first);
  assert.notEqual(a.last, b.last, "le nom de famille doit les départager");
});

test("un prénom seul ne fabrique pas un nom de famille vide à afficher", () => {
  assert.deepEqual(splitName("Marie"), { first: "Marie", last: "" });
});

test("les espaces en trop ne décalent pas le découpage", () => {
  assert.deepEqual(splitName("  Marie   Tremblay  "), { first: "Marie", last: "Tremblay" });
});

test("un prénom composé au trait d'union reste entier", () => {
  assert.deepEqual(splitName("Marie-Josée Tremblay"), { first: "Marie-Josée", last: "Tremblay" });
});

test("tout ce qui suit le prénom part dans le nom de famille", () => {
  assert.deepEqual(splitName("Jean Marc Tremblay"), { first: "Jean", last: "Marc Tremblay" });
  assert.deepEqual(splitName("Ana Lopez de la Vega"), { first: "Ana", last: "Lopez de la Vega" });
});

test("un nom manquant ne fait planter aucune des deux pages", () => {
  for (const vide of ["", "   ", null, undefined]) {
    assert.deepEqual(splitName(vide), { first: "", last: "" });
  }
});

test("fullName nettoie les espaces sans rien perdre", () => {
  assert.equal(fullName("  Marie   Tremblay "), "Marie Tremblay");
  assert.equal(fullName("Marie"), "Marie");
  assert.equal(fullName(""), "");
});
