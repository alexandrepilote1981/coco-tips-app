// Effacement d'une semaine entière d'horaire, testé sur le vrai serveur HTTP.
//
// Pourquoi ce fichier existe : c'est la seule route qui détruit des données en lot, sans
// aucune annulation possible. Deux bornes comptent autant que l'effacement lui-même — ne pas
// déborder sur les semaines voisines, et ne pas sortir du restaurant visé. Les deux sont
// invisibles à la relecture du code et évidentes dans un test.
//
// Le serveur tourne sur une base jetable, jamais sur data.sqlite.
//
// Lancer seul : node --test test/effacer-semaine.test.mjs

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

test("effacement d'une semaine d'horaire", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-effacer-"));
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

  // --- décor : deux restaurants, un employé chacun, des quarts sur trois semaines
  const resto = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Chez Coco" }) })).json();
  const voisin = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Le Voisin" }) })).json();

  const empA = await (await admin("/api/admin/employees", {
    method: "POST",
    body: JSON.stringify({ restaurant_id: resto.id, name: "Marie Tremblay" }),
  })).json();
  const empB = await (await admin("/api/admin/employees", {
    method: "POST",
    body: JSON.stringify({ restaurant_id: voisin.id, name: "Alexandre Roy" }),
  })).json();

  const quart = (employee_id, date) =>
    admin("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id, date, start_time: "09:00", end_time: "17:00", role: "server" }),
    });

  // Semaine visée : lundi 21 → dimanche 27 septembre 2026.
  await quart(empA.id, "2026-09-21"); // lundi, première borne
  await quart(empA.id, "2026-09-24");
  await quart(empA.id, "2026-09-27"); // dimanche, dernière borne
  await quart(empA.id, "2026-09-20"); // dimanche précédent : doit survivre
  await quart(empA.id, "2026-09-28"); // lundi suivant : doit survivre
  await quart(empB.id, "2026-09-24"); // autre restaurant, même jour : doit survivre

  const tousLesQuarts = async () => (await (await admin("/api/admin/shifts")).json()).shifts;
  assert.equal((await tousLesQuarts()).length, 6, "les six quarts de départ doivent exister");

  await t.test("la semaine visée est effacée, les jours voisins survivent", async () => {
    const res = await admin(
      `/api/admin/shifts?restaurant_id=${resto.id}&from=2026-09-21&to=2026-09-27`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 3, "seuls les trois quarts de la semaine visée");

    const restants = (await tousLesQuarts()).map((s) => s.date).sort();
    assert.deepEqual(restants, ["2026-09-20", "2026-09-24", "2026-09-28"]);
  });

  await t.test("le restaurant voisin n'est jamais touché", async () => {
    const restants = await tousLesQuarts();
    const duVoisin = restants.filter((s) => s.employee_id === empB.id);
    assert.equal(duVoisin.length, 1, "le quart du voisin du 24 doit toujours être là");
  });

  await t.test("une semaine déjà vide s'efface sans erreur et ne supprime rien", async () => {
    const res = await admin(
      `/api/admin/shifts?restaurant_id=${resto.id}&from=2026-10-05&to=2026-10-11`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 0);
    assert.equal((await tousLesQuarts()).length, 3);
  });

  await t.test("une date malformée est refusée plutôt qu'interprétée", async () => {
    for (const plage of ["from=hier&to=2026-09-27", "from=2026-09-21&to=", "from=2026-9-21&to=2026-09-27"]) {
      const res = await admin(`/api/admin/shifts?restaurant_id=${resto.id}&${plage}`, { method: "DELETE" });
      assert.equal(res.status, 400, `plage refusée attendue pour ${plage}`);
    }
    assert.equal((await tousLesQuarts()).length, 3, "aucun effacement après un refus");
  });

  await t.test("sans restaurant, rien n'est effacé", async () => {
    const res = await admin("/api/admin/shifts?from=2026-09-21&to=2026-09-27", { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.equal((await tousLesQuarts()).length, 3);
  });

  await t.test("le lien horaire efface sa propre semaine, sans jeton admin", async () => {
    await quart(empA.id, "2026-11-02");
    await quart(empB.id, "2026-11-02"); // voisin, même jour

    const res = await fetch(`${base}/api/schedule/by-code/${resto.schedule_code}/shifts?from=2026-11-02&to=2026-11-08`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 1, "seul le quart de son propre restaurant");

    const restants = await tousLesQuarts();
    assert.ok(
      restants.some((s) => s.date === "2026-11-02" && s.employee_id === empB.id),
      "le quart du voisin doit survivre à un effacement par code"
    );
  });

  await t.test("un code d'horaire inconnu ne peut rien effacer", async () => {
    const avant = (await tousLesQuarts()).length;
    const res = await fetch(`${base}/api/schedule/by-code/ZZZZZZ/shifts?from=2026-09-01&to=2026-12-31`, {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
    assert.equal((await tousLesQuarts()).length, avant);
  });

  await t.test("sans jeton admin, la route admin refuse", async () => {
    const avant = (await tousLesQuarts()).length;
    const res = await fetch(`${base}/api/admin/shifts?restaurant_id=${resto.id}&from=2026-09-01&to=2026-12-31`, {
      method: "DELETE",
    });
    assert.ok(res.status === 401 || res.status === 403, `refus attendu, reçu ${res.status}`);
    assert.equal((await tousLesQuarts()).length, avant);
  });
});
