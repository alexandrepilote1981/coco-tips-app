// Plafond de tentatives, en mémoire, sans dépendance externe.
//
// Principe : on ne compte QUE les échecs. Un employé qui rafraîchit sa page vingt fois
// avec un code valide n'est jamais gêné ; c'est celui qui enchaîne les codes faux ou les
// mauvais mots de passe qui se fait ralentir. C'est ce qui rend un code court (6 caractères)
// ou un mot de passe court (4 chiffres) inattaquable par force brute, sans compliquer la vie
// des vraies personnes.
//
// L'état vit en mémoire : il repart à zéro à chaque redéploiement, et il n'est pas partagé
// entre plusieurs instances. C'est assez pour un service à une instance comme celui-ci.

const WINDOW_MS = 15 * 60 * 1000; // fenêtre d'observation : 15 minutes
const MAX_FAILURES = 10; // au-delà, on bloque
const BLOCK_MS = 15 * 60 * 1000; // durée du blocage

const buckets = new Map(); // clé "bucket:ip" -> { failures, windowStart, blockedUntil }

function keyFor(bucket, req) {
  // req.ip tient compte de "trust proxy" côté serveur : derrière Railway on obtient
  // l'adresse réelle du client, pas celle du proxy (sinon on bloquerait tout le monde d'un coup).
  return `${bucket}:${req.ip || "inconnue"}`;
}

// Ménage : sans ça, la Map grossirait indéfiniment au fil des adresses IP croisées.
function prune(now) {
  for (const [key, entry] of buckets) {
    const expired = entry.blockedUntil ? entry.blockedUntil < now : entry.windowStart + WINDOW_MS < now;
    if (expired) buckets.delete(key);
  }
}

function retryAfterSeconds(entry, now) {
  return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
}

// Middleware : refuse la requête si cette IP est déjà bloquée pour ce bucket.
function guard(bucket) {
  return (req, res, next) => {
    const now = Date.now();
    const entry = buckets.get(keyFor(bucket, req));
    if (entry && entry.blockedUntil && entry.blockedUntil > now) {
      const seconds = retryAfterSeconds(entry, now);
      res.setHeader("Retry-After", String(seconds));
      return res.status(429).json({
        error: `Trop de tentatives. Réessaie dans ${Math.ceil(seconds / 60)} minute(s).`,
      });
    }
    next();
  };
}

// À appeler quand une tentative échoue (code inconnu, mauvais mot de passe).
function noteFailure(bucket, req) {
  const now = Date.now();
  prune(now);
  const key = keyFor(bucket, req);
  const entry = buckets.get(key);

  if (!entry || entry.windowStart + WINDOW_MS < now) {
    buckets.set(key, { failures: 1, windowStart: now, blockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_MS;
  }
}

// À appeler quand une tentative réussit : on efface l'ardoise de cette IP.
function clearFailures(bucket, req) {
  buckets.delete(keyFor(bucket, req));
}

module.exports = { guard, noteFailure, clearFailures, MAX_FAILURES, WINDOW_MS, BLOCK_MS };
