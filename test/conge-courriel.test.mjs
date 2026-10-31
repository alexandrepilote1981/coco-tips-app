// Répondre à une demande de congé DEPUIS LE COURRIEL — sur le vrai serveur HTTP.
//
// Les boutons « Accepter / Refuser » du courriel mènent à une page qui agit sans connexion.
// Ce qui autorise, c'est le jeton signé passé dans l'adresse. On vérifie ici la promesse de
// sécurité : un lien falsifié ne passe pas, un lien pour une autre demande non plus, on ne
// répond qu'une fois, et accepter place bien le congé dans la grille (il devient une absence
// acceptée).
//
// Le serveur tourne sur une base jetable. Le secret de signature vit en base (table
// `reglages`) ; le test l'y lit pour fabriquer un vrai jeton, comme le ferait le serveur.
//
// Lancer seul : node --test test/conge-courriel.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import N from "../notifications.js";

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
      throw new Error(`délai dépassé au démarrage :\n${journal}`);
    }
    await attendre(100);
  }
  return { proc, base };
}

test("répondre à un congé par le lien signé du courriel", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-conge-courriel-"));
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
  const jsonPost = (chemin, corps) =>
    fetch(`${base}${chemin}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

  const resto = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Le Coco Resto" }) })).json();
  const emp = await (await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Marie Tremblay", secteur: "salle" }) })).json();

  // L'employée demande un congé.
  const demande = await (await jsonPost(`/api/employee/${emp.access_code}/conges`, {
    date_debut: "2026-11-05", type: "conge", note: "Rendez-vous médical",
  })).json();
  const id = demande.id;
  assert.ok(id, "la demande a un id");

  // 1. Un lien sans jeton valide est refusé — ET cet appel crée le secret en base.
  assert.equal((await fetch(`${base}/api/conge/${id}?t=bogus`)).status, 403, "jeton bidon → 403");

  // On lit le secret comme le serveur l'a écrit, pour fabriquer un VRAI jeton.
  const bdd = new Database(path.join(dossier, "essai.sqlite"));
  const ligne = bdd.prepare("SELECT valeur FROM reglages WHERE cle = 'notif_secret'").get();
  bdd.close();
  assert.ok(ligne && ligne.valeur, "le secret de signature a été créé");
  const tok = N.jeton(ligne.valeur, id);

  // 2. Le bon jeton laisse voir la demande.
  const vue = await (await fetch(`${base}/api/conge/${id}?t=${tok}`)).json();
  assert.equal(vue.demande.employee_name, "Marie Tremblay");
  assert.equal(vue.demande.restaurant_name, "Le Coco Resto");
  assert.equal(vue.demande.statut, "en_attente");

  // 3. Un jeton falsifié est refusé.
  assert.equal((await fetch(`${base}/api/conge/${id}?t=${tok}x`)).status, 403, "jeton falsifié → 403");

  // 4. Un bon jeton pour une demande qui n'existe pas → 404 (pas 403 : la signature est bonne).
  const faux = "zzzzzzzzzz";
  assert.equal((await fetch(`${base}/api/conge/${faux}?t=${N.jeton(ligne.valeur, faux)}`)).status, 404);

  // 5. Accepter → 200, et le congé devient une absence ACCEPTÉE qui marque la grille.
  const rep = await fetch(`${base}/api/conge/${id}/reponse`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: tok, accepte: true }),
  });
  assert.equal(rep.status, 200);
  assert.equal((await rep.json()).statut, "accepte");

  const abs = await (await admin(`/api/admin/absences?restaurant_id=${resto.id}`)).json();
  assert.ok(abs.absences.some((a) => a.id === id), "le congé accepté apparaît dans les absences");

  // 6. Une deuxième réponse est refusée (un refus ne devient pas une acceptation d'un 2e clic).
  const rep2 = await fetch(`${base}/api/conge/${id}/reponse`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: tok, accepte: false }),
  });
  assert.equal(rep2.status, 409, "déjà répondu → 409");

  // 7. Refuser une AUTRE demande avec un mot : elle ne marque PAS la grille, et l'employée
  //    voit le refus et le mot.
  const d2 = await (await jsonPost(`/api/employee/${emp.access_code}/conges`, { date_debut: "2026-11-20", type: "vacances" })).json();
  const tok2 = N.jeton(ligne.valeur, d2.id);
  const repR = await fetch(`${base}/api/conge/${d2.id}/reponse`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: tok2, accepte: false, reponse: "On est déjà trop juste cette semaine" }),
  });
  assert.equal(repR.status, 200);

  const abs2 = await (await admin(`/api/admin/absences?restaurant_id=${resto.id}`)).json();
  assert.ok(!abs2.absences.some((a) => a.id === d2.id), "un congé refusé ne marque pas la grille");

  const cote = await (await fetch(`${base}/api/employee/${emp.access_code}/conges`)).json();
  const vueEmp = cote.conges.find((c) => c.id === d2.id);
  assert.equal(vueEmp.statut, "refuse");
  assert.equal(vueEmp.reponse, "On est déjà trop juste cette semaine");
});
