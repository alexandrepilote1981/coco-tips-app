// Plafond de tentatives, en mémoire, sans dépendance externe.
//
// Principe : on ne compte QUE les échecs. Un employé qui rafraîchit sa page vingt fois
// avec un code valide n'est jamais gêné ; c'est celui qui enchaîne les codes faux ou les
// mauvais mots de passe qui se fait ralentir. C'est ce qui rend un code court (6 caractères)
// ou un mot de passe court (4 chiffres) inattaquable par force brute, sans compliquer la vie
// des vraies personnes.
//
// ---------------------------------------------------------------------------------------
// LE PROBLÈME QU'ON A EU, ET POURQUOI IL Y A DEUX MÉCANIQUES DE PLUS
//
// Le compte se fait par adresse Internet. Dans un restaurant, toute l'équipe est sur le même
// WiFi — donc UNE seule adresse. Dix codes faux en quinze minutes, et c'est tout le monde
// qui est bloqué, y compris les gens dont le code est bon. La protection était censée ne
// jamais déranger les vraies personnes ; elle les dérangeait.
//
// Deux corrections, qui visent chacune un cas réel sans rien affaiblir :
//
// 1. ON NE COMPTE QUE LES CODES DISTINCTS. Une employée dont le lien s'est fait couper en
//    deux par Messenger réessaie huit fois LE MÊME mauvais code : c'est un échec, pas huit.
//    Une attaque par force brute, elle, essaie forcément un code différent à chaque coup —
//    elle atteint donc le plafond aussi vite qu'avant.
//
// 2. UN CODE DÉJÀ UTILISÉ AVEC SUCCÈS DEPUIS CETTE ADRESSE PASSE TOUJOURS. Si Trycia a
//    ouvert son lien hier depuis le WiFi du restaurant, son code continue de marcher même
//    si une collègue vient d'en rater dix. Ça ne donne rien à un attaquant : pour qu'un code
//    soit « connu » de son adresse, il faut qu'il l'ait déjà utilisé avec succès — donc
//    qu'il l'ait déjà.
//
// Ce qu'on ne fait SURTOUT pas : laisser passer un code valide pendant un blocage sans cette
// mémoire. Répondre 200 pour un bon code et 429 pour un mauvais, c'est répondre « oui / non »
// à volonté — le plafond ne servirait plus à rien. Pendant un blocage, un code inconnu reçoit
// toujours la même réponse, quel qu'il soit.
//
// La limite honnête : quelqu'un qui ouvre son lien pour la PREMIÈRE fois pendant que son
// WiFi est bloqué doit attendre la fin du blocage. C'est rare, et ça se règle tout seul.
// ---------------------------------------------------------------------------------------
//
// L'état vit en mémoire : il repart à zéro à chaque redéploiement, et il n'est pas partagé
// entre plusieurs instances. C'est assez pour un service à une instance comme celui-ci. On
// ne l'écrit pas en base exprès : ça reviendrait à garder une trace durable de quelle
// adresse Internet a ouvert quel code, et on n'a pas besoin de ça.

const WINDOW_MS = 15 * 60 * 1000; // fenêtre d'observation : 15 minutes
const MAX_FAILURES = 10; // au-delà, on bloque
const BLOCK_MS = 15 * 60 * 1000; // durée du blocage
const CONNU_MS = 30 * 24 * 60 * 60 * 1000; // un code reconnu le reste un mois
const CONNUS_MAX = 60; // par adresse : de quoi couvrir une équipe, pas de quoi grossir sans fin

const buckets = new Map(); // clé "bucket:ip" -> { marques:Set, anonymes, windowStart, blockedUntil }
const connus = new Map(); // clé "bucket:ip" -> Map(marque -> expiration)

function keyFor(bucket, req) {
  // req.ip tient compte de "trust proxy" côté serveur : derrière Railway on obtient
  // l'adresse réelle du client, pas celle du proxy (sinon on bloquerait tout le monde d'un coup).
  return `${bucket}:${req.ip || "inconnue"}`;
}

// Ménage : sans ça, les Map grossiraient indéfiniment au fil des adresses IP croisées.
function prune(now) {
  for (const [key, entry] of buckets) {
    const expired = entry.blockedUntil ? entry.blockedUntil < now : entry.windowStart + WINDOW_MS < now;
    if (expired) buckets.delete(key);
  }
  for (const [key, codes] of connus) {
    for (const [marque, expiration] of codes) if (expiration < now) codes.delete(marque);
    if (codes.size === 0) connus.delete(key);
  }
}

function retryAfterSeconds(entry, now) {
  return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
}

function compte(entry) {
  return entry.marques.size + entry.anonymes;
}

/**
 * Secondes restantes de blocage pour cette adresse, ou 0 si elle n'est pas bloquée.
 * Sert au middleware et aux routes qui décident elles-mêmes du moment de la vérification.
 */
function blocageSecondes(bucket, req) {
  const now = Date.now();
  const entry = buckets.get(keyFor(bucket, req));
  if (entry && entry.blockedUntil && entry.blockedUntil > now) return retryAfterSeconds(entry, now);
  return 0;
}

function refuser(res, seconds) {
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json({
    error: `Trop de tentatives. Réessaie dans ${Math.ceil(seconds / 60)} minute(s).`,
  });
}

// Middleware : refuse la requête si cette IP est déjà bloquée pour ce bucket. Reste utilisé
// pour les portes par MOT DE PASSE, où il n'y a rien à vérifier avant d'essayer.
function guard(bucket) {
  return (req, res, next) => {
    const seconds = blocageSecondes(bucket, req);
    if (seconds) return refuser(res, seconds);
    next();
  };
}

/**
 * À appeler quand une tentative échoue (code inconnu, mauvais mot de passe).
 * @param {string} [marque] ce qui a été essayé — le code. Fourni, les répétitions du MÊME
 *        essai ne comptent que pour un : une personne qui réessaie son lien tronqué huit
 *        fois n'est pas une attaque, alors qu'une force brute change de code à chaque coup.
 */
function noteFailure(bucket, req, marque) {
  const now = Date.now();
  prune(now);
  const key = keyFor(bucket, req);
  let entry = buckets.get(key);

  if (!entry || entry.windowStart + WINDOW_MS < now) {
    entry = { marques: new Set(), anonymes: 0, windowStart: now, blockedUntil: 0 };
    buckets.set(key, entry);
  }
  if (marque) entry.marques.add(String(marque));
  else entry.anonymes += 1;

  if (compte(entry) >= MAX_FAILURES) entry.blockedUntil = now + BLOCK_MS;
}

// À appeler quand une tentative réussit : on efface l'ardoise de cette IP.
function clearFailures(bucket, req) {
  buckets.delete(keyFor(bucket, req));
}

/**
 * À appeler quand un code s'est avéré bon : cette adresse le connaît désormais, et il
 * continuera de passer même si quelqu'un d'autre sur le même WiFi fait bloquer l'adresse.
 */
function noteSuccess(bucket, req, marque) {
  if (!marque) return;
  const now = Date.now();
  prune(now);
  const key = keyFor(bucket, req);
  let codes = connus.get(key);
  if (!codes) {
    codes = new Map();
    connus.set(key, codes);
  }
  // Au-delà du plafond, on oublie le plus ancien : une adresse ne doit pas pouvoir faire
  // grossir cette mémoire sans fin.
  if (!codes.has(String(marque)) && codes.size >= CONNUS_MAX) {
    codes.delete(codes.keys().next().value);
  }
  codes.set(String(marque), now + CONNU_MS);
}

// Ce code a-t-il déjà servi avec succès depuis cette adresse ?
function estConnu(bucket, req, marque) {
  if (!marque) return false;
  const codes = connus.get(keyFor(bucket, req));
  if (!codes) return false;
  const expiration = codes.get(String(marque));
  if (!expiration) return false;
  if (expiration < Date.now()) {
    codes.delete(String(marque));
    return false;
  }
  return true;
}

// Pour les tests : repartir d'une ardoise vierge.
function _reset() {
  buckets.clear();
  connus.clear();
}

module.exports = {
  guard,
  blocageSecondes,
  refuser,
  noteFailure,
  clearFailures,
  noteSuccess,
  estConnu,
  _reset,
  MAX_FAILURES,
  WINDOW_MS,
  BLOCK_MS,
  CONNUS_MAX,
};
