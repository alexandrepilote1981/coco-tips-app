const express = require("express");
const path = require("path");
const fs = require("fs");
const { db, nanoid, makeAccessCode, PHOTOS_DIR } = require("./db");
const { buildSchedulePdf, schedulePdfFilename } = require("./pdf-horaire");
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
    db.prepare(
      `UPDATE entries SET date=?, ventes=?, clients=?, pct=?, remis=?, remit_direction=?, remit_amount=?, is_hotesse=?, updated_at=datetime('now'), data_updated_at=datetime('now') WHERE id=?`
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

// ---------- Accès horaire par lien direct (un code par restaurant, aucun mot de passe) ----------
// Même logique que les liens employés : le code lui-même sert de clé d'accès.
function getRestaurantByCode(code) {
  return db.prepare("SELECT * FROM restaurants WHERE schedule_code = ?").get((code || "").toUpperCase());
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
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  const employees = db
    .prepare("SELECT id, name, employee_number FROM employees WHERE restaurant_id = ? ORDER BY created_at ASC")
    .all(r.id);
  res.json({ restaurant: { id: r.id, name: r.name }, employees });
});

app.get("/api/schedule/by-code/:code/shifts", (req, res) => {
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  const shifts = db
    .prepare(`
      SELECT s.* FROM shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE e.restaurant_id = ?
      ORDER BY s.date ASC, s.start_time ASC
    `)
    .all(r.id);
  res.json({ shifts });
});

app.post("/api/schedule/by-code/:code/shifts", (req, res) => {
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  const { employee_id, date, start_time, end_time, role, note } = req.body;
  if (!employee_id || !date || !start_time || !end_time) {
    return res.status(400).json({ error: "employee_id, date, start_time et end_time requis" });
  }
  const emp = db.prepare("SELECT * FROM employees WHERE id = ? AND restaurant_id = ?").get(employee_id, r.id);
  if (!emp) return res.status(403).json({ error: "Cet employé n'appartient pas à ce restaurant" });
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO shifts (id, employee_id, date, start_time, end_time, role, note) VALUES (?,?,?,?,?,?,?)"
  ).run(id, employee_id, date, start_time, end_time, role || "server", note || "");
  res.json({ id, ok: true });
});

app.post("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  const shift = db
    .prepare("SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id WHERE s.id = ? AND e.restaurant_id = ?")
    .get(req.params.id, r.id);
  if (!shift) return res.status(404).json({ error: "Quart introuvable" });
  const { date, start_time, end_time, role, note } = req.body;
  db.prepare(
    "UPDATE shifts SET date=?, start_time=?, end_time=?, role=?, note=?, updated_at=datetime('now') WHERE id=?"
  ).run(date, start_time, end_time, role || "server", note || "", req.params.id);
  res.json({ ok: true });
});

app.delete("/api/schedule/by-code/:code/shifts/:id", (req, res) => {
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  const shift = db
    .prepare("SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id WHERE s.id = ? AND e.restaurant_id = ?")
    .get(req.params.id, r.id);
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

function employeesOf(restaurantId) {
  return db
    // Même ordre que la grille à l'écran, pour que le PDF se lise comme ce que le gérant vient de voir.
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

async function sendSchedulePdf(res, restaurant, weekStartISO, lang) {
  const buffer = await buildSchedulePdf({
    restaurantName: restaurant.name,
    employees: employeesOf(restaurant.id),
    shifts: shiftsOfWeek(restaurant.id, weekStartISO),
    weekStartISO,
    lang,
  });
  const filename = schedulePdfFilename(restaurant.name, weekStartISO, lang);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

// Mode lien direct (/horaire/CODE) : le code fait office de clé, comme pour les autres routes by-code.
app.get("/api/schedule/by-code/:code/pdf", async (req, res) => {
  const r = getRestaurantByCode(req.params.code);
  if (!r) return res.status(404).json({ error: "Lien invalide" });
  try {
    await sendSchedulePdf(res, r, isoOrToday(req.query.week), req.query.lang === "en" ? "en" : "fr");
  } catch (err) {
    console.error("PDF horaire (by-code) :", err);
    res.status(500).json({ error: "Impossible de générer le PDF" });
  }
});

// Mode mot de passe (/horaire) : même porte que le reste de la planification.
app.get("/api/admin/schedule/pdf", requireScheduleAccess, async (req, res) => {
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(req.query.restaurantId);
  if (!restaurant) return res.status(404).json({ error: "Restaurant introuvable" });
  try {
    await sendSchedulePdf(res, restaurant, isoOrToday(req.query.week), req.query.lang === "en" ? "en" : "fr");
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
    SELECT s.*, e.name AS employee_name, e.restaurant_id
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
  ).run(id, employee_id, date, start_time, end_time, role || "server", note || "");
  res.json({ id, ok: true });
});

app.post("/api/admin/shifts/:id", requireScheduleAccess, (req, res) => {
  const { date, start_time, end_time, role, note } = req.body;
  db.prepare(
    "UPDATE shifts SET date=?, start_time=?, end_time=?, role=?, note=?, updated_at=datetime('now') WHERE id=?"
  ).run(date, start_time, end_time, role || "server", note || "", req.params.id);
  res.json({ ok: true });
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
  let scheduleCode;
  do {
    scheduleCode = makeAccessCode();
  } while (db.prepare("SELECT 1 FROM restaurants WHERE schedule_code = ?").get(scheduleCode));
  db.prepare("INSERT INTO restaurants (id, name, schedule_code) VALUES (?, ?, ?)").run(id, name, scheduleCode);
  res.json({ id, name, schedule_code: scheduleCode });
});

app.post("/api/admin/employees", requireAdmin, (req, res) => {
  const { restaurant_id, name, employee_number } = req.body;
  if (!restaurant_id || !name) return res.status(400).json({ error: "restaurant_id et name requis" });

  let code;
  do {
    code = makeAccessCode();
  } while (db.prepare("SELECT 1 FROM employees WHERE access_code = ?").get(code));

  const id = nanoid(10);
  db.prepare(
    "INSERT INTO employees (id, restaurant_id, name, employee_number, access_code) VALUES (?,?,?,?,?)"
  ).run(id, restaurant_id, name, employee_number || "", code);

  res.json({ id, name, employee_number, access_code: code });
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
