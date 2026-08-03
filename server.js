const express = require("express");
const path = require("path");
const fs = require("fs");
const { db, nanoid, makeAccessCode, PHOTOS_DIR } = require("./db");

const app = express();
app.use(express.json({ limit: "12mb" })); // les photos en base64 sont plus lourdes que du texte
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

// ---------- helpers ----------
function computeEntry(e) {
  const ventes = e.ventes || 0;
  const clients = e.clients || 0;
  const pct = e.pct || 0;
  const remis = e.remis || 0;
  const pourboireBrut = ventes * (pct / 100);
  const net = pourboireBrut - remis;
  const moyenne = clients > 0 ? ventes / clients : 0;
  return { ...e, ventes, clients, pct, remis, pourboireBrut, net, moyenne };
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// =========================================================
//  API EMPLOYÉ (accès par code, aucun mot de passe compliqué)
// =========================================================

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

  const { id, date, ventes, clients, pct, remis, remit_direction } = req.body;
  if (!date) return res.status(400).json({ error: "Date requise" });
  const direction = ["employer_owes", "employee_owes"].includes(remit_direction) ? remit_direction : null;

  // Si un id est fourni et appartient bien à cet employé, on met à jour cette entrée précise.
  const existing = id
    ? db.prepare("SELECT id FROM entries WHERE id = ? AND employee_id = ?").get(id, emp.id)
    : null;

  if (existing) {
    db.prepare(
      `UPDATE entries SET date=?, ventes=?, clients=?, pct=?, remis=?, remit_direction=?, updated_at=datetime('now') WHERE id=?`
    ).run(date, ventes || 0, clients || 0, pct || 0, remis || 0, direction, existing.id);
    res.json({ ok: true, id: existing.id });
  } else {
    // Sinon on crée une NOUVELLE entrée — plusieurs entrées peuvent exister pour la même date
    // (ex: une serveuse qui rentre ses chiffres 2 fois dans la même journée).
    const newId = nanoid(10);
    db.prepare(
      `INSERT INTO entries (id, employee_id, date, ventes, clients, pct, remis, remit_direction) VALUES (?,?,?,?,?,?,?,?)`
    ).run(newId, emp.id, date, ventes || 0, clients || 0, pct || 0, remis || 0, direction);
    res.json({ ok: true, id: newId });
  }
});

app.delete("/api/employee/:code/entries/:entryId", (req, res) => {
  const emp = db
    .prepare("SELECT * FROM employees WHERE access_code = ?")
    .get(req.params.code.toUpperCase());
  if (!emp) return res.status(404).json({ error: "Code inconnu" });
  db.prepare("DELETE FROM entries WHERE employee_id = ? AND id = ?").run(emp.id, req.params.entryId);
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

  const match = /^data:image\/(\w+);base64,(.+)$/.exec(photoBase64);
  if (!match) return res.status(400).json({ error: "Format de photo invalide" });
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");

  const filename = `${entry.id}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
  db.prepare(`UPDATE entries SET photo_filename=?, updated_at=datetime('now') WHERE id=?`).run(filename, entry.id);

  res.json({ ok: true, photo_filename: filename });
});

app.get("/api/photos/:filename", (req, res) => {
  // sécurité de base : empêche de remonter dans l'arborescence via le nom de fichier
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(PHOTOS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send("Photo introuvable");
  res.sendFile(filePath);
});

// =========================================================
//  API ADMIN (Alex) — vue sur tous les restaurants/employés
// =========================================================

app.post("/api/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    return res.json({ token: ADMIN_PASSWORD });
  }
  res.status(401).json({ error: "Mot de passe incorrect" });
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

app.post("/api/admin/restaurants", requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Nom requis" });
  const id = nanoid(10);
  db.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run(id, name);
  res.json({ id, name });
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
  db.prepare("DELETE FROM entries WHERE employee_id = ?").run(req.params.id);
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

app.delete("/api/admin/restaurants/:id", requireAdmin, (req, res) => {
  const emps = db.prepare("SELECT id FROM employees WHERE restaurant_id = ?").all(req.params.id);
  for (const e of emps) {
    db.prepare("DELETE FROM entries WHERE employee_id = ?").run(e.id);
  }
  db.prepare("DELETE FROM employees WHERE restaurant_id = ?").run(req.params.id);
  db.prepare("DELETE FROM restaurants WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- pages ----------
app.get("/e/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "employee.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/", (req, res) => {
  res.redirect("/admin");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coco Tips app running on port ${PORT}`));
