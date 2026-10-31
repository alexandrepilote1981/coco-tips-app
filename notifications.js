// Notifications par courriel — le gérant reçoit un courriel quand un employé DEMANDE un congé
// ou ENVOIE un message. Deux événements seulement : ce sont ceux qui attendent une action du
// gérant et qu'il ne voit autrement qu'en ouvrant l'app.
//
// POURQUOI UN SEUL FICHIER, ET POURQUOI « OFF » PAR DÉFAUT
//
// Tout le reste du dépôt tient sans aucun service externe ni clé API — c'est une force, et
// l'incident Railway d'octobre 2026 (clés lues, fuitées) l'a rappelé. Ce fichier est la SEULE
// porte vers l'extérieur. Il est donc isolé ici, et il ne s'allume que si DEUX variables
// d'environnement sont posées : la clé Resend et l'adresse qui reçoit. Sans elles, `activee()`
// est faux, rien ne part, et l'app se comporte EXACTEMENT comme avant. On ne casse pas une
// installation qui n'a pas configuré ça.
//
// LA CLÉ NE VIT QUE DANS L'ENVIRONNEMENT (Railway), jamais en base ni dans la sauvegarde
// téléchargeable : une clé de courriel qui fuite est peu grave (au pire du spam, on la change),
// mais on ne la met pas là où la sauvegarde l'emporterait.
//
// UN ENVOI RATÉ NE CASSE JAMAIS RIEN. La demande de congé et le message sont déjà enregistrés
// quand on arrive ici ; si le courriel ne part pas (réseau, clé expirée), l'employé ne voit
// aucune différence. Tout est en try/catch, et on ne `await` pas l'envoi côté serveur.

const crypto = require("node:crypto");

const RESEND_URL = "https://api.resend.com/emails";

// Les deux variables qui ALLUMENT la fonction. Lues à chaque appel, pas au chargement : un
// test peut les poser puis les retirer sans recharger le module.
function activee() {
  return !!(process.env.RESEND_API_KEY && process.env.NOTIF_EMAIL);
}

function adresseExpediteur() {
  return process.env.NOTIF_FROM || "Declara <notifications@declara.tips>";
}

function adresseDestinataire() {
  return process.env.NOTIF_EMAIL || "";
}

// L'adresse publique de l'app, pour bâtir les liens des courriels. Défaut : la production.
function lienBase() {
  return (process.env.APP_URL || "https://declara.tips").replace(/\/+$/, "");
}

// --------------------------------------------------------------- le jeton signé des liens
//
// Les boutons « Accepter » / « Refuser » du courriel mènent à une page qui agit SANS
// connexion. Ce qui autorise l'action, c'est ce jeton : une empreinte HMAC de l'identifiant
// de la demande, calculée avec un secret que seul le serveur connaît. Un lien ne peut donc
// pas être fabriqué ni deviné, et il ne vaut que pour CETTE demande précise.
//
// Le jeton couvre l'id SEUL (pas l'action) : le même jeton laisse voir la demande, puis
// l'accepter OU la refuser. C'est la page qui demande ensuite laquelle, d'un tap — un
// scanner de liens (Gmail, antivirus) qui ouvre l'URL ne fait donc qu'AFFICHER, il ne répond
// jamais à la place du gérant.
function jeton(secret, absenceId) {
  return crypto.createHmac("sha256", String(secret)).update(String(absenceId)).digest("hex").slice(0, 32);
}

function jetonValide(secret, absenceId, essai) {
  const bon = Buffer.from(jeton(secret, absenceId));
  const vu = Buffer.from(String(essai || ""));
  // Longueur d'abord : timingSafeEqual lève si les tailles diffèrent.
  return bon.length === vu.length && crypto.timingSafeEqual(bon, vu);
}

// --------------------------------------------------------------- mise en forme
function echapper(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];
const MOIS_COURT_FR = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juill.", "août", "sept.", "oct.", "nov.", "déc.",
];

// Tout passe par UTC à midi, comme feries.js : sinon un fuseau décale la date d'un jour.
function partsDe(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return { j: d.getUTCDay(), jour: +m[3], mois: d.getUTCMonth() };
}

// « jeudi 30 octobre »
function dateLongue(iso) {
  const p = partsDe(iso);
  if (!p) return iso;
  return `${JOURS_FR[p.j]} ${p.jour} ${MOIS_FR[p.mois]}`;
}

// « jeudi 30 oct. » — pour l'objet, plus court
function dateCourte(iso) {
  const p = partsDe(iso);
  if (!p) return iso;
  return `${JOURS_FR[p.j]} ${p.jour} ${MOIS_COURT_FR[p.mois]}`;
}

// Une plage : une seule journée se dit court, deux dates se disent « du … au … ».
function plageLongue(debut, fin) {
  if (!fin || fin === debut) return dateLongue(debut);
  return `du ${dateLongue(debut)} au ${dateLongue(fin)}`;
}
function plageCourte(debut, fin) {
  if (!fin || fin === debut) return dateCourte(debut);
  return `${dateCourte(debut)} → ${dateCourte(fin)}`;
}

const NOM_TYPE = { conge: "Congé", vacances: "Vacances", maladie: "Maladie", cnesst: "CNESST" };
// La tournure qui se lit bien dans la phrase « X demande ___ » : un/des selon le type.
const PHRASE_TYPE = { conge: "un congé", vacances: "des vacances", maladie: "un congé maladie", cnesst: "un congé CNESST" };

// --------------------------------------------------------------- les deux courriels

// Demande de congé : objet qui dit tout, corps avec la note, et DEUX boutons Accepter/Refuser
// qui mènent à la page de réponse avec le jeton signé.
function courrielDemandeConge({ demande, employe, restaurant, secret }) {
  const nom = (employe && employe.name) || "Un employé";
  const resto = (restaurant && restaurant.name) || "";
  const type = NOM_TYPE[demande.type] || "Congé";
  const t = jeton(secret, demande.id);
  const base = lienBase();
  const lien = (a) => `${base}/conge?id=${encodeURIComponent(demande.id)}&t=${t}&a=${a}`;

  const sujet = `${type} demandé — ${nom} (${plageCourte(demande.date_debut, demande.date_fin)})`;

  const ligneNote = demande.note
    ? `<p style="color:#555;margin:6px 0 0">Note : « ${echapper(demande.note)} »</p>`
    : "";

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:8px">
  <p style="font-size:13px;color:#8a8a8a;margin:0 0 4px">${echapper(resto)}</p>
  <h2 style="color:#111;margin:0 0 12px;font-size:20px">Demande de ${echapper(type.toLowerCase())}</h2>
  <p style="font-size:16px;margin:0"><strong>${echapper(nom)}</strong> demande ${echapper(PHRASE_TYPE[demande.type] || "un congé")}&nbsp;:</p>
  <p style="font-size:16px;margin:4px 0 0"><strong>${echapper(plageLongue(demande.date_debut, demande.date_fin))}</strong></p>
  ${ligneNote}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px"><tr>
    <td style="padding-right:10px">
      <a href="${lien("accepte")}" style="display:inline-block;background:#6FBF93;color:#10151D;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px">Accepter</a>
    </td>
    <td>
      <a href="${lien("refuse")}" style="display:inline-block;background:#f3dede;color:#E2685A;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px">Refuser</a>
    </td>
  </tr></table>
  <p style="color:#999;font-size:12px;margin:14px 0 0">Accepter place le congé directement dans l'horaire. Tu confirmes d'un tap sur la page qui s'ouvre.</p>
</div>`.trim();

  return { sujet, html };
}

// Message d'un employé : objet « Message de … », corps avec le texte et un lien vers l'app.
// Pas de bouton d'action — un message se lit et se répond dans l'app.
function courrielMessage({ message, employe, restaurant }) {
  const nom = (employe && employe.name) || "Un employé";
  const resto = (restaurant && restaurant.name) || "";
  const base = lienBase();
  const sujet = `Message de ${nom}`;
  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:8px">
  <p style="font-size:13px;color:#8a8a8a;margin:0 0 4px">${echapper(resto)}</p>
  <h2 style="color:#111;margin:0 0 12px;font-size:20px">Message de ${echapper(nom)}</h2>
  <blockquote style="margin:0;padding:12px 16px;background:#f5f5f4;border-left:3px solid #6FBF93;border-radius:6px;font-size:16px;color:#222">${echapper(message.body)}</blockquote>
  <p style="margin:22px 0 0">
    <a href="${base}/admin" style="display:inline-block;background:#6FBF93;color:#10151D;padding:13px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px">Répondre dans l'app</a>
  </p>
</div>`.trim();
  return { sujet, html };
}

// --------------------------------------------------------------- l'envoi

// Appel bas niveau à Resend. Ne lève JAMAIS : renvoie un objet qui dit ce qui s'est passé.
// On passe `fetch` en paramètre pour que les tests puissent l'injecter sans réseau.
async function envoyer({ sujet, html }, fetchImpl) {
  if (!activee()) return { envoye: false, raison: "desactive" };
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) return { envoye: false, raison: "pas-de-fetch" };
  try {
    const r = await f(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: adresseExpediteur(),
        to: adresseDestinataire(),
        subject: sujet,
        html,
      }),
    });
    if (!r || !r.ok) {
      const code = r ? r.status : "?";
      let detail = "";
      try { detail = await r.text(); } catch (e) { /* tant pis */ }
      console.error("Notif courriel refusée :", code, String(detail).slice(0, 200));
      return { envoye: false, raison: "refus", code };
    }
    return { envoye: true };
  } catch (e) {
    console.error("Notif courriel — erreur réseau :", e && e.message);
    return { envoye: false, raison: "erreur" };
  }
}

// Les deux fonctions que le serveur appelle (sans `await` : feu et oubli). Elles n'attrapent
// pas les erreurs elles-mêmes parce qu'`envoyer` ne lève jamais — mais on reste prudent.
async function notifierDemandeConge(args, fetchImpl) {
  try {
    if (!activee()) return { envoye: false, raison: "desactive" };
    return await envoyer(courrielDemandeConge(args), fetchImpl);
  } catch (e) {
    console.error("notifierDemandeConge :", e && e.message);
    return { envoye: false, raison: "erreur" };
  }
}

async function notifierMessage(args, fetchImpl) {
  try {
    if (!activee()) return { envoye: false, raison: "desactive" };
    return await envoyer(courrielMessage(args), fetchImpl);
  } catch (e) {
    console.error("notifierMessage :", e && e.message);
    return { envoye: false, raison: "erreur" };
  }
}

module.exports = {
  activee,
  jeton,
  jetonValide,
  dateLongue,
  dateCourte,
  plageLongue,
  plageCourte,
  courrielDemandeConge,
  courrielMessage,
  envoyer,
  notifierDemandeConge,
  notifierMessage,
};
