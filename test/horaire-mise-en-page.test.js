// Mise en page de la feuille d'horaire, testée sans rien dessiner pour de vrai.
//
// Le PDF (pdfkit) et la photo (canvas) partagent ce calcul : une erreur ici casse les deux
// à la fois. On branche donc une fausse surface qui note les ordres de dessin au lieu de
// les exécuter, ce qui permet de vérifier ce qu'aucun rendu ne montre — qu'aucun trait ne
// sort de la feuille, et que personne ne disparaît de la liste.
const test = require("node:test");
const assert = require("node:assert/strict");
const mise = require("../public/shared/horaire-mise-en-page.js");

// Note tout, ne dessine rien.
function surfaceTemoin() {
  const ordres = [];
  const noter = (type) => (...args) => ordres.push({ type, args });
  return {
    ordres,
    rect: noter("rect"),
    rectArrondi: noter("rectArrondi"),
    ligne: noter("ligne"),
    cadre: noter("cadre"),
    texte(contenu, x, y, o = {}) {
      ordres.push({ type: "texte", contenu: String(contenu), x, y, o });
    },
    // Une largeur approchée suffit : seul le rognage du texte s'en sert.
    mesurer(contenu, o = {}) {
      return String(contenu).length * (o.taille || 10) * 0.55;
    },
  };
}

const NOMS = Array.from({ length: 40 }, (_, i) => `Prenom${i} Famille${i}`);

function equipe(n) {
  return NOMS.slice(0, n).map((name, i) => ({ id: `e${i}`, name }));
}

function dessiner(n, options = {}) {
  const employees = equipe(n);
  const shifts = employees.flatMap((e, i) =>
    ["2026-09-21", "2026-09-26"].map((date) => ({
      employee_id: e.id,
      date,
      start_time: i % 2 ? "16:30" : "09:00",
      role: i % 3 ? "server" : "hostess",
    }))
  );
  const surface = surfaceTemoin();
  const hauteur = mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco",
    employees,
    shifts,
    weekStartISO: "2026-09-21",
    lang: "fr",
    ...options,
  });
  return { surface, hauteur, employees };
}

// Le bas atteint par un ordre de dessin, quel qu'il soit.
function basAtteint(ordres) {
  let bas = 0;
  for (const o of ordres) {
    if (o.type === "texte") bas = Math.max(bas, o.y + (o.o.taille || 10) * 1.15);
    else if (o.type === "rect" || o.type === "rectArrondi") bas = Math.max(bas, o.args[1] + o.args[3]);
    else if (o.type === "cadre") bas = Math.max(bas, o.args[1] + o.args[3]);
    else if (o.type === "ligne") bas = Math.max(bas, o.args[1], o.args[3]);
  }
  return bas;
}

for (const n of [1, 11, 12, 20, 40]) {
  test(`${n} employé(s) : rien n'est dessiné hors de la feuille`, () => {
    const { surface } = dessiner(n);
    assert.ok(
      basAtteint(surface.ordres) <= mise.PAGE.hauteur,
      `le dessin descend à ${basAtteint(surface.ordres).toFixed(1)} pour une feuille de ${mise.PAGE.hauteur}`
    );
  });
}

test("personne n'est laissé de côté, même à 40", () => {
  const { surface, employees } = dessiner(40);
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  for (const emp of employees) {
    const prenom = emp.name.split(" ")[0];
    assert.ok(
      textes.some((t) => t.startsWith(prenom)),
      `${prenom} doit être écrit quelque part`
    );
  }
});

test("le nom de famille passe sur la même ligne quand les lignes deviennent basses", () => {
  const court = dessiner(4).surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(court.includes("Prenom0"), "sur une liste courte, le prénom est seul sur sa ligne");
  assert.ok(court.includes("Famille0"), "et le nom de famille juste en dessous");

  const long = dessiner(40).surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(long.includes("Prenom0 Famille0"), "sur une liste longue, les deux tiennent sur une ligne");
});

test("le mode compact rogne la feuille sous le tableau", () => {
  const papier = dessiner(4);
  const compact = dessiner(4, { compact: true });

  assert.equal(papier.hauteur, mise.PAGE.hauteur, "le PDF garde la page A4 entière");
  assert.ok(compact.hauteur < mise.PAGE.hauteur, "l'image est plus courte que la page");
  assert.ok(
    compact.hauteur >= basAtteint(compact.surface.ordres),
    "la hauteur annoncée ne doit jamais couper un élément dessiné"
  );
});

test("une longue liste occupe toute la feuille, compacte ou non", () => {
  const compact = dessiner(40, { compact: true });
  assert.ok(compact.hauteur > mise.PAGE.hauteur * 0.9, "à 40 employés il n'y a presque rien à rogner");
  assert.ok(compact.hauteur <= mise.PAGE.hauteur + 1);
});

test("les colonnes de fin de semaine sont teintées", () => {
  const { surface } = dessiner(3);
  const teintes = surface.ordres.filter(
    (o) => o.type === "rect" && o.args[4] === mise.COULEURS.fondFinSemaine
  );
  assert.equal(teintes.length, 6, "samedi et dimanche, pour chacun des trois employés");
});

test("un restaurant sans employé reste dans la feuille", () => {
  const surface = surfaceTemoin();
  const hauteur = mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco",
    employees: [],
    shifts: [],
    weekStartISO: "2026-09-21",
    lang: "fr",
    compact: true,
  });
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(textes.some((t) => t.includes("Aucun employé")));
  assert.ok(hauteur >= basAtteint(surface.ordres), "le message ne doit pas être rogné");
});

test("le nom de fichier est le même pour le PDF et la photo, à l'extension près", () => {
  const pdf = mise.nomDeFichier("Chez Coco", "2026-09-24", "fr", "pdf");
  const png = mise.nomDeFichier("Chez Coco", "2026-09-24", "fr", "png");
  assert.equal(pdf, "Horaire_Chez-Coco_2026-09-21.pdf", "la date est ramenée au lundi");
  assert.equal(png, "Horaire_Chez-Coco_2026-09-21.png");
  assert.equal(pdf.replace(/pdf$/, "png"), png);
});

test("un nom de restaurant accentué ou vide donne quand même un fichier ouvrable", () => {
  assert.equal(mise.nomDeFichier("Café Été / Nord", "2026-09-21", "fr", "png"), "Horaire_Cafe-Ete-Nord_2026-09-21.png");
  assert.equal(mise.nomDeFichier("", "2026-09-21", "en", "pdf"), "Schedule_restaurant_2026-09-21.pdf");
  assert.equal(mise.nomDeFichier("!!!", "2026-09-21", "fr", "png"), "Horaire_restaurant_2026-09-21.png");
});

test("sur la feuille, le poste et la tâche partagent la même ligne", () => {
  const employees = [{ id: "e0", name: "Lokassa Mbala" }];
  const quarts = [
    { employee_id: "e0", date: "2026-09-21", start_time: "17:30", end_time: "01:30", role: "cuisinier", note: "Prép" },
    { employee_id: "e0", date: "2026-09-23", start_time: "17:30", end_time: "01:30", role: "cuisinier" },
  ];
  const surface = surfaceTemoin();
  mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco", employees, shifts: quarts, weekStartISO: "2026-09-21",
    lang: "fr", avecHeureFin: true, avecTaches: true,
  });
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);

  assert.ok(textes.includes("Cuisinier · Prép"), "les deux, ensemble, quand la place le permet");
  assert.ok(textes.includes("Cuisinier"), "le quart sans tâche garde son poste seul");
  assert.ok(textes.includes("17:30–01:30"), "l'heure de fin est là en cuisine");
});

test("une tâche trop longue pour la colonne fait céder le poste, jamais l'inverse", () => {
  const employees = [{ id: "e0", name: "Lokassa Mbala" }];
  const longue = "augmente Lim 18car"; // la tâche la plus longue possible
  const surface = surfaceTemoin();
  mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco",
    employees,
    shifts: [{ employee_id: "e0", date: "2026-09-21", start_time: "17:30", end_time: "01:30", role: "plongeur", note: longue }],
    weekStartISO: "2026-09-21",
    lang: "fr",
    avecHeureFin: true,
    avecTaches: true,
  });
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(textes.includes(longue), "la tâche survit");
  assert.ok(!textes.some((x) => x.startsWith("Plongeur ·")), "le poste s'efface plutôt que de la tronquer");
});

test("en salle, la tâche n'apparaît pas même si elle est enregistrée", () => {
  const employees = [{ id: "e0", name: "Marie Tremblay" }];
  const surface = surfaceTemoin();
  mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco",
    employees,
    shifts: [{ employee_id: "e0", date: "2026-09-21", start_time: "09:00", end_time: "17:00", role: "server", note: "Prép" }],
    weekStartISO: "2026-09-21",
    lang: "fr",
  });
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(!textes.includes("Prép"), "les tâches sont réservées à la cuisine");
  assert.ok(textes.includes("Serveur"));
});

test("la limite de longueur d'une tâche est dictée par la mise en page", () => {
  assert.equal(typeof mise.TACHE_MAX, "number");
  // Les tâches réelles du restaurant doivent tenir : c'est à ça que sert ce chiffre.
  for (const tache of ["Prép", "Prise de commande", "Commande à défaire"]) {
    assert.ok(tache.length <= mise.TACHE_MAX, `« ${tache} » (${tache.length}) doit tenir dans ${mise.TACHE_MAX}`);
  }
});

// ---------------------------------------------------------------- jours fériés

// La semaine du 4 mai 2026 porte la fête des Mères (dimanche 10) ; celle du 18 mai porte la
// Journée des patriotes (lundi 18). Deux semaines réelles, choisies pour couvrir les deux
// familles : une occasion et un férié.
function dessinerSemaine(weekStartISO, n = 4, options = {}) {
  const employees = equipe(n);
  const surface = surfaceTemoin();
  const hauteur = mise.dessinerHoraire(surface, {
    restaurantName: "Chez Coco",
    employees,
    shifts: [],
    weekStartISO,
    lang: "fr",
    ...options,
  });
  return { surface, hauteur, textes: surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu) };
}

test("la feuille nomme le jour férié de la semaine", () => {
  const { textes } = dessinerSemaine("2026-05-18");
  assert.ok(textes.includes("Journée des patriotes"), `patriotes manquant : ${textes.join(" | ")}`);
});

test("la fête des Mères est écrite et teintée à part des fériés", () => {
  const { surface, textes } = dessinerSemaine("2026-05-04");
  assert.ok(textes.includes("Fête des Mères"));

  const occasion = surface.ordres.filter((o) => o.type === "rect" && o.args[4] === mise.COULEURS.occasionFond);
  // L'en-tête plus une bande par employé : la couleur descend sur toute la colonne.
  assert.equal(occasion.length, 5, "en-tête + 4 rangées");
  const ferie = surface.ordres.filter((o) => o.type === "rect" && o.args[4] === mise.COULEURS.ferieFond);
  assert.equal(ferie.length, 0, "cette semaine-là ne contient aucun férié de la loi");
});

test("la teinte du férié couvre la même colonne que son nom", () => {
  const { surface } = dessinerSemaine("2026-05-04");
  const nom = surface.ordres.find((o) => o.type === "texte" && o.contenu === "Fête des Mères");
  const bandes = surface.ordres.filter((o) => o.type === "rect" && o.args[4] === mise.COULEURS.occasionFond);
  for (const b of bandes) {
    assert.ok(Math.abs(b.args[0] - (nom.x - 3)) < 0.01, "la bande est sous le nom, pas à côté");
  }
});

test("un dimanche férié garde sa couleur de férié, pas celle du week-end", () => {
  // La fête des Mères tombe TOUJOURS un dimanche : si la teinte de fin de semaine
  // l'emportait, la journée la plus occupée de l'année serait grise comme les autres.
  const { surface } = dessinerSemaine("2026-05-04");
  const dimanche = surface.ordres.filter(
    (o) => o.type === "rect" && o.args[4] === mise.COULEURS.fondFinSemaine
  );
  assert.equal(dimanche.length, 4, "seul le samedi reste gris, pour chacun des 4 employés");
});

test("une semaine ordinaire n'affiche aucune couleur de férié", () => {
  const { surface } = dessinerSemaine("2026-09-21");
  const teintes = surface.ordres.filter(
    (o) => o.type === "rect" && (o.args[4] === mise.COULEURS.ferieFond || o.args[4] === mise.COULEURS.occasionFond)
  );
  assert.equal(teintes.length, 0);
});

test("un nom de férié trop long pour la colonne passe à sa version courte", () => {
  // « Journée des patriotes » ne tient pas dans une colonne de jour ; « Patriotes », oui.
  // Ce qu'on refuse, c'est « Journée des patr… », qui ne dit plus rien.
  const surface = surfaceTemoin();
  // Une mesure volontairement pessimiste : tout paraît deux fois trop large.
  const mesurerLarge = (contenu, o = {}) => String(contenu).length * (o.taille || 10) * 1.6;
  mise.dessinerHoraire({ ...surface, mesurer: mesurerLarge }, {
    restaurantName: "Chez Coco", employees: equipe(3), shifts: [], weekStartISO: "2026-05-18", lang: "fr",
  });
  const textes = surface.ordres.filter((o) => o.type === "texte").map((o) => o.contenu);
  assert.ok(textes.includes("Patriotes"), `version courte attendue : ${textes.join(" | ")}`);
  assert.ok(!textes.includes("Journée des patriotes"));
});

test("les fériés sont écrits en anglais sur une feuille en anglais", () => {
  const { textes } = dessinerSemaine("2026-05-04", 3, { lang: "en" });
  assert.ok(textes.includes("Mother's Day"), textes.join(" | "));
});

for (const n of [1, 14, 40]) {
  test(`${n} employé(s) : une semaine avec férié tient encore sur la feuille`, () => {
    const { surface } = dessinerSemaine("2026-05-04", n);
    assert.ok(
      basAtteint(surface.ordres) <= mise.PAGE.hauteur,
      `le dessin descend à ${basAtteint(surface.ordres).toFixed(1)}`
    );
  });
}
