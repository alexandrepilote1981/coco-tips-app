const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { nanoid } = require("nanoid");

// Railway: monter un volume sur /data pour que la DB survive aux redéploiements.
// En local (sans volume), on retombe sur un fichier dans le dossier du projet.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Les photos vivent à côté de la base, sur le même volume persistant.
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(path.dirname(DB_PATH), "photos");
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule_code TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  employee_number TEXT,
  access_code TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  ventes REAL DEFAULT 0,
  clients REAL DEFAULT 0,
  pct REAL DEFAULT 0,
  remis REAL DEFAULT 0,
  photo_filename TEXT,
  flagged_negative INTEGER DEFAULT 0,
  remit_direction TEXT,
  remit_amount REAL DEFAULT 0,
  transferred INTEGER DEFAULT 0,
  transfer_date TEXT,
  is_hotesse INTEGER DEFAULT 0,
  delay_dismissed INTEGER DEFAULT 0,
  modified_dismissed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  data_updated_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  body TEXT NOT NULL,
  sender TEXT DEFAULT 'employee',
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  role TEXT DEFAULT 'server',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration : ajoute la colonne sender ('employee' | 'admin') si la table messages existait déjà
// sans cette colonne, pour permettre les réponses du gérant dans la même conversation.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sender TEXT DEFAULT 'employee';`);
} catch (e) {
  // colonne déjà présente — rien à faire
}

// Migrations sécuritaires : ajoute les colonnes si la base existait déjà (volume persistant)
// sans ces colonnes. Ignore l'erreur si elles existent déjà.
// remit_direction : 'employer_owes' (l'employeur doit un virement) | 'employee_owes' (l'employé doit un virement) | NULL
// is_hotesse : la personne se déclare "hôtesse pour cette journée" — change le formulaire pour cette entrée précise
for (const col of [
  "photo_filename TEXT",
  "flagged_negative INTEGER DEFAULT 0",
  "remit_direction TEXT",
  "remit_amount REAL DEFAULT 0",
  "transferred INTEGER DEFAULT 0",
  "transfer_date TEXT",
  "is_hotesse INTEGER DEFAULT 0",
  "created_at TEXT",
  "delay_dismissed INTEGER DEFAULT 0",
  "modified_dismissed INTEGER DEFAULT 0",
  "data_updated_at TEXT",
]) {
  try {
    db.exec(`ALTER TABLE entries ADD COLUMN ${col};`);
  } catch (e) {
    // colonne déjà présente — rien à faire
  }
}

// Pour les journées créées avant l'ajout de cette colonne, on utilise updated_at comme
// approximation raisonnable de la date de création (mieux que rien; on ne le refait
// jamais après, donc les vraies nouvelles journées auront toujours la bonne date figée).
db.exec(`UPDATE entries SET created_at = updated_at WHERE created_at IS NULL;`);
db.exec(`UPDATE entries SET data_updated_at = updated_at WHERE data_updated_at IS NULL;`);

// Migration défensive : ajoute la colonne role si la table shifts existait déjà sans elle.
try {
  db.exec(`ALTER TABLE shifts ADD COLUMN role TEXT DEFAULT 'server';`);
} catch (e) {
  // colonne déjà présente — rien à faire
}

function makeAccessCode() {
  // court, facile à lire/dicter au téléphone : 6 caractères, sans caractères ambigus.
  // Tirage cryptographique et non Math.random() : ce code EST la clé d'accès d'un employé,
  // et Math.random() est prévisible — connaître quelques codes permettait d'en deviner d'autres.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

// Migration défensive : ajoute la colonne schedule_code si la table restaurants existait déjà sans elle,
// puis donne un code à tout restaurant qui n'en a pas encore (ex: restaurants créés avant cette mise à jour).
try {
  db.exec(`ALTER TABLE restaurants ADD COLUMN schedule_code TEXT;`);
} catch (e) {
  // colonne déjà présente — rien à faire
}
const restaurantsSansCode = db.prepare(`SELECT id FROM restaurants WHERE schedule_code IS NULL OR schedule_code = ''`).all();
for (const r of restaurantsSansCode) {
  let code;
  do {
    code = makeAccessCode();
  } while (db.prepare(`SELECT 1 FROM restaurants WHERE schedule_code = ?`).get(code));
  db.prepare(`UPDATE restaurants SET schedule_code = ? WHERE id = ?`).run(code, r.id);
}

module.exports = {
  db,
  nanoid,
  makeAccessCode,
  PHOTOS_DIR,
};
