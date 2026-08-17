// Tests du calcul des pourboires. Aucune dépendance : node:test est intégré à Node 18+.
// Lancer avec : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeEntry, applyComputed, toNumber } = require("../public/shared/tip-math.js");

// Les montants sont calculés en virgule flottante : 16.8 − 12 vaut 4.800000000000001 et non
// 4.8. C'est le comportement normal de JavaScript, invisible pour l'utilisateur puisque
// l'affichage arrondit aux cents. On compare donc au centième près plutôt qu'à l'identique.
function assertMontant(actual, expected, message) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    message || `attendu ${expected}, obtenu ${actual}`
  );
}

test("une journée normale : brut, net et moyenne", () => {
  const r = computeEntry({ ventes: 420, clients: 30, pct: 4, remis: 12 });
  assertMontant(r.pourboireBrut, 16.8); // 420 × 4 %
  assertMontant(r.net, 4.8); // 16.80 − 12
  assertMontant(r.moyenne, 14); // 420 ÷ 30
});

test("une journée sans client ne divise pas par zéro", () => {
  const r = computeEntry({ ventes: 200, clients: 0, pct: 5, remis: 0 });
  assert.equal(r.moyenne, 0);
  assert.ok(Number.isFinite(r.moyenne));
});

test("les valeurs saisies au clavier arrivent en texte et doivent être converties", () => {
  const r = computeEntry({ ventes: "420", clients: "30", pct: "4", remis: "12" });
  assert.equal(r.ventes, 420);
  assert.equal(typeof r.ventes, "number");
  assertMontant(r.pourboireBrut, 16.8);
  assertMontant(r.net, 4.8);
});

test("une saisie illisible vaut zéro et ne produit jamais NaN", () => {
  // C'est précisément ici que les deux anciennes versions divergeaient : le serveur
  // renvoyait NaN, le navigateur 0.
  const r = computeEntry({ ventes: "abc", clients: "", pct: undefined, remis: null });
  assert.equal(r.ventes, 0);
  assert.equal(r.pourboireBrut, 0);
  assert.equal(r.net, 0);
  assert.equal(r.moyenne, 0);
  for (const champ of ["ventes", "clients", "pct", "remis", "pourboireBrut", "net", "moyenne"]) {
    assert.ok(Number.isFinite(r[champ]), `${champ} doit rester un nombre fini`);
  }
});

test("les champs absents valent zéro", () => {
  const r = computeEntry({});
  assert.deepEqual(
    { v: r.ventes, c: r.clients, p: r.pct, rm: r.remis, b: r.pourboireBrut, n: r.net, m: r.moyenne },
    { v: 0, c: 0, p: 0, rm: 0, b: 0, n: 0, m: 0 }
  );
});

test("un net négatif est conservé : c'est le cas où l'employeur doit un virement", () => {
  const r = computeEntry({ ventes: 100, clients: 5, pct: 3, remis: 50 });
  assert.equal(r.pourboireBrut, 3);
  assert.equal(r.net, -47);
});

test("les décimales des pourcentages sont respectées", () => {
  const r = computeEntry({ ventes: 1000, clients: 40, pct: 3.5, remis: 0 });
  assert.equal(r.pourboireBrut, 35);
  assert.equal(r.moyenne, 25);
});

test("computeEntry ne modifie pas l'objet reçu et conserve les autres champs", () => {
  const source = { id: "abc123", date: "2026-08-17", ventes: "50", photo_filename: "x.jpg" };
  const r = computeEntry(source);
  assert.equal(source.ventes, "50", "l'objet d'origine ne doit pas être modifié");
  assert.equal(r.id, "abc123");
  assert.equal(r.date, "2026-08-17");
  assert.equal(r.photo_filename, "x.jpg", "les champs non calculés doivent survivre");
});

test("applyComputed modifie l'objet sur place, comme l'attend l'affichage", () => {
  const entry = { ventes: "420", clients: "30", pct: "4", remis: "12" };
  const retour = applyComputed(entry);
  assertMontant(entry.pourboireBrut, 16.8);
  assert.equal(entry.ventes, 420);
  assert.equal(retour, entry, "doit retourner le même objet, pas une copie");
});

test("toNumber couvre les cas limites", () => {
  assert.equal(toNumber(12.5), 12.5);
  assert.equal(toNumber("12,5"), 12, "une virgule décimale s'arrête à la virgule");
  assert.equal(toNumber(""), 0);
  assert.equal(toNumber(null), 0);
  assert.equal(toNumber(undefined), 0);
  assert.equal(toNumber(NaN), 0);
  assert.equal(toNumber(Infinity), 0, "un infini ne doit pas contaminer les totaux");
  assert.equal(toNumber("30 clients"), 30);
});
