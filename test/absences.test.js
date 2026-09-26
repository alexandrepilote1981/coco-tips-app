// Congés et vacances posés d'avance.
//
// Ce que ces tests protègent : une absence qui ne couvre pas la bonne journée ne fait rien
// planter — elle laisse simplement céduler quelqu'un qui avait demandé congé, et personne ne
// s'en aperçoit avant que la personne ne se présente pas.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../public/shared/absences.js");

const VACANCES = { id: "v1", employee_id: "marie", date_debut: "2026-07-20", date_fin: "2026-07-26", type: "vacances" };
const CONGE = { id: "c1", employee_id: "marie", date_debut: "2026-07-04", date_fin: "2026-07-04", type: "conge" };

test("une plage couvre ses deux bornes, et rien à côté", () => {
  assert.equal(A.couvre(VACANCES, "2026-07-20"), true, "le premier jour compte");
  assert.equal(A.couvre(VACANCES, "2026-07-26"), true, "le dernier aussi");
  assert.equal(A.couvre(VACANCES, "2026-07-23"), true);
  assert.equal(A.couvre(VACANCES, "2026-07-19"), false);
  assert.equal(A.couvre(VACANCES, "2026-07-27"), false);
});

test("une date illisible ne couvre rien plutôt que de couvrir tout", () => {
  for (const mauvais of ["", null, undefined, "2026-7-20", "hier"]) {
    assert.equal(A.couvre(VACANCES, mauvais), false);
  }
  assert.equal(A.couvre(null, "2026-07-20"), false);
});

test("une fin laissée vide fait une absence d'une seule journée", () => {
  // C'est le cas le plus courant : un congé d'un jour. Obliger à retaper la même date deux
  // fois ferait rater des demandes.
  const a = A.normaliser({ employee_id: "x", date_debut: "2026-07-04" });
  assert.equal(a.date_fin, "2026-07-04");
  assert.equal(A.nombreDeJours(a), 1);
});

test("des bornes à l'envers sont remises dans l'ordre plutôt que refusées", () => {
  const a = A.normaliser({ employee_id: "x", date_debut: "2026-07-26", date_fin: "2026-07-20" });
  assert.equal(a.date_debut, "2026-07-20");
  assert.equal(a.date_fin, "2026-07-26");
  assert.equal(A.couvre(a, "2026-07-23"), true);
});

test("une absence sans dates exploitables est refusée", () => {
  assert.equal(A.normaliser({ date_debut: "pas une date" }), null);
  assert.equal(A.normaliser({}), null);
  assert.equal(A.normaliser(null), null);
});

test("un type inconnu retombe sur « congé » au lieu de casser l'affichage", () => {
  assert.equal(A.normaliser({ date_debut: "2026-07-04", type: "sabbatique" }).type, "conge");
  assert.equal(A.typeValide("vacances"), "vacances");
  assert.equal(A.libelleType("n'importe quoi", "fr"), "Congé");
});

test("on retrouve l'absence de la bonne personne, la bonne journée", () => {
  const toutes = [VACANCES, CONGE, { id: "x", employee_id: "luc", date_debut: "2026-07-22", date_fin: "2026-07-22" }];
  assert.equal(A.absenceDuJour(toutes, "marie", "2026-07-22").id, "v1");
  assert.equal(A.absenceDuJour(toutes, "marie", "2026-07-04").id, "c1");
  assert.equal(A.absenceDuJour(toutes, "marie", "2026-07-15"), null);
  assert.equal(A.absenceDuJour(toutes, "luc", "2026-07-22").id, "x", "le congé de Marie n'est pas celui de Luc");
  assert.equal(A.absenceDuJour(toutes, "inconnu", "2026-07-22"), null);
});

test("quand deux absences se chevauchent, les vacances l'emportent", () => {
  const chevauche = { id: "c2", employee_id: "marie", date_debut: "2026-07-22", date_fin: "2026-07-22", type: "conge" };
  assert.equal(A.absenceDuJour([chevauche, VACANCES], "marie", "2026-07-22").type, "vacances");
  assert.equal(A.absenceDuJour([VACANCES, chevauche], "marie", "2026-07-22").type, "vacances");
});

test("un quart cédulé pendant une absence est signalé — c'est tout l'intérêt", () => {
  const quarts = [
    { id: "q1", employee_id: "marie", date: "2026-07-22" }, // en plein dans ses vacances
    { id: "q2", employee_id: "marie", date: "2026-07-15" }, // hors absence
    { id: "q3", employee_id: "luc", date: "2026-07-22" }, // pas la même personne
  ];
  const trouves = A.conflits([VACANCES, CONGE], quarts);
  assert.equal(trouves.length, 1);
  assert.equal(trouves[0].quart.id, "q1");
  assert.equal(trouves[0].absence.type, "vacances");
});

test("aucune absence, aucun conflit — et aucune exception", () => {
  assert.deepEqual(A.conflits([], [{ id: "q", employee_id: "x", date: "2026-07-01" }]), []);
  assert.deepEqual(A.conflits(null, null), []);
});

test("les prochaines absences sont triées, et celle en cours reste dedans", () => {
  const tard = { employee_id: "a", date_debut: "2026-08-01", date_fin: "2026-08-01" };
  const passee = { employee_id: "a", date_debut: "2026-06-01", date_fin: "2026-06-02" };
  const encours = { employee_id: "a", date_debut: "2026-07-01", date_fin: "2026-07-31" };

  const liste = A.prochaines([tard, passee, encours, CONGE], "2026-07-10");
  assert.deepEqual(liste.map((a) => a.date_debut), ["2026-07-01", "2026-08-01"]);
  assert.ok(
    liste.some((a) => a.date_debut === "2026-07-01"),
    "une période déjà commencée est plus pertinente que jamais, pas moins"
  );
});

test("sans date de référence, on garde tout", () => {
  assert.equal(A.prochaines([CONGE, VACANCES]).length, 2);
});

test("prochaines() ne réordonne pas la liste d'origine", () => {
  const source = [VACANCES, CONGE];
  A.prochaines(source, "2026-01-01");
  assert.equal(source[0].id, "v1", "le tableau reçu doit rester intact");
});

test("une période s'écrit sans répéter le mois inutilement", () => {
  assert.equal(A.fmtPeriode(VACANCES, "fr"), "20 au 26 juillet 2026");
  assert.equal(A.fmtPeriode(CONGE, "fr"), "4 juillet 2026");
  assert.equal(
    A.fmtPeriode({ date_debut: "2026-07-28", date_fin: "2026-08-03" }, "fr"),
    "28 juillet au 3 août 2026",
    "à cheval sur deux mois, les deux mois s'écrivent"
  );
  assert.equal(A.fmtPeriode(VACANCES, "en"), "July 20 to 26, 2026", "l'anglais met le mois devant");
  assert.equal(A.fmtPeriode(CONGE, "en"), "July 4, 2026");
  assert.equal(A.fmtPeriode({ date_debut: "2026-07-28", date_fin: "2026-08-03" }, "en"), "July 28 to August 3, 2026");
});

test("le nombre de jours compte les deux bornes", () => {
  assert.equal(A.nombreDeJours(VACANCES), 7, "du lundi au dimanche fait une semaine");
  assert.equal(A.nombreDeJours(CONGE), 1);
  assert.equal(A.nombreDeJours({ date_debut: "2026-07-28", date_fin: "2026-08-03" }), 7, "même à cheval sur deux mois");
  assert.equal(A.nombreDeJours({}), 0);
});
