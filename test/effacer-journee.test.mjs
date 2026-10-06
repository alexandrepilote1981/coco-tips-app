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

// ---------------------------------------------------------------------------------------
// CORRIGER une journée déclarée, depuis le tableau de bord.
//
// Même famille que l'effacement, et né de la même question : « j'aimerais savoir comment
// modifier la déclaration d'une fille ». Avant, pour une coquille — 1 240 $ tapé 12 400 — il
// fallait rejoindre l'employée ou tout effacer et lui demander de recommencer.
//
// Ce qui se joue : de l'argent, et trois faits qui ne se recalculent PAS tout seuls.
test("corriger les chiffres d'une journée déclarée", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-corriger-"));
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
  const creer = (name) => admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name }) }).then((r) => r.json());
  const marie = await creer("Marie Tremblay");
  const sophie = await creer("Sophie Roy");

  const declarer = (emp, date, corps) =>
    fetch(`${base}/api/employee/${emp.access_code}/entries`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, clients: 62, pct: 12, remis: 0, ...corps }),
    }).then((r) => r.json());
  const journee = async (emp, i = 0) =>
    (await (await fetch(`${base}/api/employee/${emp.access_code}`)).json()).entries[i];
  const corriger = (id, corps) => admin(`/api/admin/entries/${id}`, { method: "PATCH", body: JSON.stringify(corps) });

  // La coquille : un zéro de trop, la journée déjà envoyée, le virement déjà réglé.
  const coquille = await declarer(marie, "2026-10-03", { ventes: 12400, remit_direction: "employee_owes", remit_amount: 75 });
  await fetch(`${base}/api/employee/${marie.access_code}/entries/${coquille.id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" } });
  await admin(`/api/admin/entries/${coquille.id}/transferred`, { method: "POST", body: JSON.stringify({ transferred: true }) });
  // Une collègue a déclaré LE MÊME JOUR.
  const voisine = await declarer(sophie, "2026-10-03", { ventes: 900, clients: 40, pct: 11 });

  await t.test("les chiffres et le net se refont", async () => {
    const rep = await corriger(coquille.id, { ventes: 1240, clients: 62, pct: 12, remis: 0, remit_direction: "employee_owes", remit_amount: 75 });
    assert.equal(rep.status, 200);
    // Le net revient dans la réponse : la page affiche le montant neuf sans recharger.
    // On compare à un cent près : 1240 × 0,12 vaut 148,799999… en virgule flottante, et
    // l'app n'arrondit qu'à l'affichage. Exiger l'égalité exacte testerait la représentation
    // des nombres, pas le calcul des pourboires.
    const aUnCentPres = (a, b, quoi) => assert.ok(Math.abs(a - b) < 0.005, `${quoi} : ${a} ≈ ${b}`);
    aUnCentPres((await rep.json()).entry.net, 148.8, "le net rendu");

    const apres = await journee(marie);
    assert.equal(apres.ventes, 1240);
    aUnCentPres(apres.net, 148.8, "1240 × 12 % — recalculé, jamais stocké");
  });

  await t.test("la journée NE repasse PAS « à envoyer »", async () => {
    // C'est la différence avec la saisie de l'employée, où corriger après coup remet la
    // journée dans sa pile. Ici c'est le gérant qui corrige : elle n'a rien à renvoyer, et
    // la remettre dans sa liste lui ferait refaire un geste pour une faute qui n'est pas la
    // sienne.
    assert.ok((await journee(marie)).submitted_at, "elle reste envoyée");
  });

  await t.test("le virement déjà réglé reste réglé", async () => {
    // Les chiffres se recalculent, l'argent qui a circulé entre deux personnes non. La
    // fenêtre le dit en rouge AVANT d'enregistrer ; le serveur, lui, n'y touche pas.
    const d = await journee(marie);
    assert.equal(!!d.transferred, true);
    assert.equal(d.remit_amount, 75);
  });

  await t.test("la trace « modifiée après coup » reste possible", async () => {
    // `data_updated_at` bouge à chaque correction : c'est ce qui permet au tableau de bord
    // d'écrire « modifiée le … ». Sans ça, un chiffre pourrait changer sans laisser de trace.
    const d = await journee(marie);
    assert.ok(d.data_updated_at, "la date de dernière modification est écrite");
    assert.ok(d.data_updated_at >= d.created_at);
  });

  await t.test("la journée du MÊME JOUR d'une collègue ne bouge pas", async () => {
    // La borne qui compte le plus, comme pour l'effacement.
    const d = await journee(sophie);
    assert.equal(d.id, voisine.id);
    assert.equal(d.ventes, 900);
    assert.equal(d.net, 99);
  });

  await t.test("une saisie de travers vaut zéro, jamais NaN", async () => {
    // Un NaN se propagerait ensuite dans TOUS les totaux du restaurant sans rien afficher
    // d'anormal. Les montants ne descendent pas sous zéro non plus — c'est le NET qui peut
    // être négatif, et il se calcule.
    const rep = await corriger(coquille.id, { ventes: "abc", clients: -5, pct: 300, remis: "", remit_direction: "hop", remit_amount: 999 });
    const e = (await rep.json()).entry;
    assert.equal(e.ventes, 0);
    assert.equal(e.clients, 0);
    assert.equal(e.pct, 100, "un pourcentage se plafonne à 100");
    assert.equal(e.remis, 0);
    assert.equal(e.remit_direction, null, "un sens inconnu ne s'écrit pas");
    assert.equal(e.remit_amount, 0, "et sans sens, aucun montant");
    assert.ok(Number.isFinite(e.net));
  });

  await t.test("un net négatif passe : elle a remis plus que son brut", async () => {
    const rep = await corriger(coquille.id, { ventes: 1000, clients: 50, pct: 10, remis: 300 });
    assert.equal((await rep.json()).entry.net, -200);
  });

  await t.test("une journée qui n'existe plus répond 404", async () => {
    // Comme l'effacement : un double envoi ne doit pas se lire comme deux corrections.
    assert.equal((await corriger("jamaisvu", { ventes: 1 })).status, 404);
  });

  await t.test("la porte reste fermée sans le mot de passe", async () => {
    const r = await fetch(`${base}/api/admin/entries/${coquille.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ventes: 99999 }),
    });
    assert.equal(r.status, 401);
    assert.notEqual((await journee(marie)).ventes, 99999, "et rien n'a été écrit");
  });
});
