const express = require("express");
const path = require("path");
const fs = require("fs");
const { db, nanoid, makeAccessCode, codeLibre, PHOTOS_DIR } = require("./db");
const { buildSchedulePdf, schedulePdfFilename } = require("./pdf-horaire");
// Le titre de la feuille est le même pour le PDF et pour la photo exportée par le
// navigateur : il vit donc avec la mise en page, pas ici.
const miseEnPage = require("./public/shared/horaire-mise-en-page.js");
const Disponibilites = require("./public/shared/disponibilites.js");
// Congés et vacances : mêmes règles de plage et de tri des deux côtés.
const Absences = require("./public/shared/absences.js");
// Qui travaille où. Chargé ici ET par les pages : c'est lui qui décide qu'un quart
// appartient à un secteur par son POSTE, et plus par le secteur de la personne.
const Secteurs = require("./public/shared/secteurs.js");
const { guard, blocageSecondes, refuser, noteFailure, clearFailures, noteSuccess, estConnu } = require("./rate-limit");
const Mdp = require("./mdp");
// Le calcul des pourboires vit dans public/shared/ pour que le navigateur puisse charger
// EXACTEMENT le même fichier. Une seule implémentation, couverte par test/tip-math.test.js.
const TipMath = require("./public/shared/tip-math.js");
const { computeEntry } = TipMath;
const CoutMainOeuvre = require("./public/shared/cout-main-oeuvre.js");
const { buildBackupZip } = require("./backup");

const app = express();

// Railway place un proxy devant l'app. Sans ça, req.ip vaudrait l'adresse du proxy pour
// TOUT LE MONDE, et le plafond de tentatives bloquerait tous les utilisateurs d'un coup.
// On fait confiance à un seul saut : l'adresse ajoutée par le proxy de Railway, et pas
// un en-tête X-Forwarded-For que le client pourrait fabriquer lui-même.
app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" })); // les photos en base64 sont plus lourdes que du texte
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      // Les pages HTML et le JavaScript partagé changent souvent — on force le navigateur
      // à toujours redemander la dernière version au lieu de garder une vieille copie en cache.
      // Sans ça pour les .js, quelqu'un pourrait se retrouver avec une page à jour qui
      // appelle du code périmé après un déploiement.
      if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  })
);

const NO_CACHE_HEADERS = {
  headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0" },
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SCHEDULE_PASSWORD = process.env.SCHEDULE_PASSWORD || "horaire2026";

// Seuls ces formats sont acceptés en téléversement et renvoyés par /api/photos.
// La valeur est l'extension écrite sur disque, la clé le sous-type du data: URI.
const PHOTO_EXTENSIONS = {
  jpeg: "jpg",
  jpg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  heic: "heic",
  heif: "heif",
};
const PHOTO_CONTENT_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

// Supprime les fichiers photo d'une liste de journées — sinon ils s'accumulent
// indéfiniment sur le volume après la suppression des entrées en base.
function deletePhotoFiles(entries) {
  for (const e of entries) {
    if (!e || !e.photo_filename) continue;
    try {
      fs.unlinkSync(path.join(PHOTOS_DIR, path.basename(e.photo_filename)));
    } catch (err) {
      // fichier déjà absent — rien à faire
    }
  }
}

// ---------- helpers ----------

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// Accepte le mot de passe admin OU le mot de passe horaire — utilisé pour tout ce qui
// touche uniquement à la planification (aucune donnée financière derrière cette porte).
function requireScheduleAccess(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD && token !== SCHEDULE_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// =========================================================
//  API EMPLOYÉ (accès par code, aucun mot de passe compliqué)
// =========================================================

// Toutes les routes /api/employee/:code/... passent d'abord ici. On ne compte que les codes
// INCONNUS : un employé dont le code est bon peut rafraîchir sa page autant qu'il veut.
// Volontairement, on ne remet pas le compteur à zéro sur un succès — sinon quelqu'un
// possédant un code valide pourrait effacer son ardoise entre deux essais et deviner
// tranquillement les codes des autres.
app.use("/api/employee/:code", (req, res, next) => {
  const code = (req.params.code || "").toUpperCase();

  // Un code déjà utilisé avec succès depuis cette adresse passe TOUJOURS, même si le WiFi
  // est bloqué parce que quelqu'un d'autre a raté ses essais. Voir rate-limit.js pour
  // pourquoi ça ne donne rien à un attaquant.
  if (estConnu("employee-code", req, code)) return next();

  const attente = blocageSecondes("employee-code", req);
  // Bloqué : on répond pareil pour tout code inconnu. Laisser passer un bon code ici
  // reviendrait à répondre « oui / non » à volonté, et le plafond ne servirait plus à rien.
  if (attente) return refuser(res, attente);

  const emp = db.prepare("SELECT id FROM employees WHERE access_code = ?").get(code);
  if (!emp) {
    // Le code est passé en marque : réessayer LE MÊME mauvais lien huit fois ne compte que
    // pour un échec, alors qu'une force brute change de code à chaque coup.
    noteFailure("employee-code", req, code);
    return res.status(404).json({ error: "Code inconnu" });
  }
  noteSuccess("employee-code", req, code);
  next();
});

/**
 * La fiche telle qu'elle sort vers la page d'un employé.
 *
 * Sa page n'affiche NI son taux NI son plafond — elle ne les a jamais utilisés. Ils
 * partaient quand même, parce que la requête fait `SELECT *` : chaque colonne ajoutée à la
 * table se met à voyager toute seule, sans que personne ne l'ait décidé.
 *
 * Ce n'est pas une fuite — c'est SA fiche, ouverte avec SON code, et personne ne voit le
 * taux d'un collègue. Mais un lien personnel se fait suivre plus souvent qu'on pense, et le
 * principe du dépôt est que ce qui ne sert pas ne sort pas du serveur. Le jour où sa page
 * aura besoin de son taux, on l'ajoutera exprès.
 */
function ficheEmploye(emp) {
  const { taux_horaire, heures_max, ...reste } = emp;
  return reste;
}

app.get("/api/employee/:code", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(emp.restaurant_id);
  const entries = db
    .prepare("SELECT * FROM entries WHERE employee_id = ? ORDER BY date DESC, updated_at DESC, rowid DESC")
    .all(emp.id)
    .map(computeEntry);

  res.json({ employee: ficheEmploye(emp), restaurant, entries });
});

// L'employé et ses disponibilités. Le code de 6 caractères de son lien sert de clé, comme
// pour tout le reste de sa page.
app.get("/api/employee/:code/disponibilites", (req, res) => {
  const emp = db.prepare("SELECT id FROM employees WHERE access_code = ?").get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  const lignes = db.prepare("SELECT * FROM disponibilites WHERE employee_id = ? ORDER BY jour ASC").all(emp.id);
  res.json({ disponibilites: lignes, aRepondu: Disponibilites.aRepondu(lignes) });
});

app.post("/api/employee/:code/disponibilites", (req, res) => {
  const emp = db.prepare("SELECT id FROM employees WHERE access_code = ?").get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  if (!Array.isArray(req.body.disponibilites)) {
    return res.status(400).json({ error: "disponibilites requis" });
  }
  enregistrerDisponibilites(emp.id, req.body.disponibilites);
  const lignes = db.prepare("SELECT * FROM disponibilites WHERE employee_id = ? ORDER BY jour ASC").all(emp.id);
  res.json({ disponibilites: lignes, aRepondu: Disponibilites.aRepondu(lignes) });
});

// ---------- Demandes de congé, du côté de l'employé ----------
//
// Jusqu'ici, un employé n'avait AUCUN moyen de demander une journée : seul le gérant pouvait
// inscrire un congé, et l'employé ne voyait même pas celui qu'on avait noté pour lui. Sa page
// le disait elle-même sous ses disponibilités — « pour une semaine différente, écris au
// gérant » — et le gérant retranscrivait le message à la main dans sa grille.
//
// Demandé ainsi : « un employé n'est pas disponible, comment il fait pour placer sa demande
// dans l'horaire ? Je vois les demandes de mon côté mais quand je regarde côté employé je
// vois rien. » Ce qu'il voyait de son côté, c'était ce qu'il avait tapé lui-même.
//
// Une demande est une absence avec `statut = 'en_attente'`. Accepter ne fait que changer le
// statut : la journée devient alors une absence ordinaire, marquée dans la grille et
// signalée si on cédule quelqu'un par-dessus. Rien n'est recopié.

// Deux types seulement se demandent : un congé et des vacances. `maladie` et `cnesst` se
// constatent après coup — personne ne demande la permission d'être malade la semaine
// prochaine —, et le gérant les inscrit lui-même comme avant.
const TYPES_DEMANDABLES = ["conge", "vacances"];

function employeParCode(code) {
  return db.prepare("SELECT * FROM employees WHERE access_code = ?").get(String(code || "").toUpperCase());
}

// Ce que l'employé voit : ses demandes et ses congés à venir, plus les réponses récentes.
//
// On remonte un peu dans le passé exprès. Une demande refusée hier doit rester lisible : la
// faire disparaître le lendemain donnerait l'impression qu'elle n'a jamais existé, et c'est
// le genre de silence qui fait rappeler le gérant pour rien.
app.get("/api/employee/:code/conges", (req, res) => {
  const emp = employeParCode(req.params.code);
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  const depuis = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const conges = db
    .prepare("SELECT * FROM absences WHERE employee_id = ? AND date_fin >= ? ORDER BY date_debut ASC")
    .all(emp.id, depuis);
  res.json({ conges });
});

app.post("/api/employee/:code/conges", (req, res) => {
  const emp = employeParCode(req.params.code);
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const propre = Absences.normaliser(req.body);
  if (!propre) return res.status(400).json({ error: "date_debut requise (AAAA-MM-JJ)" });
  // Le type passe par la liste blanche ET par le validateur partagé : sans ça, quelqu'un
  // pourrait se déclarer un accident de travail depuis son téléphone.
  const type = TYPES_DEMANDABLES.includes(propre.type) ? propre.type : "conge";

  const id = nanoid(10);
  db.prepare(`
    INSERT INTO absences (id, employee_id, date_debut, date_fin, type, note, statut)
    VALUES (?,?,?,?,?,?,'en_attente')
  `).run(id, emp.id, propre.date_debut, propre.date_fin, type, propre.note.slice(0, 120));
  res.json({ id, ...propre, type, statut: "en_attente", employee_id: emp.id });
});

// Annuler SA demande. Seulement tant qu'elle attend : une fois répondue, elle appartient à
// l'horaire du gérant — effacer un congé accepté la veille lui retirerait de sous les pieds
// une journée sur laquelle il a bâti sa semaine.
app.delete("/api/employee/:code/conges/:id", (req, res) => {
  const emp = employeParCode(req.params.code);
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  // Le `employee_id` dans la requête, et pas seulement l'identifiant de la demande : sans
  // lui, n'importe quel code valide effacerait la demande de n'importe qui.
  const demande = db
    .prepare("SELECT * FROM absences WHERE id = ? AND employee_id = ?")
    .get(req.params.id, emp.id);
  if (!demande) return res.status(404).json({ error: "Demande introuvable" });
  if (demande.statut !== "en_attente") {
    return res.status(409).json({ error: "Cette demande a déjà reçu une réponse" });
  }
  db.prepare("DELETE FROM absences WHERE id = ?").run(demande.id);
  res.json({ ok: true });
});

app.post("/api/employee/:code/entries", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const { id, date, ventes, clients, pct, remis, remit_direction, remit_amount, is_hotesse } = req.body;
  if (!date) return res.status(400).json({ error: "Date requise" });
  const direction = ["employer_owes", "employee_owes"].includes(remit_direction) ? remit_direction : null;
  const amount = direction ? (parseFloat(remit_amount) || 0) : 0;
  const hotesse = is_hotesse ? 1 : 0;

  // Si un id est fourni et appartient bien à cet employé, on met à jour cette entrée précise.
  const existing = id
    ? db.prepare("SELECT id FROM entries WHERE id = ? AND employee_id = ?").get(id, emp.id)
    : null;

  if (existing) {
    // submitted_at repasse à NULL : « envoyée » doit toujours désigner le contenu réellement
    // transmis. Si la serveuse corrige un chiffre après avoir envoyé, la journée redevient à
    // envoyer, sinon le gérant croirait final un montant qui a changé depuis.
    db.prepare(
      `UPDATE entries SET date=?, ventes=?, clients=?, pct=?, remis=?, remit_direction=?, remit_amount=?, is_hotesse=?, submitted_at=NULL, updated_at=datetime('now'), data_updated_at=datetime('now') WHERE id=?`
    ).run(date, ventes || 0, clients || 0, pct || 0, remis || 0, direction, amount, hotesse, existing.id);
    res.json({ ok: true, id: existing.id });
  } else {
    // Sinon on crée une NOUVELLE entrée — plusieurs entrées peuvent exister pour la même date
    // (ex: une serveuse qui rentre ses chiffres 2 fois dans la même journée).
    const newId = nanoid(10);
    db.prepare(
      `INSERT INTO entries (id, employee_id, date, ventes, clients, pct, remis, remit_direction, remit_amount, is_hotesse, created_at, data_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).run(newId, emp.id, date, ventes || 0, clients || 0, pct || 0, remis || 0, direction, amount, hotesse);
    res.json({ ok: true, id: newId });
  }
});

// La serveuse déclare avoir fini de remplir sa journée. Aucune donnée déclarée n'est
// touchée : on ne fait qu'horodater le moment où elle a dit « c'est complet ». Ajouter le
// relevé photo ensuite ne l'annule pas — comme data_updated_at, la photo n'est pas une
// donnée déclarée.
app.post("/api/employee/:code/entries/:entryId/submit", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const entry = db
    .prepare("SELECT id FROM entries WHERE employee_id = ? AND id = ?")
    .get(emp.id, req.params.entryId);
  if (!entry) return res.status(404).json({ error: "Journée introuvable" });

  db.prepare(
    `UPDATE entries SET submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(entry.id);
  const { submitted_at } = db.prepare("SELECT submitted_at FROM entries WHERE id = ?").get(entry.id);
  res.json({ ok: true, submitted_at });
});

app.delete("/api/employee/:code/entries/:entryId", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  const entry = db.prepare("SELECT photo_filename FROM entries WHERE employee_id = ? AND id = ?").get(emp.id, req.params.entryId);
  db.prepare("DELETE FROM entries WHERE employee_id = ? AND id = ?").run(emp.id, req.params.entryId);
  deletePhotoFiles([entry]);
  res.json({ ok: true });
});

app.post("/api/employee/:code/entries/:entryId/photo", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const entry = db
    .prepare("SELECT * FROM entries WHERE id = ? AND employee_id = ?")
    .get(req.params.entryId, emp.id);
  if (!entry) return res.status(404).json({ error: "Journée introuvable" });

  const { photoBase64 } = req.body;
  if (!photoBase64) return res.status(400).json({ error: "Photo requise" });

  const match = /^data:image\/([\w+.-]+);base64,(.+)$/.exec(photoBase64);
  if (!match) return res.status(400).json({ error: "Format de photo invalide" });
  // On n'accepte QUE de vraies extensions d'image. Sans cette liste blanche, quelqu'un
  // pouvait envoyer "data:image/html;base64,..." : le fichier était écrit en .html et
  // /api/photos/ le renvoyait ensuite en text/html, donc du script exécuté sur le domaine
  // de l'app (et le jeton admin est dans sessionStorage).
  const ext = PHOTO_EXTENSIONS[match[1].toLowerCase()];
  if (!ext) return res.status(400).json({ error: "Format de photo invalide" });
  const buffer = Buffer.from(match[2], "base64");

  const filename = `${entry.id}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
  db.prepare(`UPDATE entries SET photo_filename=?, updated_at=datetime('now') WHERE id=?`).run(filename, entry.id);

  res.json({ ok: true, photo_filename: filename });
});

app.get("/api/photos/:filename", (req, res) => {
  // sécurité de base : empêche de remonter dans l'arborescence via le nom de fichier
  const safeName = path.basename(req.params.filename);
  // Deuxième garde-fou, en plus de la liste blanche au téléversement : on refuse de servir
  // tout ce qui n'est pas une image, et on impose le type MIME au lieu de le déduire du
  // nom de fichier. Ça neutralise aussi les fichiers déjà écrits avant cette correction.
  const ext = (safeName.split(".").pop() || "").toLowerCase();
  const contentType = PHOTO_CONTENT_TYPES[ext];
  if (!contentType) return res.status(404).send("Photo introuvable");

  const filePath = path.join(PHOTOS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send("Photo introuvable");
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  res.sendFile(filePath, { headers: { "Content-Type": contentType } });
});

app.post("/api/employee/:code/messages", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Message vide" });
  if (body.length > 2000) return res.status(400).json({ error: "Message trop long" });

  const id = nanoid(10);
  db.prepare("INSERT INTO messages (id, employee_id, body, sender) VALUES (?,?,?,'employee')").run(id, emp.id, body);
  res.json({ ok: true, id });
});

app.get("/api/employee/:code/messages", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  const messages = db
    .prepare("SELECT id, body, sender, is_read, created_at FROM messages WHERE employee_id = ? ORDER BY created_at ASC")
    .all(emp.id);
  res.json({ messages });
});

app.post("/api/employee/:code/messages/mark-read", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  db.prepare("UPDATE messages SET is_read=1 WHERE employee_id=? AND sender='admin'").run(emp.id);
  res.json({ ok: true });
});

app.delete("/api/employee/:code/messages", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  db.prepare("DELETE FROM messages WHERE employee_id=?").run(emp.id);
  res.json({ ok: true });
});

// =========================================================
//  API ADMIN (Alex) — vue sur tous les restaurants/employés
// =========================================================

app.post("/api/admin/login", guard("admin-login"), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    clearFailures("admin-login", req);
    return res.json({ token: ADMIN_PASSWORD });
  }
  noteFailure("admin-login", req);
  res.status(401).json({ error: "Mot de passe incorrect" });
});

// Connexion horaire seulement : accepte le mot de passe horaire OU le mot de passe admin,
// pour que la même page fonctionne peu importe qui se connecte.
app.post("/api/schedule/login", guard("schedule-login"), (req, res) => {
  if (req.body.password === SCHEDULE_PASSWORD || req.body.password === ADMIN_PASSWORD) {
    clearFailures("schedule-login", req);
    return res.json({ token: req.body.password === SCHEDULE_PASSWORD ? SCHEDULE_PASSWORD : ADMIN_PASSWORD });
  }
  noteFailure("schedule-login", req);
  res.status(401).json({ error: "Mot de passe incorrect" });
});

// Liste allégée des restaurants + employés (noms seulement, AUCUNE donnée financière) —
// c'est tout ce dont la page horaire indépendante a besoin pour construire la grille.
//
// Uniquement la SALLE : entrer par mot de passe ouvre la même porte que le lien horaire de la
// salle, et rien d'autre. Sans ce filtre, la cuisine apparaissait dans la grille de la salle,
// donc sans heure de fin, sans tâche, et avec les mauvais postes — le jour où les secteurs
// sont apparus, cette route est restée en arrière.
app.get("/api/schedule/roster", requireScheduleAccess, (req, res) => {
  const restaurants = db.prepare("SELECT * FROM restaurants ORDER BY created_at ASC").all();
  const data = restaurants.map((r) => ({
    id: r.id,
    name: r.name,
    employees: sansMontants(employesDuSecteur(r.id, "salle")),
  }));
  res.json({ restaurants: data });
});

// ---------- Congés et vacances ----------

// Disponibilités : l'habitude déclarée par chaque employé. C'est de l'information pour
// monter l'horaire, pas un secret — le gérant en a besoin dans la grille, l'équipe peut la
// voir sur les liens horaire. Rien de financier là-dedans.
function disponibilitesDuRestaurant(restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur, "e.secteur") : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [restaurantId, ...equipe.params] : [restaurantId];
  return db
    .prepare(`
      SELECT d.* FROM disponibilites d
      JOIN employees e ON e.id = d.employee_id
      WHERE e.restaurant_id = ?${conditionSecteur}
      ORDER BY d.employee_id ASC, d.jour ASC
    `)
    .all(...params);
}

// Sept lignes d'un coup, dans une transaction : une semaine à moitié enregistrée serait une
// semaine qui dit des faussetés.
function enregistrerDisponibilites(employeeId, lignes) {
  const propres = [];
  for (const l of lignes || []) {
    const n = Disponibilites.normaliser(l);
    if (n) propres.push(n);
  }
  const effacer = db.prepare("DELETE FROM disponibilites WHERE employee_id = ?");
  const inserer = db.prepare(`
    INSERT INTO disponibilites (employee_id, jour, disponible, heure_debut, heure_fin, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    effacer.run(employeeId);
    for (const n of propres) inserer.run(employeeId, n.jour, n.disponible ? 1 : 0, n.heure_debut, n.heure_fin);
  })();
  return propres;
}

function absencesDuRestaurant(restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur, "e.secteur") : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [restaurantId, ...equipe.params] : [restaurantId];
  return db
    .prepare(`
      SELECT a.* FROM absences a
      JOIN employees e ON e.id = a.employee_id
      WHERE e.restaurant_id = ?${conditionSecteur} AND a.statut = 'accepte'
      ORDER BY a.date_debut ASC
    `)
    .all(...params);
}

// Les demandes de congé qui attendent une réponse, pour la porte qui peut y répondre.
//
// Elles vivent dans la MÊME table que les absences, avec `statut = 'en_attente'` — accepter
// une demande ne fait que changer son statut, donc il n'y a jamais deux vérités à tenir
// d'accord. Mais elles sortent par une requête séparée, et c'est voulu : tant que personne
// n'a répondu, une demande ne doit marquer aucune journée dans la grille. Une case qui
// afficherait « Congé » pendant que le gérant hésite encore se lirait comme un congé accordé.
function demandesEnAttente(restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur, "e.secteur") : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [restaurantId, ...equipe.params] : [restaurantId];
  return db
    .prepare(`
      SELECT a.*, e.name AS employee_name FROM absences a
      JOIN employees e ON e.id = a.employee_id
      WHERE e.restaurant_id = ?${conditionSecteur} AND a.statut = 'en_attente'
      ORDER BY a.date_debut ASC
    `)
    .all(...params);
}

// Accepter ou refuser. La réponse ne se donne qu'UNE fois : une demande déjà répondue ne se
// rouvre pas d'un second clic, sinon un refus envoyé deviendrait une acceptation sans que
// l'employé sache laquelle des deux vaut.
function repondreDemande(req, res, restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur, "e.secteur") : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [req.params.id, restaurantId, ...equipe.params] : [req.params.id, restaurantId];
  const demande = db
    .prepare(`
      SELECT a.* FROM absences a JOIN employees e ON e.id = a.employee_id
      WHERE a.id = ? AND e.restaurant_id = ?${conditionSecteur}
    `)
    .get(...params);
  if (!demande) return res.status(404).json({ error: "Demande introuvable" });
  if (demande.statut !== "en_attente") {
    return res.status(409).json({ error: "Cette demande a déjà reçu une réponse" });
  }

  const accepte = !!req.body.accepte;
  const mot = String(req.body.reponse || "").trim().slice(0, 200);
  db.prepare("UPDATE absences SET statut=?, reponse=?, repondu_at=datetime('now') WHERE id=?")
    .run(accepte ? "accepte" : "refuse", mot, demande.id);
  res.json({ ok: true, id: demande.id, statut: accepte ? "accepte" : "refuse" });
}

// Une absence n'existe que pour un employé de CE restaurant, et de CE secteur quand la porte
// en a un : le lien de la cuisine ne pose pas de congé à une serveuse.
function employePourAbsence(employeeId, restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur) : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [employeeId, restaurantId, ...equipe.params] : [employeeId, restaurantId];
  return db.prepare(`SELECT * FROM employees WHERE id = ? AND restaurant_id = ?${conditionSecteur}`).get(...params);
}

function creerAbsence(req, res, restaurantId, secteur) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: "employee_id requis" });
  if (!employePourAbsence(employee_id, restaurantId, secteur)) {
    return res.status(403).json({ error: "Cet employé n'est pas dans cette équipe" });
  }
  const propre = Absences.normaliser(req.body);
  if (!propre) return res.status(400).json({ error: "date_debut requise (AAAA-MM-JJ)" });

  const id = nanoid(10);
  db.prepare(`
    INSERT INTO absences (id, employee_id, date_debut, date_fin, type, note) VALUES (?,?,?,?,?,?)
  `).run(id, employee_id, propre.date_debut, propre.date_fin, propre.type, propre.note.slice(0, 120));
  res.json({ id, ...propre, employee_id });
}

function supprimerAbsence(req, res, restaurantId, secteur) {
  const equipe = secteur ? Secteurs.conditionEmployeSQL(secteur, "e.secteur") : null;
  const conditionSecteur = equipe ? ` AND ${equipe.sql}` : "";
  const params = equipe ? [req.params.id, restaurantId, ...equipe.params] : [req.params.id, restaurantId];
  const absence = db
    .prepare(`
      SELECT a.* FROM absences a JOIN employees e ON e.id = a.employee_id
      WHERE a.id = ? AND e.restaurant_id = ?${conditionSecteur}
    `)
    .get(...params);
  if (!absence) return res.status(404).json({ error: "Absence introuvable" });
  db.prepare("DELETE FROM absences WHERE id = ?").run(absence.id);
  res.json({ ok: true });
}

// Sans restaurant_id, le tableau de bord reçoit tout : il affiche plusieurs restaurants à la
// fois, et faire un appel par restaurant à chaque rafraîchissement ne rapporterait rien.
app.get("/api/admin/disponibilites", requireScheduleAccess, (req, res) => {
  const restaurantId = req.query.restaurant_id;
  if (restaurantId) return res.json({ disponibilites: disponibilitesDuRestaurant(restaurantId, null) });
  res.json({
    disponibilites: db
      .prepare(`
        SELECT d.* FROM disponibilites d
        JOIN employees e ON e.id = d.employee_id
        ORDER BY d.employee_id ASC, d.jour ASC
      `)
      .all(),
  });
});

app.get("/api/admin/absences", requireScheduleAccess, (req, res) => {
  const restaurantId = req.query.restaurant_id;
  if (restaurantId) return res.json({ absences: absencesDuRestaurant(restaurantId, null) });
  res.json({
    // `statut = 'accepte'` ici AUSSI, et pas seulement dans absencesDuRestaurant : cette
    // branche sert le tableau de bord quand il affiche tous les restaurants. Sans le filtre,
    // une demande encore en attente marquerait des journées dans la grille — un congé qui
    // s'affiche avant d'avoir été accordé, c'est exactement ce qu'on veut éviter.
    absences: db
      .prepare(`
        SELECT a.* FROM absences a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.statut = 'accepte'
        ORDER BY a.date_debut ASC
      `)
      .all(),
  });
});

app.post("/api/admin/absences", requireScheduleAccess, (req, res) => {
  const restaurantId = req.body.restaurant_id;
  if (!restaurantId) return res.status(400).json({ error: "restaurant_id requis" });
  creerAbsence(req, res, restaurantId, null);
});

app.get("/api/admin/demandes-conge", requireScheduleAccess, (req, res) => {
  const restaurantId = req.query.restaurant_id;
  if (restaurantId) return res.json({ demandes: demandesEnAttente(restaurantId, null) });
  // Sans restaurant_id : toutes, comme la route des absences. Le tableau de bord peut porter
  // plusieurs restaurants, et la grille de chacun filtrera sur ses propres employés.
  res.json({
    demandes: db
      .prepare(`
        SELECT a.*, e.name AS employee_name FROM absences a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.statut = 'en_attente'
        ORDER BY a.date_debut ASC
      `)
      .all(),
  });
});

app.post("/api/admin/demandes-conge/:id/reponse", requireScheduleAccess, (req, res) => {
  const restaurantId = req.body.restaurant_id;
  if (!restaurantId) return res.status(400).json({ error: "restaurant_id requis" });
  repondreDemande(req, res, restaurantId, null);
});

app.delete("/api/admin/absences/:id", requireScheduleAccess, (req, res) => {
  const restaurantId = req.query.restaurant_id;
  if (!restaurantId) return res.status(400).json({ error: "restaurant_id requis" });
  supprimerAbsence(req, res, restaurantId, null);
});

// ---------- Rappels avant un férié ----------
//
// Le problème, dans les mots du gérant : « pendant nos fériés, les horaires de livraison de
// nos fournisseurs peuvent changer… si on manque de bananes, nous sommes dans la
// schnoutte ». L'app ne peut pas savoir si Dufour & Fils est fermé le lundi — personne ne le
// lui a dit. Mais elle sait quand un férié s'en vient, et elle peut ressortir à ce
// moment-là ce que le gérant, lui, sait déjà. L'oubli qu'on vise n'est pas « je ne savais
// pas », c'est « j'ai pas pensé à vérifier ».
//
// Qui y a droit : le gérant par /admin, et le gérant de cuisine par son lien. Ce sont les
// deux qui passent les commandes. Le lien de la salle et celui des cuisiniers ne les voient
// pas — ce n'est pas un secret, c'est du bruit pour quelqu'un qui ne commande rien.

const RAPPELS_MAX = 20; // au-delà, la fenêtre devient un mur de texte que personne ne lit
const RAPPEL_LONGUEUR_MAX = 120;

function rappelsValides(valeur) {
  return String(valeur == null ? "" : valeur)
    .split("\n")
    .map((l) => l.trim().slice(0, RAPPEL_LONGUEUR_MAX))
    .filter(Boolean)
    .slice(0, RAPPELS_MAX)
    .join("\n");
}

app.get("/api/admin/rappels", requireAdmin, (req, res) => {
  const restaurants = db
    .prepare("SELECT id, name, rappels_ferie FROM restaurants ORDER BY created_at ASC")
    .all();
  res.json({ restaurants: restaurants.map((r) => ({ id: r.id, name: r.name, rappels: r.rappels_ferie || "" })) });
});

app.post("/api/admin/restaurants/:id/rappels", requireAdmin, (req, res) => {
  const r = db.prepare("SELECT id FROM restaurants WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Restaurant introuvable" });
  const rappels = rappelsValides(req.body.rappels);
  db.prepare("UPDATE restaurants SET rappels_ferie = ? WHERE id = ?").run(rappels, r.id);
  res.json({ rappels });
});

// Le lien du gérant de cuisine. `voitMontants` n'est vrai que pour cette porte-là : c'est
// déjà la marque du gérant dans tout le reste du fichier, on s'en sert plutôt que d'inventer
// un deuxième moyen de le reconnaître.
function porteGerant(req, res) {
  const porte = porteParCode(req.params.code);
  if (!porte) {
    res.status(404).json({ error: "Lien introuvable" });
    return null;
  }
  if (!porte.voitMontants) {
    res.status(403).json({ error: "Non autorisé" });
    return null;
  }
  return porte;
}

// ---------------------------------------------------------------- les deux gardes
//
// Tout ce qui passe par /api/schedule/by-code/:code franchit ces deux-là, dans cet ordre, et
// elles sont déclarées ICI — avant la première route by-code, qui est celle des rappels.
// Les ranger plus bas les ferait sauter par les routes déclarées au-dessus : c'est exactement
// ce qui arrivait au plafond de tentatives, que /rappels contournait sans que ça se voie.

// 1. Le code existe-t-il, et cette adresse a-t-elle le droit d'essayer ?
app.use("/api/schedule/by-code/:code", (req, res, next) => {
  // Même logique que la porte employé, et pour la même raison : l'équipe partage un WiFi.
  const code = (req.params.code || "").toUpperCase();
  if (estConnu("schedule-code", req, code)) return next();

  const attente = blocageSecondes("schedule-code", req);
  if (attente) return refuser(res, attente);

  if (!getRestaurantByCode(code)) {
    noteFailure("schedule-code", req, code);
    return res.status(404).json({ error: "Lien invalide" });
  }
  noteSuccess("schedule-code", req, code);
  next();
});

// 2. Le mot de passe du lien gérant de cuisine, quand il y en a un.
//
// Seule cette porte-là en demande un : c'est celle qui montre les salaires et les codes
// d'accès personnels de l'équipe. La salle et le lien de lecture des cuisiniers passent sans
// rien, comme avant — ce sont des liens partagés à des équipes entières, un mot de passe que
// quinze personnes connaissent n'en est pas un.
//
// Trois réponses à distinguer, et c'est ce qui permet à la page de dire la vérité :
//   - rien d'envoyé       → 401 « il en faut un », et ça NE COMPTE PAS comme un échec. Sinon
//                           ouvrir sa page dix fois bloquerait le gérant sans qu'il ait jamais
//                           tapé un seul mauvais mot de passe.
//   - mauvais mot de passe → 401, et celui-là compte. 1212 fait quatre chiffres : sans
//                           plafond, on les essaie tous en quelques secondes.
//   - trop de tentatives   → 429, avec le délai.
app.use("/api/schedule/by-code/:code", async (req, res, next) => {
  const porte = porteParCode(req.params.code);
  if (!porte || !porte.voitMontants) return next();
  if (!Mdp.estPose(porte.restaurant.mdp_cuisine)) return next();

  const essai = req.get("X-Horaire-Mdp");
  if (!essai) {
    return res.status(401).json({ error: "Mot de passe requis", mdpRequis: true });
  }

  // Un mot de passe DÉJÀ accepté depuis cette adresse passe toujours, même pendant un
  // blocage — exactement la mécanique des codes employés, et pour la même raison : toute
  // l'équipe est sur un seul WiFi, donc une seule adresse. Sans ça, quelqu'un qui malmène ce
  // lien enfermerait dehors le gérant dont le mot de passe est bon. Ça ne donne rien à qui
  // cherche à deviner : pour qu'un mot de passe soit « connu » de son adresse, il faut qu'il
  // ait déjà réussi avec — donc qu'il l'ait déjà.
  if (!estConnu("horaire-mdp", req, essai)) {
    const attente = blocageSecondes("horaire-mdp", req);
    if (attente) return refuser(res, attente);
  }

  let bon = false;
  try {
    bon = await Mdp.verifier(essai, porte.restaurant.mdp_cuisine);
  } catch (e) {
    return res.status(500).json({ error: "Erreur" });
  }
  if (!bon) {
    // L'essai sert de marque : réessayer VINGT fois le même mot de passe mal retenu compte
    // pour un, alors que deviner en change forcément à chaque coup.
    noteFailure("horaire-mdp", req, essai);
    return res.status(401).json({ error: "Mot de passe invalide", mdpRequis: true });
  }
  clearFailures("horaire-mdp", req);
  noteSuccess("horaire-mdp", req, essai);
  next();
});

app.get("/api/schedule/by-code/:code/rappels", (req, res) => {
  const porte = porteGerant(req, res);
  if (!porte) return;
  res.json({
    restaurants: [{ id: porte.restaurant.id, name: porte.restaurant.name, rappels: porte.restaurant.rappels_ferie || "" }],
  });
});

app.post("/api/schedule/by-code/:code/rappels", (req, res) => {
  const porte = porteGerant(req, res);
  if (!porte) return;
  const rappels = rappelsValides(req.body.rappels);
  db.prepare("UPDATE restaurants SET rappels_ferie = ? WHERE id = ?").run(rappels, porte.restaurant.id);
  res.json({ rappels });
});

// ---------- Effacement d'une semaine entière ----------

function isISODate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Une seule requête SQL plutôt qu'un DELETE par quart : si la connexion tombe en chemin, la
// semaine ne peut pas rester à moitié vidée — et il n'y a aucune annulation possible après
// coup. Le sous-select enferme l'effacement dans un seul restaurant : un code d'horaire ne
// peut pas vider la semaine du restaurant d'à côté.
// Les quarts qu'un effacement en lot VA emporter, lus avant de les détruire.
//
// C'est ce qui rend « Annuler » possible. Jusqu'ici l'effacement d'une semaine n'avait aucun
// retour en arrière : une tape à côté sur un téléphone, et l'horaire était parti pour de bon.
// On garde les lignes entières, id compris, pour pouvoir les remettre telles quelles — un
// quart remis avec un id neuf casserait les liens que la page garde en mémoire.
function shiftsEntre(restaurantId, from, to, secteur) {
  if (secteur) {
    const quart = Secteurs.conditionQuartSQL(secteur, "role");
    return db
      .prepare(`
        SELECT * FROM shifts
        WHERE date >= ? AND date <= ? AND ${quart.sql}
          AND employee_id IN (SELECT id FROM employees WHERE restaurant_id = ?)
      `)
      .all(from, to, ...quart.params, restaurantId);
  }
  return db
    .prepare(`
      SELECT * FROM shifts
      WHERE date >= ? AND date <= ?
        AND employee_id IN (SELECT id FROM employees WHERE restaurant_id = ?)
    `)
    .all(from, to, restaurantId);
}

/**
 * Remet en place des quarts qu'on vient d'effacer.
 *
 * Deux bornes, parce que cette route accepte des lignes venues du navigateur : on ne remet
 * qu'un quart dont l'employé appartient VRAIMENT à ce restaurant, et — pour une porte par
 * code — dont le poste appartient à son secteur. Sans ça, le lien du gérant de cuisine
 * pourrait écrire des quarts de salle, ou chez le voisin.
 *
 * `INSERT OR IGNORE` : remettre deux fois ne crée pas de doublon, et un double clic sur
 * « Annuler » ne doit rien casser.
 */
function restaurerShifts(restaurantId, quarts, secteur) {
  if (!Array.isArray(quarts)) return 0;
  const sien = db.prepare("SELECT id FROM employees WHERE id = ? AND restaurant_id = ?");
  const insere = db.prepare(`
    INSERT OR IGNORE INTO shifts (id, employee_id, date, start_time, end_time, role, note)
    VALUES (?,?,?,?,?,?,?)
  `);
  let n = 0;
  const lot = db.transaction((liste) => {
    for (const q of liste) {
      if (!q || !q.id || !q.employee_id || !isISODate(q.date) || !q.start_time) continue;
      if (!sien.get(q.employee_id, restaurantId)) continue;
      const role = q.role || "server";
      if (secteur && Secteurs.duRole(role) !== Secteurs.valide(secteur)) continue;
      n += insere.run(q.id, q.employee_id, q.date, q.start_time, q.end_time || null, role, tacheValide(q.note)).changes;
    }
  });
  lot(quarts.slice(0, 500)); // une semaine d'un gros restaurant tient largement là-dedans
  return n;
}

function deleteShiftsBetween(restaurantId, from, to, secteur) {
  // Sans secteur, on efface toute la semaine du restaurant — c'est ce que fait le tableau de
  // bord. Avec, on reste dans son équipe : le gérant de cuisine ne vide pas la salle.
  if (secteur) {
    // Le filtre porte sur le POSTE du quart, pas sur l'équipe de la personne. Sans ça,
    // « effacer la semaine » depuis la cuisine effacerait aussi les quarts de SALLE d'un
    // employé mixte — un effacement en lot sans annulation possible.
    const quart = Secteurs.conditionQuartSQL(secteur, "role");
    return db
      .prepare(`
        DELETE FROM shifts
        WHERE date >= ? AND date <= ? AND ${quart.sql}
          AND employee_id IN (SELECT id FROM employees WHERE restaurant_id = ?)
      `)
      .run(from, to, ...quart.params, restaurantId);
  }
  return db
    .prepare(`
      DELETE FROM shifts
      WHERE date >= ? AND date <= ?
        AND employee_id IN (SELECT id FROM employees WHERE restaurant_id = ?)
    `)
    .run(from, to, restaurantId);
}

// ---------- Accès horaire par lien direct (un code par restaurant, aucun mot de passe) ----------
// Même logique que les liens employés : le code lui-même sert de clé d'accès.
// Un code d'horaire n'ouvre pas qu'un restaurant : il ouvre une PORTE précise, avec ses
// propres droits. Ce qu'on a le droit de voir et de modifier se déduit de la colonne où le
// code a été trouvé — jamais de ce que le client demande.
//
//   schedule_code                 salle,   modification,  aucun montant
//   schedule_code_cuisine         cuisine, modification,  salaires visibles  ← lien du gérant
//   schedule_code_cuisine_lecture cuisine, lecture seule, aucun montant      ← lien des cuisiniers
function porteParCode(code) {
  const c = (code || "").toUpperCase();
  const r = db
    .prepare(`
      SELECT * FROM restaurants
      WHERE schedule_code = ? OR schedule_code_cuisine = ? OR schedule_code_cuisine_lecture = ?
    `)
    .get(c, c, c);
  if (!r) return null;
  if (r.schedule_code_cuisine === c) {
    return { restaurant: r, secteur: "cuisine", peutModifier: true, voitMontants: true };
  }
  if (r.schedule_code_cuisine_lecture === c) {
    return { restaurant: r, secteur: "cuisine", peutModifier: false, voitMontants: false };
  }
  return { restaurant: r, secteur: "salle", peutModifier: true, voitMontants: false };
}

function getRestaurantByCode(code) {
  const porte = porteParCode(code);
  return porte ? porte.restaurant : undefined;
}

function employesDuSecteur(restaurantId, secteur) {
  return db
    .prepare(`
      SELECT id, name, employee_number, secteur, taux_horaire, heures_max
      FROM employees WHERE restaurant_id = ? AND ${Secteurs.conditionEmployeSQL(secteur).sql}
      ORDER BY created_at ASC
    `)
    .all(restaurantId, ...Secteurs.conditionEmployeSQL(secteur).params);
}

// Les montants ne sont pas simplement cachés à l'écran : ils ne sortent pas du serveur.
// Une porte sans droit aux salaires ne reçoit jamais le champ, même vide.
function sansMontants(employes) {
  return employes.map(({ taux_horaire, heures_max, ...reste }) => reste);
}


// Le code d'accès personnel d'un employé, pour la porte du gérant seulement.
//
// Pourquoi lui et pas les autres : ce code EST la clé de la page de la personne. Le gérant
// en a besoin pour distribuer les liens à son équipe — sans ça, personne ne peut remplir ses
// disponibilités. Mais le lien de LECTURE des cuisiniers ne doit jamais les recevoir :
// n'importe quel cuisinier pourrait alors ouvrir la page d'un collègue et changer ses
// disponibilités à sa place.
//
// Et jamais du côté salle : le gérant n'y a pas accès du tout, et la page d'une serveuse
// montre ses pourboires déclarés.
function avecCodes(employes, restaurantId) {
  const codes = new Map(
    db.prepare("SELECT id, access_code FROM employees WHERE restaurant_id = ?").all(restaurantId).map((e) => [e.id, e.access_code])
  );
  return employes.map((e) => ({ ...e, access_code: codes.get(e.id) || "" }));
}

app.get("/api/schedule/by-code/:code", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  const { restaurant: r, secteur, peutModifier, voitMontants } = porte;
  const employees = employesDuSecteur(r.id, secteur);
  res.json({
    restaurant: { id: r.id, name: r.name },
    employees: voitMontants ? avecCodes(employees, r.id) : sansMontants(employees),
    secteur,
    peutModifier,
    voitMontants,
    charges_pct: voitMontants ? r.charges_pct || 0 : undefined,
  });
});

app.get("/api/schedule/by-code/:code/absences", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  // Même en lecture seule on les voit : savoir qui est en vacances n'est un secret pour
  // personne dans un restaurant, et c'est utile à l'équipe.
  res.json({ absences: absencesDuRestaurant(porte.restaurant.id, porte.secteur) });
});

app.get("/api/schedule/by-code/:code/disponibilites", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  // Même en lecture seule : savoir que quelqu'un ne rentre jamais avant 9h le mardi n'est
  // un secret pour personne, et ça évite des questions dans le groupe.
  res.json({ disponibilites: disponibilitesDuRestaurant(porte.restaurant.id, porte.secteur) });
});

app.post("/api/schedule/by-code/:code/absences", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  creerAbsence(req, res, porte.restaurant.id, porte.secteur);
});

// Les demandes de congé par un lien d'horaire. Mêmes bornes que les absences : il faut
// pouvoir modifier, et la porte ne voit que SON secteur — le lien de la cuisine ne répond
// pas à la demande d'une serveuse.
app.get("/api/schedule/by-code/:code/demandes-conge", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  res.json({ demandes: porte.peutModifier ? demandesEnAttente(porte.restaurant.id, porte.secteur) : [] });
});

app.post("/api/schedule/by-code/:code/demandes-conge/:id/reponse", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  repondreDemande(req, res, porte.restaurant.id, porte.secteur);
});

app.delete("/api/schedule/by-code/:code/absences/:id", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  supprimerAbsence(req, res, porte.restaurant.id, porte.secteur);
});

/**
 * Les heures qu'une personne a faites AILLEURS que dans cette grille, jour par jour.
 *
 * Un plafond d'heures porte sur la personne — visa étudiant, ou éviter l'overtime — et pas
 * sur un poste. Cette porte ne reçoit que les quarts de son secteur : sans ce complément,
 * quelqu'un à 15 h de cuisine et 16 h de salle s'afficherait « 15 h / 20 h », en vert, alors
 * qu'il est à 31 h. Le gérant ajouterait un quart en croyant qu'il reste de la place.
 *
 * « Ailleurs » couvre les DEUX façons d'être des deux bords :
 *   - une seule fiche en « les_deux » : ses propres quarts portant un poste de l'autre équipe ;
 *   - deux fiches réunies par le même numéro d'employé : tout ce que fait l'autre fiche.
 *
 * On n'envoie QUE des heures : ni poste, ni tâche, ni heure d'arrivée. La porte apprend que
 * la personne a travaillé 8 h ailleurs ce jour-là, pas l'horaire de l'autre équipe.
 */
function heuresAilleursDe(restaurantId, secteur) {
  const equipe = Secteurs.conditionEmployeSQL(secteur);
  const visibles = db
    .prepare(`SELECT id, employee_number FROM employees WHERE restaurant_id = ? AND ${equipe.sql}`)
    .all(restaurantId, ...equipe.params);
  const tous = db.prepare("SELECT id, employee_number FROM employees WHERE restaurant_id = ?").all(restaurantId);
  const quarts = db
    .prepare(`
      SELECT s.employee_id, s.date, s.start_time, s.end_time, s.role FROM shifts s
      JOIN employees e ON e.id = s.employee_id WHERE e.restaurant_id = ?
    `)
    .all(restaurantId);

  const numero = (e) => String(e.employee_number || "").trim();
  const sortie = [];

  for (const moi of visibles) {
    // Jamais sur un numéro vide : sinon toutes les fiches sans matricule n'en feraient qu'une.
    const jumeaux = new Set(
      numero(moi) ? tous.filter((a) => a.id !== moi.id && numero(a) === numero(moi)).map((a) => a.id) : []
    );
    for (const q of quarts) {
      const sien = q.employee_id === moi.id && Secteurs.duRole(q.role) !== Secteurs.valide(secteur);
      const dUnJumeau = jumeaux.has(q.employee_id);
      if (!sien && !dUnJumeau) continue;
      sortie.push({ employee_id: moi.id, date: q.date, heures: CoutMainOeuvre.heuresDuQuart(q) });
    }
  }
  return sortie;
}

app.get("/api/schedule/by-code/:code/shifts", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  const shifts = db
    .prepare(`
      SELECT s.* FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE e.restaurant_id = ? AND ${Secteurs.conditionQuartSQL(porte.secteur).sql}
      ORDER BY s.date ASC, s.start_time ASC
    `)
    .all(porte.restaurant.id, ...Secteurs.conditionQuartSQL(porte.secteur).params);

  res.json({ shifts, heuresAilleurs: heuresAilleursDe(porte.restaurant.id, porte.secteur) });
});

app.post("/api/schedule/by-code/:code/shifts", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const r = porte.restaurant;
  const { employee_id, date, start_time, end_time, role, note } = req.body;
  if (!employee_id || !date || !start_time || !end_time) {
    return res.status(400).json({ error: "employee_id, date, start_time et end_time requis" });
  }
  // Le secteur compte autant que le restaurant : le lien cuisine ne doit pas pouvoir
  // céduler une serveuse, ni l'inverse.
  const equipe = Secteurs.conditionEmployeSQL(porte.secteur);
  const emp = db
    .prepare(`SELECT * FROM employees WHERE id = ? AND restaurant_id = ? AND ${equipe.sql}`)
    .get(employee_id, r.id, ...equipe.params);
  if (!emp) return res.status(403).json({ error: "Cet employé n'est pas dans cette équipe" });
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO shifts (id, employee_id, date, start_time, end_time, role, note) VALUES (?,?,?,?,?,?,?)"
  ).run(id, employee_id, date, start_time, end_time, role || "server", tacheValide(note));
  res.json({ id, ok: true });
});

// Avant /shifts/:id, pour la même raison que du côté admin : « restaurer » se ferait lire
// comme un identifiant de quart.
app.post("/api/schedule/by-code/:code/shifts/restaurer", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  res.json({ restaures: restaurerShifts(porte.restaurant.id, req.body.quarts, porte.secteur) });
});

app.post("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const shift = db
    .prepare(`
      SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.id = ? AND e.restaurant_id = ? AND ${Secteurs.conditionQuartSQL(porte.secteur).sql}
    `)
    .get(req.params.id, porte.restaurant.id, ...Secteurs.conditionQuartSQL(porte.secteur).params);
  if (!shift) return res.status(404).json({ error: "Quart introuvable" });
  const { date, start_time, end_time, role, note } = req.body;
  db.prepare(
    "UPDATE shifts SET date=?, start_time=?, end_time=?, role=?, note=?, updated_at=datetime('now') WHERE id=?"
  ).run(date, start_time, end_time, role || "server", tacheValide(note), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/schedule/by-code/:code/shifts", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const { from, to } = req.query;
  if (!isISODate(from) || !isISODate(to)) {
    return res.status(400).json({ error: "from et to (AAAA-MM-JJ) requis" });
  }
  // Les quarts voyagent avec la réponse : c'est la page qui les garde le temps d'un
  // « Annuler », pas le serveur. Rien à expirer, rien à nettoyer.
  const quarts = shiftsEntre(porte.restaurant.id, from, to, porte.secteur);
  res.json({ deleted: deleteShiftsBetween(porte.restaurant.id, from, to, porte.secteur).changes, quarts });
});


app.delete("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const shift = db
    .prepare(`
      SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.id = ? AND e.restaurant_id = ? AND ${Secteurs.conditionQuartSQL(porte.secteur).sql}
    `)
    .get(req.params.id, porte.restaurant.id, ...Secteurs.conditionQuartSQL(porte.secteur).params);
  if (!shift) return res.status(404).json({ error: "Quart introuvable" });
  db.prepare("DELETE FROM shifts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- PDF de l'horaire (semaine complète, lundi → dimanche) ----------

// Le PDF couvre toujours une semaine pleine : on envoie n'importe quelle date de la
// semaine voulue et pdf-horaire.js la ramène au lundi.
function isoOrToday(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function employeesOf(restaurantId, secteur) {
  // Même ordre que la grille à l'écran, pour que le PDF se lise comme ce que le gérant vient
  // de voir. Sans secteur : tout le restaurant (l'ancien comportement).
  if (secteur) {
    return db
      .prepare(`
        SELECT id, name, employee_number FROM employees
        WHERE restaurant_id = ? AND ${Secteurs.conditionEmployeSQL(secteur).sql}
        ORDER BY created_at ASC
      `)
      .all(restaurantId, ...Secteurs.conditionEmployeSQL(secteur).params);
  }
  return db
    .prepare("SELECT id, name, employee_number FROM employees WHERE restaurant_id = ? ORDER BY created_at ASC")
    .all(restaurantId);
}

function shiftsOfWeek(restaurantId, weekStartISO) {
  // On récupère large (2 semaines autour) et le module PDF filtre sur les 7 jours exacts —
  // ça évite de dupliquer ici le calcul du lundi.
  return db
    .prepare(`
      SELECT s.* FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE e.restaurant_id = ?
        AND s.date >= date(?, '-7 day') AND s.date <= date(?, '+7 day')
      ORDER BY s.date ASC, s.start_time ASC
    `)
    .all(restaurantId, weekStartISO, weekStartISO);
}

async function sendSchedulePdf(res, restaurant, weekStartISO, lang, secteur) {
  const employes = employeesOf(restaurant.id, secteur);
  const ids = new Set(employes.map((e) => e.id));
  const buffer = await buildSchedulePdf({
    restaurantName: miseEnPage.nomFeuille(restaurant.name, secteur, lang),
    employees: employes,
    shifts: shiftsOfWeek(restaurant.id, weekStartISO).filter(
      (q) => ids.has(q.employee_id) && (!secteur || Secteurs.duRole(q.role) === secteur)
    ),
    weekStartISO,
    lang,
    // La cuisine finit à l'heure : son horaire affiche donc l'heure de fin. En salle, une
    // serveuse part quand la salle est vide — l'heure écrite serait une promesse fausse.
    avecHeureFin: secteur === "cuisine",
    // Les tâches de quart (« Prép », « Commande à défaire ») n'existent qu'en cuisine.
    // Les deux équipes écrivent des tâches, donc la feuille les porte toutes les deux.
    avecTaches: true,
  });
  // Le nom de fichier porte aussi l'équipe : sans ça, le PDF de la cuisine et celui de la
  // salle de la même semaine s'écrasent l'un l'autre dans le dossier de téléchargements.
  const filename = schedulePdfFilename(miseEnPage.nomFeuille(restaurant.name, secteur, lang), weekStartISO, lang);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

// Mode lien direct (/horaire/CODE) : le code fait office de clé, comme pour les autres routes by-code.
app.get("/api/schedule/by-code/:code/pdf", async (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  const r = porte.restaurant;
  try {
    await sendSchedulePdf(res, r, isoOrToday(req.query.week), req.query.lang === "en" ? "en" : "fr", porte.secteur);
  } catch (err) {
    console.error("PDF horaire (by-code) :", err);
    res.status(500).json({ error: "Impossible de générer le PDF" });
  }
});

// Mode mot de passe (/horaire) : même porte que le reste de la planification.
app.get("/api/admin/schedule/pdf", requireScheduleAccess, async (req, res) => {
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(req.query.restaurantId);
  if (!restaurant) return res.status(404).json({ error: "Restaurant introuvable" });
  const secteur = req.query.secteur === "cuisine" ? "cuisine" : req.query.secteur === "salle" ? "salle" : null;
  try {
    await sendSchedulePdf(res, restaurant, isoOrToday(req.query.week), req.query.lang === "en" ? "en" : "fr", secteur);
  } catch (err) {
    console.error("PDF horaire (admin) :", err);
    res.status(500).json({ error: "Impossible de générer le PDF" });
  }
});

// Sauvegarde complète téléchargeable. Réservée à l'admin : le fichier contient tout,
// y compris les codes d'accès des employés.
// La date de la dernière sauvegarde. Elle vit en base et pas dans le navigateur : le gérant
// change de téléphone, ouvre /admin de l'ordinateur du bureau, et un rappel qui repartirait
// à zéro à chaque appareil ne vaudrait rien.
function derniereSauvegarde() {
  const l = db.prepare("SELECT valeur FROM reglages WHERE cle = 'derniere_sauvegarde'").get();
  return l ? l.valeur : null;
}

app.get("/api/admin/backup", requireAdmin, async (req, res) => {
  try {
    const { buffer, filename, resume } = await buildBackupZip({ db, photosDir: PHOTOS_DIR });
    // On note APRÈS avoir construit l'archive : une sauvegarde qui a planté n'en est pas une,
    // et dire « c'est fait » effacerait le rappel sans que rien ne soit sauvé.
    db.prepare(`
      INSERT INTO reglages (cle, valeur) VALUES ('derniere_sauvegarde', datetime('now'))
      ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur
    `).run();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    // Permet à la page d'annoncer ce que contient la sauvegarde sans rouvrir le fichier.
    res.setHeader("X-Backup-Summary", encodeURIComponent(JSON.stringify(resume)));
    res.send(buffer);
  } catch (err) {
    console.error("Sauvegarde :", err);
    res.status(500).json({ error: "Impossible de créer la sauvegarde" });
  }
});

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const { startDate, endDate } = req.query;
  const restaurants = db.prepare("SELECT * FROM restaurants ORDER BY name").all();
  const data = restaurants.map((r) => {
    const employees = db
      .prepare("SELECT * FROM employees WHERE restaurant_id = ? ORDER BY name")
      .all(r.id)
      .map((emp) => {
        let query = "SELECT * FROM entries WHERE employee_id = ?";
        const params = [emp.id];
        if (startDate) {
          query += " AND date >= ?";
          params.push(startDate);
        }
        if (endDate) {
          query += " AND date <= ?";
          params.push(endDate);
        }
        query += " ORDER BY date DESC, updated_at DESC, rowid DESC";
        const entries = db.prepare(query).all(...params).map(computeEntry);
        const totals = entries.reduce(
          (acc, e) => {
            acc.ventes += e.ventes;
            acc.clients += e.clients;
            acc.net += e.net;
            acc.brut += e.pourboireBrut;
            return acc;
          },
          { ventes: 0, clients: 0, net: 0, brut: 0 }
        );
        totals.pctMoyen = totals.ventes > 0 ? totals.brut / totals.ventes : 0;
        return { ...emp, entries, totals };
      });
    // L'empreinte du mot de passe ne sort pas d'ici. Elle partait toute seule, parce que la
    // requête fait SELECT * — le même piège que les taux horaires sur la page employé : toute
    // colonne ajoutée à la table se met à voyager sans que personne l'ait décidé. L'écran n'a
    // besoin que d'une chose : y en a-t-il un, oui ou non.
    const { mdp_cuisine, ...sansEmpreinte } = r;
    return { ...sansEmpreinte, mdp_cuisine_pose: Mdp.estPose(mdp_cuisine), employees };
  });
  res.json({ restaurants: data, derniereSauvegarde: derniereSauvegarde() });
});

// ---------- Horaire (quarts de travail) ----------
app.get("/api/admin/shifts", requireScheduleAccess, (req, res) => {
  const { startDate, endDate } = req.query;
  let query = `
    SELECT s.*, e.name AS employee_name, e.restaurant_id, e.secteur
    FROM shifts s
    JOIN employees e ON e.id = s.employee_id
    WHERE 1=1
  `;
  const params = [];
  if (startDate) { query += " AND s.date >= ?"; params.push(startDate); }
  if (endDate) { query += " AND s.date <= ?"; params.push(endDate); }
  query += " ORDER BY s.date ASC, s.start_time ASC";
  const shifts = db.prepare(query).all(...params);
  res.json({ shifts });
});

app.post("/api/admin/shifts", requireScheduleAccess, (req, res) => {
  const { employee_id, date, start_time, end_time, role, note } = req.body;
  if (!employee_id || !date || !start_time || !end_time) {
    return res.status(400).json({ error: "employee_id, date, start_time et end_time requis" });
  }
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO shifts (id, employee_id, date, start_time, end_time, role, note) VALUES (?,?,?,?,?,?,?)"
  ).run(id, employee_id, date, start_time, end_time, role || "server", tacheValide(note));
  res.json({ id, ok: true });
});

// AVANT la route /shifts/:id, et ce n'est pas un détail de style : Express prend les routes
// dans l'ordre, donc « restaurer » se ferait lire comme un identifiant de quart. La mise à
// jour tournerait alors sur un quart qui n'existe pas et répondrait « ok » — l'annulation
// disait « c'est fait » et ne remettait rien. Vu en vrai, pas deviné.
app.post("/api/admin/shifts/restaurer", requireScheduleAccess, (req, res) => {
  const { restaurant_id, quarts } = req.body;
  if (!restaurant_id) return res.status(400).json({ error: "restaurant_id requis" });
  res.json({ restaures: restaurerShifts(restaurant_id, quarts, null) });
});

app.post("/api/admin/shifts/:id", requireScheduleAccess, (req, res) => {
  const { date, start_time, end_time, role, note } = req.body;
  db.prepare(
    "UPDATE shifts SET date=?, start_time=?, end_time=?, role=?, note=?, updated_at=datetime('now') WHERE id=?"
  ).run(date, start_time, end_time, role || "server", tacheValide(note), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/admin/shifts", requireScheduleAccess, (req, res) => {
  const { restaurant_id, from, to } = req.query;
  if (!restaurant_id || !isISODate(from) || !isISODate(to)) {
    return res.status(400).json({ error: "restaurant_id, from et to (AAAA-MM-JJ) requis" });
  }
  const secteur = req.query.secteur === "cuisine" ? "cuisine" : req.query.secteur === "salle" ? "salle" : null;
  const quarts = shiftsEntre(restaurant_id, from, to, secteur);
  res.json({ deleted: deleteShiftsBetween(restaurant_id, from, to, secteur).changes, quarts });
});


app.delete("/api/admin/shifts/:id", requireScheduleAccess, (req, res) => {
  db.prepare("DELETE FROM shifts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/**
 * Les fiches qui désignent la MÊME personne, réunies par leur numéro d'employé.
 *
 * Demande du propriétaire, dans ses mots : « il faut en créer 2, sinon la cuisine voit pas
 * son nom dispo pour horaire… je veux que la personne soit indiquée dans les 2, et toi tu
 * fais les horaires perso en fonction de la collecte d'info des numéros d'employé. »
 *
 * Sa manière de travailler : une fiche par équipe, le même matricule de paie sur les deux.
 * Le numéro devient donc la pièce d'identité, et c'est lui qui recolle l'horaire personnel.
 *
 * Trois bornes, parce qu'un rapprochement qui se trompe montrerait à quelqu'un l'horaire
 * d'un autre :
 *   - jamais sur un numéro VIDE : sinon toutes les fiches sans matricule ne feraient qu'une ;
 *   - jamais entre deux restaurants : deux commerces peuvent numéroter à partir de 1 ;
 *   - la comparaison se fait sur le texte exact, tel qu'il a été saisi et borné.
 *
 * Une personne en « les_deux » n'a qu'une fiche et n'a donc rien à rapprocher : elle passe
 * ici sans y trouver personne d'autre, et son horaire est déjà entier.
 */
function fichesDeLaMemePersonne(emp) {
  const numero = String(emp.employee_number || "").trim();
  if (!numero) return [emp];
  return db
    .prepare("SELECT * FROM employees WHERE restaurant_id = ? AND employee_number = ? ORDER BY created_at ASC")
    .all(emp.restaurant_id, numero);
}

app.get("/api/employee/:code/shifts", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  // Toutes ses fiches, pas seulement celle du lien ouvert : c'est ce qui met ses quarts de
  // cuisine et de salle dans le même horaire, quel que soit le lien qu'elle utilise.
  const fiches = fichesDeLaMemePersonne(emp);
  const ids = fiches.map((f) => f.id);
  const trous = ids.map(() => "?").join(", ");

  // Les quarts à venir (à partir d'aujourd'hui, heure locale approximative), les plus proches en premier
  const shifts = db
    .prepare(`SELECT * FROM shifts WHERE employee_id IN (${trous}) AND date >= date('now', '-1 day') ORDER BY date ASC, start_time ASC`)
    .all(...ids);

  // La page a besoin de savoir que l'horaire vient de plusieurs fiches : elle l'écrit sous
  // la bande. Sans ça, voir apparaître des quarts qu'on n'a jamais reçus par ce lien-là
  // ressemble à une erreur.
  res.json({ shifts, fichesJumelees: fiches.length });
});

app.post("/api/admin/restaurants", requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Nom requis" });
  const id = nanoid(10);
  const scheduleCode = codeLibre();
  const codeCuisine = codeLibre();
  const codeCuisineLecture = codeLibre();
  db.prepare(`
    INSERT INTO restaurants (id, name, schedule_code, schedule_code_cuisine, schedule_code_cuisine_lecture)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, scheduleCode, codeCuisine, codeCuisineLecture);
  res.json({
    id,
    name,
    schedule_code: scheduleCode,
    schedule_code_cuisine: codeCuisine,
    schedule_code_cuisine_lecture: codeCuisineLecture,
  });
});

// Le secteur et le taux n'acceptent que des valeurs connues : tout le reste du code s'y fie
// pour décider qui voit quoi, on ne laisse donc pas le client écrire ce qu'il veut.
// La tâche d'un quart est bornée par ce qu'une case d'horaire peut afficher — la limite
// vient de la mise en page, pas d'un chiffre choisi ici. On la coupe aussi côté serveur :
// le champ de saisie l'empêche déjà, mais une requête n'a pas à passer par le champ.
function tacheValide(valeur) {
  return String(valeur == null ? "" : valeur).trim().slice(0, miseEnPage.TACHE_MAX);
}

const secteurValide = Secteurs.valide;
// Un numéro d'employé est un matricule de paie, pas un texte libre : borné pour qu'un
// copier-coller malheureux ne fasse pas déborder la fiche et la grille.
function numeroValide(valeur) {
  return String(valeur == null ? "" : valeur).trim().slice(0, 20);
}
function tauxValide(valeur) {
  const n = typeof valeur === "number" ? valeur : parseFloat(valeur);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1000); // un taux à quatre chiffres est une faute de frappe, pas un salaire
}

// Plafond d'heures par semaine. 0 signifie « aucun plafond » ; au-delà de 168 on a dépassé
// le nombre d'heures qu'une semaine contient.
// Le plafond par défaut, en heures. 40 parce que c'est là que commence le temps
// supplémentaire : le plafond sert d'abord à ne pas y tomber sans s'en apercevoir.
const HEURES_MAX_DEFAUT = 40;

function heuresMaxValide(valeur) {
  const n = typeof valeur === "number" ? valeur : parseFloat(valeur);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 168);
}

/**
 * Le plafond est un total PAR NUMÉRO D'EMPLOYÉ, pas par fiche.
 *
 * « Le plafond, mets 40 h par défaut, total. C'est un total par numéro d'employé. »
 * Quelqu'un inscrit des deux bords a deux fiches ; son 20 h de visa ne se divise pas en
 * deux. On écrit donc la même valeur sur toutes ses fiches : peu importe celle qu'on ouvre,
 * on lit et on modifie le même chiffre.
 */
function ecrirePlafondSurToutesSesFiches(emp, heures) {
  const numero = String(emp.employee_number || "").trim();
  if (!numero) return;
  db.prepare("UPDATE employees SET heures_max = ? WHERE restaurant_id = ? AND employee_number = ?")
    .run(heures, emp.restaurant_id, numero);
}

app.post("/api/admin/employees", requireAdmin, (req, res) => {
  const { restaurant_id, name, employee_number } = req.body;
  if (!restaurant_id || !name) return res.status(400).json({ error: "restaurant_id et name requis" });

  let code;
  do {
    code = makeAccessCode();
  } while (db.prepare("SELECT 1 FROM employees WHERE access_code = ?").get(code));

  const id = nanoid(10);
  const secteur = secteurValide(req.body.secteur);
  const taux = tauxValide(req.body.taux_horaire);
  const heuresMax = req.body.heures_max === undefined ? HEURES_MAX_DEFAUT : heuresMaxValide(req.body.heures_max);
  db.prepare(`
    INSERT INTO employees (id, restaurant_id, name, employee_number, access_code, secteur, taux_horaire, heures_max)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, restaurant_id, name, numeroValide(employee_number), code, secteur, taux, heuresMax);

  res.json({ id, name, employee_number: numeroValide(employee_number), access_code: code, secteur, taux_horaire: taux, heures_max: heuresMax });
});

// Modifier un employé : c'est par ici qu'on entre un taux horaire, qu'on corrige un nom, ou
// qu'on déplace quelqu'un de la salle vers la cuisine.
app.post("/api/admin/employees/:id", requireAdmin, (req, res) => {
  const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });

  const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : emp.name;
  const numero = req.body.employee_number === undefined ? emp.employee_number : numeroValide(req.body.employee_number);
  const secteur = req.body.secteur === undefined ? emp.secteur : secteurValide(req.body.secteur);
  const taux = req.body.taux_horaire === undefined ? emp.taux_horaire : tauxValide(req.body.taux_horaire);
  const heuresMax = req.body.heures_max === undefined ? emp.heures_max : heuresMaxValide(req.body.heures_max);

  db.prepare("UPDATE employees SET name=?, employee_number=?, secteur=?, taux_horaire=?, heures_max=? WHERE id=?")
    .run(name, numero, secteur, taux, heuresMax, emp.id);
  // Le plafond appartient à la PERSONNE : on le recopie sur ses autres fiches. On passe le
  // numéro qui vient d'être enregistré, pas l'ancien — sinon changer le numéro et le plafond
  // du même coup écrirait sur les fiches de l'ancien numéro.
  if (req.body.heures_max !== undefined) {
    ecrirePlafondSurToutesSesFiches({ ...emp, employee_number: numero }, heuresMax);
  }
  res.json({ id: emp.id, name, employee_number: numero, secteur, taux_horaire: taux, heures_max: heuresMax });
});

// Le supplément que l'employeur paie par-dessus le salaire (vacances, CNESST, RRQ…).
app.post("/api/admin/restaurants/:id/charges", requireAdmin, (req, res) => {
  const r = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Restaurant introuvable" });
  const n = parseFloat(req.body.charges_pct);
  const pct = Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 0;
  db.prepare("UPDATE restaurants SET charges_pct = ? WHERE id = ?").run(pct, r.id);
  res.json({ charges_pct: pct });
});

// Un lien gérant de cuisine tout neuf. L'ancien meurt à l'instant : c'est le but même du
// bouton — un gérant qui s'en va, un téléphone perdu, un lien collé dans la mauvaise
// conversation. Il n'y a rien à « désactiver » ailleurs, le lien EST la clé.
//
// Seul celui du gérant se change ici. Les deux autres se partagent à des équipes entières :
// les refaire obligerait à redistribuer un lien à quinze personnes pour régler un problème
// qu'elles n'ont pas.
app.post("/api/admin/restaurants/:id/nouveau-code-cuisine", requireAdmin, (req, res) => {
  const r = db.prepare("SELECT id FROM restaurants WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Restaurant introuvable" });
  // codeLibre() vérifie l'unicité sur les TROIS colonnes : un même code ne peut pas désigner
  // deux portes, sinon /horaire/<code> ouvrirait la mauvaise une fois sur deux.
  const code = codeLibre();
  db.prepare("UPDATE restaurants SET schedule_code_cuisine = ? WHERE id = ?").run(code, r.id);
  res.json({ schedule_code_cuisine: code });
});

// Poser, changer ou retirer le mot de passe de ce lien. Un champ vide RETIRE le verrou — il
// faut que ça se défasse aussi facilement que ça se fait, sinon on hésite à s'en servir.
//
// La réponse ne renvoie jamais le mot de passe ni son empreinte, seulement s'il y en a un :
// ce qui revient d'un enregistrement finit dans la page, et la page se garde en cache.
app.post("/api/admin/restaurants/:id/mdp-cuisine", requireAdmin, async (req, res) => {
  const r = db.prepare("SELECT id FROM restaurants WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Restaurant introuvable" });
  const brut = req.body.mot_de_passe == null ? "" : String(req.body.mot_de_passe);
  if (brut.length > 200) return res.status(400).json({ error: "Mot de passe trop long" });
  const empreinte = await Mdp.poser(brut);
  db.prepare("UPDATE restaurants SET mdp_cuisine = ? WHERE id = ?").run(empreinte, r.id);
  res.json({ mdp_cuisine_pose: Mdp.estPose(empreinte) });
});

app.delete("/api/admin/employees/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM absences WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM disponibilites WHERE employee_id = ?").run(req.params.id);
  deletePhotoFiles(db.prepare("SELECT photo_filename FROM entries WHERE employee_id = ?").all(req.params.id));
  db.prepare("DELETE FROM entries WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM shifts WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM messages WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Effacer une journée déclarée, depuis le tableau de bord.
//
// Jusqu'ici seule l'employée pouvait le faire, depuis son lien à elle : corriger une saisie
// croche obligeait donc à la rejoindre et à lui expliquer où taper. Demandé ainsi, à la
// veille d'une reprise de commerce : « je suis pas encore propriétaire, dimanche je veux
// effacer ça pour repartir à zéro ».
//
// On renvoie la date de ce qu'on vient d'effacer : la page s'en sert pour dire quelle
// journée est partie, et un 404 distingue « effacé » de « n'existait déjà plus » — deux
// clics sur le même bouton ne doivent pas se lire comme deux journées effacées.
app.delete("/api/admin/entries/:entryId", requireAdmin, (req, res) => {
  const entry = db
    .prepare("SELECT id, date, photo_filename FROM entries WHERE id = ?")
    .get(req.params.entryId);
  if (!entry) return res.status(404).json({ error: "Journée introuvable" });
  db.prepare("DELETE FROM entries WHERE id = ?").run(entry.id);
  // La photo part avec la journée : un justificatif sans la journée qu'il justifie ne sert
  // plus à rien et continuerait d'occuper le volume.
  deletePhotoFiles([entry]);
  res.json({ ok: true, date: entry.date });
});

// Corriger les chiffres d'une journée déclarée, depuis le tableau de bord.
//
// Ça n'existait nulle part : le gérant pouvait EFFACER une journée mais pas la réparer. Pour
// une coquille — 1 240 $ tapé 12 400 — il fallait rejoindre l'employée et lui expliquer où
// taper, ou tout effacer et lui demander de recommencer. Demandé ainsi : « j'aimerais savoir
// comment modifier la déclaration d'une fille ».
//
// Trois décisions qui font la différence avec la saisie de l'employée :
//
// 1. `submitted_at` N'EST PAS remis à NULL. Sur sa page à elle, corriger un chiffre après
//    avoir envoyé remet la journée « à envoyer » — « envoyée » doit désigner le contenu
//    réellement transmis. Ici c'est le GÉRANT qui corrige : elle n'a rien à renvoyer, et la
//    remettre dans sa pile lui ferait refaire un geste pour une faute qui n'est pas la sienne.
// 2. `data_updated_at` BOUGE, donc la journée porte « modifiée le … ». C'est la trace que le
//    chiffre a changé après la déclaration, et elle vaut autant quand c'est le gérant.
// 3. `transferred` ne bouge pas. Si le virement était marqué reçu, il le reste — c'est un
//    fait entre deux personnes, pas un calcul. La fenêtre le dit en rouge avant d'enregistrer.
//
// La date n'est pas modifiable ici : la déplacer changerait la semaine de la journée et
// pourrait créer un doublon avec une autre déjà déclarée. Effacer et refaire reste le chemin
// pour ça. La photo ne bouge pas non plus.
app.patch("/api/admin/entries/:entryId", requireAdmin, (req, res) => {
  const entry = db.prepare("SELECT id FROM entries WHERE id = ?").get(req.params.entryId);
  // Comme pour l'effacement : un double envoi ne doit pas se lire comme deux corrections.
  if (!entry) return res.status(404).json({ error: "Journée introuvable" });

  // `TipMath.toNumber` et pas `|| 0` : un champ vidé ou une saisie de travers vaut zéro et
  // jamais NaN, qui se propagerait ensuite dans tous les totaux. Les montants ne descendent
  // pas sous zéro — c'est le NET qui peut être négatif, quand elle a remis plus que son
  // pourboire brut, et il se calcule.
  const positif = (v) => Math.max(0, TipMath.toNumber(v));
  const ventes = positif(req.body.ventes);
  const clients = positif(req.body.clients);
  const pct = Math.min(100, positif(req.body.pct));
  const remis = positif(req.body.remis);

  const direction = ["employer_owes", "employee_owes"].includes(req.body.remit_direction)
    ? req.body.remit_direction
    : null;
  const montant = direction ? positif(req.body.remit_amount) : 0;
  const hotesse = req.body.is_hotesse ? 1 : 0;

  db.prepare(
    `UPDATE entries SET ventes=?, clients=?, pct=?, remis=?, remit_direction=?, remit_amount=?,
     is_hotesse=?, data_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(ventes, clients, pct, remis, direction, montant, hotesse, entry.id);

  // On rend la journée recalculée : la page affiche le net neuf sans attendre un rechargement.
  const apres = computeEntry(db.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id));
  res.json({ ok: true, entry: apres });
});

app.post("/api/admin/entries/:entryId/transferred", requireAdmin, (req, res) => {
  const value = req.body.transferred ? 1 : 0;
  const transferDate = req.body.transfer_date || null;
  db.prepare(`UPDATE entries SET transferred=?, transfer_date=?, updated_at=datetime('now') WHERE id=?`)
    .run(value, value ? transferDate : null, req.params.entryId);
  res.json({ ok: true });
});

// Mettre de côté PLUSIEURS pastilles d'un coup.
//
// Avant, il n'y avait que la route une-par-une, et le bandeau portait une pastille par
// journée : vider un bandeau de cent journées, c'était cent tapes et cent requêtes. Le
// bandeau regroupe maintenant par personne, et ces deux boutons — la croix d'une personne,
// et « tout mettre de côté » — ont besoin d'un seul aller-retour.
//
// On ne touche jamais `updated_at` ici, pour la même raison que la route une-par-une : ça
// redéclencherait la détection « modifiée après coup » et la pastille ne se fermerait jamais.
app.post("/api/admin/entries/dismiss-flags", requireAdmin, (req, res) => {
  const liste = Array.isArray(req.body.flags) ? req.body.flags.slice(0, 2000) : [];
  const retard = db.prepare("UPDATE entries SET delay_dismissed=1 WHERE id=?");
  const modif = db.prepare("UPDATE entries SET modified_dismissed=1 WHERE id=?");
  let n = 0;
  const lot = db.transaction((f) => {
    for (const { entryId, type } of f) {
      if (!entryId) continue;
      if (type === "late") n += retard.run(entryId).changes;
      else if (type === "modified") n += modif.run(entryId).changes;
    }
  });
  lot(liste);
  res.json({ misDeCote: n });
});

app.post("/api/admin/entries/:entryId/dismiss-flag", requireAdmin, (req, res) => {
  const type = req.body.type;
  // IMPORTANT : on ne touche jamais updated_at ici, sinon ça redéclencherait
  // la détection "modifiée après coup" et la notification ne se fermerait jamais.
  if (type === "late") {
    db.prepare("UPDATE entries SET delay_dismissed=1 WHERE id=?").run(req.params.entryId);
  } else if (type === "modified") {
    db.prepare("UPDATE entries SET modified_dismissed=1 WHERE id=?").run(req.params.entryId);
  } else {
    return res.status(400).json({ error: "type invalide" });
  }
  res.json({ ok: true });
});

app.delete("/api/admin/restaurants/:id", requireAdmin, (req, res) => {
  const emps = db.prepare("SELECT id FROM employees WHERE restaurant_id = ?").all(req.params.id);
  for (const e of emps) {
    deletePhotoFiles(db.prepare("SELECT photo_filename FROM entries WHERE employee_id = ?").all(e.id));
    db.prepare("DELETE FROM entries WHERE employee_id = ?").run(e.id);
    db.prepare("DELETE FROM shifts WHERE employee_id = ?").run(e.id);
    db.prepare("DELETE FROM messages WHERE employee_id = ?").run(e.id);
    // Les deux lignes qui manquaient : effacer un restaurant laissait derrière lui les
    // absences et les disponibilités de son monde, rattachées à des employés disparus.
    // La route qui efface UN employé, elle, les a toujours effacées.
    db.prepare("DELETE FROM absences WHERE employee_id = ?").run(e.id);
    db.prepare("DELETE FROM disponibilites WHERE employee_id = ?").run(e.id);
  }
  db.prepare("DELETE FROM employees WHERE restaurant_id = ?").run(req.params.id);
  db.prepare("DELETE FROM restaurants WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/messages", requireAdmin, (req, res) => {
  const messages = db.prepare(`
    SELECT m.id, m.body, m.sender, m.is_read, m.created_at, e.id AS employee_id, e.name AS employee_name, e.restaurant_id, r.name AS restaurant_name
    FROM messages m
    JOIN employees e ON e.id = m.employee_id
    JOIN restaurants r ON r.id = e.restaurant_id
    ORDER BY m.created_at DESC
  `).all();
  res.json({ messages });
});

app.post("/api/admin/employees/:id/messages", requireAdmin, (req, res) => {
  const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });

  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Message vide" });
  if (body.length > 2000) return res.status(400).json({ error: "Message trop long" });

  const id = nanoid(10);
  db.prepare("INSERT INTO messages (id, employee_id, body, sender) VALUES (?,?,?,'admin')").run(id, emp.id, body);
  res.json({ ok: true, id });
});

app.post("/api/admin/employees/:id/messages/mark-read", requireAdmin, (req, res) => {
  db.prepare("UPDATE messages SET is_read=1 WHERE employee_id=? AND sender='employee'").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/messages/:id/read", requireAdmin, (req, res) => {
  const value = req.body.is_read === false ? 0 : 1;
  db.prepare("UPDATE messages SET is_read=? WHERE id=?").run(value, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/admin/messages/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM messages WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/admin/employees/:id/messages", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM messages WHERE employee_id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- pages ----------
// Un lien tronqué jusqu'à « /e/ » tombait sur la page d'erreur brute d'Express — « Cannot
// GET /e/ », en Times New Roman. Une employée qui reçoit ça ne sait pas quoi en faire. On
// sert la page de l'app, qui affichera son propre écran « Code invalide » avec ce qu'elle a
// lu dans l'adresse.
app.get(["/e", "/e/"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "employee.html"), NO_CACHE_HEADERS);
});

app.get("/e/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "employee.html"), NO_CACHE_HEADERS);
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"), NO_CACHE_HEADERS);
});
app.get("/horaire", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "horaire.html"), NO_CACHE_HEADERS);
});
app.get("/horaire/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "horaire.html"), NO_CACHE_HEADERS);
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"), NO_CACHE_HEADERS);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coco Tips app running on port ${PORT}`));
