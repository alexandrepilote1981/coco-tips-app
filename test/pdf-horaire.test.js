// Le PDF de l'horaire doit TOUJOURS tenir sur une seule page.
//
// Pourquoi ce fichier existe : la feuille est affichée au mur. Une deuxième page se
// décroche, se perd, ou se lit sans la première — et rien à l'écran ne prévient que le PDF
// a débordé. Avant, la mise en page coupait la liste à onze employés ; le douzième partait
// sur une page que personne ne voyait. C'est exactement le genre de régression qui repasse
// inaperçue, d'où ces tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { buildSchedulePdf } = require("../pdf-horaire.js");

// Nombre de pages, lu dans l'objet /Pages du PDF.
function nombreDePages(buf) {
  const m = /\/Count (\d+)/.exec(buf.toString("latin1"));
  assert.ok(m, "le PDF doit déclarer son nombre de pages");
  return Number(m[1]);
}

// Texte dessiné, reconstitué depuis les flux de contenu. pdfkit écrit chaque mot en
// hexadécimal dans un tableau TJ, entrecoupé des décalages de crénage.
function texteDessine(buf) {
  let sortie = "";
  let i = 0;
  while ((i = buf.indexOf("stream", i)) !== -1) {
    let debut = i + 6;
    if (buf[debut] === 13) debut++;
    if (buf[debut] === 10) debut++;
    const fin = buf.indexOf("endstream", debut);
    if (fin < 0) break;
    try {
      sortie += zlib.inflateSync(buf.subarray(debut, fin)).toString("latin1");
    } catch {
      /* flux non compressé (polices, etc.) : sans intérêt ici */
    }
    i = fin + 9;
  }
  return [...sortie.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .map((m) => [...m[1].matchAll(/<([0-9A-Fa-f]+)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""))
    .join(" | ");
}

const NOMS = [
  "Marie Tremblay", "Marie Bergeron-Lalonde", "Alexandre Roy", "Jean Marc Tremblay",
  "Sophie Gagnon", "Luc Bouchard", "Émilie Côté", "Nicolas Fortin", "Camille Lavoie",
  "Olivier Roy", "Sarah Bélanger", "Thomas Pelletier", "Chloé Morin", "Antoine Girard",
  "Laura Dubé", "Maxime Caron", "Julie Simard", "Félix Cloutier", "Noémie Paquette",
  "Samuel Ouellet", "Rosalie Dion", "Vincent Lemieux", "Amélie Boucher", "Gabriel Nadeau",
  "Léa Poulin", "Mathieu Richard", "Anne Grenier", "Hugo Bergeron", "Clara Mercier",
  "Étienne Leblanc", "Zoé Martel", "Philippe Aubry", "Maude Cyr", "Raphaël Hébert",
  "Alice Turcotte", "Benoît Doyon", "Karine Vézina", "Simon Lachance", "Iris Marcoux",
  "Pascal Côté",
];

function equipe(n) {
  return NOMS.slice(0, n).map((name, i) => ({ id: `e${i}`, name }));
}

function quartsDeLaSemaine(employees) {
  const shifts = [];
  employees.forEach((e, i) => {
    for (const date of ["2026-09-21", "2026-09-23", "2026-09-26"]) {
      shifts.push({ employee_id: e.id, date, start_time: i % 2 ? "16:30" : "09:00", end_time: "23:00", role: "server" });
    }
  });
  return shifts;
}

function horaire(n, extra = []) {
  const employees = equipe(n);
  return buildSchedulePdf({
    restaurantName: "Chez Coco",
    weekStartISO: "2026-09-21",
    employees,
    shifts: [...quartsDeLaSemaine(employees), ...extra],
    lang: "fr",
  });
}

// 11 employés tenaient sur l'ancienne mise en page ; 12 était le premier débordement.
for (const n of [1, 4, 11, 12, 20, 40]) {
  test(`${n} employé(s) tiennent sur une seule page`, async () => {
    assert.equal(nombreDePages(await horaire(n)), 1);
  });
}

test("un restaurant sans employé produit quand même une page lisible", async () => {
  const buf = await buildSchedulePdf({
    restaurantName: "Chez Coco",
    weekStartISO: "2026-09-21",
    employees: [],
    shifts: [],
    lang: "fr",
  });
  assert.equal(nombreDePages(buf), 1);
  assert.match(texteDessine(buf), /Aucun employé/);
});

test("personne n'est laissé de côté quand la liste est longue", async () => {
  // Le vrai risque en rétrécissant les lignes : couper la liste au lieu de la comprimer.
  const texte = texteDessine(await horaire(40));
  for (const nom of NOMS) {
    const prenom = nom.split(" ")[0];
    assert.ok(texte.includes(prenom), `${prenom} doit apparaître dans le PDF`);
  }
});

test("deux quarts le même jour restent tous les deux visibles, même serrés", async () => {
  const doubles = [
    { employee_id: "e1", date: "2026-09-25", start_time: "08:00", end_time: "12:00", role: "server" },
    { employee_id: "e1", date: "2026-09-25", start_time: "17:00", end_time: "22:00", role: "hostess" },
  ];

  // Lignes hautes : deux pastilles empilées.
  const petit = texteDessine(await horaire(4, doubles));
  assert.ok(petit.includes("08:00"), "la première heure doit être là");
  assert.ok(petit.includes("17:00"), "la seconde aussi");

  // Lignes basses : une seule pastille qui porte les deux heures.
  const grand = texteDessine(await horaire(40, doubles));
  assert.ok(grand.includes("08:00 / 17:00"), "les deux heures doivent partager une pastille");
});

test("le pied de page n'annonce plus un numéro de page", async () => {
  const texte = texteDessine(await horaire(12));
  assert.match(texte, /Généré le/);
  assert.doesNotMatch(texte, /Page \d/, "un compteur de pages n'a plus de sens sur une page unique");
});

test("l'anglais produit lui aussi une page unique", async () => {
  const employees = equipe(20);
  const buf = await buildSchedulePdf({
    restaurantName: "Chez Coco",
    weekStartISO: "2026-09-21",
    employees,
    shifts: quartsDeLaSemaine(employees),
    lang: "en",
  });
  assert.equal(nombreDePages(buf), 1);
  assert.match(texteDessine(buf), /Generated on/);
});
