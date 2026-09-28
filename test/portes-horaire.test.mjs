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

  // Les rappels de commande avant un férié : seuls ceux qui commandent y ont droit. Ce
  // n'est pas un secret, mais une porte qui ne commande rien n'a pas à écrire dedans.
  await t.test("seul le gérant de cuisine lit et écrit les rappels de commande", async () => {
    const poster = (code, rappels) =>
      parCode(code, "/rappels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rappels }),
      });

    assert.equal((await poster(CODE_CUISINE, "Appeler Dufour & Fils")).status, 200);
    const lu = await (await parCode(CODE_CUISINE, "/rappels")).json();
    assert.equal(lu.restaurants[0].rappels, "Appeler Dufour & Fils");

    // La salle et les cuisiniers en lecture seule : rien, ni en lecture ni en écriture.
    for (const code of [CODE_SALLE, CODE_LECTURE]) {
      assert.equal((await parCode(code, "/rappels")).status, 403, `lecture par ${code}`);
      assert.equal((await poster(code, "Effacer tout")).status, 403, `écriture par ${code}`);
    }
    // Et rien n'a bougé.
    assert.equal((await (await parCode(CODE_CUISINE, "/rappels")).json()).restaurants[0].rappels, "Appeler Dufour & Fils");
  });

  await t.test("un code inventé ne donne pas accès aux rappels", async () => {
    assert.equal((await parCode("ZZZZZZ", "/rappels")).status, 404);
  });

  await t.test("le gérant voit les rappels de tous ses restaurants par /admin", async () => {
    const rep = await (await admin("/api/admin/rappels")).json();
    assert.equal(rep.restaurants.length, 1);
    assert.equal(rep.restaurants[0].rappels, "Appeler Dufour & Fils");
  });

  await t.test("les rappels sont bornés : lignes vides, longueur, nombre", async () => {
    const trop = Array.from({ length: 30 }, (_, i) => `Rappel ${i}`).join("\n");
    await admin(`/api/admin/restaurants/${resto.id}/rappels`, {
      method: "POST",
      body: JSON.stringify({ rappels: `  Appeler Dufour  \n\n\n${"x".repeat(300)}\n${trop}` }),
    });
    const lignes = (await (await admin("/api/admin/rappels")).json()).restaurants[0].rappels.split("\n");
    assert.equal(lignes.length, 20, "vingt lignes au maximum");
    assert.equal(lignes[0], "Appeler Dufour", "les espaces autour sont coupés");
    assert.ok(!lignes.includes(""), "aucune ligne vide");
    assert.ok(lignes.every((l) => l.length <= 120), "aucune ligne interminable");
  });

  // Les disponibilités : de l'information pour monter l'horaire, pas un secret. Toutes les
  // portes horaire les lisent ; seul l'employé écrit les siennes, par son propre lien.
  await t.test("l'employé écrit ses disponibilités par son lien, et lui seul", async () => {
    const lien = (code, chemin = "", opts = {}) => fetch(`${base}/api/employee/${code}${chemin}`, opts);
    const poster = (code, disponibilites) =>
      lien(code, "/disponibilites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disponibilites }),
      });

    // Avant d'avoir répondu : aucune ligne, et c'est ça qui dit « jamais rempli ».
    const avant = await (await lien(serveuse.access_code, "/disponibilites")).json();
    assert.deepEqual(avant.disponibilites, []);
    assert.equal(avant.aRepondu, false);

    assert.equal(
      (await poster(serveuse.access_code, [
        { jour: 0, disponible: true },
        { jour: 1, disponible: true, heure_debut: "09:00" },
        { jour: 2, disponible: false },
      ])).status,
      200
    );
    const apres = await (await lien(serveuse.access_code, "/disponibilites")).json();
    assert.equal(apres.disponibilites.length, 3);
    assert.equal(apres.aRepondu, true);
    assert.equal(apres.disponibilites[1].heure_debut, "09:00");
    assert.equal(apres.disponibilites[2].disponible, 0);

    // Un code inventé n'écrit chez personne.
    assert.equal((await poster("ZZZZZZ", [{ jour: 0, disponible: false }])).status, 404);
  });

  await t.test("une saisie abîmée est nettoyée plutôt que gardée telle quelle", async () => {
    await fetch(`${base}/api/employee/${plongeur.access_code}/disponibilites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        disponibilites: [
          { jour: 99, disponible: true },                                       // jour inexistant
          { jour: 3, disponible: true, heure_debut: "15:00", heure_fin: "09:00" }, // à l'envers
          { jour: 4, disponible: true, heure_debut: "pas une heure" },
        ],
      }),
    });
    const lu = await (await fetch(`${base}/api/employee/${plongeur.access_code}/disponibilites`)).json();
    assert.equal(lu.disponibilites.length, 2, "le jour inexistant est jeté");
    const jeudi = lu.disponibilites.find((d) => d.jour === 3);
    assert.equal(jeudi.heure_debut, "09:00", "les bornes sont remises dans l'ordre");
    assert.equal(jeudi.heure_fin, "15:00");
    const vendredi = lu.disponibilites.find((d) => d.jour === 4);
    assert.equal(vendredi.heure_debut, "", "une heure qui n'en est pas une est ignorée");
  });

  await t.test("les portes horaire lisent les disponibilités de leur secteur", async () => {
    const salle = await (await parCode(CODE_SALLE, "/disponibilites")).json();
    assert.ok(salle.disponibilites.length > 0, "la serveuse a rempli les siennes");
    assert.ok(
      salle.disponibilites.every((d) => d.employee_id === serveuse.id),
      "la cuisine n'apparaît pas dans la porte de la salle"
    );

    for (const code of [CODE_CUISINE, CODE_LECTURE]) {
      const cuisine = await (await parCode(code, "/disponibilites")).json();
      assert.ok(
        cuisine.disponibilites.every((d) => d.employee_id !== serveuse.id),
        `la salle n'apparaît pas dans ${code}`
      );
    }
    assert.equal((await parCode("ZZZZZZ", "/disponibilites")).status, 404);
  });

  await t.test("aucune disponibilité ne charrie de montant", async () => {
    for (const code of [CODE_SALLE, CODE_CUISINE, CODE_LECTURE]) {
      const texte = await (await parCode(code, "/disponibilites")).text();
      assert.doesNotMatch(texte, /taux_horaire|heures_max|18\.5/, `porte ${code}`);
    }
  });

  // Le code d'accès personnel EST la clé de la page de quelqu'un. Le gérant en a besoin pour
  // distribuer les liens ; personne d'autre ne doit les recevoir.
  await t.test("seul le lien du gérant reçoit les codes d'accès personnels", async () => {
    const gerant = await (await parCode(CODE_CUISINE)).json();
    assert.ok(
      gerant.employees.every((e) => typeof e.access_code === "string" && e.access_code.length === 6),
      "le gérant reçoit les codes de son équipe"
    );

    // Le lien de lecture des cuisiniers : sans ça, n'importe quel cuisinier pourrait ouvrir
    // la page d'un collègue et changer ses disponibilités à sa place.
    const lecture = await (await parCode(CODE_LECTURE)).json();
    assert.ok(lecture.employees.every((e) => e.access_code === undefined), "aucun code par le lien de lecture");

    const salle = await (await parCode(CODE_SALLE)).json();
    assert.ok(salle.employees.every((e) => e.access_code === undefined), "aucun code par le lien de la salle");

    // Et l'entrée par mot de passe non plus.
    const roster = await (await fetch(`${base}/api/schedule/roster`, { headers: { "X-Admin-Token": MOT_DE_PASSE } })).json();
    assert.ok(
      roster.restaurants.every((r) => r.employees.every((e) => e.access_code === undefined)),
      "aucun code par l'entrée mot de passe"
    );
  });

  await t.test("le gérant ne reçoit que les codes de SA cuisine", async () => {
    const gerant = await (await parCode(CODE_CUISINE)).json();
    const codes = gerant.employees.map((e) => e.access_code);
    assert.ok(!codes.includes(serveuse.access_code), "le code de la serveuse ne sort pas");
    assert.ok(codes.includes(cuisinier.access_code) && codes.includes(plongeur.access_code));
    // Compter les employés serait fragile — d'autres sous-tests en ajoutent. Ce qui compte,
    // c'est que tout ce qui sort par cette porte soit de la cuisine.
    assert.ok(
      gerant.employees.every((e) => e.secteur === "cuisine" || e.secteur === "les_deux"),
      "sa cuisine, et rien d'autre — « les deux » EN FAIT partie"
    );
  });

  await t.test("les codes ne traînent pas dans le texte brut des mauvaises portes", async () => {
    for (const code of [CODE_SALLE, CODE_LECTURE]) {
      const texte = await (await parCode(code)).text();
      for (const secret of [serveuse.access_code, cuisinier.access_code, plongeur.access_code]) {
        assert.ok(!texte.includes(secret), `${secret} ne doit pas sortir par ${code}`);
      }
    }
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
  // ------------------------------------------------------------ quelqu'un des deux bords
  //
  // « J'ai besoin que tu joignes les horaires, si un employé est ouvert en cuisine et en
  // salle. » C'est ici que se vérifie la promesse, et surtout qu'elle n'ouvre aucune porte :
  // la personne est des deux équipes, mais chacun de ses QUARTS reste d'un seul côté.

  // Des dates À VENIR, calculées : la page d'un employé ne montre que ses quarts à venir,
  // et des dates écrites en dur finiraient par tomber dans le passé — le test se mettrait à
  // échouer un beau matin pour une raison qui n'a rien à voir avec ce qu'il vérifie.
  const dansNJours = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const J_CUISINE = dansNJours(3);
  const J_SALLE = dansNJours(4);

  const mixte = await creer("Trycia Dufour", "les_deux", 17);
  await admin("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({ employee_id: mixte.id, date: J_CUISINE, start_time: "05:30", end_time: "15:00", role: "cuisinier", note: "Prép" }),
  });
  await admin("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({ employee_id: mixte.id, date: J_SALLE, start_time: "16:00", end_time: "23:00", role: "server" }),
  });

  await t.test("un employé des deux bords est dans les deux équipes", async () => {
    for (const code of [CODE_CUISINE, CODE_SALLE]) {
      const d = await (await parCode(code)).json();
      assert.ok(d.employees.some((e) => e.name === "Trycia Dufour"), `absent de la porte ${code}`);
    }
  });

  await t.test("chacun de ses quarts ne sort que par la porte de SON secteur", async () => {
    // Le vrai risque du mélange : un quart de salle qui fuirait vers la cuisine. Ce n'est
    // plus le secteur de la personne qui filtre, c'est le poste du quart.
    const cuisine = await (await parCode(CODE_CUISINE, "/shifts")).json();
    const siens = cuisine.shifts.filter((q) => q.employee_id === mixte.id);
    assert.deepEqual(siens.map((q) => q.date), [J_CUISINE], "seulement son quart de cuisine");

    const salle = await (await parCode(CODE_SALLE, "/shifts")).json();
    const autres = salle.shifts.filter((q) => q.employee_id === mixte.id);
    assert.deepEqual(autres.map((q) => q.date), [J_SALLE], "seulement son quart de salle");
  });

  await t.test("sur SA page à lui, les deux quarts sont ensemble", async () => {
    // C'est la demande, mot pour mot : « dans son horaire à lui il voit une horaire avec
    // toutes ses chiffres cuisine et salle dans le même ».
    const d = await (await fetch(`${base}/api/employee/${mixte.access_code}/shifts`)).json();
    assert.deepEqual(d.shifts.map((q) => q.date).sort(), [J_CUISINE, J_SALLE].sort());
    assert.deepEqual(d.shifts.map((q) => q.role).sort(), ["cuisinier", "server"]);
  });

  await t.test("il garde son droit de déclarer ses pourboires", async () => {
    const d = await (await fetch(`${base}/api/employee/${mixte.access_code}`)).json();
    assert.equal(d.employee.secteur, "les_deux");
    const reponse = await fetch(`${base}/api/employee/${mixte.access_code}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: J_SALLE, ventes: 900, clients: 34, tips_declared: 130 }),
    });
    assert.equal(reponse.status, 200, "un employé mixte doit pouvoir déclarer sa journée");
  });

  await t.test("le gérant de cuisine reçoit son lien perso — c'est voulu", async () => {
    // Décision explicite du propriétaire : « je veux que les gérants soient en mesure de
    // distribuer les liens perso des employés ».
    const gerant = await (await parCode(CODE_CUISINE)).json();
    const sien = gerant.employees.find((e) => e.name === "Trycia Dufour");
    assert.equal(sien.access_code, mixte.access_code);
  });

  await t.test("mais son lien ne fuit toujours pas par les deux autres portes", async () => {
    // Le lien ouvre sa page, où il y a ses pourboires déclarés. Le lien de LECTURE des
    // cuisiniers et celui de la salle sont partagés à toute une équipe.
    for (const code of [CODE_LECTURE, CODE_SALLE]) {
      const texte = await (await parCode(code)).text();
      assert.ok(!texte.includes(mixte.access_code), `son code ne doit pas sortir par ${code}`);
      assert.doesNotMatch(texte, /\b17\b.*taux|taux_horaire/, "ni son taux");
    }
  });

  await t.test("la porte cuisine reçoit ses HEURES de salle, et rien de plus", async () => {
    // Un plafond d'heures porte sur la personne — visa étudiant, ou éviter l'overtime — pas
    // sur un poste. Sans ce complément, quelqu'un à 15 h de cuisine et 16 h de salle
    // s'afficherait « 15 h / 20 h », en vert, alors qu'il est à 31 h : le gérant ajouterait
    // un quart en croyant qu'il reste de la place.
    const d = await (await parCode(CODE_CUISINE, "/shifts")).json();
    const siennes = (d.heuresAilleurs || []).filter((h) => h.employee_id === mixte.id);
    assert.deepEqual(siennes.map((h) => h.date), [J_SALLE]);
    assert.equal(siennes[0].heures, 7, "16:00 → 23:00");

    // Des HEURES, pas un horaire : ni poste, ni tâche, ni heure d'arrivée. La porte apprend
    // qu'il a travaillé 7 h ailleurs ce jour-là, pas ce qu'il y faisait.
    assert.deepEqual(Object.keys(siennes[0]).sort(), ["date", "employee_id", "heures"]);
    for (const h of d.heuresAilleurs) {
      assert.ok(!("start_time" in h) && !("role" in h) && !("note" in h));
    }
  });

  await t.test("un employé d'un seul bord n'a pas d'heures ailleurs", async () => {
    const d = await (await parCode(CODE_CUISINE, "/shifts")).json();
    for (const h of d.heuresAilleurs || []) {
      assert.notEqual(h.employee_id, cuisinier.id, "un cuisinier pur n'a rien en salle");
      assert.notEqual(h.employee_id, serveuse.id, "et une serveuse n'a rien à faire ici");
    }
  });

  await t.test("effacer la semaine en cuisine n'efface pas ses quarts de salle", async () => {
    // LE piège de tout ce chantier. L'effacement en lot n'a aucune annulation possible :
    // s'il filtrait sur le secteur de la PERSONNE, il emporterait les quarts de salle d'un
    // employé mixte, et personne ne s'en apercevrait avant le service.
    const avant = await (await parCode(CODE_SALLE, "/shifts")).json();
    const salleAvant = avant.shifts.filter((q) => q.employee_id === mixte.id).length;
    assert.equal(salleAvant, 1);

    const r = await parCode(CODE_CUISINE, `/shifts?from=${dansNJours(2)}&to=${dansNJours(5)}`, { method: "DELETE" });
    assert.equal(r.status, 200);

    const apres = await (await parCode(CODE_SALLE, "/shifts")).json();
    const restants = apres.shifts.filter((q) => q.employee_id === mixte.id);
    assert.deepEqual(restants.map((q) => q.date), [J_SALLE], "son quart de salle a survécu");

    const cuisine = await (await parCode(CODE_CUISINE, "/shifts")).json();
    assert.equal(
      cuisine.shifts.filter((q) => q.employee_id === mixte.id).length,
      0,
      "son quart de cuisine, lui, est bien parti"
    );
  });
});
