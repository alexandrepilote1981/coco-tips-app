// Ouverture de la base, schéma et migrations. Comme sur le projet précédent, tout est
// idempotent et s'exécute au démarrage : il n'y a aucune étape de migration manuelle à se
// rappeler au moment d'un déploiement.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { nanoid } = require("nanoid");

// Railway : monter un volume sur /data pour que la base survive aux redéploiements.
// En local (sans volume), on retombe sur un fichier dans le dossier du projet.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Les photos vivent à côté de la base, sur le même volume persistant. Une facture dont la
// photo a disparu ne vaut rien à la vérification fiscale : les deux doivent être sauvegardés
// ensemble ou pas du tout.
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(path.dirname(DB_PATH), "photos");
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS factures (
  id TEXT PRIMARY KEY,
  fournisseur TEXT,
  fournisseur_tps TEXT,
  fournisseur_tvq TEXT,
  date TEXT,
  sous_total REAL DEFAULT 0,
  tps REAL DEFAULT 0,
  tvq REAL DEFAULT 0,
  total REAL DEFAULT 0,
  devise TEXT DEFAULT 'CAD',
  categorie TEXT,
  mode_paiement TEXT,
  note TEXT,
  photo_filename TEXT,
  image_hash TEXT,
  statut TEXT DEFAULT 'a_valider',
  extraction_brute TEXT,
  extraction_erreur TEXT,
  ecart_taxes REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Sert à la détection de doublons par empreinte d'image. Non UNIQUE volontairement : on veut
-- pouvoir enregistrer une deuxième fois si l'utilisateur confirme que ce n'en est pas un.
CREATE INDEX IF NOT EXISTS idx_factures_hash ON factures(image_hash);
CREATE INDEX IF NOT EXISTS idx_factures_statut ON factures(statut, date);

CREATE TABLE IF NOT EXISTS reglages (
  cle TEXT PRIMARY KEY,
  valeur TEXT
);
`);

// Migrations défensives : ajoute les colonnes si la base existait déjà sur un volume
// persistant sans elles. Ignore l'erreur quand la colonne est déjà là.
for (const col of [
  "fournisseur_tps TEXT",
  "fournisseur_tvq TEXT",
  "categorie TEXT",
  "mode_paiement TEXT",
  "image_hash TEXT",
  "extraction_brute TEXT",
  "extraction_erreur TEXT",
  "ecart_taxes REAL DEFAULT 0",
]) {
  try {
    db.exec(`ALTER TABLE factures ADD COLUMN ${col};`);
  } catch (e) {
    // colonne déjà présente — rien à faire
  }
}

function makeCode() {
  // Court, facile à dicter au téléphone : 6 caractères, sans caractères ambigus.
  // Tirage cryptographique et non Math.random() : ce code EST la clé du lien de capture,
  // et Math.random() est prévisible.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function getReglage(cle) {
  const row = db.prepare("SELECT valeur FROM reglages WHERE cle = ?").get(cle);
  return row ? row.valeur : null;
}

function setReglage(cle, valeur) {
  db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(cle, valeur);
}

// Le code du lien de capture est généré une fois puis conservé : il est enregistré dans les
// favoris du téléphone, donc le changer casserait le raccourci de l'utilisateur.
if (!getReglage("capture_code")) setReglage("capture_code", makeCode());

module.exports = { db, nanoid, makeCode, getReglage, setReglage, PHOTOS_DIR };
