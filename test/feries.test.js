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
