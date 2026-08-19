// Tests d'interface : démarrent le vrai serveur sur une base jetable et pilotent les pages
// dans un vrai navigateur, sans dépendance ajoutée au projet.
//
// Pourquoi ce fichier existe : toute la logique d'affichage vit dans public/*.html, en
// JavaScript en ligne — plusieurs milliers de lignes que rien ne couvrait. Les tests de
// tip-math.test.js vérifient les montants, pas ce que la page fait avec.
//
// Comment ça marche, sans playwright ni puppeteer : Chrome expose le protocole DevTools sur
// un port local, et Node 22 a un client WebSocket intégré. Une centaine de lignes suffisent
// donc à ouvrir une page, cliquer et lire le DOM — au prix de ne pas dépendre d'un paquet de
// 300 Mo qui doit télécharger son propre navigateur.
//
// Le fichier se saute tout seul, sans échouer, quand aucun Chrome n'est installé ou quand
// npm install n'a pas été fait : `npm test` reste utilisable sur une machine nue.
//
// Lancer seul : node --test test/ui-smoke.test.mjs
// Navigateur imposé : CHROME_PATH=/chemin/vers/chrome node --test test/ui-smoke.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOT_DE_PASSE = "motdepassedetest";

// ---------------------------------------------------------------- outils

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Réessaie jusqu'à ce que la condition tienne. Toujours préférable à une pause fixe : sur une
// machine lente une pause trop courte donne un échec qui n'a rien à voir avec le code testé.
async function jusqua(condition, { delai = 10000, pas = 100, quoi = "condition" } = {}) {
  const limite = Date.now() + delai;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > limite) throw new Error(`délai dépassé en attendant : ${quoi}`);
    await attendre(pas);
  }
}

function trouverNavigateur() {
  // Un chemin imposé est respecté tel quel : retomber en silence sur un autre navigateur
  // ferait passer le test sur une machine qui n'a pas celui qu'on voulait vérifier.
  const impose = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (impose) return existsSync(impose) ? impose : null;

  const candidats = [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);

  for (const chemin of candidats) if (existsSync(chemin)) return chemin;

  for (const nom of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
    try {
      const trouve = execFileSync("which", [nom], { encoding: "utf8" }).trim();
      if (trouve) return trouve;
    } catch {
      /* pas dans le PATH, on essaie le suivant */
    }
  }
  return null;
}

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

// ---------------------------------------------------------------- serveur

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
  try {
    await jusqua(
      async () => {
        if (proc.exitCode !== null) throw new Error(`le serveur s'est arrêté :\n${journal}`);
        try {
          return (await fetch(`${base}/admin`)).ok;
        } catch {
          return false;
        }
      },
      { delai: 15000, quoi: "le démarrage du serveur" }
    );
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
  return { proc, base };
}

// ---------------------------------------------------------------- navigateur

async function demarrerNavigateur(binaire, dossier) {
  const profil = path.join(dossier, "profil-chrome");
  const proc = spawn(
    binaire,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0", // le port réel est écrit dans DevToolsActivePort
      `--user-data-dir=${profil}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  const fichierPort = path.join(profil, "DevToolsActivePort");
  await jusqua(() => existsSync(fichierPort), { delai: 20000, quoi: "le démarrage du navigateur" });
  const port = readFileSync(fichierPort, "utf8").split("\n")[0].trim();
  return { proc, devtools: `http://127.0.0.1:${port}` };
}

// Un onglet piloté par le protocole DevTools.
async function ouvrirOnglet(devtools) {
  const cible = await (await fetch(`${devtools}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(cible.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const attentes = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && attentes.has(msg.id)) {
      attentes.get(msg.id)(msg);
      attentes.delete(msg.id);
    }
  });

  const envoyer = (methode, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      attentes.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method: methode, params }));
    });

  const onglet = {
    envoyer,
    fermer: () => ws.close(),

    // Évalue une expression dans la page et remonte l'exception s'il y en a une : sans ça,
    // une erreur de script se lirait comme « undefined » et enverrait sur une fausse piste.
    async ev(expression) {
      const r = await envoyer("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const pepin = r.result?.exceptionDetails;
      if (pepin) throw new Error(pepin.exception?.description || pepin.text);
      return r.result?.result?.value;
    },

    async taille(largeur, hauteur = 900) {
      await envoyer("Emulation.setDeviceMetricsOverride", {
        width: largeur,
        height: hauteur,
        deviceScaleFactor: 1,
        mobile: largeur < 600,
      });
    },

    async aller(url, selecteurAttendu) {
      await envoyer("Page.navigate", { url });
      await jusqua(
        async () => onglet.ev(`!!document.querySelector(${JSON.stringify(selecteurAttendu)})`),
        { delai: 20000, quoi: `l'affichage de ${selecteurAttendu}` }
      );
    },
  };

  await envoyer("Page.enable");
  await envoyer("Runtime.enable");
  await envoyer("Network.enable");
  // Les polices Google sont bloquantes au chargement : si la machine n'a pas Internet, la
  // page reste en « loading » et le test échouerait pour une raison sans rapport.
  await envoyer("Network.setBlockedURLs", {
    urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"],
  });
  return onglet;
}

// ---------------------------------------------------------------- mise en place

const navigateur = trouverNavigateur();
const dependancesPretes = existsSync(path.join(RACINE, "node_modules", "express"));
const raisonDeSauter = !dependancesPretes
  ? "npm install n'a pas été fait"
  : !navigateur
    ? "aucun Chrome/Chromium trouvé (CHROME_PATH pour l'imposer)"
    : null;

// La clé « skip » n'est posée que s'il y a vraiment une raison : node:test marque le test
// comme sauté dès que la clé existe, même avec une valeur vide.
const optionsDuTest = { timeout: 180000 };
if (raisonDeSauter) optionsDuTest.skip = raisonDeSauter;

test("interface", optionsDuTest, async (t) => {
  const dossier = mkdtempSync(path.join(tmpdir(), "declara-ui-"));
  const serveur = await demarrerServeur(dossier);
  const chrome = await demarrerNavigateur(navigateur, dossier);
  const onglet = await ouvrirOnglet(chrome.devtools);

  t.after(() => {
    onglet.fermer();
    chrome.proc.kill("SIGKILL");
    serveur.proc.kill("SIGKILL");
    rmSync(dossier, { recursive: true, force: true });
  });

  const api = (chemin, options = {}) =>
    fetch(`${serveur.base}${chemin}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": MOT_DE_PASSE,
        ...options.headers,
      },
    });

  // Ouvre /admin déjà authentifié : le jeton est le mot de passe lui-même, gardé dans
  // sessionStorage. Passer par l'écran de connexion ne testerait rien de plus ici.
  async function ouvrirAdmin() {
    await onglet.aller(`${serveur.base}/admin`, "#app");
    await onglet.ev(`sessionStorage.setItem("adminToken", ${JSON.stringify(MOT_DE_PASSE)})`);
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
  }

  const saisirDates = (debut, fin) =>
    onglet.ev(`(function () {
      var d = document.getElementById("customStart");
      var f = document.getElementById("customEnd");
      d.value = ${JSON.stringify(debut)};
      f.value = ${JSON.stringify(fin)};
      d.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

  const periodeActive = () =>
    onglet.ev(`(document.querySelector("[data-period].active") || {}).dataset ?
      document.querySelector("[data-period].active").dataset.period : null`);

  await onglet.taille(1000);
  await ouvrirAdmin();

  await t.test("« Appliquer » reste éteint tant que la plage est incomplète", async () => {
    assert.equal(await onglet.ev(`document.getElementById("customApply").disabled`), true);

    await saisirDates("2026-07-01", "");
    assert.equal(
      await onglet.ev(`document.getElementById("customApply").disabled`),
      true,
      "une seule date remplie ne devrait pas activer le bouton"
    );
    assert.equal(await onglet.ev(`document.getElementById("periodError").hidden`), true);
  });

  await t.test("des dates inversées affichent un message et bloquent le bouton", async () => {
    await saisirDates("2026-07-31", "2026-07-01");
    assert.equal(await onglet.ev(`document.getElementById("customApply").disabled`), true);
    assert.equal(await onglet.ev(`document.getElementById("periodError").hidden`), false);
    assert.match(
      await onglet.ev(`document.getElementById("periodError").textContent`),
      /date de début|start date/i
    );
  });

  await t.test("une plage valide active le bouton et efface le message", async () => {
    await saisirDates("2026-07-01", "2026-07-31");
    assert.equal(await onglet.ev(`document.getElementById("customApply").disabled`), false);
    assert.equal(await onglet.ev(`document.getElementById("periodError").hidden`), true);
  });

  await t.test("appliquer une plage rend le mode personnalisé visible", async () => {
    await onglet.ev(`document.getElementById("customApply").click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("customClear")`), {
      quoi: "le bouton d'effacement",
    });

    assert.equal(
      await onglet.ev(`document.querySelector(".period-dates").classList.contains("active")`),
      true,
      "le bloc de dates devrait être mis en évidence"
    );
    assert.equal(
      await periodeActive(),
      null,
      "aucune pastille de raccourci ne devrait rester active"
    );
    assert.match(await onglet.ev(`document.querySelector(".period-label").textContent`), /juillet|july/i);
  });

  await t.test("le bouton d'effacement ramène aux 2 dernières semaines", async () => {
    await onglet.ev(`document.getElementById("customClear").click()`);
    await jusqua(async () => (await periodeActive()) === "2w", { quoi: "le retour au raccourci" });
    assert.equal(await onglet.ev(`!!document.getElementById("customClear")`), false);
    assert.equal(await onglet.ev(`document.getElementById("customApply").disabled`), true);
  });

  await t.test("pastilles, champs et bouton ont la même hauteur", async () => {
    const hauteurs = await onglet.ev(`[
      document.querySelector(".period-btn").offsetHeight,
      document.getElementById("customStart").offsetHeight,
      document.getElementById("customApply").offsetHeight
    ]`);
    assert.equal(
      new Set(hauteurs).size,
      1,
      `les trois éléments devraient être alignés, obtenu ${hauteurs.join(" / ")}`
    );
  });

  await t.test("la période choisie survit au rechargement", async () => {
    await onglet.ev(`document.querySelector('[data-period="month"]').click()`);
    await jusqua(async () => (await periodeActive()) === "month", { quoi: "le changement de période" });
    assert.equal(
      await onglet.ev(`JSON.parse(localStorage.getItem("coco-period-admin")).mode`),
      "month"
    );

    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    assert.equal(await periodeActive(), "month", "la période devrait être relue au chargement");
  });

  await t.test("une valeur de période abîmée retombe sur le défaut", async () => {
    await onglet.ev(`localStorage.setItem("coco-period-admin", "{ pas du json")`);
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    assert.equal(await periodeActive(), "2w");

    // Une plage personnalisée sans ses deux bornes est inutilisable : même repli attendu.
    await onglet.ev(
      `localStorage.setItem("coco-period-admin", JSON.stringify({ mode: "custom", start: null, end: null }))`
    );
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    assert.equal(await periodeActive(), "2w");
  });

  await t.test("rien ne déborde sur un écran de téléphone", async () => {
    await onglet.taille(375, 800);
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    const [contenu, fenetre] = await onglet.ev(
      `[document.documentElement.scrollWidth, window.innerWidth]`
    );
    assert.ok(
      contenu <= fenetre,
      `la page mesure ${contenu} px de large pour une fenêtre de ${fenetre} px`
    );
    await onglet.taille(1000);
  });

  await t.test("la page employé garde aussi la période choisie", async () => {
    const resto = await (
      await api("/api/admin/restaurants", {
        method: "POST",
        body: JSON.stringify({ name: "Resto d'essai" }),
      })
    ).json();
    const employe = await (
      await api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: resto.id, name: "Camille" }),
      })
    ).json();

    const lien = `${serveur.base}/e/${employe.access_code}`;
    await onglet.aller(lien, "[data-period]");
    await onglet.ev(`localStorage.removeItem("coco-period")`);
    await onglet.aller(lien, "[data-period]");

    await onglet.ev(`document.querySelector('[data-period="all"]').click()`);
    await jusqua(async () => (await periodeActive()) === "all", { quoi: "le changement de période" });

    await onglet.aller(lien, "[data-period]");
    assert.equal(await periodeActive(), "all", "la période devrait être relue au chargement");
  });
});
