// Le rappel de sauvegarde, testé sur le vrai serveur HTTP.
//
// Pourquoi ce fichier existe : le bouton de sauvegarde était à 4 409 px du haut du tableau
// de bord — cinq écrans et demi de défilement — et RIEN ne disait jamais qu'il était temps
// d'en prendre une. Le rappel ne vaut que s'il est exact ; un rappel qui s'efface alors que
// la sauvegarde a planté est pire que pas de rappel du tout.
//
// Le serveur tourne sur une base jetable, jamais sur data.sqlite.
//
// Lancer seul : node --test test/sauvegarde.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOT_DE_PASSE = "motdepassedetest";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function portLibre() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function demarrerServeur(dossier) {
  const port = await portLibre();
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: RACINE,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dossier, "essai.sqlite"),
      PHOTOS_DIR: path.join(dossier, "photos"),
      ADMIN_PASSWORD: MOT_DE_PASSE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let journal = "";
  proc.stdout.on("data", (d) => (journal += d));
  proc.stderr.on("data", (d) => (journal += d));

  const base = `http://127.0.0.1:${port}`;
  const limite = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`le serveur s'est arrêté :\n${journal}`);
    try {
      if ((await fetch(`${base}/admin`)).ok) break;
    } catch {
      /* pas encore prêt */
    }
    if (Date.now() > limite) {
      proc.kill("SIGKILL");
      throw new Error(`délai dépassé au démarrage du serveur :\n${journal}`);
    }
    await attendre(100);
  }
  return { proc, base };
}

test("la date de la dernière sauvegarde", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-sauve-"));
  const { proc, base } = await demarrerServeur(dossier);

  const admin = (chemin, opts = {}) =>
    fetch(`${base}${chemin}`, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-Admin-Token": MOT_DE_PASSE, ...(opts.headers || {}) },
    });

  t.after(() => {
    proc.kill("SIGKILL");
    rmSync(dossier, { recursive: true, force: true });
  });

  const vue = () => admin("/api/admin/overview").then((r) => r.json());

  await t.test("au départ, aucune sauvegarde n'a jamais été prise", async () => {
    // null et non une date lointaine : « jamais » et « il y a longtemps » ne se disent pas
    // de la même façon à l'écran, et c'est « jamais » qui doit alarmer le plus.
    assert.equal((await vue()).derniereSauvegarde, null);
  });

  await t.test("télécharger une sauvegarde note la date", async () => {
    const res = await admin("/api/admin/backup");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type"), /zip/);
    await res.arrayBuffer();

    const quand = (await vue()).derniereSauvegarde;
    assert.ok(quand, "la date doit être écrite");
    const ecart = Math.abs(Date.now() - new Date(quand.replace(" ", "T") + "Z").getTime());
    assert.ok(ecart < 60000, `la date devrait être maintenant, écart de ${Math.round(ecart / 1000)} s`);
  });

  await t.test("sans jeton admin, la date ne sort pas", async () => {
    const res = await fetch(`${base}/api/admin/overview`);
    assert.equal(res.status, 401);
  });

  await t.test("la date survit à un redémarrage du serveur", async () => {
    // Elle vit en base et pas dans le navigateur : le gérant change de téléphone, ouvre
    // /admin de l'ordinateur du bureau, et un rappel qui repartirait à zéro à chaque
    // appareil ne vaudrait rien.
    const avant = (await vue()).derniereSauvegarde;
    proc.kill("SIGKILL");
    await attendre(300);
    const relance = await demarrerServeur(dossier);
    t.after(() => relance.proc.kill("SIGKILL"));
    const apres = await (await fetch(`${relance.base}/api/admin/overview`, {
      headers: { "X-Admin-Token": MOT_DE_PASSE },
    })).json();
    assert.equal(apres.derniereSauvegarde, avant);
  });

});
