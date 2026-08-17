// Fabrique une sauvegarde complète, téléchargeable en un seul fichier .zip.
//
// Le volume protège les données d'un redéploiement, mais pas d'une fausse manœuvre : un
// restaurant supprimé par erreur est perdu. Et les sauvegardes automatiques de Railway
// exigent un plan payant. D'où ce bouton : le gérant télécharge tout, quand il veut.
//
// Le .zip contient deux choses de nature différente :
//   - donnees.sqlite : la vraie sauvegarde, celle qui permet de tout remettre en place.
//   - des fichiers .csv : les mêmes données en version lisible, ouvrables dans Excel ou
//     Numbers. Le gérant n'est pas informaticien ; il doit pouvoir vérifier lui-même que
//     sa sauvegarde contient bien quelque chose.

const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { computeEntry } = require("./public/shared/tip-math.js");

// Au-delà de cette taille, on laisse les photos de côté. Le .zip est assemblé en mémoire et
// le conteneur n'a qu'un Go : mieux vaut une sauvegarde sans les photos qu'une application
// qui tombe au moment précis où l'on essaie de se protéger. Les chiffres, eux, passent
// toujours — ils pèsent quelques dizaines de kilo-octets.
const PHOTOS_MAX_BYTES = 250 * 1024 * 1024;

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Point-virgule comme séparateur : c'est ce qu'attendent Excel et Numbers en français,
// où la virgule sert déjà de séparateur décimal.
function toCsv(rows, columns) {
  const head = columns.map(csvEscape).join(";");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(";")).join("\n");
  return "﻿" + head + "\n" + body + "\n"; // BOM : sans lui, Excel abîme les accents
}

function folderSize(dir) {
  let total = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return { total: 0, files: [] };
  }
  const kept = [];
  for (const name of files) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) {
        total += st.size;
        kept.push(name);
      }
    } catch (e) {
      // fichier disparu entre-temps — on l'ignore
    }
  }
  return { total, files: kept };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} octets`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Construit le .zip de sauvegarde et le retourne en Buffer.
 * @param {object} deps
 * @param {import("better-sqlite3").Database} deps.db
 * @param {string} deps.photosDir
 * @returns {Promise<{ buffer: Buffer, filename: string, resume: object }>}
 */
async function buildBackupZip({ db, photosDir }) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declara-backup-"));
  const tmpDb = path.join(tmpDir, "donnees.sqlite");

  try {
    // Copie cohérente PENDANT que l'application tourne. Copier le fichier à la main pendant
    // qu'une employée enregistre sa journée pourrait produire une sauvegarde abîmée ;
    // .backup() gère ça correctement.
    await db.backup(tmpDb);

    const zip = new AdmZip();
    zip.addLocalFile(tmpDb, "", "donnees.sqlite");

    // ----- versions lisibles -----
    const restaurants = db.prepare("SELECT id, name, schedule_code, created_at FROM restaurants ORDER BY created_at").all();
    const employees = db
      .prepare(`SELECT e.id, e.name, e.employee_number, e.access_code, r.name AS restaurant, e.created_at
                FROM employees e LEFT JOIN restaurants r ON r.id = e.restaurant_id ORDER BY r.name, e.created_at`)
      .all();
    const entries = db
      .prepare(`SELECT en.date, r.name AS restaurant, e.name AS employe, en.ventes, en.clients, en.pct, en.remis,
                       en.remit_direction, en.remit_amount, en.transferred, en.transfer_date, en.is_hotesse,
                       en.photo_filename, en.created_at, en.data_updated_at
                FROM entries en
                LEFT JOIN employees e ON e.id = en.employee_id
                LEFT JOIN restaurants r ON r.id = e.restaurant_id
                ORDER BY en.date DESC`)
      .all()
      .map((e) => {
        const c = computeEntry(e);
        // Arrondi aux cents : personne ne veut lire 4.800000000000001 dans un tableur.
        return { ...c, pourboire_brut: c.pourboireBrut.toFixed(2), pourboire_net: c.net.toFixed(2), moyenne_par_client: c.moyenne.toFixed(2) };
      });
    const shifts = db
      .prepare(`SELECT s.date, r.name AS restaurant, e.name AS employe, s.start_time, s.end_time, s.role, s.note
                FROM shifts s
                LEFT JOIN employees e ON e.id = s.employee_id
                LEFT JOIN restaurants r ON r.id = e.restaurant_id
                ORDER BY s.date DESC, s.start_time`)
      .all();
    const messages = db
      .prepare(`SELECT m.created_at, r.name AS restaurant, e.name AS employe, m.sender, m.is_read, m.body
                FROM messages m
                LEFT JOIN employees e ON e.id = m.employee_id
                LEFT JOIN restaurants r ON r.id = e.restaurant_id
                ORDER BY m.created_at DESC`)
      .all();

    zip.addFile("lisible/restaurants.csv", Buffer.from(toCsv(restaurants, ["name", "schedule_code", "created_at"]), "utf8"));
    zip.addFile("lisible/employes.csv", Buffer.from(toCsv(employees, ["restaurant", "name", "employee_number", "access_code", "created_at"]), "utf8"));
    zip.addFile(
      "lisible/journees.csv",
      Buffer.from(
        toCsv(entries, [
          "date", "restaurant", "employe", "ventes", "clients", "pct", "remis",
          "pourboire_brut", "pourboire_net", "moyenne_par_client",
          "remit_direction", "remit_amount", "transferred", "transfer_date",
          "is_hotesse", "photo_filename", "created_at", "data_updated_at",
        ]),
        "utf8"
      )
    );
    zip.addFile("lisible/horaires.csv", Buffer.from(toCsv(shifts, ["date", "restaurant", "employe", "start_time", "end_time", "role", "note"]), "utf8"));
    zip.addFile("lisible/messages.csv", Buffer.from(toCsv(messages, ["created_at", "restaurant", "employe", "sender", "is_read", "body"]), "utf8"));

    // ----- photos -----
    const { total: photosBytes, files: photoFiles } = folderSize(photosDir);
    const photosIncluded = photosBytes <= PHOTOS_MAX_BYTES;
    if (photosIncluded) {
      for (const name of photoFiles) zip.addLocalFile(path.join(photosDir, name), "photos");
    }

    const resume = {
      restaurants: restaurants.length,
      employes: employees.length,
      journees: entries.length,
      horaires: shifts.length,
      messages: messages.length,
      photos: photoFiles.length,
      photosIncluses: photosIncluded,
      photosTaille: humanSize(photosBytes),
    };

    zip.addFile("LISEZ-MOI.txt", Buffer.from(readme(now, resume), "utf8"));

    return { buffer: zip.toBuffer(), filename: `Declara_sauvegarde_${stamp}.zip`, resume };
  } finally {
    // On nettoie toujours, même si quelque chose a échoué au milieu.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // rien à faire de plus
    }
  }
}

function readme(now, r) {
  const date = now.toLocaleString("fr-CA");
  return `SAUVEGARDE DÉCLARA
Faite le ${date}

CE QUE CONTIENT CE DOSSIER
--------------------------

1) donnees.sqlite
   C'est LA sauvegarde. Ce fichier contient absolument tout.
   Tu ne peux pas l'ouvrir toi-même, et c'est normal : il sert à tout
   remettre en place si jamais quelque chose se perd. Garde-le.

2) Le dossier "lisible"
   Les mêmes informations, mais en fichiers que tu peux ouvrir toi-même
   dans Excel ou Numbers, en double-cliquant dessus :
     - restaurants.csv  tes restaurants et leurs liens horaire
     - employes.csv     tes employés et leurs codes d'accès
     - journees.csv     toutes les journées de pourboires, avec les calculs
     - horaires.csv     tous les quarts de travail
     - messages.csv     les conversations avec tes employés

3) Le dossier "photos"
   Les photos justificatives envoyées par tes employés.

CE QU'IL Y A DEDANS
-------------------
  Restaurants ......... ${r.restaurants}
  Employés ............ ${r.employes}
  Journées ............ ${r.journees}
  Quarts de travail ... ${r.horaires}
  Messages ............ ${r.messages}
  Photos .............. ${r.photos} (${r.photosTaille})${r.photosIncluses ? "" : "  ** NON INCLUSES — voir plus bas **"}
${
  r.photosIncluses
    ? ""
    : `
ATTENTION : LES PHOTOS N'ONT PAS ÉTÉ INCLUSES
Elles pèsent ${r.photosTaille}, c'est trop pour être mis dans un seul
fichier sans risquer de faire planter l'application. Tes chiffres, eux,
sont tous là. Si tu veux récupérer les photos aussi, écris-moi.
`
}
QUOI FAIRE AVEC
---------------
Garde ce fichier ailleurs que sur le site : sur ton ordinateur, dans tes
courriels, ou dans un nuage (iCloud, Google Drive, Dropbox).
Une sauvegarde qui reste au même endroit que l'original ne protège de rien.

Refais-en une de temps en temps — le dimanche soir, par exemple.
`;
}

module.exports = { buildBackupZip };
