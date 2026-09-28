// Qui travaille où. Ce fichier existe parce que ce module a déplacé une question que toute
// l'app posait au mauvais endroit : le secteur d'un quart ne se déduit plus de la personne,
// il se lit sur le quart. Chaque test ci-dessous tient à une conséquence concrète.

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../public/shared/secteurs.js");

test("le secteur d'un employé se ramène toujours à une valeur connue", () => {
  assert.equal(S.valide("cuisine"), "cuisine");
  assert.equal(S.valide("salle"), "salle");
  assert.equal(S.valide("les_deux"), "les_deux");
});

test("un secteur inconnu retombe sur la salle, jamais sur la cuisine", () => {
  // Se tromper vers la salle fait apparaître quelqu'un dans la mauvaise grille. Se tromper
  // vers la cuisine le ferait entrer dans la masse salariale et fausserait un chiffre
  // d'argent — on penche donc toujours du même côté.
  for (const valeur of [undefined, null, "", "plonge", "LES_DEUX", 0, {}]) {
    assert.equal(S.valide(valeur), "salle", JSON.stringify(valeur));
  }
});

// ---------------------------------------------------------------- le quart fait autorité

test("le poste du quart dit son secteur", () => {
  assert.equal(S.duRole("cuisinier"), "cuisine");
  assert.equal(S.duRole("plongeur"), "cuisine");
  assert.equal(S.duRole("server"), "salle");
  assert.equal(S.duRole("hostess"), "salle");
});

test("un poste inconnu ou absent compte comme salle", () => {
  // Le serveur écrit « server » quand le poste manque : un quart sans poste est un quart de
  // salle, et surtout il ne doit pas se retrouver dans un calcul de salaire.
  for (const role of [undefined, null, "", "inventé", "CUISINIER"]) {
    assert.equal(S.duRole(role), "salle", JSON.stringify(role));
  }
});

test("une serveuse qui fait un quart à la plonge ne devient pas plongeuse", () => {
  // Le cas qui a fait naître le module : c'est le quart qui est en cuisine, pas la personne.
  const quart = { role: "plongeur" };
  assert.equal(S.duRole(quart.role), "cuisine");
  assert.equal(S.valide("les_deux"), "les_deux", "elle reste des deux équipes");
});

// ---------------------------------------------------------------- l'appartenance

test("« les deux » appartient aux deux équipes", () => {
  assert.equal(S.travailleEn("les_deux", "salle"), true);
  assert.equal(S.travailleEn("les_deux", "cuisine"), true);
});

test("un employé d'un seul bord n'apparaît pas dans l'autre grille", () => {
  assert.equal(S.travailleEn("cuisine", "cuisine"), true);
  assert.equal(S.travailleEn("cuisine", "salle"), false);
  assert.equal(S.travailleEn("salle", "salle"), true);
  assert.equal(S.travailleEn("salle", "cuisine"), false);
});

// ---------------------------------------------------------------- les pourboires

test("seule la cuisine PURE ne déclare pas de pourboires", () => {
  // Demande explicite du propriétaire : un employé mixte garde son formulaire, parce qu'il
  // fait des pourboires dès qu'il met le pied sur le plancher.
  assert.equal(S.declarePourboires("salle"), true);
  assert.equal(S.declarePourboires("les_deux"), true);
  assert.equal(S.declarePourboires("cuisine"), false);
});

// ---------------------------------------------------------------- les fragments SQL

test("le fragment SQL d'un quart de cuisine ne nomme que les postes de cuisine", () => {
  const { sql, params } = S.conditionQuartSQL("cuisine");
  assert.match(sql, /^COALESCE\(s\.role, 'server'\) IN \(\?, \?\)$/);
  assert.deepEqual(params, ["cuisinier", "plongeur"]);
});

test("le fragment d'un quart de salle est exactement la négation de l'autre", () => {
  // Les deux doivent se partager TOUS les quarts, sans trou ni recouvrement : un quart qui
  // ne serait dans aucune des deux grilles serait invisible partout.
  const cuisine = S.conditionQuartSQL("cuisine");
  const salle = S.conditionQuartSQL("salle");
  assert.equal(salle.sql, `NOT ${cuisine.sql}`);
  assert.deepEqual(salle.params, cuisine.params);
});

test("le fragment SQL accepte une autre colonne que s.role", () => {
  // La route d'effacement en lot ne donne pas d'alias à sa table.
  assert.match(S.conditionQuartSQL("cuisine", "role").sql, /COALESCE\(role, 'server'\)/);
});

test("le fragment SQL d'une équipe ramasse toujours « les deux »", () => {
  const { sql, params } = S.conditionEmployeSQL("cuisine");
  assert.match(sql, /secteur = \? OR secteur = \?/);
  assert.deepEqual(params, ["cuisine", "les_deux"]);
  assert.deepEqual(S.conditionEmployeSQL("salle").params, ["salle", "les_deux"]);
});

test("les postes de cuisine ne sont listés qu'à un seul endroit", () => {
  // Si schedule-ui.js changeait sa liste sans que celle-ci suive, des quarts disparaîtraient
  // d'une grille sans que rien ne le signale.
  assert.deepEqual(S.ROLES_CUISINE, ["cuisinier", "plongeur"]);
});
