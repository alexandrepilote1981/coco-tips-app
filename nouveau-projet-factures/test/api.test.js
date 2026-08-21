// Parcours complet sur une base jetable : dépôt, doublon, validation, export.
//
// Aucune clé ANTHROPIC_API_KEY n'est définie ici, volontairement : c'est le chemin où
// l'analyse est indisponible, et c'est celui qui doit prouver qu'une photo n'est JAMAIS
// perdue parce que l'extraction n'a pas pu tourner.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "factures-test-"));
process.env.DB_PATH = path.join(dossier, "essai.sqlite");
process.env.PHOTOS_DIR = path.join(dossier, "photos");
process.env.APP_PASSWORD = "motdepasse-test";
delete process.env.ANTHROPIC_API_KEY;

const app = require("../server");
const { getReglage } = require("../db");

// Un GIF 1×1 valide : assez pour traverser la liste blanche et être écrit sur disque.
const IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const AUTRE_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let base, serveur;
test.before(async () => {
  await new Promise((resolve) => { serveur = app.listen(0, resolve); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});
test.after(() => {
  serveur.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

const admin = () => ({ "X-App-Token": "motdepasse-test", "Content-Type": "application/json" });

test("un dépôt sans identification est refusé", async () => {
  const r = await fetch(`${base}/api/factures`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoBase64: IMAGE }),
  });
  assert.strictEqual(r.status, 401);
});

test("le registre n'est pas lisible avec le seul code de capture", async () => {
  // Le lien du téléphone ne doit jamais exposer les montants : il vit dans les favoris d'un
  // appareil qui peut se perdre.
  const r = await fetch(`${base}/api/factures`, { headers: { "X-Capture-Code": getReglage("capture_code") } });
  assert.strictEqual(r.status, 401);
});

test("un format d'image maquillé est refusé", async () => {
  const r = await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(),
    body: JSON.stringify({ photoBase64: "data:image/html;base64,PHNjcmlwdD4=" }),
  });
  assert.strictEqual(r.status, 400);
});

test("la photo est conservée même quand l'analyse est indisponible", async () => {
  const r = await fetch(`${base}/api/factures`, {
    method: "POST", headers: { "X-Capture-Code": getReglage("capture_code"), "Content-Type": "application/json" },
    body: JSON.stringify({ photoBase64: IMAGE }),
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.extraite, false);
  assert.ok(data.id, "la facture doit exister malgré l'échec d'analyse");

  const liste = await (await fetch(`${base}/api/factures`, { headers: admin() })).json();
  const f = liste.factures.find((x) => x.id === data.id);
  assert.ok(f.photo_filename, "le fichier photo doit être référencé");
  assert.ok(fs.existsSync(path.join(process.env.PHOTOS_DIR, f.photo_filename)), "le fichier photo doit être sur le disque");
});

test("la même photo redéposée est signalée comme doublon", async () => {
  const r = await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(), body: JSON.stringify({ photoBase64: IMAGE }),
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, "doublon");
});

test("le doublon peut être forcé quand l'utilisateur confirme", async () => {
  const r = await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(), body: JSON.stringify({ photoBase64: IMAGE, forcer: true }),
  });
  assert.strictEqual(r.status, 200);
  // La ligne forcée ne doit pas polluer les tests suivants.
  await fetch(`${base}/api/factures/${(await r.json()).id}`, { method: "DELETE", headers: admin() });
});

test("une facture se complète, se valide et entre dans l'export", async () => {
  const liste = await (await fetch(`${base}/api/factures?statut=a_valider`, { headers: admin() })).json();
  const id = liste.factures[0].id;

  const r = await fetch(`${base}/api/factures/${id}`, {
    method: "PATCH", headers: admin(),
    body: JSON.stringify({
      fournisseur: "Épicerie du coin", fournisseur_tps: "123456789RT0001", fournisseur_tvq: "1234567890TQ0001",
      date: "2026-08-15", sous_total: 100, tps: 5, tvq: 9.98, total: 114.98,
      categorie: "Nourriture et boissons", statut: "valide",
    }),
  });
  assert.strictEqual(r.status, 200);
  const { facture, coherence, alertes } = await r.json();
  assert.strictEqual(facture.statut, "valide");
  assert.strictEqual(coherence.coherent, true);
  assert.deepStrictEqual(alertes, []);

  // Les octets bruts, pas .text() : le décodage UTF-8 de fetch retire le BOM, donc la seule
  // façon de vérifier qu'il part vraiment est de regarder les trois premiers octets.
  const octets = new Uint8Array(await (await fetch(`${base}/api/export.csv`, { headers: admin() })).arrayBuffer());
  assert.deepStrictEqual([...octets.slice(0, 3)], [0xef, 0xbb, 0xbf], "le BOM doit être présent pour qu'Excel lise l'UTF-8");

  const csv = new TextDecoder().decode(octets);
  assert.ok(csv.includes("Épicerie du coin"), "le fournisseur doit apparaître dans l'export");
  assert.ok(csv.includes("114.98"), "le total doit apparaître dans l'export");
});

test("un total incohérent est enregistré mais l'écart est conservé", async () => {
  // On n'empêche pas d'enregistrer — parfois le reçu lui-même est étrange. On garde la trace
  // pour que le drapeau reste visible dans la page.
  const depot = await (await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(), body: JSON.stringify({ photoBase64: AUTRE_IMAGE }),
  })).json();

  const { facture, coherence } = await (await fetch(`${base}/api/factures/${depot.id}`, {
    method: "PATCH", headers: admin(),
    body: JSON.stringify({ fournisseur: "Quincaillerie", date: "2026-08-16", sous_total: 100, tps: 5, tvq: 9.98, total: 14.98 }),
  })).json();

  assert.strictEqual(coherence.coherent, false);
  assert.strictEqual(facture.ecart_taxes, 100);
});

test("une facture identique déjà validée bloque la validation", async () => {
  // Empreinte différente, même facture : c'est le reçu rephotographié sous un autre angle.
  const depot = await (await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(),
    body: JSON.stringify({ photoBase64: "data:image/gif;base64,R0lGODlhAQABAIAAACgoKP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }),
  })).json();

  const corps = { fournisseur: "Épicerie du coin", date: "2026-08-15", sous_total: 100, tps: 5, tvq: 9.98, total: 114.98, statut: "valide" };
  const r = await fetch(`${base}/api/factures/${depot.id}`, { method: "PATCH", headers: admin(), body: JSON.stringify(corps) });
  assert.strictEqual(r.status, 409);

  const force = await fetch(`${base}/api/factures/${depot.id}`, {
    method: "PATCH", headers: admin(), body: JSON.stringify({ ...corps, forcer: true }),
  });
  assert.strictEqual(force.status, 200);
});

test("supprimer une facture retire aussi sa photo du disque", async () => {
  const depot = await (await fetch(`${base}/api/factures`, {
    method: "POST", headers: admin(),
    body: JSON.stringify({ photoBase64: "data:image/gif;base64,R0lGODlhAQABAIAAAP//AP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }),
  })).json();

  const liste = await (await fetch(`${base}/api/factures`, { headers: admin() })).json();
  const fichier = liste.factures.find((f) => f.id === depot.id).photo_filename;
  const chemin = path.join(process.env.PHOTOS_DIR, fichier);
  assert.ok(fs.existsSync(chemin));

  await fetch(`${base}/api/factures/${depot.id}`, { method: "DELETE", headers: admin() });
  assert.ok(!fs.existsSync(chemin), "le volume ne doit pas se remplir de photos orphelines");
});
