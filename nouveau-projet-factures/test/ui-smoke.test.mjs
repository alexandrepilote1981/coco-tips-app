// Pilote les vraies pages dans un vrai navigateur.
//
// L'essentiel de la logique d'interface vit dans les fichiers de public/ et rien d'autre ne
// la couvre : une page qui plante au premier clic passerait tous les tests unitaires.
//
// Ce test se saute tout seul, sans échouer, quand Playwright ou Chromium n'est pas installé —
// il ne doit jamais bloquer un `npm test` sur une machine sans navigateur.
//
//   npm install --no-save playwright
//   npm test

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function trouverNavigateur() {
  // Le conteneur peut fournir un Chromium dont le numéro de build ne correspond pas à celui
  // que Playwright attend : on prend le chemin explicite quand il existe.
  const racine = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(racine)) return undefined;
  for (const nom of fs.readdirSync(racine)) {
    const chemin = path.join(racine, nom, "chrome-linux", "chrome");
    if (fs.existsSync(chemin)) return chemin;
  }
  return undefined;
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  test("interface — sauté, Playwright absent", { skip: true }, () => {});
}

if (chromium) {
  test("parcours complet dans un navigateur", async (t) => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "factures-ui-"));
    const port = 3900 + Math.floor(process.pid % 90);
    const env = {
      ...process.env,
      DB_PATH: path.join(dossier, "ui.sqlite"),
      PHOTOS_DIR: path.join(dossier, "photos"),
      APP_PASSWORD: "test123",
      PORT: String(port),
    };
    delete env.ANTHROPIC_API_KEY;

    const serveur = spawn("node", [path.join(import.meta.dirname, "..", "server.js")], { env, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1200));

    let nav;
    try {
      nav = await chromium.launch({ executablePath: trouverNavigateur() });
    } catch {
      serveur.kill();
      fs.rmSync(dossier, { recursive: true, force: true });
      return t.skip("Chromium absent");
    }

    const page = await nav.newPage({ viewport: { width: 420, height: 900 } });
    page.setDefaultTimeout(8000);
    // Les polices Google ne sont pas toujours joignables : sans ça le chargement de page
    // attend un délai réseau qui n'arrivera jamais.
    await page.route("**://fonts.googleapis.com/**", (r) => r.abort());
    await page.route("**://fonts.gstatic.com/**", (r) => r.abort());

    const erreurs = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("ERR_FAILED")) erreurs.push(m.text());
    });

    const base = `http://127.0.0.1:${port}`;
    try {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.fill("#mdp", "test123");
      await page.click("#entrer");
      await page.waitForSelector("#photographier");

      // Le comportement demandé au départ : un tap, la caméra arrière s'ouvre.
      assert.strictEqual(await page.getAttribute("#fichier", "capture"), "environment");
      assert.strictEqual(await page.getAttribute("#fichier", "accept"), "image/*");

      await page.click("#voir-lien");
      await page.waitForSelector(".lien-prive");
      const lien = (await page.textContent(".lien-prive")).trim();

      const IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const depot = await page.evaluate(async (img) => {
        const r = await fetch("/api/factures", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-App-Token": sessionStorage.getItem("appToken") },
          body: JSON.stringify({ photoBase64: img }),
        });
        return r.json();
      }, IMAGE);
      assert.ok(depot.id, "la photo doit être enregistrée même sans analyse");

      await page.goto(base + "/depenses", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-ouvrir]");
      await page.click("[data-ouvrir]");
      await page.waitForSelector("#c-fournisseur");
      await page.fill("#c-fournisseur", "Épicerie du coin");
      await page.fill("#c-date", "2026-08-15");
      await page.fill("#c-sous_total", "100");
      await page.fill("#c-tps", "5");
      await page.fill("#c-tvq", "9.98");
      await page.fill("#c-total", "14.98");   // volontairement faux
      await page.click("[data-enregistrer]");
      await page.waitForTimeout(400);
      await page.click("[data-ouvrir]");
      await page.waitForTimeout(200);

      const alerte = await page.textContent(".alerte.grave");
      assert.match(alerte, /Écart/, "un total incohérent doit lever un drapeau visible");

      await page.click("[data-ouvrir]");
      await page.waitForSelector("#c-total");
      await page.fill("#c-total", "114.98");
      await page.click("[data-valider]");
      await page.waitForTimeout(500);
      await page.click('[data-onglet="valide"]');
      await page.waitForTimeout(300);
      assert.match((await page.textContent(".totaux")).replace(/\s+/g, " "), /114\.98/);

      // Le lien du téléphone peut se perdre avec l'appareil : il ne doit jamais rien chiffrer.
      await page.goto(lien, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#photographier");
      assert.ok(!/\d+[.,]\d\d\s*\$/.test(await page.textContent("body")), "le lien privé ne doit afficher aucun montant");

      assert.deepStrictEqual(erreurs, [], "aucune erreur JavaScript ne doit survenir");
    } finally {
      await nav.close();
      serveur.kill();
      fs.rmSync(dossier, { recursive: true, force: true });
    }
  });
}
