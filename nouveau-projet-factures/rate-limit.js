// Plafond de tentatives en mémoire, sur les ÉCHECS seulement.
//
// C'est ce qui rend un code de 6 caractères acceptable : rafraîchir la page de capture avec
// un code valide n'est jamais pénalisé, enchaîner des codes faux l'est très vite. Ne pas
// affaiblir ce principe en comptant aussi les succès.

const tentatives = new Map();

const MAX = 8;
const FENETRE_MS = 15 * 60 * 1000;

function cle(req, portee) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  return `${portee}:${ip}`;
}

function estBloque(req, portee) {
  const e = tentatives.get(cle(req, portee));
  if (!e) return false;
  if (Date.now() - e.debut > FENETRE_MS) {
    tentatives.delete(cle(req, portee));
    return false;
  }
  return e.n >= MAX;
}

function noterEchec(req, portee) {
  const k = cle(req, portee);
  const e = tentatives.get(k);
  if (!e || Date.now() - e.debut > FENETRE_MS) {
    tentatives.set(k, { n: 1, debut: Date.now() });
  } else {
    e.n += 1;
  }
}

function noterSucces(req, portee) {
  tentatives.delete(cle(req, portee));
}

module.exports = { estBloque, noterEchec, noterSucces, MAX };
