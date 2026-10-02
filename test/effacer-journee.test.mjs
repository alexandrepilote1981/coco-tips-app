// Ce que le GÉRANT peut faire à une journée déclarée, testé sur le vrai serveur HTTP :
// l'effacer, et ranger ses pastilles d'alerte.
//
// Pourquoi ce fichier existe : jusqu'ici, seule l'employée pouvait effacer une de ses
// journées, depuis son lien à elle. Corriger une saisie croche obligeait donc à la rejoindre
// et à lui expliquer où taper. La route neuve détruit des données sans annulation possible,
// et c'est de l'ARGENT — ce qui mérite ses bornes : effacer la bonne journée, celle-là
// seulement, et ne rien laisser derrière.
//
// Le serveur tourne sur une base jetable, jamais sur data.sqlite.
//
// Lancer seul : node --test test/effacer-journee.test.mjs

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

test("effacer une journée déclarée depuis le tableau de bord", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-journee-"));
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

  const resto = await (await admin("/api/admin/restaurants", {
    method: "POST", body: JSON.stringify({ name: "Chez Coco" }),
  })).json();
  const creer = (name) => admin("/api/admin/employees", {
    method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name }),
  }).then((r) => r.json());

  const marie = await creer("Marie Tremblay");
  const alex = await creer("Alexandre Roy");

  // Les journées se créent par le lien de l'employée, comme dans la vraie vie.
  const declarer = (emp, date, ventes) =>
    fetch(`${base}/api/employee/${emp.access_code}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, ventes, clients: 20, pct: 10, remis: 0 }),
    }).then((r) => r.json());

  const journeesDe = async (emp) =>
    (await (await fetch(`${base}/api/employee/${emp.access_code}`)).json()).entries;

  const j1 = await declarer(marie, "2026-09-21", 500);
  await declarer(marie, "2026-09-22", 600);
  await declarer(alex, "2026-09-21", 700);

  assert.equal((await journeesDe(marie)).length, 2, "les deux journées de départ doivent exister");

  await t.test("la journée visée part, et elle seule", async () => {
    const res = await admin(`/api/admin/entries/${j1.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).date, "2026-09-21", "la réponse nomme la journée effacée");

    const restantes = await journeesDe(marie);
    assert.equal(restantes.length, 1, "l'autre journée de Marie doit survivre");
    assert.equal(restantes[0].date, "2026-09-22");

    const chezAlex = await journeesDe(alex);
    assert.equal(chezAlex.length, 1, "la journée du MÊME JOUR d'un collègue ne doit pas partir");
  });

  await t.test("effacer deux fois la même journée ne se lit pas comme deux effacements", async () => {
    // Un double clic, ou un retour en arrière, ne doit pas répondre « c'est fait » une
    // seconde fois : le tableau de bord afficherait une journée effacée qui n'existait plus.
    const res = await admin(`/api/admin/entries/${j1.id}`, { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  await t.test("sans le mot de passe admin, personne n'efface rien", async () => {
    const restante = (await journeesDe(marie))[0];
    const res = await fetch(`${base}/api/admin/entries/${restante.id}`, { method: "DELETE" });
    assert.equal(res.status, 401);
    assert.equal((await journeesDe(marie)).length, 1, "la journée doit être encore là");
  });

  await t.test("effacer un restaurant ne laisse derrière ni absence ni disponibilité", async () => {
    // Ces deux lignes manquaient à la route : un restaurant effacé laissait des absences et
    // des disponibilités rattachées à des employés qui n'existaient plus.
    //
    // Il FAUT regarder dans la base, et pas par l'API : la liste des absences passe par une
    // jointure sur les employés, donc une ligne orpheline n'y paraît déjà plus. Un test qui
    // interrogerait l'API passerait au vert avec ou sans le correctif — vérifié.
    await admin("/api/admin/absences", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, employee_id: alex.id, type: "vacances", date_debut: "2026-10-05", date_fin: "2026-10-11" }),
    });
    await fetch(`${base}/api/employee/${alex.access_code}/disponibilites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disponibilites: [{ jour: 0, disponible: 1, heure_debut: "", heure_fin: "" }] }),
    });

    const { default: Database } = await import("better-sqlite3");
    const base2 = new Database(path.join(dossier, "essai.sqlite"), { readonly: true });
    const compter = (table) => base2.prepare(`SELECT COUNT(*) n FROM ${table} WHERE employee_id = ?`).get(alex.id).n;
    assert.ok(compter("absences") >= 1, "l'absence de départ doit exister");
    assert.ok(compter("disponibilites") >= 1, "la disponibilité de départ doit exister");

    await admin(`/api/admin/restaurants/${resto.id}`, { method: "DELETE" });

    assert.equal(compter("absences"), 0, "aucune absence ne doit survivre au restaurant");
    assert.equal(compter("disponibilites"), 0, "aucune disponibilité ne doit survivre au restaurant");
    base2.close();
  });
});

// ------------------------------------------- ranger les pastilles en lot
//
// Le bandeau des retards portait une pastille PAR JOURNÉE, avec sa croix : vider un bandeau
// de cent journées demandait cent tapes et cent requêtes. Il regroupe maintenant par
// personne, et les deux boutons — la croix d'une personne, « tout mettre de côté » — ont
// besoin d'une route qui en range plusieurs d'un coup.

test("mettre des pastilles de côté en lot", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-pastilles-"));
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

  const resto = await (await admin("/api/admin/restaurants", {
    method: "POST", body: JSON.stringify({ name: "Chez Coco" }),
  })).json();
  const marie = await (await admin("/api/admin/employees", {
    method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Marie Tremblay" }),
  })).json();

  const declarer = (date) => fetch(`${base}/api/employee/${marie.access_code}/entries`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, ventes: 400, clients: 20, pct: 10, remis: 0 }),
  }).then((r) => r.json());

  const journees = async () =>
    (await (await fetch(`${base}/api/employee/${marie.access_code}`)).json()).entries;

  const a = await declarer("2026-09-21");
  const b = await declarer("2026-09-22");
  await declarer("2026-09-23");

  await t.test("on range exactement celles qu'on nomme", async () => {
    const res = await admin("/api/admin/entries/dismiss-flags", {
      method: "POST",
      body: JSON.stringify({ flags: [{ entryId: a.id, type: "late" }, { entryId: b.id, type: "late" }] }),
    });
    assert.equal((await res.json()).misDeCote, 2);

    const toutes = await journees();
    const rangee = (id) => toutes.find((j) => j.id === id).delay_dismissed;
    assert.equal(rangee(a.id), 1);
    assert.equal(rangee(b.id), 1);
    assert.ok(!toutes.find((j) => j.id !== a.id && j.id !== b.id).delay_dismissed, "la troisième ne bouge pas");
  });

  await t.test("les deux sortes de pastilles ne se mélangent pas", async () => {
    // « En retard » et « modifiée après coup » sont deux faits différents : ranger l'un ne
    // doit pas ranger l'autre, sinon une modification passerait inaperçue.
    const c = (await journees()).find((j) => !j.delay_dismissed);
    await admin("/api/admin/entries/dismiss-flags", {
      method: "POST", body: JSON.stringify({ flags: [{ entryId: c.id, type: "modified" }] }),
    });
    const apres = (await journees()).find((j) => j.id === c.id);
    assert.equal(apres.modified_dismissed, 1);
    assert.ok(!apres.delay_dismissed, "ranger « modifiée » ne doit pas ranger « en retard »");
  });

  await t.test("ranger une pastille ne compte pas comme une modification", async () => {
    // Le piège que la route une-par-une évitait déjà : toucher updated_at redéclencherait la
    // détection « modifiée après coup », et la pastille ne se fermerait jamais.
    const avant = (await journees()).find((j) => j.id === a.id);
    await admin("/api/admin/entries/dismiss-flags", {
      method: "POST", body: JSON.stringify({ flags: [{ entryId: a.id, type: "late" }] }),
    });
    const apres = (await journees()).find((j) => j.id === a.id);
    assert.equal(apres.data_updated_at, avant.data_updated_at);
  });

  await t.test("une liste vide ou bancale ne fait rien, et ne plante pas", async () => {
    for (const corps of [{ flags: [] }, { flags: null }, {}, { flags: [{ type: "late" }, { entryId: "zzz", type: "n'importe quoi" }] }]) {
      const res = await admin("/api/admin/entries/dismiss-flags", { method: "POST", body: JSON.stringify(corps) });
      assert.equal(res.status, 200, JSON.stringify(corps));
      assert.equal((await res.json()).misDeCote, 0);
    }
  });

  await t.test("sans jeton admin, personne ne range rien", async () => {
    const res = await fetch(`${base}/api/admin/entries/dismiss-flags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flags: [{ entryId: a.id, type: "late" }] }),
    });
    assert.equal(res.status, 401);
  });
});
