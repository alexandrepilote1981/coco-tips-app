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
  -- Trois portes différentes sur l'horaire, parce qu'elles ne montrent pas la même chose :
  -- schedule_code                 : horaire de la salle, aucun montant
  -- schedule_code_cuisine         : horaire de la cuisine POUR LE GÉRANT — salaires compris,
  --                                 donc ce lien-là ne se partage pas à l'équipe
  -- schedule_code_cuisine_lecture : le même horaire pour les cuisiniers, en lecture seule
  --                                 et sans un sou affiché
  schedule_code_cuisine TEXT,
  schedule_code_cuisine_lecture TEXT,
  -- Un second verrou sur le lien du GÉRANT de cuisine, et sur lui seul : c'est la porte qui
  -- montre les salaires et qui porte les codes d'accès personnels de l'équipe. Un lien se
  -- fait suivre ; un lien plus un mot de passe, beaucoup moins.
  --
  -- Ce n'est PAS le mot de passe en clair : sel:empreinte, calculé par scrypt (node:crypto,
  -- aucune dépendance neuve). Personne ne peut le relire, pas même en ouvrant la base — et
  -- c'est voulu, puisque les gens réemploient leurs mots de passe ailleurs. Vide ou NULL veut
  -- dire « aucun mot de passe », l'état d'avant cette colonne : rien ne se ferme tout seul
  -- sur les installations existantes.
  mdp_cuisine TEXT,
  -- Ce que l'employeur paie EN PLUS du salaire (vacances, CNESST, RRQ…), en pourcentage du
  -- taux horaire. Reste à 0 tant que le comptable n'a pas donné le vrai chiffre : mieux vaut
  -- un coût visiblement incomplet qu'un coût inventé.
  charges_pct REAL DEFAULT 0,
  -- Les rappels à relire avant un férié, une par ligne (« Appeler Dufour & Fils »,
  -- « Doubler les bananes »). Du texte libre, pas une table : ce sont trois ou quatre
  -- phrases écrites une fois, jamais triées ni comptées. Une table aurait apporté des
  -- identifiants et un ordre à gérer, pour rien.
  rappels_ferie TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  employee_number TEXT,
  access_code TEXT UNIQUE NOT NULL,
  -- 'salle' | 'cuisine'. La salle déclare des pourboires, la cuisine non : c'est ce champ
  -- qui décide quel écran, quels postes et quel horaire s'appliquent à la personne.
  secteur TEXT DEFAULT 'salle',
  taux_horaire REAL DEFAULT 0,
  -- Plafond d'heures par semaine. 0 = aucun plafond : la plupart des employés n'en ont pas,
  -- et une valeur par défaut inventée ferait rougir des rangées sans raison.
  heures_max REAL DEFAULT 40,
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

-- Congés demandés et semaines de vacances, posés d'avance. Une plage plutôt qu'une date :
-- une semaine de vacances est une seule entrée, pas sept.
CREATE TABLE IF NOT EXISTS absences (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date_debut TEXT NOT NULL,
  date_fin TEXT NOT NULL,
  type TEXT DEFAULT 'conge',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Disponibilités : l'HABITUDE d'une personne, pas sa semaine. « Le mardi, pas avant 9h. »
-- Une ligne par jour de semaine et par employé ; la colonne jour va de 0 (lundi) à 6
-- (dimanche), comme les grilles d'horaire partout dans l'app.
--
-- L'ABSENCE de lignes veut dire « cette personne n'a jamais rempli ses disponibilités », et
-- c'est une information qu'on veut : elle est alors disponible partout par défaut, mais le
-- gérant voit qu'il reste à la relancer. Si on écrivait sept lignes « disponible » à la
-- création d'un employé, on perdrait la différence entre « j'ai dit oui à tout » et « j'ai
-- jamais ouvert la page ».
--
-- heure_debut / heure_fin vides = toute la journée. disponible = 0 = pas ce jour-là.
CREATE TABLE IF NOT EXISTS disponibilites (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  jour INTEGER NOT NULL,
  disponible INTEGER DEFAULT 1,
  heure_debut TEXT DEFAULT '',
  heure_fin TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, jour)
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
  "submitted_at TEXT",
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

// Retrouver les absences d'une personne est la question qu'on pose le plus souvent : une
// fois par employé et par rendu de grille.
db.exec(`CREATE INDEX IF NOT EXISTS idx_absences_employe ON absences(employee_id);`);

// Migration défensive : ajoute la colonne role si la table shifts existait déjà sans elle.
try {
  db.exec(`ALTER TABLE shifts ADD COLUMN role TEXT DEFAULT 'server';`);
} catch (e) {
  // colonne déjà présente — rien à faire
}

// Secteur et taux horaire. Le défaut 'salle' est volontaire : tout le monde déjà en place
// reste exactement où il était, et c'est le gérant qui déplace ensuite les gens en cuisine.
for (const col of ["secteur TEXT DEFAULT 'salle'", "taux_horaire REAL DEFAULT 0", "heures_max REAL DEFAULT 40"]) {
  try {
    db.exec(`ALTER TABLE employees ADD COLUMN ${col};`);
  } catch (e) {
    // colonne déjà présente — rien à faire
  }
}
db.exec(`UPDATE employees SET secteur = 'salle' WHERE secteur IS NULL OR secteur = '';`);
db.exec(`UPDATE employees SET heures_max = 0 WHERE heures_max IS NULL;`);

// 40 h par défaut pour tout le monde — demande du propriétaire, et la raison est la paie :
// au-delà de 40 h dans une semaine, les heures se paient en temps supplémentaire. Le plafond
// sert d'abord à ne pas y tomber sans s'en apercevoir, donc 40 est le bon défaut et « aucun
// plafond » devient l'exception.
//
// UNE SEULE FOIS, marqué par PRAGMA user_version : sans ce garde, quelqu'un qu'on a
// délibérément remis à « aucun plafond » se retrouverait à 40 h au prochain redéploiement,
// et le réglage ne tiendrait jamais. Pas de table de configuration pour ça — user_version
// est fait exactement pour marquer une migration déjà passée.
if (db.pragma("user_version", { simple: true }) < 1) {
  db.exec(`UPDATE employees SET heures_max = 40 WHERE heures_max = 0;`);
  db.pragma("user_version = 1");
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
for (const col of ["schedule_code_cuisine TEXT", "schedule_code_cuisine_lecture TEXT", "charges_pct REAL DEFAULT 0", "rappels_ferie TEXT DEFAULT ''", "mdp_cuisine TEXT"]) {
  try {
    db.exec(`ALTER TABLE restaurants ADD COLUMN ${col};`);
  } catch (e) {
    // colonne déjà présente — rien à faire
  }
}

// Un code d'horaire doit désigner UNE seule porte : /horaire/<code> ne peut pas être à la
// fois la salle et la cuisine. On vérifie donc l'unicité sur les trois colonnes à la fois.
function codeDejaPris(code) {
  return !!db
    .prepare(
      `SELECT 1 FROM restaurants
       WHERE schedule_code = ? OR schedule_code_cuisine = ? OR schedule_code_cuisine_lecture = ?`
    )
    .get(code, code, code);
}

function codeLibre() {
  let code;
  do {
    code = makeAccessCode();
  } while (codeDejaPris(code));
  return code;
}

// Donne à chaque restaurant les codes qui lui manquent — ceux créés avant cette mise à jour
// n'ont que celui de la salle.
for (const colonne of ["schedule_code", "schedule_code_cuisine", "schedule_code_cuisine_lecture"]) {
  const sansCode = db.prepare(`SELECT id FROM restaurants WHERE ${colonne} IS NULL OR ${colonne} = ''`).all();
  for (const r of sansCode) {
    db.prepare(`UPDATE restaurants SET ${colonne} = ? WHERE id = ?`).run(codeLibre(), r.id);
  }
}
// Un petit casier clé/valeur pour ce qui appartient à l'INSTALLATION et pas à un restaurant.
// Pour l'instant il ne sert qu'à la date de la dernière sauvegarde — mais c'était ça ou une
// colonne de plus sur `restaurants`, qui aurait menti : une sauvegarde couvre toute la base,
// pas un commerce.
db.exec(`
CREATE TABLE IF NOT EXISTS reglages (
  cle   TEXT PRIMARY KEY,
  valeur TEXT
);
`);

db.exec(`UPDATE restaurants SET charges_pct = 0 WHERE charges_pct IS NULL;`);
db.exec(`UPDATE restaurants SET rappels_ferie = '' WHERE rappels_ferie IS NULL;`);

module.exports = {
  db,
  nanoid,
  makeAccessCode,
  codeLibre,
  PHOTOS_DIR,
};
