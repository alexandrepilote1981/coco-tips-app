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

  await t.test("le plafond d'heures se règle, se borne, et reste côté gestion", async () => {
    const emp = await creer("Plafonné", "cuisine", 20);
    assert.equal(emp.heures_max, 0, "aucun plafond par défaut : inventer un chiffre ferait rougir sans raison");

    const pose = await (await admin(`/api/admin/employees/${emp.id}`, {
      method: "POST",
      body: JSON.stringify({ heures_max: 37.5 }),
    })).json();
    assert.equal(pose.heures_max, 37.5);
    assert.equal(pose.taux_horaire, 20, "le taux n'est pas effacé quand on ne l'envoie pas");

    for (const [envoye, attendu] of [[-5, 0], [9999, 168], ["abc", 0]]) {
      const r = await (await admin(`/api/admin/employees/${emp.id}`, {
        method: "POST",
        body: JSON.stringify({ heures_max: envoye }),
      })).json();
      assert.equal(r.heures_max, attendu, `${envoye} doit être ramené à ${attendu}`);
    }

    await admin(`/api/admin/employees/${emp.id}`, { method: "POST", body: JSON.stringify({ heures_max: 30 }) });

    // Le plafond est un réglage de gestion : il suit les salaires, pas l'horaire de l'équipe.
    const gerant = await (await parCode(CODE_CUISINE)).json();
    assert.equal(gerant.employees.find((x) => x.name === "Plafonné").heures_max, 30);

    const lecture = await (await parCode(CODE_LECTURE)).json();
    for (const x of lecture.employees) {
      assert.ok(!("heures_max" in x), `le plafond de ${x.name} ne doit pas être envoyé aux cuisiniers`);
    }
  });

  await t.test("le pourcentage de charges se règle et se borne", async () => {
    const ok = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: 14.5 }) })).json();
    assert.equal(ok.charges_pct, 14.5);
    const trop = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: 5000 }) })).json();
    assert.equal(trop.charges_pct, 100);
    const negatif = await (await admin(`/api/admin/restaurants/${resto.id}/charges`, { method: "POST", body: JSON.stringify({ charges_pct: -3 }) })).json();
    assert.equal(negatif.charges_pct, 0);
  });

  await t.test("la tâche d'un quart est coupée à ce qui rentre dans une case", async () => {
    const { TACHE_MAX } = await import("../public/shared/horaire-mise-en-page.js").then((m) => m.default || m);
    const trop = "Commande à défaire et prise de commande au comptoir";
    const res = await admin("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({
        employee_id: plongeur.id, date: "2026-12-01", start_time: "17:00", end_time: "23:00",
        role: "plongeur", note: `   ${trop}   `,
      }),
    });
    assert.equal(res.status, 200);
    const quart = (await (await admin("/api/admin/shifts?startDate=2026-12-01&endDate=2026-12-01")).json()).shifts[0];
    assert.equal(quart.note, trop.slice(0, TACHE_MAX), "coupée à la limite, et sans les espaces autour");
    assert.ok(quart.note.length <= TACHE_MAX);
  });

  await t.test("les congés se posent, se voient et se suppriment par le lien du gérant", async () => {
    const pose = await (await parCode(CODE_CUISINE, "/absences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: cuisinier.id, date_debut: "2026-07-20", date_fin: "2026-07-26", type: "vacances" }),
    })).json();
    assert.equal(pose.type, "vacances");

    // Une fin laissée vide : un congé d'une seule journée.
    await parCode(CODE_CUISINE, "/absences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: plongeur.id, date_debut: "2026-08-02" }),
    });

    const liste = (await (await parCode(CODE_CUISINE, "/absences")).json()).absences;
    assert.equal(liste.length, 2);
    assert.equal(liste.find((a) => a.employee_id === plongeur.id).date_fin, "2026-08-02");

    assert.equal((await parCode(CODE_CUISINE, `/absences/${pose.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await (await parCode(CODE_CUISINE, "/absences")).json()).absences.length, 1);
  });

  await t.test("le lien cuisine ne pose pas de congé à une serveuse", async () => {
    const res = await parCode(CODE_CUISINE, "/absences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: serveuse.id, date_debut: "2026-07-20" }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("le lien des cuisiniers voit les congés mais n'y touche pas", async () => {
    const liste = (await (await parCode(CODE_LECTURE, "/absences")).json()).absences;
    assert.ok(liste.length >= 1, "savoir qui est en vacances n'est pas un secret");

    const ajout = await parCode(CODE_LECTURE, "/absences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: cuisinier.id, date_debut: "2026-09-01" }),
    });
    assert.equal(ajout.status, 403);
    assert.equal((await parCode(CODE_LECTURE, `/absences/${liste[0].id}`, { method: "DELETE" })).status, 403);
  });

  await t.test("une date illisible est refusée plutôt qu'enregistrée à moitié", async () => {
    const avant = (await (await parCode(CODE_CUISINE, "/absences")).json()).absences.length;
    const res = await parCode(CODE_CUISINE, "/absences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: cuisinier.id, date_debut: "la semaine prochaine" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await (await parCode(CODE_CUISINE, "/absences")).json()).absences.length, avant);
  });

  await t.test("retirer un employé emporte ses congés", async () => {
    const jetable = await creer("Parti", "cuisine", 15);
    await admin("/api/admin/absences", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, employee_id: jetable.id, date_debut: "2026-10-01" }),
    });
    const avant = (await (await admin(`/api/admin/absences?restaurant_id=${resto.id}`)).json()).absences;
    assert.ok(avant.some((a) => a.employee_id === jetable.id));

    await admin(`/api/admin/employees/${jetable.id}`, { method: "DELETE" });
    const apres = (await (await admin(`/api/admin/absences?restaurant_id=${resto.id}`)).json()).absences;
    assert.ok(!apres.some((a) => a.employee_id === jetable.id), "aucun congé orphelin");
  });

  await t.test("le tableau de bord voit les congés des deux équipes", async () => {
    await admin("/api/admin/absences", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, employee_id: serveuse.id, date_debut: "2026-07-20", date_fin: "2026-07-26" }),
    });
    const toutes = (await (await admin(`/api/admin/absences?restaurant_id=${resto.id}`)).json()).absences;
    assert.ok(toutes.some((a) => a.employee_id === serveuse.id), "la salle aussi");
    assert.ok(toutes.some((a) => a.employee_id === plongeur.id), "et la cuisine");
  });

  await t.test("entrer par mot de passe ouvre la salle, pas la cuisine", async () => {
    // Le jour où les secteurs sont apparus, cette route est restée en arrière : la cuisine
    // se retrouvait dans la grille de la salle, donc sans heure de fin, sans tâche et avec
    // les mauvais postes.
    const res = await fetch(`${base}/api/schedule/roster`, { headers: { "X-Admin-Token": MOT_DE_PASSE } });
    assert.equal(res.status, 200);
    const equipe = (await res.json()).restaurants.find((r) => r.id === resto.id).employees;

    assert.ok(equipe.some((e) => e.name === "Marie Tremblay"), "la salle est là");
    assert.ok(!equipe.some((e) => e.name === "Lokassa Mbala"), "la cuisine n'y est pas");
    for (const e of equipe) {
      assert.ok(!("taux_horaire" in e), "aucun montant par cette porte non plus");
    }
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
