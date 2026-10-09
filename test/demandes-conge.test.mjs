// Les demandes de congé : l'employé demande, le gérant répond, et l'employé voit la réponse.
//
// Pourquoi ce fichier existe. Avant, un employé n'avait aucun moyen de demander une journée —
// il écrivait au gérant, qui retranscrivait à la main. Rapporté ainsi : « un employé n'est pas
// disponible, comment il fait pour placer sa demande dans l'horaire ? Je vois les demandes de
// mon côté mais quand je regarde côté employé je vois rien. »
//
// Une demande EST une absence, avec `statut = 'en_attente'` : accepter ne change que le
// statut, donc il n'y a jamais deux vérités à tenir d'accord. Tout le risque est là — un
// statut oublié dans une requête et une journée que personne n'a accordée se met à marquer la
// grille, ou un refus réapparaît comme un congé accordé. Ce sont ces bornes-là qu'on vérifie.
//
// Le serveur tourne sur une base jetable, jamais sur data.sqlite.
//
// Lancer seul : node --test test/demandes-conge.test.mjs

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

test("demandes de congé, de l'employé au gérant et retour", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-conges-"));
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
  const json = async (res) => res.json();
  const poster = (chemin, corps, opts = {}) =>
    fetch(`${base}${chemin}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: JSON.stringify(corps),
    });

  // --- décor : deux restaurants ; chez le premier, une serveuse, un cuisinier, une collègue
  const resto = await json(await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Chez Coco" }) }));
  const voisin = await json(await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Le Voisin" }) }));

  const marie = await json(await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Marie Tremblay", secteur: "salle" }) }));
  const noemi = await json(await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Noémie Jean", secteur: "salle" }) }));
  const luc = await json(await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Luc Gagnon", secteur: "cuisine" }) }));
  const chezLeVoisin = await json(await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: voisin.id, name: "Alexandre Roy", secteur: "salle" }) }));

  const absencesDuResto = async () =>
    (await json(await admin(`/api/admin/absences?restaurant_id=${resto.id}`))).absences;
  const demandesDuResto = async () =>
    (await json(await admin(`/api/admin/demandes-conge?restaurant_id=${resto.id}`))).demandes;
  const sesConges = async (code) => (await json(await fetch(`${base}/api/employee/${code}/conges`))).conges;

  let demandeDeMarie;

  await t.test("une demande arrive en attente, et ne marque RIEN dans la grille", async () => {
    // C'est la borne qui compte le plus : une case qui afficherait « Congé » pendant que le
    // gérant hésite encore se lirait comme un congé accordé, et il bâtirait sa semaine
    // autour d'une journée qu'il n'a jamais donnée.
    const res = await poster(`/api/employee/${marie.access_code}/conges`, {
      date_debut: "2026-11-10",
      type: "conge",
      note: "Rendez-vous médical",
    });
    assert.equal(res.status, 200);
    demandeDeMarie = await res.json();
    assert.equal(demandeDeMarie.statut, "en_attente");
    assert.equal(demandeDeMarie.date_fin, "2026-11-10", "une fin vide vaut une seule journée");

    assert.equal((await absencesDuResto()).length, 0, "aucune absence tant que personne n'a répondu");
    // Et la branche « tous les restaurants » du tableau de bord, qui a son propre filtre.
    const toutes = (await json(await admin("/api/admin/absences"))).absences;
    assert.equal(toutes.length, 0, "ni par la branche sans restaurant_id");
  });

  await t.test("le gérant la voit, avec le nom de la personne", async () => {
    const demandes = await demandesDuResto();
    assert.equal(demandes.length, 1);
    assert.equal(demandes[0].id, demandeDeMarie.id);
    assert.equal(demandes[0].employee_name, "Marie Tremblay", "le nom voyage avec la demande");
    assert.equal(demandes[0].note, "Rendez-vous médical");
  });

  await t.test("on ne se déclare pas un accident de travail depuis son téléphone", async () => {
    // `maladie` et `cnesst` se constatent après coup et changent la paie. Un type refusé en
    // silence serait pire qu'un refus : la demande deviendrait un congé ordinaire sans que
    // personne ne le voie. Elle en devient donc un, explicitement, et le gérant verra « Congé ».
    for (const type of ["cnesst", "maladie", "n'importe quoi"]) {
      const d = await json(await poster(`/api/employee/${noemi.access_code}/conges`, { date_debut: "2026-12-01", type }));
      assert.equal(d.type, "conge", `${type} doit retomber sur conge`);
      await fetch(`${base}/api/employee/${noemi.access_code}/conges/${d.id}`, { method: "DELETE" });
    }
    assert.equal((await demandesDuResto()).length, 1, "le décor est revenu à la seule demande de Marie");
  });

  await t.test("une date manquante est refusée plutôt qu'interprétée", async () => {
    for (const corps of [{}, { date_debut: "" }, { date_debut: "demain" }, { date_debut: "2026-2-3" }]) {
      const res = await poster(`/api/employee/${marie.access_code}/conges`, corps);
      assert.equal(res.status, 400, `refus attendu pour ${JSON.stringify(corps)}`);
    }
    assert.equal((await demandesDuResto()).length, 1);
  });

  await t.test("un code inconnu n'ouvre rien", async () => {
    assert.equal((await fetch(`${base}/api/employee/ZZZZZZ/conges`)).status, 404);
    assert.equal((await poster(`/api/employee/ZZZZZZ/conges`, { date_debut: "2026-11-10" })).status, 404);
  });

  await t.test("la collègue ne peut pas annuler la demande de Marie", async () => {
    // Un code valide ne doit pas suffire : sans le `employee_id` dans la requête, n'importe
    // quelle employée effacerait la demande de n'importe qui.
    const res = await fetch(`${base}/api/employee/${noemi.access_code}/conges/${demandeDeMarie.id}`, { method: "DELETE" });
    assert.equal(res.status, 404);
    assert.equal((await demandesDuResto()).length, 1, "la demande de Marie est toujours là");
  });

  await t.test("Marie annule la sienne, puis la repose", async () => {
    const res = await fetch(`${base}/api/employee/${marie.access_code}/conges/${demandeDeMarie.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal((await demandesDuResto()).length, 0);

    demandeDeMarie = await json(await poster(`/api/employee/${marie.access_code}/conges`, {
      date_debut: "2026-11-10",
      type: "conge",
      note: "Rendez-vous médical",
    }));
    assert.equal((await demandesDuResto()).length, 1);
  });

  await t.test("le lien de la salle ne voit pas la demande d'un cuisinier", async () => {
    const duCuistot = await json(await poster(`/api/employee/${luc.access_code}/conges`, { date_debut: "2026-11-12", type: "vacances" }));

    const salle = (await json(await fetch(`${base}/api/schedule/by-code/${resto.schedule_code}/demandes-conge`))).demandes;
    assert.deepEqual(salle.map((d) => d.id), [demandeDeMarie.id], "la salle ne voit que la salle");

    const cuisine = (await json(await fetch(`${base}/api/schedule/by-code/${resto.schedule_code_cuisine}/demandes-conge`))).demandes;
    assert.deepEqual(cuisine.map((d) => d.id), [duCuistot.id], "la cuisine ne voit que la cuisine");

    // Et le gérant de cuisine ne répond pas à la demande d'une serveuse, même en connaissant
    // son identifiant : c'est la même borne que pour les absences.
    const res = await poster(
      `/api/schedule/by-code/${resto.schedule_code_cuisine}/demandes-conge/${demandeDeMarie.id}/reponse`,
      { accepte: true }
    );
    assert.equal(res.status, 404);

    await fetch(`${base}/api/employee/${luc.access_code}/conges/${duCuistot.id}`, { method: "DELETE" });
  });

  await t.test("le lien de LECTURE des cuisiniers ne reçoit aucune demande et ne répond pas", async () => {
    // Ce lien se partage à toute l'équipe. Y laisser répondre reviendrait à laisser un
    // cuisinier s'accorder son propre congé.
    const duCuistot = await json(await poster(`/api/employee/${luc.access_code}/conges`, { date_debut: "2026-11-12", type: "conge" }));

    const lecture = (await json(await fetch(`${base}/api/schedule/by-code/${resto.schedule_code_cuisine_lecture}/demandes-conge`))).demandes;
    assert.deepEqual(lecture, [], "rien ne sort vers la porte en lecture seule");

    const res = await poster(
      `/api/schedule/by-code/${resto.schedule_code_cuisine_lecture}/demandes-conge/${duCuistot.id}/reponse`,
      { accepte: true }
    );
    assert.equal(res.status, 403);
    const apres = (await json(await admin(`/api/admin/demandes-conge?restaurant_id=${resto.id}`))).demandes;
    assert.ok(apres.some((d) => d.id === duCuistot.id), "la demande attend toujours");

    await fetch(`${base}/api/employee/${luc.access_code}/conges/${duCuistot.id}`, { method: "DELETE" });
  });

  await t.test("le restaurant voisin ne voit pas les demandes d'ici", async () => {
    const res = await poster(
      `/api/schedule/by-code/${voisin.schedule_code}/demandes-conge/${demandeDeMarie.id}/reponse`,
      { accepte: true }
    );
    assert.equal(res.status, 404);
    assert.deepEqual((await json(await admin(`/api/admin/demandes-conge?restaurant_id=${voisin.id}`))).demandes, []);
  });

  await t.test("accepter inscrit le congé dans la grille et vide la demande", async () => {
    const res = await admin("/api/admin/demandes-conge/" + demandeDeMarie.id + "/reponse", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, accepte: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).statut, "accepte");

    const absences = await absencesDuResto();
    assert.equal(absences.length, 1, "la journée marque enfin la grille");
    assert.equal(absences[0].id, demandeDeMarie.id, "la MÊME ligne : rien n'est recopié");
    assert.equal(absences[0].type, "conge");
    assert.deepEqual(await demandesDuResto(), [], "et elle ne réclame plus de réponse");
  });

  await t.test("une seconde réponse est refusée, le premier mot reste le bon", async () => {
    // Sans ça, un refus envoyé deviendrait une acceptation d'un second clic, et l'employée
    // ne saurait pas laquelle des deux vaut.
    const res = await admin("/api/admin/demandes-conge/" + demandeDeMarie.id + "/reponse", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, accepte: false }),
    });
    assert.equal(res.status, 409);
    assert.equal((await absencesDuResto()).length, 1, "le congé accepté reste accepté");
  });

  await t.test("Marie ne peut plus retirer un congé accepté, mais elle le voit", async () => {
    // Le gérant a bâti sa semaine autour. Le retirer d'un clic la veille lui enlèverait une
    // journée sous les pieds sans qu'il l'apprenne.
    const res = await fetch(`${base}/api/employee/${marie.access_code}/conges/${demandeDeMarie.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);

    const siens = await sesConges(marie.access_code);
    assert.equal(siens.length, 1);
    assert.equal(siens[0].statut, "accepte");
  });

  await t.test("un refus porte le mot du gérant jusqu'à la page de l'employé", async () => {
    const demande = await json(await poster(`/api/employee/${noemi.access_code}/conges`, {
      date_debut: "2026-11-20",
      date_fin: "2026-11-22",
      type: "vacances",
    }));

    const res = await admin("/api/admin/demandes-conge/" + demande.id + "/reponse", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, accepte: false, reponse: "Trop de monde cette semaine-là" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).statut, "refuse");

    const siens = await sesConges(noemi.access_code);
    assert.equal(siens.length, 1);
    assert.equal(siens[0].statut, "refuse");
    assert.equal(siens[0].reponse, "Trop de monde cette semaine-là");
    assert.ok(siens[0].repondu_at, "la date de la réponse est notée");

    // Et un refus ne marque RIEN : la journée reste libre, et on peut la céduler sans avis.
    assert.equal((await absencesDuResto()).length, 1, "seul le congé accepté de Marie");
  });

  await t.test("chacune ne voit que ses propres congés", async () => {
    const chezMarie = await sesConges(marie.access_code);
    const chezNoemi = await sesConges(noemi.access_code);
    assert.deepEqual(chezMarie.map((c) => c.statut), ["accepte"]);
    assert.deepEqual(chezNoemi.map((c) => c.statut), ["refuse"]);
    assert.equal((await sesConges(chezLeVoisin.access_code)).length, 0);
  });

  await t.test("le gérant de salle répond par son lien, sans jeton admin", async () => {
    const demande = await json(await poster(`/api/employee/${marie.access_code}/conges`, { date_debut: "2026-12-24", type: "conge" }));
    const res = await poster(
      `/api/schedule/by-code/${resto.schedule_code}/demandes-conge/${demande.id}/reponse`,
      { accepte: true }
    );
    assert.equal(res.status, 200);
    const absences = await absencesDuResto();
    assert.ok(absences.some((a) => a.id === demande.id && a.date_debut === "2026-12-24"));
  });
});
