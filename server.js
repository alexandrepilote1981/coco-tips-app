const express = require("express");
const path = require("path");
const fs = require("fs");
const { db, nanoid, makeAccessCode, codeLibre, PHOTOS_DIR } = require("./db");
const { buildSchedulePdf, schedulePdfFilename } = require("./pdf-horaire");
// Le titre de la feuille est le même pour le PDF et pour la photo exportée par le
// navigateur : il vit donc avec la mise en page, pas ici.
const miseEnPage = require("./public/shared/horaire-mise-en-page.js");
const { guard, noteFailure, clearFailures } = require("./rate-limit");
// Le calcul des pourboires vit dans public/shared/ pour que le navigateur puisse charger
// EXACTEMENT le même fichier. Une seule implémentation, couverte par test/tip-math.test.js.
const { computeEntry } = require("./public/shared/tip-math.js");
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
app.use("/api/employee/:code", guard("employee-code"), (req, res, next) => {
  const emp = db
    .prepare("SELECT id FROM employees WHERE access_code = ?")
    .get((req.params.code || "").toUpperCase());
  if (!emp) {
    noteFailure("employee-code", req);
    return res.status(404).json({ error: "Code inconnu" });
  }
  next();
});

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

  res.json({ employee: emp, restaurant, entries });
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
app.get("/api/schedule/roster", requireScheduleAccess, (req, res) => {
  const restaurants = db.prepare("SELECT * FROM restaurants ORDER BY created_at ASC").all();
  const data = restaurants.map((r) => {
    const employees = db
      .prepare("SELECT id, name, employee_number FROM employees WHERE restaurant_id = ? ORDER BY created_at ASC")
      .all(r.id);
    return { id: r.id, name: r.name, employees };
  });
  res.json({ restaurants: data });
});

// ---------- Effacement d'une semaine entière ----------

function isISODate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Une seule requête SQL plutôt qu'un DELETE par quart : si la connexion tombe en chemin, la
// semaine ne peut pas rester à moitié vidée — et il n'y a aucune annulation possible après
// coup. Le sous-select enferme l'effacement dans un seul restaurant : un code d'horaire ne
// peut pas vider la semaine du restaurant d'à côté.
function deleteShiftsBetween(restaurantId, from, to, secteur) {
  // Sans secteur, on efface toute la semaine du restaurant — c'est ce que fait le tableau de
  // bord. Avec, on reste dans son équipe : le gérant de cuisine ne vide pas la salle.
  if (secteur) {
    return db
      .prepare(`
        DELETE FROM shifts
        WHERE date >= ? AND date <= ?
          AND employee_id IN (SELECT id FROM employees WHERE restaurant_id = ? AND secteur = ?)
      `)
      .run(from, to, restaurantId, secteur);
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
      FROM employees WHERE restaurant_id = ? AND secteur = ? ORDER BY created_at ASC
    `)
    .all(restaurantId, secteur);
}

// Les montants ne sont pas simplement cachés à l'écran : ils ne sortent pas du serveur.
// Une porte sans droit aux salaires ne reçoit jamais le champ, même vide.
function sansMontants(employes) {
  return employes.map(({ taux_horaire, heures_max, ...reste }) => reste);
}

// Même protection que pour les codes employés, sur les liens horaire par code.
app.use("/api/schedule/by-code/:code", guard("schedule-code"), (req, res, next) => {
  if (!getRestaurantByCode(req.params.code)) {
    noteFailure("schedule-code", req);
    return res.status(404).json({ error: "Lien invalide" });
  }
  next();
});

app.get("/api/schedule/by-code/:code", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  const { restaurant: r, secteur, peutModifier, voitMontants } = porte;
  const employees = employesDuSecteur(r.id, secteur);
  res.json({
    restaurant: { id: r.id, name: r.name },
    employees: voitMontants ? employees : sansMontants(employees),
    secteur,
    peutModifier,
    voitMontants,
    charges_pct: voitMontants ? r.charges_pct || 0 : undefined,
  });
});

app.get("/api/schedule/by-code/:code/shifts", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  const shifts = db
    .prepare(`
      SELECT s.* FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE e.restaurant_id = ? AND e.secteur = ?
      ORDER BY s.date ASC, s.start_time ASC
    `)
    .all(porte.restaurant.id, porte.secteur);
  res.json({ shifts });
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
  const emp = db
    .prepare("SELECT * FROM employees WHERE id = ? AND restaurant_id = ? AND secteur = ?")
    .get(employee_id, r.id, porte.secteur);
  if (!emp) return res.status(403).json({ error: "Cet employé n'est pas dans cette équipe" });
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO shifts (id, employee_id, date, start_time, end_time, role, note) VALUES (?,?,?,?,?,?,?)"
  ).run(id, employee_id, date, start_time, end_time, role || "server", tacheValide(note));
  res.json({ id, ok: true });
});

app.post("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const shift = db
    .prepare(`
      SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.id = ? AND e.restaurant_id = ? AND e.secteur = ?
    `)
    .get(req.params.id, porte.restaurant.id, porte.secteur);
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
  res.json({ deleted: deleteShiftsBetween(porte.restaurant.id, from, to, porte.secteur).changes });
});

app.delete("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const porte = porteParCode(req.params.code);
  if (!porte) return res.status(404).json({ error: "Lien invalide" });
  if (!porte.peutModifier) return res.status(403).json({ error: "Ce lien est en lecture seule" });
  const shift = db
    .prepare(`
      SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.id = ? AND e.restaurant_id = ? AND e.secteur = ?
    `)
    .get(req.params.id, porte.restaurant.id, porte.secteur);
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
        WHERE restaurant_id = ? AND secteur = ? ORDER BY created_at ASC
      `)
      .all(restaurantId, secteur);
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
    shifts: shiftsOfWeek(restaurant.id, weekStartISO).filter((q) => ids.has(q.employee_id)),
    weekStartISO,
    lang,
    // La cuisine finit à l'heure : son horaire affiche donc l'heure de fin. En salle, une
    // serveuse part quand la salle est vide — l'heure écrite serait une promesse fausse.
    avecHeureFin: secteur === "cuisine",
    // Les tâches de quart (« Prép », « Commande à défaire ») n'existent qu'en cuisine.
    avecTaches: secteur === "cuisine",
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
app.get("/api/admin/backup", requireAdmin, async (req, res) => {
  try {
    const { buffer, filename, resume } = await buildBackupZip({ db, photosDir: PHOTOS_DIR });
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
    return { ...r, employees };
  });
  res.json({ restaurants: data });
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
  res.json({ deleted: deleteShiftsBetween(restaurant_id, from, to, secteur).changes });
});

app.delete("/api/admin/shifts/:id", requireScheduleAccess, (req, res) => {
  db.prepare("DELETE FROM shifts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/employee/:code/shifts", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });

  // Les quarts à venir (à partir d'aujourd'hui, heure locale approximative), les plus proches en premier
  const shifts = db
    .prepare("SELECT * FROM shifts WHERE employee_id = ? AND date >= date('now', '-1 day') ORDER BY date ASC, start_time ASC")
    .all(emp.id);
  res.json({ shifts });
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

function secteurValide(valeur) {
  return valeur === "cuisine" ? "cuisine" : "salle";
}
function tauxValide(valeur) {
  const n = typeof valeur === "number" ? valeur : parseFloat(valeur);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1000); // un taux à quatre chiffres est une faute de frappe, pas un salaire
}

// Plafond d'heures par semaine. 0 signifie « aucun plafond » ; au-delà de 168 on a dépassé
// le nombre d'heures qu'une semaine contient.
function heuresMaxValide(valeur) {
  const n = typeof valeur === "number" ? valeur : parseFloat(valeur);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 168);
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
  const heuresMax = heuresMaxValide(req.body.heures_max);
  db.prepare(`
    INSERT INTO employees (id, restaurant_id, name, employee_number, access_code, secteur, taux_horaire, heures_max)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, restaurant_id, name, employee_number || "", code, secteur, taux, heuresMax);

  res.json({ id, name, employee_number, access_code: code, secteur, taux_horaire: taux, heures_max: heuresMax });
});

// Modifier un employé : c'est par ici qu'on entre un taux horaire, qu'on corrige un nom, ou
// qu'on déplace quelqu'un de la salle vers la cuisine.
app.post("/api/admin/employees/:id", requireAdmin, (req, res) => {
  const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });

  const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : emp.name;
  const numero = req.body.employee_number === undefined ? emp.employee_number : String(req.body.employee_number || "");
  const secteur = req.body.secteur === undefined ? emp.secteur : secteurValide(req.body.secteur);
  const taux = req.body.taux_horaire === undefined ? emp.taux_horaire : tauxValide(req.body.taux_horaire);
  const heuresMax = req.body.heures_max === undefined ? emp.heures_max : heuresMaxValide(req.body.heures_max);

  db.prepare("UPDATE employees SET name=?, employee_number=?, secteur=?, taux_horaire=?, heures_max=? WHERE id=?")
    .run(name, numero, secteur, taux, heuresMax, emp.id);
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

app.delete("/api/admin/employees/:id", requireAdmin, (req, res) => {
  deletePhotoFiles(db.prepare("SELECT photo_filename FROM entries WHERE employee_id = ?").all(req.params.id));
  db.prepare("DELETE FROM entries WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM shifts WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM messages WHERE employee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/entries/:entryId/transferred", requireAdmin, (req, res) => {
  const value = req.body.transferred ? 1 : 0;
  const transferDate = req.body.transfer_date || null;
  db.prepare(`UPDATE entries SET transferred=?, transfer_date=?, updated_at=datetime('now') WHERE id=?`)
    .run(value, value ? transferDate : null, req.params.entryId);
  res.json({ ok: true });
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
