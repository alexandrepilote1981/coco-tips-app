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

// ------------------------------------------- deux fiches, une seule personne
//
// Signalé par le propriétaire, et c'est LE cas de sa façon de travailler : « Try était
// cédulée mardi cuisine. Je l'ai ajoutée serveuse et ça rien fait. » Ses deux fiches portent
// le même numéro d'employé, mais ce sont deux id différents — la grille ne cherchait que
// l'id de la fiche ouverte, et ne voyait donc jamais le quart de l'autre.

function avecDeuxFiches(quarts) {
  UI.init({
    t: (c) => c, icon: () => "", lang: () => "fr",
    // Le tableau de bord donne TOUT l'effectif du restaurant : c'est là que les deux fiches
    // de la même personne se retrouvent.
    restaurants: () => [{ id: "resto1", employees: [
      { id: "trycia-salle", name: "Trycia Dufour", employee_number: "113" },
      { id: "trycia-cuisine", name: "Trycia Dufour", employee_number: "113" },
      { id: "sarah", name: "Sarah Côté", employee_number: "121" },
      { id: "sans-numero-a", name: "Sans Numero A", employee_number: "" },
      { id: "sans-numero-b", name: "Sans Numero B", employee_number: "" },
    ] }],
    shifts: () => quarts,
    setShifts: () => {}, reloadShifts: async () => [], absences: () => [],
    setAbsences: () => {}, reloadAbsences: async () => [], shiftApi: async () => ({}),
    pdfRequest: () => ({ url: "", options: {} }), rerender: () => {},
  });
}

test("le quart de l'AUTRE fiche déclenche l'avertissement", () => {
  avecDeuxFiches([quartComplet("trycia-cuisine", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "trycia-salle", date: SEMAINE[0], role: "server" });
  assert.equal(r.heures, 9.5, "ajouter un quart de salle doit voir le quart de cuisine de son autre fiche");
});

test("les heures de l'autre fiche comptent dans le plafond", () => {
  avecDeuxFiches([
    quartComplet("trycia-cuisine", SEMAINE[0], "05:30", "15:00", "cuisinier"),
    quartComplet("trycia-salle", SEMAINE[1], "16:00", "23:00", "server"),
  ]);
  const b = UI.bilanEmploye({ id: "trycia-salle", heures_max: 20 }, new Set(SEMAINE));
  assert.equal(b.heures, 16.5, "9,5 h de cuisine + 7 h de salle");
});

test("un numéro VIDE ne rapproche jamais deux personnes", () => {
  // Sans ce garde, toutes les fiches sans matricule n'en feraient qu'une.
  avecDeuxFiches([quartComplet("sans-numero-b", SEMAINE[0], "08:00", "12:00", "plongeur")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "sans-numero-a", date: SEMAINE[0], role: "server" });
  assert.equal(r.heures, 0);
});

test("un numéro différent ne rapproche rien", () => {
  avecDeuxFiches([quartComplet("trycia-cuisine", SEMAINE[0], "05:30", "15:00", "cuisinier")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "sarah", date: SEMAINE[0], role: "server" });
  assert.equal(r.heures, 0);
});

test("modifier le quart de sa PROPRE fiche ne se compte pas comme un double", () => {
  avecDeuxFiches([quartComplet("trycia-salle", SEMAINE[0], "16:00", "23:00", "server", "LE-SIEN")]);
  const r = UI.quartsAilleursLeMemeJour({ employee_id: "trycia-salle", date: SEMAINE[0], role: "server", id: "LE-SIEN" });
  assert.equal(r.heures, 0);
});

// ------------------------------------------------- une couleur par poste
//
// « Quand un employé de la cuisine a un chiffre cuisinier c'est vert, s'il fait un chiffre
// serveuse c'est aussi vert. » Il n'y avait que deux teintes — principal / second — et deux
// postes de bords différents partageaient donc la même. Il en faut une par poste.

test("chaque poste a sa propre classe de couleur", () => {
  assert.equal(UI.classePoste("server"), "server");
  assert.equal(UI.classePoste("hostess"), "hostess");
  assert.equal(UI.classePoste("cuisinier"), "cuisinier");
  assert.equal(UI.classePoste("plongeur"), "plongeur");
});

test("les quatre postes donnent quatre classes DIFFÉRENTES", () => {
  // Le bogue d'origine tenait exactement là : Cuisinier et Serveur tombaient sur la même.
  const classes = ["server", "hostess", "cuisinier", "plongeur"].map(UI.classePoste);
  assert.equal(new Set(classes).size, 4);
});

test("un poste inconnu retombe sur une couleur plutôt que sur aucune", () => {
  // Le nom du poste reste écrit dans la case : mieux vaut une teinte neutre qu'une case
  // sans couleur, qui se lirait comme un quart différent des autres.
  for (const role of [undefined, null, "", "inventé", "SERVER"]) {
    assert.equal(UI.classePoste(role), "server", JSON.stringify(role));
  }
});

test("tous les postes proposés par la grille ont leur couleur", () => {
  // Si schedule-ui ajoutait un poste sans lui donner de teinte, il sortirait en vert comme
  // un Serveur — et ce serait exactement le bogue qu'on vient de corriger.
  for (const secteur of ["salle", "cuisine"]) {
    for (const role of UI.rolesDe(secteur)) {
      assert.equal(UI.classePoste(role), role, `${role} doit avoir sa propre couleur`);
    }
  }
});

// ------------------------------------------- l'heure de fin proposée
//
// « Mets l'heure de fin de quart à 14h30 par défaut, et si c'est différemment je le ferai
// manuellement — même mieux, 14h30 ou 8h max. » Deux règles, et la PLUS COURTE gagne.

test("c'est 14h30 quand les 8 h iraient plus loin", () => {
  assert.equal(UI.finParDefaut("09:00"), "14:30"); // 8 h donnerait 17:00
  assert.equal(UI.finParDefaut("08:00"), "14:30"); // 8 h donnerait 16:00
  assert.equal(UI.finParDefaut("07:00"), "14:30"); // 8 h donnerait 15:00
});

test("ce sont les 8 h quand elles mordent avant 14h30", () => {
  // Le vrai cas de la cuisine : on rentre à 5h30.
  assert.equal(UI.finParDefaut("05:30"), "13:30");
  assert.equal(UI.finParDefaut("05:00"), "13:00");
  assert.equal(UI.finParDefaut("06:00"), "14:00");
});

test("à 6h30 les deux règles tombent sur la même heure", () => {
  assert.equal(UI.finParDefaut("06:30"), "14:30");
});

test("un quart de soir ne se voit pas proposer une fin déjà passée", () => {
  // 14h30 est derrière lui : proposer ça donnerait un quart négatif, ou pire un quart de
  // 23 heures une fois passé par le calcul qui traverse minuit.
  assert.equal(UI.finParDefaut("16:00"), "00:00");
  assert.equal(UI.finParDefaut("18:00"), "02:00");
  assert.equal(UI.finParDefaut("14:30"), "22:30");
});

test("la fin proposée existe vraiment dans la liste d'heures", () => {
  // La liste va par tranches de 15 min : une fin qui n'y serait pas ferait retomber le
  // sélecteur sur 00:00 en silence, et le quart repartirait avec la mauvaise heure.
  const choix = new Set(valeurs(UI.timeOptionsHTML("")));
  for (const h of ["05:00", "05:30", "06:45", "09:00", "11:15", "16:00", "23:45"]) {
    assert.ok(choix.has(UI.finParDefaut(h)), `${h} -> ${UI.finParDefaut(h)} doit être dans la liste`);
  }
});

test("une heure de début illisible ne fait pas planter la fenêtre", () => {
  for (const mauvais of [undefined, null, "", "midi", "99:99"]) {
    assert.equal(UI.finParDefaut(mauvais), "14:30", JSON.stringify(mauvais));
  }
});

test("la fin proposée ne dépasse jamais 8 h", () => {
  const C = require("../public/shared/cout-main-oeuvre.js");
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const debut = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const heures = C.heuresDuQuart({ start_time: debut, end_time: UI.finParDefaut(debut) });
      assert.ok(heures > 0 && heures <= 8 + 1e-9, `${debut} donne ${heures} h`);
    }
  }
});


// ------------------------------------------- la note d'un quart, des deux bords
//
// Elle n'existait qu'en cuisine, où elle est née pour « Prép » et « Commande à défaire ».
// La salle a les siennes — « Fermeture », « Terrasse » — et c'était la demande : « comme pour
// la cuisine, être capable d'ajouter une note dans horaire salle ».

test("la note se lit sur un quart de salle comme sur un quart de cuisine", () => {
  assert.equal(UI.tacheDuQuart({ note: "Fermeture" }), "Fermeture");
  assert.equal(UI.tacheDuQuart({ note: "  Prép  " }), "Prép", "les espaces autour sont rognés");
  assert.equal(UI.tacheDuQuart({ note: "" }), "");
  assert.equal(UI.tacheDuQuart({}), "");
  // Une grille lit des lignes venues du serveur : une ligne sans note ne doit pas planter.
  assert.equal(UI.tacheDuQuart(null), "");
  assert.equal(UI.tacheDuQuart(undefined), "");
});

test("les deux grilles ont la même largeur de colonne", () => {
  // « Ça fonctionne bien côté cuisine, fais la même chose en salle. » Une seule configuration
  // plutôt que deux.
  //
  // Ce test garde surtout un plancher : 62 px suffisaient à « 16:00 » et « Serveur », mais
  // depuis qu'un quart de salle porte une note ils couperaient « Fermeture » en « Ferm… ».
  // Si quelqu'un rabaisse la salle pour regagner de la largeur sur un téléphone, c'est la
  // note qui disparaît en silence.
  assert.equal(UI.COLONNE_MIN.salle, 100);
  assert.equal(UI.COLONNE_MIN.cuisine, 100);
  assert.equal(UI.COLONNE_MIN.salle, UI.COLONNE_MIN.cuisine, "les deux équipes, même grille");
});

test("les listes de tâches récentes ne se mélangent pas entre les deux équipes", () => {
  // Les deux équipes écrivent maintenant des notes. Proposer « Commande à défaire » à une
  // hôtesse rendrait la liste inutilisable des deux bords.
  // `tachesRecentes` lit les quarts par l'hôte, comme en vrai : on lui en fournit un minimal
  // plutôt que de contourner le chemin que la page emprunte réellement.
  UI.init({
    shifts: () => [
      { id: "1", employee_id: "salle1", date: "2026-10-05", start_time: "16:00", role: "server", note: "Fermeture" },
      { id: "2", employee_id: "cuis1", date: "2026-10-05", start_time: "08:00", end_time: "14:00", role: "cuisinier", note: "Prép" },
    ],
  });
  assert.deepEqual(UI.tachesRecentes("salle", [{ id: "salle1" }]), ["Fermeture"]);
  assert.deepEqual(UI.tachesRecentes("cuisine", [{ id: "cuis1" }]), ["Prép"]);
  // Et chacune ne voit que SES gens : le quart de l'autre équipe n'est pas dans sa liste.
  assert.deepEqual(UI.tachesRecentes("salle", [{ id: "cuis1" }]), []);
});
