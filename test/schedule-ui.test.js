// La grille d'horaire est du JavaScript de navigateur, mais tout n'y touche pas au DOM :
// ce qui n'y touche pas se teste ici, sans navigateur, et ça vaut la peine — c'est du code
// que seul un œil humain couvrait jusqu'ici.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Le fichier s'installe dans `window` : on lui en fournit un faux. Rien à son niveau racine
// ne touche au DOM, seulement l'intérieur des fonctions.
function chargerScheduleUI() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "schedule-ui.js"), "utf8");
  const fenetre = {};
  new Function("window", source)(fenetre);
  return fenetre.ScheduleUI;
}

const UI = chargerScheduleUI();

function valeurs(html) {
  return [...html.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
}

test("la liste d'heures couvre les 24 heures, par quarts d'heure", () => {
  const options = valeurs(UI.timeOptionsHTML(""));
  assert.equal(options.length, 96, "24 heures × 4");
  assert.equal(options[0], "00:00");
  assert.equal(options[options.length - 1], "23:45");
});

test("une fermeture de cuisine après minuit existe dans la liste", () => {
  // Elle n'y était pas : le sélecteur retombait sur 05:00 et le quart perdait son heure de
  // fin en silence — donc ses heures, donc son coût.
  const options = valeurs(UI.timeOptionsHTML(""));
  for (const heure of ["01:30", "02:00", "23:00", "04:45"]) {
    assert.ok(options.includes(heure), `${heure} doit pouvoir être choisie`);
  }
});

test("l'heure déjà enregistrée ressort sélectionnée", () => {
  const html = UI.timeOptionsHTML("01:30");
  assert.match(html, /value="01:30" selected/);
  assert.equal([...html.matchAll(/selected/g)].length, 1, "une seule option sélectionnée");
});

test("une heure inconnue ne sélectionne rien plutôt que de choisir à notre place", () => {
  const html = UI.timeOptionsHTML("01:07");
  assert.doesNotMatch(html, /selected/);
});

test("chaque secteur propose ses propres postes", () => {
  assert.deepEqual(UI.rolesDe("cuisine"), ["cuisinier", "plongeur"]);
  assert.deepEqual(UI.rolesDe("salle"), ["server", "hostess"]);
  assert.deepEqual(UI.rolesDe(undefined), ["server", "hostess"], "la salle est le défaut");
  assert.deepEqual(UI.rolesDe("patron"), ["server", "hostess"], "un secteur inconnu ne casse rien");
});

test("tous les postes proposés ont un libellé dans les deux langues", () => {
  for (const secteur of ["salle", "cuisine"]) {
    for (const poste of UI.rolesDe(secteur)) {
      assert.ok(UI.ROLES[poste], `${poste} doit exister`);
      assert.ok(UI.ROLES[poste].fr && UI.ROLES[poste].en, `${poste} doit être traduit`);
    }
  }
});

test("une tâche est échappée avant d'être posée dans la grille", () => {
  // La grille se construit par concaténation de chaînes : une tâche contenant « < »
  // casserait l'affichage de toute la semaine.
  assert.equal(UI.echapper('<b>"Prép" & co</b>'), "&lt;b&gt;&quot;Prép&quot; &amp; co&lt;/b&gt;");
  assert.equal(UI.echapper(null), "");
  assert.equal(UI.echapper("Prép"), "Prép");
});
