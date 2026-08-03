const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
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
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration sécuritaire : ajoute la colonne photo_filename si la base existait déjà
// (sur le volume persistant) sans cette colonne. Ignore l'erreur si elle existe déjà.
try {
  db.exec(`ALTER TABLE entries ADD COLUMN photo_filename TEXT;`);
} catch (e) {
  // colonne déjà présente — rien à faire
}

function makeAccessCode() {
  // court, facile à lire/dicter au téléphone : 6 caractères, sans caractères ambigus
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

module.exports = {
  db,
  nanoid,
  makeAccessCode,
  PHOTOS_DIR,
};
