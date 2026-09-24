// Coût de la main-d'œuvre d'une semaine d'horaire.
//
// Ces chiffres servent à décider si on fait rentrer quelqu'un une heure plus tard. Une
// erreur ici ne plante rien : elle donne un montant crédible mais faux, sur lequel des
// décisions se prennent. D'où ces tests, y compris sur l'exemple exact qui a motivé la
// fonctionnalité.
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../public/shared/cout-main-oeuvre.js");

function presque(reel, attendu, message) {
  assert.ok(
    Number.isFinite(reel) && Math.abs(reel - attendu) < 1e-9,
    message || `attendu ${attendu}, obtenu ${reel}`
  );
}

const SEMAINE = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

test("un quart de jour dure ce qu'il a l'air de durer", () => {
  presque(c.heuresDuQuart({ start_time: "09:00", end_time: "17:00" }), 8);
  presque(c.heuresDuQuart({ start_time: "11:30", end_time: "19:45" }), 8.25);
});

test("un quart qui franchit minuit ne compte pas en négatif", () => {
  // La fermeture de cuisine : 5 h 30 du matin jusqu'à 1 h 30 la nuit suivante.
  presque(c.heuresDuQuart({ start_time: "05:30", end_time: "01:30" }), 20);
  presque(c.heuresDuQuart({ start_time: "18:00", end_time: "02:00" }), 8);
});

test("un quart sans heures lisibles vaut zéro, jamais NaN", () => {
  for (const q of [{}, { start_time: "abc", end_time: "17:00" }, { start_time: "09:00" }, { start_time: "25:00", end_time: "26:00" }]) {
    assert.equal(c.heuresDuQuart(q), 0);
  }
  assert.equal(c.heuresDuQuart(null), 0);
});

test("l'exemple du gérant : reculer l'entrée d'une heure sur trois jours", () => {
  // « Lokassa est payé 18,50 $/h, 3 jours de 17 h 30 à 1 h 30 (8 h/quart). Si on le fait
  //   rentrer à 18 h 30 ces 3 mêmes jours, on économise 55,50 $. »
  const lokassa = [{ id: "lok", taux_horaire: 18.5 }];
  const jours = ["2026-09-21", "2026-09-22", "2026-09-23"];

  const avant = c.coutSurPeriode(
    lokassa,
    jours.map((date) => ({ employee_id: "lok", date, start_time: "17:30", end_time: "01:30" })),
    SEMAINE,
    0
  );
  const apres = c.coutSurPeriode(
    lokassa,
    jours.map((date) => ({ employee_id: "lok", date, start_time: "18:30", end_time: "01:30" })),
    SEMAINE,
    0
  );

  presque(avant.heures, 24);
  presque(avant.cout, 444);
  presque(apres.heures, 21);
  presque(apres.cout, 388.5);
  presque(c.ecart(apres, avant).cout, -55.5, "l'économie annoncée par le gérant");
});

test("le total additionne tout le monde, et chacun garde son détail", () => {
  const equipe = [
    { id: "a", taux_horaire: 18.5 },
    { id: "b", taux_horaire: 16 },
    { id: "c", taux_horaire: 20 }, // jamais cédulé cette semaine
  ];
  const quarts = [
    { employee_id: "a", date: "2026-09-21", start_time: "09:00", end_time: "17:00" },
    { employee_id: "a", date: "2026-09-22", start_time: "09:00", end_time: "17:00" },
    { employee_id: "b", date: "2026-09-21", start_time: "17:00", end_time: "23:00" },
  ];
  const r = c.coutSurPeriode(equipe, quarts, SEMAINE, 0);

  presque(r.heures, 22);
  presque(r.cout, 8 * 2 * 18.5 + 6 * 16);
  presque(r.parEmploye.a.heures, 16);
  presque(r.parEmploye.b.cout, 96);
  presque(r.parEmploye.c.heures, 0, "un employé sans quart pèse zéro, mais existe");
  assert.equal(r.parEmploye.c.quarts, 0);
});

test("les journées hors de la semaine affichée ne sont pas comptées", () => {
  const equipe = [{ id: "a", taux_horaire: 20 }];
  const quarts = [
    { employee_id: "a", date: "2026-09-20", start_time: "09:00", end_time: "17:00" }, // dimanche d'avant
    { employee_id: "a", date: "2026-09-23", start_time: "09:00", end_time: "17:00" },
    { employee_id: "a", date: "2026-09-28", start_time: "09:00", end_time: "17:00" }, // lundi d'après
  ];
  presque(c.coutSurPeriode(equipe, quarts, SEMAINE, 0).heures, 8);
});

test("les quarts d'un autre employé ne se mélangent pas", () => {
  const quarts = [{ employee_id: "autre", date: "2026-09-21", start_time: "09:00", end_time: "17:00" }];
  presque(c.coutSurPeriode([{ id: "a", taux_horaire: 20 }], quarts, SEMAINE, 0).heures, 0);
});

test("le pourcentage de charges s'ajoute par-dessus le salaire", () => {
  const equipe = [{ id: "a", taux_horaire: 20 }];
  const quarts = [{ employee_id: "a", date: "2026-09-21", start_time: "09:00", end_time: "19:00" }];

  presque(c.coutSurPeriode(equipe, quarts, SEMAINE, 0).cout, 200, "à 0 %, c'est le salaire nu");
  presque(c.coutSurPeriode(equipe, quarts, SEMAINE, 15).cout, 230);
  presque(c.tauxEffectif({ taux_horaire: 18.5 }, 15), 21.275);
});

test("un employé cédulé sans taux est signalé plutôt que caché", () => {
  const equipe = [
    { id: "a", taux_horaire: 18.5 },
    { id: "b" }, // taux jamais entré
    { id: "c", taux_horaire: 0 },
  ];
  const quarts = ["a", "b", "c"].map((id) => ({
    employee_id: id,
    date: "2026-09-21",
    start_time: "09:00",
    end_time: "17:00",
  }));
  const r = c.coutSurPeriode(equipe, quarts, SEMAINE, 0);

  presque(r.heures, 24, "leurs heures comptent quand même");
  presque(r.cout, 8 * 18.5, "mais ils n'ajoutent rien au coût");
  assert.equal(r.sansTaux, 2, "et on sait qu'il en manque deux");
});

test("un taux illisible ne contamine pas le total", () => {
  const equipe = [{ id: "a", taux_horaire: "18,50" }, { id: "b", taux_horaire: null }];
  const quarts = ["a", "b"].map((id) => ({ employee_id: id, date: "2026-09-21", start_time: "09:00", end_time: "17:00" }));
  const r = c.coutSurPeriode(equipe, quarts, SEMAINE, 0);
  assert.ok(Number.isFinite(r.cout), "le total doit rester un nombre");
  presque(r.cout, 8 * 18, "« 18,50 » s'arrête à la virgule, comme partout ailleurs dans l'app");
});

test("une semaine vide coûte zéro sans planter", () => {
  const r = c.coutSurPeriode([], [], SEMAINE, 10);
  assert.equal(r.heures, 0);
  assert.equal(r.cout, 0);
  assert.equal(r.sansTaux, 0);
  assert.deepEqual(r.parEmploye, {});
});

test("les montants s'écrivent aux cents, dans les deux langues", () => {
  assert.equal(c.fmtMontant(444, "fr"), "444,00 $");
  assert.equal(c.fmtMontant(444, "en"), "$444.00");
  assert.equal(c.fmtMontant(-55.5, "fr"), "-55,50 $");
  assert.equal(c.fmtHeures(8, "fr"), "8 h");
  assert.equal(c.fmtHeures(8.25, "fr"), "8,25 h");
});

test("l'écart porte son signe, pour se lire d'un coup d'œil", () => {
  assert.equal(c.fmtEcart(-55.5, "fr"), "− 55,50 $");
  assert.equal(c.fmtEcart(120, "fr"), "+ 120,00 $");
  assert.equal(c.fmtEcart(0, "fr"), "0,00 $");
  assert.equal(c.fmtEcart(0.001, "fr"), "0,00 $", "un écart d'un dixième de cent n'est pas un écart");
});
