// Toutes les routes HTTP, dans un seul fichier. L'app est petite et le restera : découper en
// modules avant qu'il y ait quelque chose à découper coûte plus de navigation que ça n'en
// épargne.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { db, nanoid, getReglage, PHOTOS_DIR } = require("./db");
const { extraireFacture, extractionDisponible } = require("./extraction");
const Taxes = require("./public/shared/taxes");
const limite = require("./rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const MOT_DE_PASSE = process.env.APP_PASSWORD || "changeme";

// Les photos en base64 sont nettement plus lourdes que du texte. La compression côté
// navigateur les ramène sous le mégaoctet, mais on garde de la marge pour un téléphone dont
// le canvas rendrait une image plus grosse que prévu.
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Seuls ces formats sont écrits sur disque et renvoyés par /api/photos. Reprise d'une faille
// réelle rencontrée sur le projet précédent : sans liste blanche, un « data:image/html;base64,… »
// était écrit en .html puis reservi en text/html, donc du script exécuté sur le domaine.
const EXTENSIONS = { jpeg: "jpg", jpg: "jpg", png: "png", gif: "gif", webp: "webp" };
const TYPES_MIME = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

// ---------------------------------------------------------------------------
// Authentification

// Deux portes : le mot de passe (le site complet) et le code de capture (le lien du
// téléphone, qui ne peut QUE déposer une photo). Le lien vit dans les favoris d'un téléphone
// qui peut se perdre — il ne doit donc jamais donner accès au registre ni aux montants.
function motDePasseValide(req) {
  return req.get("X-App-Token") === MOT_DE_PASSE;
}

function codeCaptureValide(req) {
  const code = req.get("X-Capture-Code");
  return Boolean(code) && code === getReglage("capture_code");
}

function exigerMotDePasse(req, res, next) {
  if (limite.estBloque(req, "app")) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
  if (!motDePasseValide(req)) {
    limite.noterEchec(req, "app");
    return res.status(401).json({ error: "Non autorisé" });
  }
  limite.noterSucces(req, "app");
  next();
}

// Le dépôt d'une photo accepte les deux portes : depuis le téléphone par le lien privé,
// depuis le poste de travail une fois connecté.
function exigerDepot(req, res, next) {
  if (limite.estBloque(req, "depot")) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
  if (!motDePasseValide(req) && !codeCaptureValide(req)) {
    limite.noterEchec(req, "depot");
    return res.status(401).json({ error: "Non autorisé" });
  }
  limite.noterSucces(req, "depot");
  next();
}

// ---------------------------------------------------------------------------
// Pages

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/depenses", (req, res) => res.sendFile(path.join(__dirname, "public", "depenses.html")));

// Le lien du téléphone. Le code reste dans l'URL : la page le lit et l'envoie en en-tête.
app.get("/c/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "capture.html")));

// ---------------------------------------------------------------------------
// Session

app.post("/api/session", (req, res) => {
  if (limite.estBloque(req, "app")) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans quelques minutes." });
  if (req.body?.motDePasse !== MOT_DE_PASSE) {
    limite.noterEchec(req, "app");
    return res.status(401).json({ error: "Mot de passe invalide" });
  }
  limite.noterSucces(req, "app");
  res.json({ ok: true });
});

// Vérifie qu'un code de capture est valide, pour que la page du téléphone puisse afficher un
// message clair au lieu d'échouer seulement au moment du dépôt.
app.get("/api/capture/:code", (req, res) => {
  if (limite.estBloque(req, "depot")) return res.status(429).json({ error: "Trop de tentatives." });
  if (req.params.code !== getReglage("capture_code")) {
    limite.noterEchec(req, "depot");
    return res.status(404).json({ error: "Lien invalide" });
  }
  limite.noterSucces(req, "depot");
  res.json({ ok: true, extraction: extractionDisponible() });
});

app.get("/api/lien-capture", exigerMotDePasse, (req, res) => {
  res.json({ code: getReglage("capture_code") });
});

// ---------------------------------------------------------------------------
// Dépôt et analyse d'une facture

app.post("/api/factures", exigerDepot, async (req, res) => {
  const { photoBase64 } = req.body || {};
  if (!photoBase64) return res.status(400).json({ error: "Photo requise" });

  const match = /^data:image\/([\w+.-]+);base64,(.+)$/.exec(photoBase64);
  if (!match) return res.status(400).json({ error: "Format de photo invalide" });
  const ext = EXTENSIONS[match[1].toLowerCase()];
  if (!ext) return res.status(400).json({ error: "Format de photo invalide" });

  const buffer = Buffer.from(match[2], "base64");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");

  // Doublon par empreinte : la même photo renvoyée deux fois (double tap, reprise après une
  // connexion coupée). On le signale sans rien écrire — c'est à l'utilisateur de décider.
  const existante = db.prepare("SELECT id, fournisseur, date, total FROM factures WHERE image_hash = ?").get(hash);
  if (existante && !req.body.forcer) {
    return res.status(409).json({ error: "doublon", facture: existante });
  }

  // La photo est écrite AVANT l'analyse, et l'enregistrement créé dans la foulée. Si l'API
  // est en panne ou la clé absente, la facture existe quand même et reste à compléter à la
  // main : on ne perd jamais une pièce justificative parce qu'un appel réseau a échoué.
  const filename = `${Date.now()}-${nanoid(8)}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);

  const id = nanoid(12);
  db.prepare(`INSERT INTO factures (id, photo_filename, image_hash, statut) VALUES (?, ?, ?, 'a_valider')`).run(id, filename, hash);

  if (!extractionDisponible()) {
    db.prepare(`UPDATE factures SET extraction_erreur = ? WHERE id = ?`).run("ANTHROPIC_API_KEY absente — saisie manuelle", id);
    return res.json({ id, extraite: false, message: "Photo enregistrée. L'analyse automatique n'est pas configurée." });
  }

  try {
    const lu = await extraireFacture(photoBase64);
    const coherence = Taxes.verifierCoherence(lu);
    db.prepare(`
      UPDATE factures SET
        fournisseur = ?, fournisseur_tps = ?, fournisseur_tvq = ?, date = ?,
        sous_total = ?, tps = ?, tvq = ?, total = ?, devise = ?,
        categorie = ?, mode_paiement = ?,
        extraction_brute = ?, ecart_taxes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      lu.fournisseur, lu.fournisseur_tps, lu.fournisseur_tvq, lu.date,
      lu.sous_total || 0, lu.tps || 0, lu.tvq || 0, lu.total || 0, lu.devise || "CAD",
      lu.categorie, lu.mode_paiement,
      JSON.stringify(lu), coherence.ecart, id
    );
    const facture = db.prepare("SELECT * FROM factures WHERE id = ?").get(id);
    res.json({ id, extraite: true, facture, coherence, alertes: Taxes.alertesCTI(facture), lisible: lu.lisible });
  } catch (e) {
    // L'échec d'analyse n'est pas l'échec du dépôt : la photo est déjà sur le volume.
    db.prepare(`UPDATE factures SET extraction_erreur = ? WHERE id = ?`).run(String(e.message || e), id);
    res.json({ id, extraite: false, message: "Photo enregistrée, mais l'analyse a échoué. À compléter à la main." });
  }
});

// ---------------------------------------------------------------------------
// Registre

app.get("/api/factures", exigerMotDePasse, (req, res) => {
  const statut = req.query.statut;
  const lignes = statut
    ? db.prepare("SELECT * FROM factures WHERE statut = ? ORDER BY COALESCE(date, created_at) DESC").all(statut)
    : db.prepare("SELECT * FROM factures ORDER BY COALESCE(date, created_at) DESC").all();
  res.json({
    factures: lignes.map((f) => ({ ...f, alertes: Taxes.alertesCTI(f) })),
    extraction: extractionDisponible(),
  });
});

app.patch("/api/factures/:id", exigerMotDePasse, (req, res) => {
  const facture = db.prepare("SELECT * FROM factures WHERE id = ?").get(req.params.id);
  if (!facture) return res.status(404).json({ error: "Facture introuvable" });

  const b = req.body || {};
  const fusion = {
    fournisseur: b.fournisseur ?? facture.fournisseur,
    fournisseur_tps: b.fournisseur_tps ?? facture.fournisseur_tps,
    fournisseur_tvq: b.fournisseur_tvq ?? facture.fournisseur_tvq,
    date: b.date ?? facture.date,
    sous_total: Taxes.arrondirCent(b.sous_total ?? facture.sous_total),
    tps: Taxes.arrondirCent(b.tps ?? facture.tps),
    tvq: Taxes.arrondirCent(b.tvq ?? facture.tvq),
    total: Taxes.arrondirCent(b.total ?? facture.total),
    categorie: b.categorie ?? facture.categorie,
    mode_paiement: b.mode_paiement ?? facture.mode_paiement,
    note: b.note ?? facture.note,
    statut: b.statut ?? facture.statut,
  };

  const coherence = Taxes.verifierCoherence(fusion);

  // Un doublon par empreinte se voit au dépôt ; celui-ci se voit à la validation : la même
  // facture rephotographiée sous un autre angle a une empreinte différente mais le même
  // fournisseur, la même date et le même total.
  if (fusion.statut === "valide") {
    const jumelle = db.prepare(`
      SELECT id FROM factures
      WHERE id != ? AND statut = 'valide' AND fournisseur IS NOT NULL
        AND fournisseur = ? AND date = ? AND ABS(total - ?) < 0.01
    `).get(req.params.id, fusion.fournisseur, fusion.date, fusion.total);
    if (jumelle && !b.forcer) {
      return res.status(409).json({ error: "doublon", facture_id: jumelle.id });
    }
  }

  db.prepare(`
    UPDATE factures SET
      fournisseur=?, fournisseur_tps=?, fournisseur_tvq=?, date=?,
      sous_total=?, tps=?, tvq=?, total=?, categorie=?, mode_paiement=?, note=?,
      statut=?, ecart_taxes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    fusion.fournisseur, fusion.fournisseur_tps, fusion.fournisseur_tvq, fusion.date,
    fusion.sous_total, fusion.tps, fusion.tvq, fusion.total,
    fusion.categorie, fusion.mode_paiement, fusion.note,
    fusion.statut, coherence.ecart, req.params.id
  );

  const maj = db.prepare("SELECT * FROM factures WHERE id = ?").get(req.params.id);
  res.json({ facture: maj, coherence, alertes: Taxes.alertesCTI(maj) });
});

app.delete("/api/factures/:id", exigerMotDePasse, (req, res) => {
  const facture = db.prepare("SELECT photo_filename FROM factures WHERE id = ?").get(req.params.id);
  if (!facture) return res.status(404).json({ error: "Facture introuvable" });
  // La photo part avec la ligne, sinon le volume se remplit de fichiers que plus rien ne
  // référence et que personne ne pense à aller nettoyer.
  if (facture.photo_filename) {
    try {
      fs.unlinkSync(path.join(PHOTOS_DIR, path.basename(facture.photo_filename)));
    } catch (e) {
      // fichier déjà absent — rien à faire
    }
  }
  db.prepare("DELETE FROM factures WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/photos/:filename", exigerMotDePasse, (req, res) => {
  // basename() coupe toute tentative de remonter l'arborescence, et le type MIME est imposé
  // depuis la liste blanche au lieu d'être déduit du fichier.
  const safeName = path.basename(req.params.filename);
  const ext = safeName.split(".").pop().toLowerCase();
  const contentType = TYPES_MIME[ext];
  if (!contentType) return res.status(404).send("Photo introuvable");
  const filePath = path.join(PHOTOS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send("Photo introuvable");
  res.type(contentType).sendFile(filePath);
});

// ---------------------------------------------------------------------------
// Export comptable

function champCSV(v) {
  const s = v === null || v === undefined ? "" : String(v);
  // Les guillemets doublés et l'encadrement systématique évitent qu'un nom de fournisseur
  // contenant une virgule décale toutes les colonnes suivantes.
  return `"${s.replace(/"/g, '""')}"`;
}

app.get("/api/export.csv", exigerMotDePasse, (req, res) => {
  const lignes = db.prepare("SELECT * FROM factures WHERE statut = 'valide' ORDER BY date").all();
  const colonnes = [
    "date", "fournisseur", "fournisseur_tps", "fournisseur_tvq",
    "sous_total", "tps", "tvq", "total", "devise", "categorie", "mode_paiement", "note",
  ];
  const csv = [
    colonnes.join(","),
    ...lignes.map((f) => colonnes.map((c) => champCSV(f[c])).join(",")),
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="depenses-${new Date().toISOString().slice(0, 10)}.csv"`);
  // Le BOM force Excel à lire l'UTF-8 : sans lui, « Épicerie » arrive en « Ãpicerie ».
  res.send("﻿" + csv);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Factures — http://localhost:${PORT}`));
}

module.exports = app;
