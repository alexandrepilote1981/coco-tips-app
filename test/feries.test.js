// Les dates de fériés se calculent, elles ne se saisissent pas. Ce fichier est ce qui permet
// de le faire sans crainte : si un jour Pâques ou la fête des Mères tombait à côté, toute la
// grille afficherait une couleur sur le mauvais jour, et personne ne le verrait avant que le
// restaurant soit à court de monde.

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../public/shared/feries.js");

test("Pâques tombe aux bonnes dates", () => {
  // Valeurs connues, vérifiables dans n'importe quel calendrier.
  const attendu = {
    2024: "2024-03-31",
    2025: "2025-04-20",
    2026: "2026-04-05",
    2027: "2027-03-28",
    2028: "2028-04-16",
    2030: "2030-04-21",
  };
  for (const [annee, date] of Object.entries(attendu)) {
    assert.equal(F.paques(Number(annee)).toISOString().slice(0, 10), date, `Pâques ${annee}`);
  }
});

test("Vendredi saint et lundi de Pâques encadrent Pâques", () => {
  for (const annee of [2026, 2027, 2028]) {
    const liste = F.feriesDeLAnnee(annee);
    const dimanche = F.paques(annee).toISOString().slice(0, 10);
    const vendredi = liste.find((f) => f.cle === "vendrediSaint").date;
    const lundi = liste.find((f) => f.cle === "lundiPaques").date;
    const ecart = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
    assert.equal(ecart(vendredi, dimanche), 2, `vendredi saint ${annee}`);
    assert.equal(ecart(dimanche, lundi), 1, `lundi de Pâques ${annee}`);
  }
});

test("la fête des Mères est le deuxième dimanche de mai", () => {
  const attendu = { 2025: "2025-05-11", 2026: "2026-05-10", 2027: "2027-05-09", 2028: "2028-05-14" };
  for (const [annee, date] of Object.entries(attendu)) {
    const f = F.ferieDuJour(date);
    assert.ok(f, `rien le ${date}`);
    assert.equal(f.cle, "feteDesMeres");
    // C'est une journée d'affluence, pas un férié : elle ne change rien à la paie.
    assert.equal(f.type, "occasion");
    assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 0, "un dimanche");
  }
});

test("la Journée des patriotes est le lundi précédant le 25 mai", () => {
  for (const annee of [2024, 2025, 2026, 2027, 2028, 2029]) {
    const f = F.feriesDeLAnnee(annee).find((x) => x.cle === "patriotes");
    const d = new Date(`${f.date}T12:00:00Z`);
    assert.equal(d.getUTCDay(), 1, `${f.date} devrait être un lundi`);
    const numero = d.getUTCDate();
    assert.ok(numero >= 18 && numero <= 24, `${f.date} hors de la fenêtre 18–24 mai`);
  }
});

test("fête du Travail et Action de grâce tombent sur leur lundi", () => {
  const attendu = {
    2026: { feteDuTravail: "2026-09-07", actionDeGrace: "2026-10-12" },
    2027: { feteDuTravail: "2027-09-06", actionDeGrace: "2027-10-11" },
  };
  for (const [annee, jours] of Object.entries(attendu)) {
    const liste = F.feriesDeLAnnee(Number(annee));
    for (const [cle, date] of Object.entries(jours)) {
      assert.equal(liste.find((f) => f.cle === cle).date, date, `${cle} ${annee}`);
    }
  }
});

test("les dates fixes sont là, quelle que soit l'année", () => {
  for (const annee of [2026, 2031]) {
    const parCle = Object.fromEntries(F.feriesDeLAnnee(annee).map((f) => [f.cle, f.date]));
    assert.equal(parCle.jourDeLAn, `${annee}-01-01`);
    assert.equal(parCle.feteNationale, `${annee}-06-24`);
    assert.equal(parCle.feteDuCanada, `${annee}-07-01`);
    assert.equal(parCle.noel, `${annee}-12-25`);
  }
});

test("les huit fériés du Québec sont tous là", () => {
  const feries = F.feriesDeLAnnee(2026).filter((f) => f.type === "ferie");
  assert.equal(feries.length, 9, "huit fériés, dont deux au choix pour Pâques");
  assert.deepEqual(
    feries.map((f) => f.cle),
    ["jourDeLAn", "vendrediSaint", "lundiPaques", "patriotes", "feteNationale", "feteDuCanada", "feteDuTravail", "actionDeGrace", "noel"]
  );
});

test("la liste est en ordre de date", () => {
  const dates = F.feriesDeLAnnee(2026).map((f) => f.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("une journée ordinaire ne renvoie rien", () => {
  assert.equal(F.ferieDuJour("2026-03-17"), null);
  assert.equal(F.ferieDuJour("2026-09-21"), null);
});

test("une date abîmée ne fait pas planter la grille", () => {
  // La grille demande le férié de chaque jour affiché : une valeur inattendue doit rendre
  // « aucun férié », jamais lever — sinon toute la semaine cesse de s'afficher.
  for (const valeur of [null, undefined, "", "pas une date", "2026-13-45x", 20260101, {}]) {
    assert.equal(F.ferieDuJour(valeur), null, `pour ${JSON.stringify(valeur)}`);
  }
  assert.deepEqual(F.feriesDeLAnnee("pas une année"), []);
});

test("les libellés existent dans les deux langues", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    for (const lang of ["fr", "en"]) {
      assert.ok(F.libelle(f.cle, lang).length > 0, `${f.cle} en ${lang}`);
      assert.ok(F.libelleCourt(f.cle, lang).length > 0, `${f.cle} court en ${lang}`);
    }
  }
  assert.equal(F.libelle("feteDesMeres", "fr"), "Fête des Mères");
  assert.equal(F.libelle("feteDesMeres", "en"), "Mother's Day");
});

test("le nom court n'est jamais plus long que le nom complet", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    for (const lang of ["fr", "en"]) {
      assert.ok(
        F.libelleCourt(f.cle, lang).length <= F.libelle(f.cle, lang).length,
        `${f.cle} en ${lang} : « ${F.libelleCourt(f.cle, lang)} » n'est pas plus court`
      );
    }
  }
});

test("demander deux fois la même date donne la même réponse", () => {
  // Le résultat est mis en cache par année : le cache ne doit pas rendre un objet abîmé au
  // deuxième appel.
  const a = F.ferieDuJour("2026-05-10");
  const b = F.ferieDuJour("2026-05-10");
  assert.deepEqual(a, b);
  assert.equal(b.cle, "feteDesMeres");
});

// ---------------------------------------------------------------- affluence

test("les grosses journées de restaurant sont marquées comme telles", () => {
  const attendu = {
    "2027-02-14": "saintValentin",
    "2027-03-28": "dimanchePaques",
    "2027-05-09": "feteDesMeres",
    "2027-06-20": "feteDesPeres",
    "2027-10-11": "actionDeGrace",
  };
  for (const [date, cle] of Object.entries(attendu)) {
    const f = F.ferieDuJour(date);
    assert.ok(f, `rien le ${date}`);
    assert.equal(f.cle, cle);
    assert.equal(f.affluence, true, `${cle} devrait remplir la salle`);
  }
});

test("la fête des Pères est le troisième dimanche de juin", () => {
  const attendu = { 2026: "2026-06-21", 2027: "2027-06-20", 2028: "2028-06-18" };
  for (const [annee, date] of Object.entries(attendu)) {
    const f = F.feriesDeLAnnee(Number(annee)).find((x) => x.cle === "feteDesPeres");
    assert.equal(f.date, date, `fête des Pères ${annee}`);
    assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 0, "un dimanche");
  }
});

test("le dimanche de Pâques tombe entre Vendredi saint et lundi de Pâques", () => {
  for (const annee of [2026, 2027, 2028]) {
    const liste = F.feriesDeLAnnee(annee);
    const parCle = Object.fromEntries(liste.map((f) => [f.cle, f]));
    assert.equal(parCle.dimanchePaques.date, F.paques(annee).toISOString().slice(0, 10));
    assert.ok(parCle.vendrediSaint.date < parCle.dimanchePaques.date);
    assert.ok(parCle.dimanchePaques.date < parCle.lundiPaques.date);
    // Le dimanche n'est PAS un férié de la loi, contrairement aux deux qui l'encadrent.
    assert.equal(parCle.dimanchePaques.type, "occasion");
    assert.equal(parCle.vendrediSaint.type, "ferie");
  }
});

test("un férié tranquille n'est pas une grosse journée", () => {
  for (const cle of ["jourDeLAn", "vendrediSaint", "lundiPaques", "patriotes", "feteNationale", "feteDuCanada", "feteDuTravail", "noel"]) {
    const f = F.feriesDeLAnnee(2027).find((x) => x.cle === cle);
    assert.equal(f.affluence, false, `${cle} ne devrait pas être marqué « salle pleine »`);
  }
});

test("l'Action de grâce est les deux à la fois", () => {
  const f = F.ferieDuJour("2027-10-11");
  assert.equal(f.type, "ferie", "la paie change");
  assert.equal(f.affluence, true, "et la salle se remplit");
});

test("« férié » se dit en mots, jamais par la couleur", () => {
  // Toutes les journées marquées portent la même teinte : c'est le NOM qui dit laquelle, et
  // l'infobulle qui ajoute « férié » là où ça compte. Rien dans le module ne rend une
  // couleur — l'affichage n'a donc aucune teinte à choisir.
  assert.equal(F.estFerie(F.ferieDuJour("2027-12-25")), true, "Noël");
  assert.equal(F.estFerie(F.ferieDuJour("2027-10-11")), true, "Action de grâce");
  assert.equal(F.estFerie(F.ferieDuJour("2027-05-09")), false, "la fête des Mères n'est pas un férié");
  assert.equal(F.estFerie(null), false);
  for (const lang of ["fr", "en"]) assert.ok(F.mentionFerie(lang).length > 0);
  assert.equal(typeof F.teinte, "undefined", "plus aucune notion de teinte dans le module");
});

test("toutes les journées portent les deux champs", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    assert.ok(["ferie", "occasion"].includes(f.type), `${f.cle} : type inattendu`);
    assert.equal(typeof f.affluence, "boolean", `${f.cle} : affluence manquante`);
  }
});

test("aucune journée n'en écrase une autre le même jour", () => {
  // Deux entrées à la même date rendraient l'une des deux invisible : seule la dernière
  // survivrait à l'index. Pâques encadrée de ses deux fériés est le cas serré.
  for (const annee of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
    const dates = F.feriesDeLAnnee(annee).map((f) => f.date);
    assert.equal(new Set(dates).size, dates.length, `doublon de date en ${annee}`);
  }
});
