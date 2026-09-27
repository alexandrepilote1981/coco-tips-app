// Le plafond de tentatives. Ce fichier existe parce que ce code a deux jobs qui tirent en
// sens contraire : empêcher de deviner un code de 6 caractères, et ne jamais barrer une
// employée dont le code est bon. On s'est fait prendre une fois — toute une équipe bloquée
// parce qu'elle partage un WiFi — et c'est ici qu'on s'assure que ça ne revient pas.

const test = require("node:test");
const assert = require("node:assert/strict");
const RL = require("../rate-limit.js");

// Chaque test utilise son propre « bucket » : l'état est global au module, et des tests qui
// se marchent dessus donneraient des échecs qui n'ont rien à voir avec ce qu'ils vérifient.
let compteur = 0;
const seau = () => `essai-${++compteur}`;
const ip = (adresse) => ({ ip: adresse });
const UN = ip("10.0.0.1");
const AUTRE = ip("10.0.0.2");

test("une adresse neuve n'est pas bloquée", () => {
  assert.equal(RL.blocageSecondes(seau(), UN), 0);
});

test("le MÊME mauvais code réessayé vingt fois ne bloque personne", () => {
  // Le cas réel : Messenger coupe le lien en deux, l'employée réessaie. C'est un échec,
  // pas vingt.
  const b = seau();
  for (let i = 0; i < 20; i++) RL.noteFailure(b, UN, "ABC123");
  assert.equal(RL.blocageSecondes(b, UN), 0);
});

test("dix codes DIFFÉRENTS bloquent, comme avant", () => {
  // Une force brute change forcément de code à chaque coup : elle atteint le plafond aussi
  // vite qu'avant la correction.
  const b = seau();
  for (let i = 0; i < RL.MAX_FAILURES; i++) RL.noteFailure(b, UN, `CODE${i}`);
  assert.ok(RL.blocageSecondes(b, UN) > 0, "le plafond doit toujours mordre");
});

test("le plafond mord pile au bon nombre, pas avant", () => {
  const b = seau();
  for (let i = 0; i < RL.MAX_FAILURES - 1; i++) RL.noteFailure(b, UN, `X${i}`);
  assert.equal(RL.blocageSecondes(b, UN), 0, "un essai sous le plafond ne bloque pas");
  RL.noteFailure(b, UN, "DERNIER");
  assert.ok(RL.blocageSecondes(b, UN) > 0);
});

test("un blocage ne déborde pas sur une autre adresse", () => {
  const b = seau();
  for (let i = 0; i < 15; i++) RL.noteFailure(b, UN, `C${i}`);
  assert.ok(RL.blocageSecondes(b, UN) > 0);
  assert.equal(RL.blocageSecondes(b, AUTRE), 0, "le voisin n'a rien fait");
});

test("un blocage ne déborde pas sur un autre guichet", () => {
  // Rater son code employé ne doit pas fermer la porte de l'horaire.
  const employe = seau();
  const horaire = seau();
  for (let i = 0; i < 15; i++) RL.noteFailure(employe, UN, `C${i}`);
  assert.ok(RL.blocageSecondes(employe, UN) > 0);
  assert.equal(RL.blocageSecondes(horaire, UN), 0);
});

// ---------------------------------------------------------------- codes déjà connus

test("un code déjà utilisé avec succès passe malgré un blocage", () => {
  // LE cas qui a fait naître cette mécanique : Trycia a ouvert son lien hier depuis le WiFi
  // du restaurant ; une collègue rate dix codes aujourd'hui ; Trycia doit continuer d'entrer.
  const b = seau();
  RL.noteSuccess(b, UN, "TRYCIA");
  for (let i = 0; i < 15; i++) RL.noteFailure(b, UN, `MAUVAIS${i}`);

  assert.ok(RL.blocageSecondes(b, UN) > 0, "l'adresse est bien bloquée");
  assert.equal(RL.estConnu(b, UN, "TRYCIA"), true, "mais son code reste connu");
});

test("un code inconnu ne passe pas pendant un blocage — c'est toute la sécurité", () => {
  // Si un bon code passait ici et qu'un mauvais recevait 429, l'attaquant aurait une réponse
  // « oui / non » à volonté et le plafond ne servirait plus à rien.
  const b = seau();
  RL.noteSuccess(b, UN, "CONNU1");
  for (let i = 0; i < 15; i++) RL.noteFailure(b, UN, `M${i}`);
  assert.equal(RL.estConnu(b, UN, "JAMAISVU"), false);
  assert.equal(RL.estConnu(b, UN, ""), false);
  assert.equal(RL.estConnu(b, UN, null), false);
});

test("connaître un code sur une adresse ne le rend pas connu ailleurs", () => {
  const b = seau();
  RL.noteSuccess(b, UN, "PARTAGE");
  assert.equal(RL.estConnu(b, UN, "PARTAGE"), true);
  assert.equal(RL.estConnu(b, AUTRE, "PARTAGE"), false, "l'attaquant est sur une autre adresse");
});

test("connaître un code à un guichet ne l'ouvre pas à l'autre", () => {
  const employe = seau();
  const horaire = seau();
  RL.noteSuccess(employe, UN, "ABC123");
  assert.equal(RL.estConnu(horaire, UN, "ABC123"), false);
});

test("la mémoire des codes connus ne grossit pas sans fin", () => {
  // Sinon une seule adresse pourrait faire enfler la mémoire du serveur indéfiniment.
  const b = seau();
  for (let i = 0; i < RL.CONNUS_MAX + 10; i++) RL.noteSuccess(b, UN, `CODE${i}`);
  assert.equal(RL.estConnu(b, UN, `CODE${RL.CONNUS_MAX + 9}`), true, "le plus récent est gardé");
  assert.equal(RL.estConnu(b, UN, "CODE0"), false, "le plus ancien a cédé sa place");
});

test("réussir avec un code déjà connu ne le fait pas compter deux fois", () => {
  const b = seau();
  for (let i = 0; i < 30; i++) RL.noteSuccess(b, UN, "TOUJOURSLEMEME");
  assert.equal(RL.estConnu(b, UN, "TOUJOURSLEMEME"), true);
});

// ---------------------------------------------------------------- mots de passe

test("sans marque — les mots de passe — chaque essai compte", () => {
  // Pour /admin il n'y a rien à vérifier avant d'essayer : chaque mauvais mot de passe est
  // un vrai essai, et on ne peut pas les dédupliquer.
  const b = seau();
  for (let i = 0; i < RL.MAX_FAILURES; i++) RL.noteFailure(b, UN);
  assert.ok(RL.blocageSecondes(b, UN) > 0);
});

test("une bonne connexion efface l'ardoise", () => {
  const b = seau();
  for (let i = 0; i < RL.MAX_FAILURES - 1; i++) RL.noteFailure(b, UN);
  RL.clearFailures(b, UN);
  for (let i = 0; i < RL.MAX_FAILURES - 1; i++) RL.noteFailure(b, UN);
  assert.equal(RL.blocageSecondes(b, UN), 0, "le compteur est bien reparti de zéro");
});

test("une requête sans adresse identifiable ne fait pas planter le compteur", () => {
  const b = seau();
  assert.doesNotThrow(() => RL.noteFailure(b, {}, "X"));
  assert.doesNotThrow(() => RL.noteSuccess(b, {}, "X"));
  assert.equal(RL.estConnu(b, {}, "X"), true, "même sans IP, la mécanique reste cohérente");
});

test("le message d'attente reste lisible", () => {
  const b = seau();
  for (let i = 0; i < 15; i++) RL.noteFailure(b, UN, `Z${i}`);
  const secondes = RL.blocageSecondes(b, UN);
  assert.ok(secondes > 0 && secondes <= RL.BLOCK_MS / 1000);
});
