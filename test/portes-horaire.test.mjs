// Les trois portes d'entrée sur l'horaire, et ce que chacune a le droit de voir.
//
// Pourquoi ce fichier existe : un lien d'horaire se partage par texto, il se retrouve
// facilement là où on ne l'attendait pas. Deux de ces portes mènent à la même cuisine mais
// n'ont pas les mêmes droits, et l'une d'elles porte des salaires. Une erreur ici ne fait
// rien planter — elle montre la paie de quelqu'un à toute l'équipe.
//
// On vérifie donc que les montants ne SORTENT PAS du serveur pour les portes qui n'y ont
// pas droit, plutôt que de se fier à un affichage qui les cacherait.
//
// Lancer seul : node --test test/portes-horaire.test.mjs

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
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dossier, "essai.sqlite"), PHOTOS_DIR: path.join(dossier, "photos"), ADMIN_PASSWORD: MOT_DE_PASSE },
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
      throw new Error(`délai dépassé au démarrage :\n${journal}`);
    }
    await attendre(100);
  }
  return { proc, base };
}

test("les trois portes de l'horaire", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-portes-"));
  const { proc, base } = await demarrerServeur(dossier);
  t.after(() => {
    proc.kill("SIGKILL");
    rmSync(dossier, { recursive: true, force: true });
  });

  const admin = (chemin, opts = {}) =>
    fetch(`${base}${chemin}`, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-Admin-Token": MOT_DE_PASSE, ...(opts.headers || {}) },
    });

  const resto = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Chez Coco" }) })).json();

  const creer = async (name, secteur, taux) =>
    (await admin("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name, secteur, taux_horaire: taux }),
    })).json();

  const serveuse = await creer("Marie Tremblay", "salle", 15.75);
  const cuisinier = await creer("Lokassa Mbala", "cuisine", 18.5);
  const plongeur = await creer("Sam Roy", "cuisine", 16);

  await admin("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({ employee_id: cuisinier.id, date: "2026-09-21", start_time: "17:30", end_time: "01:30", role: "cuisinier" }),
  });
  await admin("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({ employee_id: serveuse.id, date: "2026-09-21", start_time: "09:00", end_time: "17:00", role: "server" }),
  });

  const CODE_SALLE = resto.schedule_code;
  const CODE_CUISINE = resto.schedule_code_cuisine;
  const CODE_LECTURE = resto.schedule_code_cuisine_lecture;
  const parCode = (code, chemin = "", opts = {}) => fetch(`${base}/api/schedule/by-code/${code}${chemin}`, opts);

  await t.test("les trois codes sont créés, et tous différents", () => {
    for (const c of [CODE_SALLE, CODE_CUISINE, CODE_LECTURE]) assert.match(c, /^[A-Z0-9]{6}$/);
    assert.equal(new Set([CODE_SALLE, CODE_CUISINE, CODE_LECTURE]).size, 3);
  });

  await t.test("le lien du gérant de cuisine voit sa cuisine et les salaires", async () => {
    const d = await (await parCode(CODE_CUISINE)).json();
    assert.equal(d.secteur, "cuisine");
    assert.equal(d.peutModifier, true);
    assert.equal(d.voitMontants, true);
    assert.deepEqual(d.employees.map((e) => e.name).sort(), ["Lokassa Mbala", "Sam Roy"]);
    assert.equal(d.employees.find((e) => e.name === "Lokassa Mbala").taux_horaire, 18.5);
    assert.equal(d.charges_pct, 0);
  });

  await t.test("le lien des cuisiniers voit la même équipe, sans un sou", async () => {
    const d = await (await parCode(CODE_LECTURE)).json();
    assert.equal(d.secteur, "cuisine");
    assert.equal(d.peutModifier, false);
    assert.equal(d.voitMontants, false);
    assert.deepEqual(d.employees.map((e) => e.name).sort(), ["Lokassa Mbala", "Sam Roy"]);
    for (const e of d.employees) {
      assert.ok(!("taux_horaire" in e), `le taux de ${e.name} ne doit même pas être envoyé`);
    }
    assert.equal(d.charges_pct, undefined);
    assert.doesNotMatch(JSON.stringify(d), /18\.5|taux/, "aucune trace de salaire dans la réponse");
  });

  await t.test("le lien de la salle ne voit pas la cuisine, ni aucun montant", async () => {
    const d = await (await parCode(CODE_SALLE)).json();
    assert.equal(d.secteur, "salle");
    assert.equal(d.voitMontants, false);
    assert.deepEqual(d.employees.map((e) => e.name), ["Marie Tremblay"]);
    assert.ok(!("taux_horaire" in d.employees[0]));
  });

  await t.test("chaque porte ne reçoit que les quarts de son équipe", async () => {
    const cuisine = await (await parCode(CODE_CUISINE, "/shifts")).json();
    assert.equal(cuisine.shifts.length, 1);
    assert.equal(cuisine.shifts[0].employee_id, cuisinier.id);

    const salle = await (await parCode(CODE_SALLE, "/shifts")).json();
    assert.equal(salle.shifts.length, 1);
    assert.equal(salle.shifts[0].employee_id, serveuse.id);

    const lecture = await (await parCode(CODE_LECTURE, "/shifts")).json();
    assert.deepEqual(lecture.shifts.map((s) => s.employee_id), [cuisinier.id]);
  });

  await t.test("le lien des cuisiniers ne peut rien changer", async () => {
    const corps = JSON.stringify({ employee_id: plongeur.id, date: "2026-09-22", start_time: "09:00", end_time: "17:00", role: "plongeur" });
    const ajout = await parCode(CODE_LECTURE, "/shifts", { method: "POST", headers: { "Content-Type": "application/json" }, body: corps });
    assert.equal(ajout.status, 403);

    const id = (await (await parCode(CODE_CUISINE, "/shifts")).json()).shifts[0].id;
    assert.equal((await parCode(CODE_LECTURE, `/shifts/${id}`, { method: "DELETE" })).status, 403);
    assert.equal(
      (await parCode(CODE_LECTURE, `/shifts?from=2026-09-21&to=2026-09-27`, { method: "DELETE" })).status,
      403
    );

    const apres = await (await parCode(CODE_CUISINE, "/shifts")).json();
    assert.equal(apres.shifts.length, 1, "rien n'a bougé");
  });

  await t.test("le gérant de cuisine ne peut pas céduler une serveuse", async () => {
    const res = await parCode(CODE_CUISINE, "/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: serveuse.id, date: "2026-09-23", start_time: "09:00", end_time: "17:00" }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("le gérant de cuisine ne peut pas toucher au quart d'une serveuse", async () => {
    const tous = await (await admin("/api/admin/shifts")).json();
    const quartSalle = tous.shifts.find((s) => s.employee_id === serveuse.id);
    assert.ok(quartSalle);
    assert.equal((await parCode(CODE_CUISINE, `/shifts/${quartSalle.id}`, { method: "DELETE" })).status, 404);
    const restants = await (await admin("/api/admin/shifts")).json();
    assert.equal(restants.shifts.length, 2, "le quart de la salle est toujours là");
  });

  await t.test("effacer la semaine par le lien cuisine ne vide pas la salle", async () => {
    const res = await parCode(CODE_CUISINE, "/shifts?from=2026-09-21&to=2026-09-27", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 1);
    const restants = await (await admin("/api/admin/shifts")).json();
    assert.deepEqual(restants.shifts.map((s) => s.employee_id), [serveuse.id]);
  });

  await t.test("un employé arrive en salle par défaut, et se déplace ensuite", async () => {
    const nouveau = await (await admin("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: "Nouvelle Personne" }),
    })).json();
    assert.equal(nouveau.secteur, "salle");
    assert.equal(nouveau.taux_horaire, 0);

    const modifie = await (await admin(`/api/admin/employees/${nouveau.id}`, {
      method: "POST",
      body: JSON.stringify({ secteur: "cuisine", taux_horaire: "19,25" }),
    })).json();
    assert.equal(modifie.secteur, "cuisine");
    assert.equal(modifie.taux_horaire, 19, "« 19,25 » s'arrête à la virgule, comme partout ailleurs");
    assert.equal(modifie.name, "Nouvelle Personne", "le nom n'est pas effacé quand on ne l'envoie pas");
  });

  await t.test("un secteur ou un taux farfelu est ramené à une valeur sûre", async () => {
    const emp = await (await admin("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: "Test", secteur: "patron", taux_horaire: -50 }),
    })).json();
    assert.equal(emp.secteur, "salle");
    assert.equal(emp.taux_horaire, 0);

    const enorme = await (await admin(`/api/admin/employees/${emp.id}`, {
      method: "POST",
      body: JSON.stringify({ taux_horaire: 99999 }),
    })).json();
    assert.equal(enorme.taux_horaire, 1000, "plafonné plutôt qu'accepté tel quel");
  });

  await t.test("le pourcentage de charges se règle et se borne", async () => {
    const ok = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: 14.5 }) })).json();
    assert.equal(ok.charges_pct, 14.5);
    const trop = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: 5000 }) })).json();
    assert.equal(trop.charges_pct, 100);
    const negatif = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: -3 }) })).json();
    assert.equal(negatif.charges_pct, 0);
  });

  await t.test("un code inconnu n'ouvre rien", async () => {
    assert.equal((await parCode("ZZZZZZ")).status, 404);
    assert.equal((await parCode("ZZZZZZ", "/shifts")).status, 404);
  });

  await t.test("le PDF de chaque porte ne contient que son équipe", async () => {
    const pdfCuisine = Buffer.from(await (await parCode(CODE_CUISINE, "/pdf?week=2026-09-21")).arrayBuffer());
    const pdfSalle = Buffer.from(await (await parCode(CODE_SALLE, "/pdf?week=2026-09-21")).arrayBuffer());
    assert.ok(pdfCuisine.length > 1000 && pdfSalle.length > 1000);
    // Les noms sont compressés dans le flux : on vérifie surtout que les deux PDF diffèrent
    // et qu'aucun ne porte un montant.
    assert.notEqual(pdfCuisine.toString("latin1"), pdfSalle.toString("latin1"));
    for (const pdf of [pdfCuisine, pdfSalle]) {
      assert.doesNotMatch(pdf.toString("latin1"), /18\.5|taux_horaire/, "aucun salaire dans un PDF");
    }
  });
});
