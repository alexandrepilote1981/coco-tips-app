const test = require("node:test");
const assert = require("node:assert");
const { decouperDataUrl, SCHEMA } = require("../extraction");

test("une data URL JPEG est découpée en type et contenu", () => {
  const { mediaType, base64 } = decouperDataUrl("data:image/jpeg;base64,AAAA");
  assert.strictEqual(mediaType, "image/jpeg");
  assert.strictEqual(base64, "AAAA");
});

test("un faux type d'image est refusé avant tout appel réseau", () => {
  // La même liste blanche que côté serveur : sans elle, « data:image/html » passait.
  assert.throws(() => decouperDataUrl("data:image/html;base64,AAAA"), /non supporté/);
});

test("une chaîne qui n'est pas une data URL est refusée", () => {
  assert.throws(() => decouperDataUrl("bonjour"), /invalide/);
});

test("le schéma exige tous les champs et interdit les extras", () => {
  // L'API n'applique la contrainte que si les deux sont présents : une régression ici
  // rendrait la sortie libre sans qu'aucun appel n'échoue.
  assert.strictEqual(SCHEMA.additionalProperties, false);
  for (const cle of Object.keys(SCHEMA.properties)) {
    assert.ok(SCHEMA.required.includes(cle), `${cle} devrait être requis`);
  }
});

test("chaque montant peut être null", () => {
  // Un null honnête vaut mieux qu'un montant inventé sur un reçu froissé.
  for (const cle of ["sous_total", "tps", "tvq", "total"]) {
    assert.deepStrictEqual(SCHEMA.properties[cle].type, ["number", "null"]);
  }
});
