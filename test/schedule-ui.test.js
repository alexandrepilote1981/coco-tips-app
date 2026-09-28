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
  // Les vrais modules voisins, pas des bouchons : le calcul des heures d'un quart est
  // précisément ce qu'on veut vérifier ici, et un bouchon le remplacerait par une fiction.
  const fenetre = {
    CoutMainOeuvre: require("../public/shared/cout-main-oeuvre.js"),
    Secteurs: require("../public/shared/secteurs.js"),
    Noms: require("../public/shared/noms.js"),
  };
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

// ---------------------------------------------------------------- le plafond d'heures
//
// Un plafond porte sur la PERSONNE, pas sur un poste : « si un employé dit qu'il peut faire
// 20 h, c'est 20 h total, c'est souvent des restrictions de visa étudiant, et le reste est
// indiqué à 40 h vu que je veux pas payer de overtime ». Les heures des deux bords comptent
// donc ensemble, et c'est ce que ces tests vérifient.

const SEMAINE = ["2026-09-28", "2026-09-29", "2026-09-30"];

// Un host minimal : la grille lit ses quarts par là. `ailleurs` sert aux portes par code,
// qui ne reçoivent que les quarts de LEUR secteur et ne pourraient pas compter le reste.
function avecQuarts(quarts, ailleurs) {
  UI.init({
    t: (c) => c,
    icon: () => "",
    lang: () => "fr",
    restaurants: () => [],
    shifts: () => quarts,
    setShifts: () => {},
    reloadShifts: async () => quarts,
    absences: () => [],
    setAbsences: () => {},
    reloadAbsences: async () => [],
    heuresAilleurs: () => ailleurs || [],
    shiftApi: async () => ({}),
    pdfRequest: () => ({ url: "", options: {} }),
    rerender: () => {},
  });
  return new Set(SEMAINE);
}

const quart = (empId, date, debut, fin) => ({ employee_id: empId, date, start_time: debut, end_time: fin });

test("le plafond ne rougit qu'une fois vraiment dépassé", () => {
  const jours = avecQuarts([
    quart("a", SEMAINE[0], "08:00", "18:00"), // 10 h
    quart("a", SEMAINE[1], "08:00", "18:00"), // 10 h → 20 h pile
    quart("c", SEMAINE[0], "08:00", "18:00"),
    quart("c", SEMAINE[1], "08:00", "18:15"), // 20,25 h
    quart("d", SEMAINE[0], "08:00", "12:00"), // 4 h
  ]);

  // Pile au plafond : ce n'est PAS un dépassement. Quelqu'un cédulé exactement à son
  // plafond ne doit pas voir sa rangée rougir chaque semaine.
  assert.equal(UI.bilanEmploye({ id: "a", heures_max: 20 }, jours).depasse, false);
  // Un quart d'heure de plus, oui.
  assert.equal(UI.bilanEmploye({ id: "c", heures_max: 20 }, jours).depasse, true);
  // Sans plafond, jamais.
  assert.equal(UI.bilanEmploye({ id: "a", heures_max: 0 }, jours).depasse, false);
  assert.equal(UI.bilanEmploye({ id: "a" }, jours).depasse, false);
  // Sous le plafond, jamais.
  assert.equal(UI.bilanEmploye({ id: "d", heures_max: 20 }, jours).depasse, false);
});

test("les heures de l'AUTRE bord comptent dans le plafond", () => {
  // LE cas du visa étudiant. Avant, la grille de cuisine ne voyait que ses propres quarts :
  // quelqu'un à 15 h de cuisine et 16 h de salle s'affichait « 15 h / 20 h », en vert, alors
  // qu'il était à 31 h. Le chiffre sur lequel on décide d'ajouter un quart était faux.
  const jours = avecQuarts(
    [quart("mixte", SEMAINE[0], "05:30", "10:30"), quart("mixte", SEMAINE[1], "05:30", "10:30")], // 10 h de cuisine
    [{ employee_id: "mixte", date: SEMAINE[2], heures: 16 }] // 16 h de salle
  );
  const b = UI.bilanEmploye({ id: "mixte", heures_max: 20 }, jours);
  assert.equal(b.heures, 26);
  assert.equal(b.depasse, true, "26 h sur un plafond de 20 h doit rougir");
});

test("les heures d'une autre semaine ne comptent pas", () => {
  const jours = avecQuarts(
    [quart("a", "2026-10-15", "08:00", "18:00")],
    [{ employee_id: "a", date: "2026-10-15", heures: 30 }]
  );
  assert.equal(UI.bilanEmploye({ id: "a", heures_max: 20 }, jours).heures, 0);
});

test("un employé jamais cédulé compte zéro heure plutôt que de faire planter la rangée", () => {
  const jours = avecQuarts([]);
  const r = UI.bilanEmploye({ id: "inconnu", heures_max: 40 }, jours);
  assert.equal(r.heures, 0);
  assert.equal(r.depasse, false);
});

test("un host sans heuresAilleurs() ne fait rien planter", () => {
  // Le tableau de bord a déjà tous les quarts : il ne fournit pas ce raccourci, et il ne
  // doit surtout pas compter les mêmes heures deux fois.
  UI.init({
    t: (c) => c, icon: () => "", lang: () => "fr", restaurants: () => [],
    shifts: () => [quart("a", SEMAINE[0], "08:00", "18:00")],
    setShifts: () => {}, reloadShifts: async () => [], absences: () => [],
    setAbsences: () => {}, reloadAbsences: async () => [], shiftApi: async () => ({}),
    pdfRequest: () => ({ url: "", options: {} }), rerender: () => {},
  });
  assert.equal(UI.bilanEmploye({ id: "a", heures_max: 20 }, new Set(SEMAINE)).heures, 10);
});

test("sans jours — une grille qui ne montre pas les heures — aucune rangée n'est jugée", () => {
  assert.equal(UI.bilanEmploye({ id: "a", heures_max: 1 }, null), null);
});

// ---------------------------------------------------- déjà cédulé de l'autre bord
//
// Le risque que « les deux » a créé : la grille de cuisine ne montre pas les quarts de
// salle, et l'inverse. Rien à l'écran ne dit qu'on inscrit quelqu'un deux fois le même jour.
// C'est un AVERTISSEMENT et jamais un refus — un 05:30-15:00 en cuisine puis un souper en
// salle, ça arrive, et le gérant doit pouvoir le faire.

const quartComplet = (empId, date, debut, fin, role, id) =>
  ({ id: id || `q-${date}-${role}`, employee_id: empId, date, start_time: debut, end_time: fin, role });

test("un quart dans l'AUTRE secteur le même jour est signalé", () => {
  avecQuarts([quartComplet("a", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "a", date: SEMAINE[0], role: "server" });
  assert.equal(r.heures, 9.5);
});

test("un quart du MÊME secteur n'est pas un double", () => {
  // Deux quarts de cuisine le même jour, la grille ne le permet pas de toute façon : poser
  // la question ici ferait sortir un avertissement à chaque simple modification.
  avecQuarts([quartComplet("a", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "a", date: SEMAINE[0], role: "plongeur" });
  assert.equal(r.heures, 0);
});

test("un autre jour ne déclenche rien", () => {
  avecQuarts([quartComplet("a", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  assert.equal(UI.quartsAilleursLeMemeJour({ employee_id: "a", date: SEMAINE[1], role: "server" }).heures, 0);
});

test("le quart d'une autre personne ne déclenche rien", () => {
  avecQuarts([quartComplet("a", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  assert.equal(UI.quartsAilleursLeMemeJour({ employee_id: "b", date: SEMAINE[0], role: "server" }).heures, 0);
});

test("modifier un quart ne le compte pas comme son propre double", () => {
  // Sans ce garde, changer l'heure d'un quart de salle ferait sortir « a déjà un quart dans
  // l'autre équipe » en parlant de lui-même.
  avecQuarts([quartComplet("a", SEMAINE[0], "16:00", "23:00", "server", "LE-SIEN")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "a", date: SEMAINE[0], role: "server", id: "LE-SIEN" });
  assert.equal(r.heures, 0);
});

test("une porte par code compte les heures qu'elle reçoit en complément", () => {
  // Elle ne voit que les quarts de son secteur : sans heuresAilleurs, elle ne pourrait pas
  // savoir que la personne travaille déjà ce jour-là.
  avecQuarts([], [{ employee_id: "a", date: SEMAINE[0], heures: 7 }]);
  assert.equal(UI.quartsAilleursLeMemeJour({ employee_id: "a", date: SEMAINE[0], role: "cuisinier" }).heures, 7);
});

