const test = require("node:test");
const assert = require("node:assert");
const Taxes = require("../public/shared/taxes");

test("un reçu dont les montants s'additionnent est cohérent", () => {
  const r = Taxes.verifierCoherence({ sous_total: 100, tps: 5, tvq: 9.98, total: 114.98 });
  assert.strictEqual(r.coherent, true);
  assert.strictEqual(r.ecart, 0);
});

test("un total mal lu est signalé", () => {
  // Le cas qui motive tout le contrôle : le « 1 » de 114,98 sauté à la lecture.
  const r = Taxes.verifierCoherence({ sous_total: 100, tps: 5, tvq: 9.98, total: 14.98 });
  assert.strictEqual(r.coherent, false);
  assert.strictEqual(r.ecart, 100);
});

test("un écart d'un cent par arrondi reste accepté", () => {
  // Refuser ça noierait l'utilisateur sous de faux drapeaux : les caisses arrondissent.
  const r = Taxes.verifierCoherence({ sous_total: 12.35, tps: 0.62, tvq: 1.23, total: 14.19 });
  assert.strictEqual(r.coherent, true);
});

test("les taxes estimées suivent les taux du Québec", () => {
  const e = Taxes.estimerTaxes(100);
  assert.strictEqual(e.tps, 5);
  assert.strictEqual(e.tvq, 9.98);
  assert.strictEqual(e.total, 114.98);
});

test("des taxes sans numéro de fournisseur lèvent une alerte de CTI", () => {
  const a = Taxes.alertesCTI({ fournisseur: "Metro", date: "2026-08-01", tps: 5, tvq: 9.98 });
  assert.ok(a.includes("numeros_taxes_manquants"));
});

test("une facture sans taxe ne réclame pas de numéro de fournisseur", () => {
  // Un petit fournisseur non inscrit ne facture aucune taxe : ce n'est pas une anomalie.
  const a = Taxes.alertesCTI({ fournisseur: "Ferme du coin", date: "2026-08-01", tps: 0, tvq: 0 });
  assert.deepStrictEqual(a, []);
});

test("le champ manquant est nommé plutôt que deviné", () => {
  const a = Taxes.alertesCTI({ tps: 0, tvq: 0 });
  assert.deepStrictEqual(a.sort(), ["date_manquante", "fournisseur_manquant"]);
});
