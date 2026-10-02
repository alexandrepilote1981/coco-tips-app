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

// ------------------------------------------- remettre ce qu'on vient d'effacer
//
// « Effacer la semaine » était la seule action de l'app qui détruisait beaucoup d'un coup
// sans aucun retour en arrière. Le seul filet était la fenêtre de confirmation du navigateur
// — celle où on tape OK sans lire. Ces tests tiennent les bornes de l'annulation, qui
// comptent plus que l'annulation elle-même : elle accepte des lignes venues du NAVIGATEUR.

test("annuler un effacement de semaine", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-annuler-"));
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

  const resto = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Chez Coco" }) })).json();
  const voisin = await (await admin("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Le Voisin" }) })).json();
  const creer = (restaurant_id, name, secteur) => admin("/api/admin/employees", {
    method: "POST", body: JSON.stringify({ restaurant_id, name, secteur }),
  }).then((r) => r.json());

  const cuisto = await creer(resto.id, "Luc Bergeron", "cuisine");
  const serveuse = await creer(resto.id, "Marie Tremblay", "salle");
  const chezLeVoisin = await creer(voisin.id, "Alexandre Roy", "cuisine");

  const poser = (employee_id, date, role) => admin("/api/admin/shifts", {
    method: "POST",
    body: JSON.stringify({ employee_id, date, start_time: "09:00", end_time: "17:00", role }),
  }).then((r) => r.json());

  const tous = async () => (await (await admin("/api/admin/shifts")).json()).shifts;

  await poser(cuisto.id, "2026-09-21", "cuisinier");
  await poser(cuisto.id, "2026-09-23", "plongeur");
  await poser(serveuse.id, "2026-09-21", "server");
  await poser(chezLeVoisin.id, "2026-09-21", "cuisinier");

  let effaces = null;

  await t.test("l'effacement rend les quarts qu'il emporte", async () => {
    const res = await admin(`/api/admin/shifts?restaurant_id=${resto.id}&from=2026-09-21&to=2026-09-27&secteur=cuisine`, { method: "DELETE" });
    const corps = await res.json();
    assert.equal(corps.deleted, 2);
    assert.equal(corps.quarts.length, 2, "les lignes effacées reviennent avec la réponse");
    assert.ok(corps.quarts[0].id && corps.quarts[0].employee_id, "des lignes entières, pas juste un compte");
    effaces = corps.quarts;
    assert.equal((await tous()).length, 2, "la serveuse et le voisin restent");
  });

  await t.test("on les remet, avec leurs identifiants d'origine", async () => {
    // Un quart remis avec un id neuf casserait les liens que la page garde en mémoire : la
    // pastille sur laquelle on tape ne pointerait plus sur rien.
    const res = await admin("/api/admin/shifts/restaurer", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, quarts: effaces }),
    });
    assert.equal((await res.json()).restaures, 2);
    const apres = await tous();
    assert.equal(apres.length, 4);
    for (const q of effaces) assert.ok(apres.some((a) => a.id === q.id), `le quart ${q.id} doit être revenu`);
  });

  await t.test("remettre deux fois ne crée pas de doublon", async () => {
    // Un double clic sur « Annuler » ne doit rien casser.
    await admin("/api/admin/shifts/restaurer", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, quarts: effaces }),
    });
    assert.equal((await tous()).length, 4);
  });

  await t.test("on ne remet jamais un quart chez le voisin", async () => {
    // La borne qui compte : la liste vient du NAVIGATEUR. Quelqu'un qui bricole la requête ne
    // doit pas pouvoir écrire des quarts dans un autre commerce.
    const intrus = [{ id: "intrus0001", employee_id: chezLeVoisin.id, date: "2026-10-05", start_time: "09:00", end_time: "17:00", role: "cuisinier" }];
    const res = await admin("/api/admin/shifts/restaurer", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, quarts: intrus }),
    });
    assert.equal((await res.json()).restaures, 0);
    assert.ok(!(await tous()).some((q) => q.id === "intrus0001"));
  });

  await t.test("le lien de cuisine ne peut pas remettre un quart de SALLE", async () => {
    // Sinon le gérant de cuisine écrirait dans une grille à laquelle il n'a pas accès.
    const quartDeSalle = [{ id: "salle00001", employee_id: serveuse.id, date: "2026-10-05", start_time: "16:00", end_time: "23:00", role: "server" }];
    const res = await fetch(`${base}/api/schedule/by-code/${resto.schedule_code_cuisine}/shifts/restaurer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quarts: quartDeSalle }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).restaures, 0);
    assert.ok(!(await tous()).some((q) => q.id === "salle00001"));
  });

  await t.test("un lien en LECTURE ne remet rien du tout", async () => {
    const res = await fetch(`${base}/api/schedule/by-code/${resto.schedule_code_cuisine_lecture}/shifts/restaurer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quarts: effaces }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("sans jeton admin, personne ne remet rien", async () => {
    const res = await fetch(`${base}/api/admin/shifts/restaurer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurant_id: resto.id, quarts: effaces }),
    });
    assert.equal(res.status, 401);
  });

  await t.test("« restaurer » n'est pas pris pour un identifiant de quart", async () => {
    // Le piège qui a mordu : Express prend les routes dans l'ordre, et /shifts/restaurer
    // tombait sur /shifts/:id. La mise à jour tournait sur un quart inexistant et répondait
    // « ok » — l'annulation disait « c'est fait » et ne remettait rien.
    const res = await admin("/api/admin/shifts/restaurer", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, quarts: [] }),
    });
    const corps = await res.json();
    assert.ok("restaures" in corps, `la réponse doit venir de la route de restauration, reçu ${JSON.stringify(corps)}`);
  });
});
