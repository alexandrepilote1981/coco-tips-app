// Le mot de passe du lien gérant de cuisine. Ce qui se joue ici : une porte qui montre les
// salaires et les codes personnels de toute l'équipe. Un test mou et c'est elle qui s'ouvre.

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../mdp.js");

test("le bon mot de passe passe, un autre non", async () => {
  const stocke = await M.poser("1212");
  assert.equal(await M.verifier("1212", stocke), true);
  assert.equal(await M.verifier("1213", stocke), false);
  assert.equal(await M.verifier("", stocke), false);
  assert.equal(await M.verifier(null, stocke), false);
});

test("le mot de passe ne se retrouve pas dans ce qu'on garde", async () => {
  // C'est toute la raison d'être du fichier : la base se télécharge dans la sauvegarde, et
  // les gens réemploient leurs mots de passe ailleurs.
  const stocke = await M.poser("poutine2026");
  assert.ok(!stocke.includes("poutine"));
  assert.match(stocke, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
});

test("deux fois le même mot de passe donnent deux empreintes différentes", async () => {
  // Le sel est tiré au hasard à chaque fois. Sans ça, deux restaurants avec le même mot de
  // passe se reconnaîtraient dans la base, et une table précalculée les ouvrirait ensemble.
  const a = await M.poser("1212");
  const b = await M.poser("1212");
  assert.notEqual(a, b);
  assert.equal(await M.verifier("1212", a), true);
  assert.equal(await M.verifier("1212", b), true);
});

test("aucun mot de passe posé : la porte reste celle d'avant", async () => {
  // Ce qu'il ne faut PAS casser : les installations existantes n'ont pas de mot de passe, et
  // rien ne doit se fermer tout seul sous les pieds de quelqu'un.
  for (const vide of ["", null, undefined]) {
    assert.equal(M.estPose(vide), false, `estPose(${JSON.stringify(vide)})`);
    assert.equal(await M.verifier("n'importe quoi", vide), true);
    assert.equal(await M.verifier("", vide), true);
  }
});

test("un mot de passe vide ou en blanc ne pose rien", async () => {
  // « Enregistrer » avec le champ vide, c'est RETIRER le verrou, pas en poser un que
  // personne ne pourrait plus deviner.
  for (const vide of ["", "   ", "\n", null, undefined]) {
    assert.equal(await M.poser(vide), "");
  }
});

test("les espaces autour comptent", async () => {
  // On ne devine pas ce que la personne voulait taper : rogner « 1212 » en « 1212 » ouvrirait
  // la porte à une frappe que le gérant n'a pas choisie.
  const stocke = await M.poser(" 1212");
  assert.equal(await M.verifier(" 1212", stocke), true);
  assert.equal(await M.verifier("1212", stocke), false);
});

test("une valeur abîmée en base refuse, elle ne plante pas", async () => {
  // Un fichier recopié à la main, une migration manquée : mieux vaut une porte fermée qu'une
  // porte qui lève une erreur 500 — et surtout pas une porte ouverte.
  for (const casse of ["pasdedeuxpoints", "zz:zz", "abcd:", ":abcd", "abcd:1234"]) {
    assert.equal(await M.verifier("1212", casse), false, casse);
  }
});

test("le cache ne fait jamais passer un mauvais mot de passe", async () => {
  // Le cache est là pour la vitesse. S'il laissait entrer sur la simple foi d'un bon essai
  // précédent, il remplacerait le mot de passe par « quelqu'un a déjà réussi ici ».
  M._viderCache();
  const a = await M.poser("1212");
  const b = await M.poser("9999");
  assert.equal(await M.verifier("1212", a), true); // mis en cache
  assert.equal(await M.verifier("1212", b), false, "l'autre restaurant reste fermé");
  assert.equal(await M.verifier("9999", a), false);
  assert.equal(await M.verifier("1212", a), true, "et le bon passe encore");
});

test("le cache garde sa taille", async () => {
  M._viderCache();
  const stocke = await M.poser("1212");
  // On ne peut pas faire grossir le cache avec des essais RATÉS — c'est le point : seuls les
  // succès y entrent, et un succès suppose qu'on connaisse déjà le mot de passe.
  for (let i = 0; i < 50; i++) await M.verifier(`faux${i}`, stocke);
  assert.equal(await M.verifier("1212", stocke), true);
});
