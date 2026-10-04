// Le mot de passe du lien gérant de cuisine : le poser, le vérifier.
//
// Pourquoi ce fichier existe. Le lien du gérant de cuisine est la porte la plus chargée de
// l'app : elle montre les salaires, la masse salariale, ET les codes d'accès personnels de
// toute l'équipe de cuisine — chacun étant la clé de la page de quelqu'un. Un lien se fait
// suivre : on le colle dans un texto, on change de gérant, le téléphone se perd. Un lien
// PLUS un mot de passe, beaucoup moins.
//
// Les deux autres portes d'horaire n'en ont pas et n'en veulent pas : celle de la salle est
// partagée à toute l'équipe, celle des cuisiniers aussi, et ni l'une ni l'autre ne montre un
// sou. Un mot de passe sur un lien qu'on envoie dans un groupe de quinze personnes, c'est un
// mot de passe que quinze personnes connaissent — donc pas un mot de passe.
//
// CE QU'ON NE GARDE PAS : le mot de passe lui-même. La base ne contient que `sel:empreinte`,
// calculé par scrypt. Même en ouvrant le fichier SQLite on ne peut pas le relire. Ça compte
// parce que les gens réemploient leurs mots de passe ailleurs, et parce que la sauvegarde
// téléchargeable emporte la base avec elle.
//
// LE PIÈGE DE PERFORMANCE, MESURÉ. scrypt coûte 81 ms par calcul sur ce serveur, et c'est le
// but : ça rend une attaque hors ligne lente. Mais la page d'horaire fait cinq appels rien
// qu'à l'ouverture, et le serveur n'a qu'un fil d'exécution — recalculer à chaque requête
// l'aurait gelé presque une demi-seconde, pendant laquelle personne d'autre n'est servi.
// Deux décisions en découlent :
//
//   1. Le calcul est ASYNCHRONE (`crypto.scrypt`, pas `scryptSync`). Même une tentative ratée
//      ne bloque plus le serveur pour les autres.
//   2. Un mot de passe DÉJÀ VÉRIFIÉ est retenu quelques minutes. La clé du cache est la paire
//      (empreinte stockée, mot de passe essayé) : une mauvaise réponse n'y est jamais, donc
//      celui qui cherche à deviner repaie les 81 ms à chaque coup. Le cache aide les vraies
//      personnes et personne d'autre.
//
// Il vit en mémoire et repart à zéro au redéploiement, comme le plafond de tentatives. On ne
// l'écrit pas en base : ce serait garder une trace de qui s'est connecté quand, et on n'en a
// pas besoin.

const crypto = require("node:crypto");

const LONGUEUR = 32;
const SEL_OCTETS = 16;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200; // de quoi couvrir quelques gérants, pas de quoi grossir sans fin

const verifies = new Map(); // "empreinte|motDePasse" -> expiration

function scrypt(motDePasse, sel) {
  return new Promise((resoudre, rejeter) => {
    crypto.scrypt(motDePasse, sel, LONGUEUR, (err, cle) => (err ? rejeter(err) : resoudre(cle)));
  });
}

/**
 * Ce qu'on écrit en base pour ce mot de passe. Une chaîne vide veut dire « aucun mot de
 * passe » — c'est l'état d'avant, et il reste atteignable : le gérant doit pouvoir enlever
 * le verrou aussi facilement qu'il l'a mis.
 *
 * Le mot de passe n'est PAS rogné ni mis en minuscules : « 1212 » et « 1212 » avec une espace
 * sont deux mots de passe différents, et deviner lequel la personne voulait vraiment, c'est
 * la façon la plus sûre de lui en refuser un qu'elle tape correctement. On rogne seulement
 * pour décider s'il est vide.
 */
async function poser(motDePasse) {
  const brut = motDePasse == null ? "" : String(motDePasse);
  if (brut.trim() === "") return "";
  const sel = crypto.randomBytes(SEL_OCTETS);
  const cle = await scrypt(brut, sel);
  return `${sel.toString("hex")}:${cle.toString("hex")}`;
}

function retenir(cle) {
  const maintenant = Date.now();
  for (const [k, expiration] of verifies) if (expiration < maintenant) verifies.delete(k);
  if (!verifies.has(cle) && verifies.size >= CACHE_MAX) verifies.delete(verifies.keys().next().value);
  verifies.set(cle, maintenant + CACHE_MS);
}

/**
 * Y a-t-il un mot de passe sur cette valeur stockée ?
 *
 * Toute valeur non vide compte, même une qu'on n'arrive pas à lire. C'est le sens qui ferme :
 * une colonne abîmée — un fichier recopié à la main, une migration manquée — doit refuser
 * tout le monde, pas ouvrir à tout le monde. La version d'avant demandait un « : » dans la
 * chaîne, donc n'importe quel caractère de travers rendait la porte libre d'accès.
 */
function estPose(stocke) {
  return typeof stocke === "string" && stocke.trim() !== "";
}

/**
 * Le mot de passe essayé correspond-il à ce qui est en base ?
 *
 * Rend `true` quand AUCUN mot de passe n'est posé : c'est la porte ouverte d'avant, et c'est
 * l'appelant qui décide s'il veut en exiger un.
 */
async function verifier(motDePasse, stocke) {
  if (!estPose(stocke)) return true;
  const essai = motDePasse == null ? "" : String(motDePasse);
  if (essai === "") return false;

  const cleCache = `${stocke}|${essai}`;
  const expiration = verifies.get(cleCache);
  if (expiration && expiration > Date.now()) return true;

  const [selHex, attenduHex] = stocke.split(":");
  // Buffer.from ne lève pas sur du texte qui n'est pas de l'hexadécimal : il s'arrête au
  // premier caractère illisible et rend un tampon plus court. C'est la LONGUEUR qui tranche,
  // des deux côtés — un sel vide donnerait sinon une empreinte parfaitement calculable.
  const sel = Buffer.from(selHex || "", "hex");
  const attendu = Buffer.from(attenduHex || "", "hex");
  if (sel.length !== SEL_OCTETS || attendu.length !== LONGUEUR) return false;

  const cle = await scrypt(essai, sel);
  // timingSafeEqual et pas `===` : comparer deux chaînes s'arrête au premier caractère qui
  // diffère, et le temps de réponse raconte alors combien de caractères étaient bons.
  const bon = crypto.timingSafeEqual(cle, attendu);
  if (bon) retenir(cleCache);
  return bon;
}

// Pour les tests : repartir d'une ardoise vierge.
function _viderCache() {
  verifies.clear();
}

module.exports = { poser, verifier, estPose, _viderCache, CACHE_MS, CACHE_MAX };
