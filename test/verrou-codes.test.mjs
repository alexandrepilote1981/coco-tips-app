// Le verrou anti-force-brute, sur le vrai serveur HTTP.
//
// Pourquoi ce fichier plutôt que les seuls tests unitaires : le comportement qui compte est
// celui que vit une employée — « mon lien marche-t-il, oui ou non ? ». Un test unitaire
// vérifie la mécanique ; celui-ci vérifie la promesse.
//
// Le cas qu'on a réellement eu : toute l'équipe partage le WiFi du restaurant, donc une
// seule adresse. Quelqu'un rate dix codes, et plus personne n'entre.

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
  return new Promise((resolve) => {
    const s = createServer();
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
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`serveur arrêté :\n${journal}`);
    try {
      if ((await fetch(`${base}/admin`)).ok) return { proc, base };
    } catch (e) {
      /* pas encore prêt */
    }
    await attendre(100);
  }
  proc.kill("SIGKILL");
  throw new Error(`le serveur n'a pas démarré :\n${journal}`);
}

test("le verrou des codes", async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-verrou-"));
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
  const creer = async (name) =>
    (await admin("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name }) })).json();

  const trycia = await creer("Trycia Gagnon");
  const nouvelle = await creer("Camille Roy");
  // Celle-ci n'ouvrira JAMAIS son lien avant le blocage : c'est avec elle qu'on vérifie que
  // le verrou tient encore. Si on réutilisait une employée déjà passée, son code serait
  // légitimement reconnu et le test ne prouverait rien.
  const jamaisVue = await creer("Sophie Inconnue");
  const employe = (code) => fetch(`${base}/api/employee/${code}`);

  // Tout part du même 127.0.0.1 : c'est exactement la situation du WiFi partagé.
  await t.test("Trycia ouvre son lien une première fois — tout va bien", async () => {
    assert.equal((await employe(trycia.access_code)).status, 200);
  });

  await t.test("le même mauvais lien réessayé quinze fois ne bloque personne", async () => {
    // Messenger coupe le lien en deux, l'employée s'obstine. Ce n'est pas une attaque.
    for (let i = 0; i < 15; i++) {
      assert.equal((await employe("TRONQ")).status, 404, `essai ${i}`);
    }
    assert.equal((await employe(trycia.access_code)).status, 200, "Trycia doit toujours entrer");
    assert.equal((await employe(nouvelle.access_code)).status, 200, "et une nouvelle aussi");
  });

  await t.test("dix codes DIFFÉRENTS bloquent bel et bien le WiFi", async () => {
    for (let i = 0; i < 12; i++) await employe(`FAUX${String(i).padStart(2, "0")}`);
    const refus = await employe("ENCOREUNAUTRE");
    assert.equal(refus.status, 429, "la force brute se fait bien arrêter");
    assert.ok(refus.headers.get("Retry-After"), "et on dit quand réessayer");
    assert.match((await refus.json()).error, /Trop de tentatives/);
  });

  await t.test("MAIS Trycia continue d'entrer, parce qu'elle est déjà passée", async () => {
    // C'est la correction. Avant, elle recevait 429 comme tout le monde.
    const rep = await employe(trycia.access_code);
    assert.equal(rep.status, 200, "son code a déjà servi depuis cette adresse");
    const corps = await rep.json();
    assert.equal(corps.employee.name, "Trycia Gagnon");
  });

  await t.test("en minuscules aussi — c'est le même code", async () => {
    assert.equal((await employe(trycia.access_code.toLowerCase())).status, 200);
  });

  await t.test("un code jamais utilisé ici attend la fin du blocage", async () => {
    // La limite qu'on assume : pendant un blocage, un code inconnu de cette adresse reçoit
    // la même réponse qu'un mauvais. Sans ça, l'attaquant aurait un « oui / non » à volonté.
    assert.equal((await employe(jamaisVue.access_code)).status, 429);
    // Et surtout : la MÊME réponse qu'un code bidon. C'est ce qui empêche l'attaquant de
    // distinguer un bon code d'un mauvais pendant qu'il est bloqué.
    const bidon = await employe("NIMPORTEQUOI");
    assert.equal(bidon.status, 429, "impossible de faire la différence");
  });

  await t.test("la porte de l'horaire n'a pas été refermée par celle des employés", async () => {
    const rep = await fetch(`${base}/api/schedule/by-code/${resto.schedule_code}`);
    assert.equal(rep.status, 200, "deux guichets, deux compteurs");
  });

  await t.test("la connexion par mot de passe reste protégée, elle", async () => {
    // Là, rien à vérifier avant d'essayer : chaque mauvais mot de passe est un vrai essai.
    for (let i = 0; i < 12; i++) {
      await fetch(`${base}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: `devine${i}` }),
      });
    }
    const refus = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: MOT_DE_PASSE }),
    });
    assert.equal(refus.status, 429, "le mot de passe, lui, se bloque toujours");
  });
});
