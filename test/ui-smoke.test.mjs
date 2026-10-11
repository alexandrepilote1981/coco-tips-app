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
    // Chrome écrit encore dans son profil à l'instant où on le tue, et le ménage échouait
    // alors sur ENOTEMPTY — un échec qui faisait rougir TOUT le fichier une fois sur six,
    // sans aucun rapport avec ce qui est testé. On laisse quelques essais, et on n'échoue
    // pas sur du ménage : les fichiers sont dans un dossier temporaire de toute façon.
    try {
      rmSync(dossier, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch {
      /* du temporaire qui survit quelques heures ne casse rien */
    }
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
    // L'onglet actif est gardé dans localStorage, exprès : un gérant qui monte son horaire
    // rafraîchit vingt fois. Mais entre deux tests, cette mémoire fait qu'un test qui finit
    // sur une grille d'horaire décide de l'écran d'entrée du suivant. On repart donc des
    // déclarations, qui sont ce que `.period-bar` ci-dessous attend.
    await onglet.ev(`localStorage.setItem("coco-onglet-admin", "declarations")`);
    // Même piège que l'onglet, et il vient de nous mordre : la période aussi vit dans
    // localStorage. Un test qui finit sur une paye décide de ce que le suivant voit, et le
    // suivant échoue sur du code juste. On repart de « tout l'historique », qui ne cache
    // rien ; les tests qui ont besoin d'une fenêtre la choisissent eux-mêmes.
    await onglet.ev(`localStorage.setItem("coco-period-admin", JSON.stringify({ mode: "all" }))`);
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

  await t.test("le bouton d'effacement ramène au défaut", async () => {
    // Le défaut était « 2 dernières semaines », une fenêtre glissante. C'est maintenant la
    // période de paye : le propriétaire a demandé de décoller le 2 semaines sur un lundi
    // fixe, pas d'en ajouter un à côté.
    await onglet.ev(`document.getElementById("customClear").click()`);
    await jusqua(async () => (await periodeActive()) === "paye", { quoi: "le retour au défaut" });
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
    assert.equal(await periodeActive(), "paye");

    // Une plage personnalisée sans ses deux bornes est inutilisable : même repli attendu.
    await onglet.ev(
      `localStorage.setItem("coco-period-admin", JSON.stringify({ mode: "custom", start: null, end: null }))`
    );
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    assert.equal(await periodeActive(), "paye");

    // Et l'ancien mode glissant bascule sur la paye plutôt que de repartir à zéro : le
    // gérant ne doit pas avoir à recliquer sur chacun de ses appareils.
    await onglet.ev(`localStorage.setItem("coco-period-admin", JSON.stringify({ mode: "2w" }))`);
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    assert.equal(await periodeActive(), "paye", "« 2 dernières semaines » enregistré doit devenir la paye");
    assert.equal(
      await onglet.ev(`!!document.querySelector('[data-period="2w"]')`),
      false,
      "le bouton glissant ne doit plus exister"
    );
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

  // Réutilisé par les tests de déclaration : crée un employé et rend son lien privé.
  async function creerEmploye(nom, secteur) {
    const resto = await (
      await api("/api/admin/restaurants", {
        method: "POST",
        body: JSON.stringify({ name: `Resto ${nom}` }),
      })
    ).json();
    const employe = await (
      await api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: resto.id, name: nom, secteur }),
      })
    ).json();
    return { restoId: resto.id, employe, lien: `${serveur.base}/e/${employe.access_code}` };
  }

  // Les journées sont repliées : une ligne chacune, qu'on ouvre d'une tape. Tout ce qui
  // touche aux champs d'une journée passe donc par là d'abord.
  async function ouvrirPremiereJournee(ou = "") {
    await jusqua(async () => onglet.ev(`!!document.querySelector("${ou} .jour-tete".trim())`), {
      quoi: "la ligne d'une journée",
    });
    await onglet.ev(`document.querySelector("${ou} .jour-tete".trim()).click()`);
    await jusqua(async () => onglet.ev(`!!document.querySelector("${ou} .day-body".trim())`), {
      quoi: "l'ouverture de la journée",
    });
  }

  await t.test("la serveuse peut envoyer sa déclaration, et la modifier l'annule", async () => {
    const { lien, employe } = await creerEmploye("Fatima");
    await onglet.aller(lien, "#addBtn");

    // Une journée neuve : le bouton d'envoi est là, rien n'est encore envoyé.
    await onglet.ev(`document.getElementById("addBtn").click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="submit"]')`), {
      quoi: "le bouton d'envoi",
    });
    assert.equal(
      await onglet.ev(`!!document.querySelector(".submitted-note")`),
      false,
      "rien ne devrait indiquer un envoi avant le clic"
    );

    // Elle remplit ses ventes, puis envoie.
    await onglet.ev(`(function () {
      var champ = document.querySelector('input[data-field="ventes"]');
      champ.value = "420";
      champ.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    // On attendait ici que le total de période affiche 420. Ces totaux ont été retirés de la
    // page — l'équipe ne s'en servait pas. On interroge donc directement le serveur, ce qui
    // est de toute façon la vraie preuve que la saisie est enregistrée : un chiffre à
    // l'écran peut venir d'un calcul local, une ligne en base non.
    await jusqua(
      async () => {
        const rep = await (await fetch(`${serveur.base}/api/employee/${employe.access_code}`)).json();
        return (rep.entries || []).some((e) => Number(e.ventes) === 420);
      },
      { quoi: "l'enregistrement des ventes" }
    );

    await onglet.ev(`document.querySelector('[data-action="submit"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".submitted-note")`), {
      quoi: "la confirmation d'envoi",
    });
    assert.match(
      await onglet.ev(`document.querySelector(".submitted-note").textContent`),
      /Envoyée le|Sent on/
    );
    assert.equal(
      await onglet.ev(`!!document.querySelector('[data-action="submit"]')`),
      false,
      "le bouton d'envoi ne devrait plus être proposé une fois la journée envoyée"
    );

    // Elle corrige un montant : la journée redevient à envoyer, et le dit.
    await onglet.ev(`(function () {
      var champ = document.querySelector('input[data-field="ventes"]');
      champ.value = "480";
      champ.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="submit"]')`), {
      quoi: "le retour du bouton d'envoi",
    });
    assert.equal(await onglet.ev(`!!document.querySelector(".submitted-note")`), false);
    assert.match(
      await onglet.ev(`document.querySelector(".submit-hint").textContent`),
      /depuis l'envoi|after sending/
    );

    // Après un rechargement, l'état vient du serveur : toujours à envoyer.
    await onglet.aller(lien, ".jour-tete");
    await ouvrirPremiereJournee();
    assert.equal(await onglet.ev(`!!document.querySelector('[data-action="submit"]')`), true);
    assert.equal(await onglet.ev(`!!document.querySelector(".submitted-note")`), false);
    assert.equal(
      await onglet.ev(`!!document.querySelector(".submit-hint")`),
      false,
      "le rappel « modifiée depuis l'envoi » ne survit pas au rechargement, par construction"
    );

    // Renvoyée : l'état tient cette fois au rechargement.
    await onglet.ev(`document.querySelector('[data-action="submit"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".submitted-note")`), { quoi: "le renvoi" });

    // Après rechargement, une journée envoyée n'est plus dans la liste ouverte : elle est
    // passée dans la section repliée. C'est ce qui garde la page courte, et c'est aussi ce
    // qui fait qu'on ne construit pas trois cents cartes pour rien.
    await onglet.aller(lien, "#toggleEnvoyees");
    assert.equal(
      await onglet.ev(`!!document.querySelector(".submitted-note")`),
      false,
      "repliée, la carte n'est même pas construite"
    );
    assert.match(
      await onglet.ev(`document.getElementById("toggleEnvoyees").textContent`),
      /Déjà envoyées \(1\)|Already sent \(1\)/
    );

    // Dépliée, elle est là, avec sa confirmation d'envoi.
    await onglet.ev(`document.getElementById("toggleEnvoyees").click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector("#sentList .day-card")`), { quoi: "le dépliage" });
    // Dépliée, la SECTION montre une ligne par journée ; la journée elle-même s'ouvre à part.
    await ouvrirPremiereJournee("#sentList");
    assert.equal(await onglet.ev(`!!document.querySelector(".submitted-note")`), true);
  });

  await t.test("le gérant voit quelles journées ont été envoyées", async () => {
    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="toggleReport"]')`), {
      quoi: "la liste des employés",
    });
    await onglet.ev(`document.querySelector('[data-action="toggleReport"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".sent-badge")`), {
      quoi: "la pastille d'envoi",
    });
    assert.match(
      await onglet.ev(`document.querySelector(".sent-badge").textContent`),
      /Envoyée|Sent/
    );
    assert.equal(
      await onglet.ev(`document.querySelector(".sent-badge").classList.contains("sent")`),
      true,
      "la journée envoyée devrait porter la pastille verte"
    );
  });

  await t.test("les pages survivent à un navigateur qui refuse le stockage", async () => {
    // Safari en navigation privée, ou « bloquer tous les témoins », fait lever une exception
    // au simple accès à localStorage. On reproduit le cas le plus dur : l'accès lui-même
    // échoue, avant même getItem. Une page qui n'y résiste pas reste blanche.
    const sabotage = await onglet.envoyer("Page.addScriptToEvaluateOnNewDocument", {
      source: `["localStorage", "sessionStorage"].forEach(function (zone) {
        Object.defineProperty(window, zone, {
          configurable: true,
          get: function () { throw new DOMException("Stockage bloqué", "SecurityError"); },
        });
      });`,
    });

    const { lien } = await creerEmploye("Nadia");
    // `aller` attend déjà #addBtn : si la page restait blanche, on n'arriverait pas ici.
    await onglet.aller(lien, "#addBtn");
    assert.equal(
      await onglet.ev(`!!document.querySelector(".dispo-card")`),
      true,
      "la page employé devrait s'afficher au complet malgré un stockage inaccessible"
    );
    // Et elle doit rester utilisable : déplier les disponibilités écrit dans l'état, pas
    // dans le stockage, donc ça doit marcher même ici.
    await onglet.ev(`document.getElementById("dispoToggle").click()`);
    await jusqua(() => onglet.ev(`document.querySelectorAll(".dispo-ligne").length === 7`), {
      quoi: "le tableau des disponibilités sans stockage",
    });

    await onglet.aller(`${serveur.base}/admin`, "#pw");
    assert.equal(
      await onglet.ev(`!!document.getElementById("loginBtn")`),
      true,
      "l'écran de connexion admin devrait s'afficher malgré un stockage inaccessible"
    );
    // La connexion écrit le jeton dans sessionStorage : elle doit aboutir quand même.
    await onglet.ev(`(function () {
      document.getElementById("pw").value = ${JSON.stringify(MOT_DE_PASSE)};
      document.getElementById("loginBtn").click();
    })()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".period-bar")`), {
      quoi: "le tableau de bord après connexion sans stockage",
    });

    await onglet.envoyer("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: sabotage.result.identifier,
    });
  });

  // Il y avait ici un test sur la période choisie qui survit au rechargement. Le sélecteur
  // de période a été retiré de la page employé : il ne servait qu'à cadrer des totaux
  // eux-mêmes retirés. Ce qui limite la longueur de la page, désormais, c'est le repli des
  // journées déjà envoyées — vérifié plus haut.

  await t.test("un cuisinier ouvre sa page, quart et tâche compris", async () => {
    // LE test de non-régression du pire bogue qu'on ait livré : pendant des jours, AUCUN
    // cuisinier ne pouvait ouvrir sa page. Son quart porte role = "cuisinier" ; la table des
    // postes de employee.html ne connaissait que la salle, lire [lang] sur un poste absent
    // levait une exception, et comme render() était appelé à l'intérieur du try de load(),
    // l'exception ressortait en « Connexion impossible ». Le serveur, lui, répondait 200 :
    // le message accusait le réseau pour un bogue d'affichage, et personne ne cherchait au
    // bon endroit. C'est pour ça que ce test regarde l'écran ET le contenu du quart.
    const { employe, lien } = await creerEmploye("Trycia", "cuisine");
    const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({
        employee_id: employe.id,
        date: demain,
        start_time: "05:30",
        end_time: "15:00",
        role: "cuisinier",
        note: "Prép",
      }),
    });

    await onglet.aller(lien, ".dispo-card");
    assert.equal(
      await onglet.ev(`!!document.querySelector(".error-box")`),
      false,
      "la page d'un cuisinier ne doit afficher aucun écran d'erreur"
    );

    const quart = await onglet.ev(`(document.querySelector(".day-pill.worked") || {}).innerText || ""`);
    assert.match(quart, /05:30/, "l'heure de début");
    assert.match(quart, /15:00/, "la cuisine finit à heure fixe : la fin doit s'afficher");
    assert.match(quart, /Cuisinier/, "le poste de cuisine doit être traduit, pas planter");
    assert.match(quart, /Prép/, "la tâche du quart");

    // Et rien de la salle : un cuisinier ne déclare pas de pourboires.
    assert.equal(await onglet.ev(`!!document.getElementById("addBtn")`), false, "pas de bouton Ajouter");
    assert.equal(await onglet.ev(`!!document.querySelector(".kpi-grid")`), false, "pas de tableau de ventes");
  });

  await t.test("les trois onglets ouvrent leur section, et la barre reste atteignable", async () => {
    // Le tableau de bord faisait onze écrans sur un téléphone : l'horaire de la cuisine
    // commençait à près de dix écrans du haut. Ce qui est vérifié ici, c'est surtout le
    // piège du découpage : les écouteurs des déclarations sont sous un garde, et sans lui
    // une grille s'afficherait sans répondre au doigt.
    await ouvrirAdmin();
    assert.equal(await onglet.ev(`document.querySelectorAll("[data-onglet]").length`), 3);
    assert.equal(
      await onglet.ev(`getComputedStyle(document.querySelector(".onglets")).position`),
      "sticky",
      "la barre doit rester collée en haut, sinon il faut remonter pour changer de section"
    );

    await onglet.ev(`document.querySelector('[data-onglet="cuisine"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".onglet.actif[data-onglet='cuisine']")`), {
      quoi: "l'onglet cuisine",
    });
    assert.equal(
      await onglet.ev(`!!document.querySelector(".period-bar")`),
      false,
      "les déclarations ne doivent plus être dans la page"
    );
    // Tout ce qui concerne la cuisine vit avec SON horaire. Le premier découpage avait
    // laissé l'équipe de cuisine — ses liens, ses taux, les charges — dans l'onglet des
    // déclarations, parce qu'il avait suivi la disposition de l'ancienne page au lieu du
    // sens. La cuisine ne déclare rien : elle n'a rien à faire là.
    assert.equal(
      await onglet.ev(`!!document.querySelector('[data-action="toggleCuisine"]')`),
      true,
      "l'équipe de cuisine doit être dans l'onglet de son horaire"
    );
    assert.equal(
      await onglet.ev(`!!document.querySelector(".chargesInput")`),
      true,
      "les charges de l'employeur nourrissent la masse salariale affichée ici"
    );

    // Le choix survit à un rechargement : un gérant qui monte son horaire rafraîchit
    // souvent, et repartir des déclarations lui referait le trajet à chaque fois.
    await onglet.aller(`${serveur.base}/admin`, ".onglets");
    assert.equal(
      await onglet.ev(`(document.querySelector(".onglet.actif") || {}).dataset.onglet`),
      "cuisine"
    );

    // Retour aux déclarations : la période doit être là ET répondre. C'est ce qui prouve
    // que les écouteurs sont rebranchés après un changement d'onglet.
    await onglet.ev(`document.querySelector('[data-onglet="declarations"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".period-bar")`), {
      quoi: "le retour des déclarations",
    });
    assert.equal(
      await onglet.ev(`!!document.querySelector('[data-action="toggleCuisine"]')`),
      false,
      "et elle ne doit pas rester en double dans les déclarations"
    );
    await onglet.ev(`document.querySelector('[data-period="month"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-period="month"].active')`), {
      quoi: "le bouton de période qui répond après un changement d'onglet",
    });

    // On repart des déclarations : les tests suivants passent par ouvrirAdmin(), qui
    // attend la barre de période.
    await onglet.ev(`localStorage.setItem("coco-onglet-admin", "declarations")`);
  });

  await t.test("un employé des deux bords voit UN horaire, et garde son formulaire", async () => {
    // La demande, mot pour mot : « dans son horaire à lui il voit une horaire avec toutes
    // ses chiffres cuisine et salle dans le même ». Le piège que ce test ferme : la page
    // décidait d'afficher l'heure de fin d'après le secteur de la PERSONNE. Pour quelqu'un
    // des deux bords, il n'y a pas de bonne réponse à cette question — c'est chaque QUART
    // qui a la sienne.
    const { employe, lien } = await creerEmploye("Trycia", "les_deux");
    const jour = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: employe.id, date: jour(1), start_time: "05:30", end_time: "15:00", role: "cuisinier", note: "Prép" }),
    });
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: employe.id, date: jour(2), start_time: "16:00", end_time: "23:00", role: "server" }),
    });

    await onglet.aller(lien, ".dispo-card");
    assert.equal(await onglet.ev(`!!document.querySelector(".error-box")`), false, "aucune erreur");

    const bande = await onglet.ev(`[...document.querySelectorAll(".day-pill.worked")].map(n => n.innerText).join(" | ")`);
    assert.match(bande, /05:30/, "son quart de cuisine");
    assert.match(bande, /15:00/, "la cuisine finit à heure fixe : la fin s'affiche");
    assert.match(bande, /Cuisinier/);
    assert.match(bande, /Prép/);
    assert.match(bande, /16:00/, "son quart de salle, dans la MÊME bande");
    assert.match(bande, /Serveur/);
    // Et surtout : le quart de SALLE n'a pas d'heure de fin. Une serveuse part quand la
    // salle est vide ; écrire 23:00 serait une promesse fausse.
    assert.doesNotMatch(bande, /23:00/, "un quart de salle ne montre jamais son heure de fin");

    // Il fait des pourboires dès qu'il met le pied sur le plancher : son formulaire reste.
    assert.equal(await onglet.ev(`!!document.getElementById("addBtn")`), true, "le bouton Ajouter doit rester");
  });

  await t.test("un double quart pose une question, et ne bloque rien", async () => {
    // « Mets l'avertissement de double quart, une alerte quand il est déjà cédulé ailleurs. »
    //
    // C'est une QUESTION, jamais un refus : un 05:30-15:00 en cuisine puis un souper en
    // salle, ça arrive. Ce test vérifie donc les deux moitiés — que la question sorte, et
    // qu'un « oui » enregistre bel et bien le quart.
    const { employe } = await creerEmploye("Noémie", "les_deux");
    const jour = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const LUNDI = jour(1);
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: employe.id, date: LUNDI, start_time: "05:30", end_time: "15:00", role: "cuisinier" }),
    });

    await ouvrirAdmin();
    // On interroge le module directement, avec le host que la page a déjà branché : ouvrir
    // la bonne case de la bonne grille dépendrait de la semaine affichée, ce qui rendrait le
    // test fragile sans rien vérifier de plus.
    const heures = await onglet.ev(`ScheduleUI.quartsAilleursLeMemeJour({
      employee_id: ${JSON.stringify(employe.id)}, date: ${JSON.stringify(LUNDI)}, role: "server"
    }).heures`);
    assert.equal(heures, 9.5, "la grille doit voir le quart de cuisine du même jour");

    // Et rien pour un jour libre : une question qui sort à tort finit par se faire cliquer
    // sans être lue.
    const rien = await onglet.ev(`ScheduleUI.quartsAilleursLeMemeJour({
      employee_id: ${JSON.stringify(employe.id)}, date: ${JSON.stringify(jour(5))}, role: "server"
    }).heures`);
    assert.equal(rien, 0);

    // La question est bien posée, et « oui » laisse passer : on remplace confirm() le temps
    // de l'enregistrement, puisqu'un vrai confirm bloquerait le navigateur sans tête.
    await onglet.ev(`(() => { window.__demandes = []; window.confirm = (m) => { window.__demandes.push(m); return true; }; return true; })()`);
    const resultat = await onglet.ev(`(async () => {
      const r = await fetch("/api/admin/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": ${JSON.stringify(MOT_DE_PASSE)} },
        body: JSON.stringify({ employee_id: ${JSON.stringify(employe.id)}, date: ${JSON.stringify(LUNDI)}, start_time: "16:00", end_time: "23:00", role: "server" }),
      });
      return r.status;
    })()`);
    assert.equal(resultat, 200, "le double quart doit rester possible");

    // Et la personne a bien ses deux quarts ce jour-là.
    const sesQuarts = await onglet.ev(`(async () => {
      const d = await (await fetch("/api/admin/shifts", { headers: { "X-Admin-Token": ${JSON.stringify(MOT_DE_PASSE)} } })).json();
      return d.shifts.filter(q => q.employee_id === ${JSON.stringify(employe.id)} && q.date === ${JSON.stringify(LUNDI)}).map(q => q.role).sort();
    })()`);
    assert.deepEqual(sesQuarts, ["cuisinier", "server"]);
  });

  await t.test("corriger une faute de frappe garde le code et le lien de la personne", async () => {
    // « Je vais-tu pouvoir ajouter les numéros d'employé en cuisine et en salle, genre onglet
    // modifier, des fois que je fais une erreur. »
    //
    // Avant : le numéro se saisissait à la création et plus jamais, le nom pas du tout. Une
    // faute de frappe obligeait à retirer la personne et à la recréer — ce qui lui donnait un
    // NOUVEAU code d'accès et cassait le lien qu'elle avait déjà reçu. C'est ça que ce test
    // protège, plus que le champ lui-même.
    const { employe } = await creerEmploye("Noemi jean");
    const codeAvant = employe.access_code;

    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="modifierEmploye"][data-emp="${employe.id}"]')`), {
      quoi: "le bouton Modifier",
    });
    await onglet.ev(`document.querySelector('[data-action="modifierEmploye"][data-emp="${employe.id}"]').click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("edit-nom-${employe.id}")`), { quoi: "le formulaire" });

    await onglet.ev(`(() => {
      document.getElementById("edit-nom-${employe.id}").value = "Noémie Jean";
      document.getElementById("edit-num-${employe.id}").value = "304";
      document.querySelector('[data-action="saveEdition"][data-emp="${employe.id}"]').click();
      return true;
    })()`);
    await jusqua(() => onglet.ev(`document.body.innerText.includes("Noémie Jean")`), { quoi: "le nom corrigé" });

    const fiche = await onglet.ev(`(() => {
      const c = document.getElementById("emp-card-${employe.id}");
      return { titre: c.querySelector(".fiche-nom").innerText, texte: c.innerText };
    })()`);
    assert.match(fiche.titre, /Noémie Jean/);
    assert.match(fiche.titre, /#\s*304/, "le numéro doit s'afficher");

    // LE point du test : le code n'a pas bougé, donc le lien déjà envoyé marche encore.
    assert.ok(fiche.texte.includes(codeAvant), "le code d'accès ne doit pas changer");
    const apres = await (await api(`/api/employee/${codeAvant}`)).json();
    assert.equal(apres.employee.name, "Noémie Jean");
    assert.equal(apres.employee.employee_number, "304");

    // Et le formulaire s'est bien refermé.
    assert.equal(await onglet.ev(`!!document.getElementById("edit-nom-${employe.id}")`), false);
  });

  await t.test("un nom vidé par erreur est refusé plutôt qu'enregistré", async () => {
    // Un nom vide effacerait la personne de toutes les listes sans rien dire.
    const { employe } = await creerEmploye("Samuel Roy");
    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="modifierEmploye"][data-emp="${employe.id}"]')`), {
      quoi: "le bouton Modifier",
    });
    await onglet.ev(`(() => { window.__alertes = []; window.alert = (m) => window.__alertes.push(m); return true; })()`);
    await onglet.ev(`document.querySelector('[data-action="modifierEmploye"][data-emp="${employe.id}"]').click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("edit-nom-${employe.id}")`), { quoi: "le formulaire" });
    await onglet.ev(`(() => {
      document.getElementById("edit-nom-${employe.id}").value = "   ";
      document.querySelector('[data-action="saveEdition"][data-emp="${employe.id}"]').click();
      return true;
    })()`);
    await jusqua(() => onglet.ev(`(window.__alertes || []).length > 0`), { quoi: "le refus" });
    const apres = await (await api(`/api/employee/${employe.access_code}`)).json();
    assert.equal(apres.employee.name, "Samuel Roy", "le nom ne doit pas avoir bougé");
  });

  await t.test("les fiches sont repliées, et l'alerte d'argent ouvre la bonne", async () => {
    // « J'imagine que quand je reçois une alerte d'argent, ça m'amène direct à la bonne
    // place ? » — c'est précisément ce que le repli risquait de casser. Un clic qui amène
    // sur une ligne fermée se lit comme un bouton qui ne fait rien.
    const { employe, restoId, lien } = await creerEmploye("Rosalie Hébert");

    // Une journée qui laisse un virement dû : c'est ce qui fait apparaître le bandeau.
    const hier = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    await onglet.aller(lien, "#addBtn");
    const entree = await (await api(`/api/employee/${employe.access_code}/entries`, {
      method: "POST",
      // Le virement dû est posé explicitement : sans lui, le bandeau d'argent n'apparaîtrait
      // pas et le test passerait en ne vérifiant rien.
      body: JSON.stringify({ date: hier, ventes: 900, clients: 30, pct: 15, remis: 0, remit_direction: "employer_owes", remit_amount: 120 }),
    })).json();
    assert.ok(entree.id, "la journée doit être créée");

    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`!!document.querySelector(".fiche-entete")`), { quoi: "les fiches repliées" });

    // Repliée par défaut : le corps est caché, mais le nom et l'argent restent lisibles.
    const etat = await onglet.ev(`(() => {
      const c = document.getElementById("emp-card-${employe.id}");
      return {
        corpsCache: getComputedStyle(c.querySelector(".fiche-corps")).display === "none",
        nom: c.querySelector(".fiche-nom").innerText,
        resume: c.querySelector(".fiche-resume").innerText.trim(),
      };
    })()`);
    assert.equal(etat.corpsCache, true, "la fiche doit être repliée par défaut");
    assert.match(etat.nom, /Rosalie Hébert/, "le nom reste visible replié");
    assert.ok(etat.resume.length > 0, "et le montant aussi — c'est ce qu'on vient chercher");

    // LE test : la pastille du bandeau d'argent ouvre la fiche.
    await jusqua(
      () => onglet.ev(`!!document.querySelector('[data-action="jumpToEmployee"][data-emp="${employe.id}"]')`),
      { quoi: "la pastille du bandeau d'argent" }
    );
    await onglet.ev(`document.querySelector('[data-action="jumpToEmployee"][data-emp="${employe.id}"]').click()`);
    await jusqua(
      () => onglet.ev(`getComputedStyle(document.querySelector("#emp-card-${employe.id} .fiche-corps")).display !== "none"`),
      { quoi: "la fiche ouverte par l'alerte" }
    );
    // Et le détail par jour est déplié du même coup : l'alerte parle d'une journée précise.
    assert.equal(
      await onglet.ev(`getComputedStyle(document.getElementById("report-${employe.id}")).display !== "none"`),
      true,
      "le tableau du détail doit être ouvert"
    );

    // Le repli se manœuvre aussi à la main, dans les deux sens.
    const estOuverte = () =>
      onglet.ev(`getComputedStyle(document.querySelector("#emp-card-${employe.id} .fiche-corps")).display !== "none"`);
    const basculer = () =>
      onglet.ev(`document.querySelector('[data-action="toggleFiche"][data-emp="${employe.id}"]').click()`);

    await basculer();
    await jusqua(async () => (await estOuverte()) === false, { quoi: "la fiche refermée" });
    await basculer();
    await jusqua(estOuverte, { quoi: "la fiche rouverte" });
  });

  await t.test("un virement dû reste atteignable même après un changement d'équipe", async () => {
    // Trouvé en répondant à « il y en a côté salle ? » : déplacer une serveuse vers la
    // cuisine la sortait de la liste des déclarations, mais ses journées déclarées restent —
    // donc sa pastille aussi, dans le bandeau des virements dus. Elle pointait alors vers
    // une fiche qui n'existait plus : le clic ne faisait rien, et les 175 $ dus ne pouvaient
    // PLUS JAMAIS être marqués comme virés. Un bandeau qui réclame de l'argent doit toujours
    // mener quelque part.
    const { employe } = await creerEmploye("Ex Serveuse");
    const hier = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    await api(`/api/employee/${employe.access_code}/entries`, {
      method: "POST",
      body: JSON.stringify({ date: hier, ventes: 900, clients: 30, pct: 15, remis: 0, remit_direction: "employer_owes", remit_amount: 175 }),
    });
    await api(`/api/admin/employees/${employe.id}`, { method: "POST", body: JSON.stringify({ secteur: "cuisine" }) });

    await ouvrirAdmin();
    await jusqua(
      () => onglet.ev(`!!document.querySelector('[data-action="jumpToEmployee"][data-emp="${employe.id}"]')`),
      { quoi: "la pastille du virement dû" }
    );
    assert.equal(
      await onglet.ev(`!!document.getElementById("emp-card-${employe.id}")`),
      true,
      "sa fiche doit rester tant qu'il lui reste une journée déclarée"
    );

    // Et la pastille mène bien quelque part.
    await onglet.ev(`document.querySelector('[data-action="jumpToEmployee"][data-emp="${employe.id}"]').click()`);
    await jusqua(
      () => onglet.ev(`getComputedStyle(document.querySelector("#emp-card-${employe.id} .fiche-corps")).display !== "none"`),
      { quoi: "la fiche ouverte par la pastille" }
    );
    // Le bouton qui solde le virement est là : c'est la seule chose qui compte vraiment.
    assert.equal(
      await onglet.ev(`!!document.querySelector('[data-action="markTransferred"]')`),
      true,
      "le virement doit pouvoir être marqué comme viré"
    );
  });

  await t.test("les boutons d'une fiche ne se mettent pas en colonne sur un grand écran", async () => {
    // « Tu as une énorme perte d'espace, pourquoi c'est laid comme ça ? » — et c'était vrai.
    // Les quatre boutons d'action étaient en flex-direction: column QUELLE QUE SOIT la
    // largeur. Sur une tablette, la colonne devenait plus haute que le texte à sa gauche et
    // la carte se retrouvait à moitié vide. Ça ne se voyait pas en testant au téléphone.
    const { employe } = await creerEmploye("Marie-Eve Mainville");
    await onglet.taille(1024);
    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="toggleFiche"][data-emp="${employe.id}"]')`), {
      quoi: "la fiche",
    });
    await onglet.ev(`document.querySelector('[data-action="toggleFiche"][data-emp="${employe.id}"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector("#emp-card-${employe.id} .employee-row-actions")`), {
      quoi: "les boutons de la fiche",
    });

    const mesures = await onglet.ev(`(() => {
      const zone = document.querySelector("#emp-card-${employe.id} .employee-row-actions");
      const boutons = [...zone.children].map((n) => Math.round(n.getBoundingClientRect().top));
      return { hauteur: Math.round(zone.getBoundingClientRect().height), lignes: new Set(boutons).size, combien: boutons.length };
    })()`);
    // Ce qu'on interdit, c'est la COLONNE — chaque bouton sur sa propre ligne. Exiger une
    // ligne unique serait fragile : le nombre de boutons et la longueur d'une adresse
    // changent, et le test casserait pour une raison qui n'a rien à voir.
    assert.ok(
      mesures.lignes < mesures.combien,
      `${mesures.combien} boutons sur ${mesures.lignes} lignes : ils sont en colonne`
    );
    assert.ok(mesures.hauteur < 80, `la rangée devrait rester basse, elle fait ${mesures.hauteur}px`);

    // Sur un téléphone ils ont le droit de passer à la ligne — c'est même le but. La seule
    // chose interdite reste la même : un bouton par ligne.
    await onglet.taille(390);
    await jusqua(async () => (await onglet.ev(`window.innerWidth`)) === 390, { quoi: "la largeur téléphone" });
    const surTel = await onglet.ev(`(() => {
      const zone = document.querySelector("#emp-card-${employe.id} .employee-row-actions");
      if (!zone) return null;
      const tops = [...zone.children].map((n) => Math.round(n.getBoundingClientRect().top));
      return { lignes: new Set(tops).size, combien: tops.length };
    })()`);
    if (surTel) {
      assert.ok(
        surTel.lignes < surTel.combien,
        `${surTel.combien} boutons sur ${surTel.lignes} lignes : ils sont en colonne même au téléphone`
      );
    }
    await onglet.taille(1000);
  });

  await t.test("deux fiches sous le même numéro : un seul horaire sur sa page", async () => {
    // La façon de travailler du propriétaire. Ce que ce test regarde, c'est ce que la
    // personne voit : un seul horaire, ses deux sortes de quarts dedans, et une ligne qui
    // dit pourquoi — sans elle, voir apparaître des quarts qu'on n'a jamais reçus par ce
    // lien-là ressemble à une erreur.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Jumelage" }),
    })).json();
    const creer = (nom, secteur) =>
      api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: resto.id, name: nom, employee_number: "120", secteur }),
      }).then((r) => r.json());
    const cotéSalle = await creer("Marie-Eve Mainville", "salle");
    const cotéCuisine = await creer("Marie-Eve Mainville", "cuisine");

    const jour = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: cotéCuisine.id, date: jour(1), start_time: "05:30", end_time: "15:00", role: "cuisinier", note: "Prép" }),
    });
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: cotéSalle.id, date: jour(2), start_time: "16:00", end_time: "23:00", role: "server" }),
    });

    // Par son lien de SALLE — celui où elle déclare ses pourboires.
    await onglet.aller(`${serveur.base}/e/${cotéSalle.access_code}`, ".dispo-card");
    assert.equal(await onglet.ev(`!!document.querySelector(".error-box")`), false);

    const bande = await onglet.ev(`[...document.querySelectorAll(".day-pill.worked")].map(n => n.innerText).join(" | ")`);
    assert.match(bande, /05:30/, "son quart de cuisine, venu de l'AUTRE fiche");
    assert.match(bande, /15:00/, "avec son heure de fin");
    assert.match(bande, /Cuisinier/);
    assert.match(bande, /Prép/);
    assert.match(bande, /16:00/, "et son quart de salle, dans la même bande");
    assert.match(bande, /Serveur/);
    assert.doesNotMatch(bande, /23:00/, "un quart de salle ne montre jamais son heure de fin");

    // La ligne qui explique d'où vient l'horaire.
    assert.match(
      await onglet.ev(`(document.querySelector(".swipe-hint") || {}).textContent || ""`),
      /cuisine et salle/i,
      "la page doit dire que l'horaire réunit les deux"
    );

    // Elle garde son formulaire de déclaration : sa fiche de salle est celle qui déclare.
    assert.equal(await onglet.ev(`!!document.getElementById("addBtn")`), true);

    // Et par son lien de CUISINE, le même horaire complet.
    await onglet.aller(`${serveur.base}/e/${cotéCuisine.access_code}`, ".dispo-card");
    const bandeCuisine = await onglet.ev(`[...document.querySelectorAll(".day-pill.worked")].map(n => n.innerText).join(" | ")`);
    assert.match(bandeCuisine, /05:30/);
    assert.match(bandeCuisine, /16:00/, "son quart de salle apparaît aussi par le lien cuisine");
    // Celle-là est une fiche de cuisine : pas de formulaire de pourboires.
    assert.equal(await onglet.ev(`!!document.getElementById("addBtn")`), false);
  });

  await t.test("le double quart se voit AUSSI entre deux fiches du même numéro", async () => {
    // Le cas exact rapporté par le propriétaire : « Try était cédulée mardi cuisine. Je l'ai
    // ajoutée serveuse et ça rien fait. » Ses deux fiches portent le même matricule mais ont
    // des id différents, et l'avertissement ne cherchait que l'id de la fiche ouverte.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Double" }),
    })).json();
    const creer = (secteur) =>
      api("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: resto.id, name: "Trycia Dufour", employee_number: "113", secteur }),
      }).then((r) => r.json());
    const cuisine = await creer("cuisine");
    const salle = await creer("salle");
    const seule = await (await api("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: "Sarah Côté", employee_number: "121", secteur: "salle" }),
    })).json();

    const mardi = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })();
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: cuisine.id, date: mardi, start_time: "05:30", end_time: "15:00", role: "cuisinier" }),
    });

    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`typeof ScheduleUI !== "undefined" && !!ScheduleUI.quartsAilleursLeMemeJour`), {
      quoi: "la grille",
    });

    // Ajouter un quart de SALLE le même jour, sur son autre fiche : l'avertissement doit sortir.
    const vu = await onglet.ev(`ScheduleUI.quartsAilleursLeMemeJour({
      employee_id: ${JSON.stringify(salle.id)}, date: ${JSON.stringify(mardi)}, role: "server"
    }).heures`);
    assert.equal(vu, 9.5, "son quart de cuisine du même jour doit être vu depuis sa fiche de salle");

    // Et l'inverse : depuis la cuisine, si on l'ajoutait en salle d'abord.
    await api("/api/admin/shifts", {
      method: "POST",
      body: JSON.stringify({ employee_id: salle.id, date: mardi, start_time: "16:00", end_time: "23:00", role: "server" }),
    });
    await ouvrirAdmin();
    await jusqua(() => onglet.ev(`typeof ScheduleUI !== "undefined" && !!ScheduleUI.quartsAilleursLeMemeJour`), { quoi: "la grille" });
    assert.equal(
      await onglet.ev(`ScheduleUI.quartsAilleursLeMemeJour({
        employee_id: ${JSON.stringify(cuisine.id)}, date: ${JSON.stringify(mardi)}, role: "cuisinier"
      }).heures`),
      7,
      "et son quart de salle doit être vu depuis sa fiche de cuisine"
    );

    // Quelqu'un d'autre n'attrape rien : un rapprochement à tort serait pire que rien.
    assert.equal(
      await onglet.ev(`ScheduleUI.quartsAilleursLeMemeJour({
        employee_id: ${JSON.stringify(seule.id)}, date: ${JSON.stringify(mardi)}, role: "server"
      }).heures`),
      0
    );
  });

  await t.test("chaque poste porte sa couleur, et les alertes rouges restent les plus fortes", async () => {
    // Deux moitiés, et la seconde compte autant que la première. La couleur du poste passe
    // par une BARRE sur le côté et non par le fond de la case : mesuré en maquette, les
    // quatre couleurs dans le fond noyaient complètement la colonne rouge d'un férié. On
    // vérifie donc que la barre est là ET que le fond reste neutre.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Couleurs" }),
    })).json();
    const creer = (nom, secteur) =>
      api("/api/admin/employees", { method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: nom, secteur }) })
        .then((r) => r.json());
    const serveuse = await creer("Une Serveuse", "salle");
    const hotesse = await creer("Une Hotesse", "salle");
    const cuisinier = await creer("Un Cuisinier", "cuisine");
    const plongeur = await creer("Un Plongeur", "cuisine");
    // AUJOURD'HUI, et pas « demain ». La grille montre la semaine en cours, du lundi au
    // dimanche : un dimanche, demain tombe dans la semaine SUIVANTE et aucune pastille
    // n'apparaît. Le test mourait donc un jour sur sept — et comme il meurt après avoir
    // changé d'onglet, l'onglet actif reste en mémoire (`coco-onglet-admin`) et les deux
    // tests suivants, qui attendent la barre de période des déclarations, tombaient avec lui.
    // Aujourd'hui est dans la semaine affichée tous les jours de l'année.
    const jour = new Date().toISOString().slice(0, 10);
    for (const [emp, role] of [[serveuse, "server"], [hotesse, "hostess"],
                               [cuisinier, "cuisinier"], [plongeur, "plongeur"]]) {
      await api("/api/admin/shifts", {
        method: "POST",
        body: JSON.stringify({ employee_id: emp.id, date: jour, start_time: "09:00", end_time: "17:00", role }),
      });
    }

    // On ouvre par les déclarations — ouvrirAdmin() attend la barre de période, qui n'existe
    // que là — puis on passe à l'horaire de salle par son onglet.
    await ouvrirAdmin();
    await onglet.ev(`document.querySelector('[data-onglet="salle"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".shift-chip")`), { quoi: "la grille de salle" });

    const lireLesBarres = (classes) => onglet.ev(`(() => {
      const chips = [...document.querySelectorAll(".shift-chip")];
      const lire = (cls) => {
        const c = chips.find((n) => n.classList.contains(cls));
        if (!c) return null;
        return { barre: getComputedStyle(c, "::before").backgroundColor, fond: getComputedStyle(c).backgroundColor };
      };
      return Object.fromEntries(${JSON.stringify(classes)}.map((c) => [c, lire("poste-" + c)]));
    })()`);

    const vu = await lireLesBarres(["server", "hostess"]);
    assert.ok(vu.server, "un quart de Serveur doit porter sa classe");
    assert.ok(vu.hostess, "un quart d'Hôtesse doit porter sa classe");
    assert.equal(vu.server.fond, vu.hostess.fond, "le fond, lui, reste le même — il appartient aux alertes");

    // Le fond doit être neutre, donc sans dominante : aucune composante ne se détache.
    const [r, v, b] = vu.server.fond.match(/\d+/g).map(Number);
    assert.ok(Math.max(r, v, b) - Math.min(r, v, b) < 12, `le fond d'une case doit rester neutre, il est rgb(${r},${v},${b})`);

    // L'autre moitié vit dans la grille de CUISINE : une grille ne montre jamais les quatre
    // postes à la fois, donc il faut aller chercher les deux autres là où ils s'affichent.
    await onglet.ev(`document.querySelector('[data-onglet="cuisine"]').click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".shift-chip.poste-plongeur")`), {
      quoi: "la grille de cuisine",
    });
    Object.assign(vu, await lireLesBarres(["cuisinier", "plongeur"]));
    assert.ok(vu.cuisinier && vu.plongeur, "les deux postes de cuisine doivent porter leur classe");

    // Et surtout : aucune PAIRE de postes ne doit se ressembler. C'est ce que le
    // propriétaire a vu avant nous — « les couleurs dans la cuisine sont trop
    // ressemblantes » : le Cuisinier en or et le Plongeur en cuivre étaient deux oranges,
    // et dans une barre de 4 px ça fait une seule couleur. Une simple distance RVB suffit
    // à attraper deux jumelles ; l'ancienne paire était à 44, la plus serrée aujourd'hui
    // (vert et bleu) est à plus de 80.
    const rvb = (s) => s.match(/\d+/g).map(Number);
    const ecart = (a, b) => Math.hypot(...rvb(a).slice(0, 3).map((n, i) => n - rvb(b)[i]));
    const postes = ["server", "hostess", "cuisinier", "plongeur"];
    for (let i = 0; i < postes.length; i++) {
      for (let j = i + 1; j < postes.length; j++) {
        const d = ecart(vu[postes[i]].barre, vu[postes[j]].barre);
        assert.ok(d >= 70, `${postes[i]} et ${postes[j]} se ressemblent trop (écart ${Math.round(d)})`);
      }
    }

    await onglet.ev(`localStorage.setItem("coco-onglet-admin", "declarations")`);
  });

  await t.test("l'export CSV ne sort que ceux qui ont déclaré, et un seul sens par colonne", async () => {
    // Quatre défauts rapportés en lisant le vrai rapport dans Numbers, sur un iPad :
    // tout l'effectif listé en lignes de zéros, le numéro d'employé perdu sur les
    // sous-totaux, une colonne « Moy./client » qui voulait dire deux choses, et un
    // sous-total pour quelqu'un qui n'a qu'une journée.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Export" }),
    })).json();
    const creer = (nom, numero, secteur) => api("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: nom, employee_number: numero, secteur }),
    }).then((r) => r.json());

    const bavarde = await creer("Bea Bavarde", "77", "salle");   // trois journées
    const unique = await creer("Uma Unique", "88", "salle");     // une seule
    await creer("Zoe Zero", "99", "salle");                      // aucune
    await creer("Carl Cuisine", "66", "cuisine");                // ne déclare jamais

    const declarer = (emp, date, ventes, clients) =>
      fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, ventes, clients, pct: 10, remis: 0 }),
      });
    await declarer(bavarde, "2026-09-21", 400, 20);
    await declarer(bavarde, "2026-09-22", 600, 30);
    await declarer(bavarde, "2026-09-23", 500, 25);
    await declarer(unique, "2026-09-21", 300, 10);

    await ouvrirAdmin();
    // La période par défaut ne couvre pas septembre 2026 : on la cadre à la main.
    await saisirDates("2026-09-01", "2026-09-30");
    await onglet.ev(`document.getElementById("customApply").click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("customClear")`), { quoi: "la période appliquée" });

    // On attrape le CSV au vol plutôt que de le laisser se télécharger.
    const csv = await onglet.ev(`(async () => {
      let attrape = null;
      const vraiUrl = URL.createObjectURL;
      const vraiClic = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (blob) => { attrape = blob; return "blob:faux"; };
      HTMLAnchorElement.prototype.click = function () {};
      try {
        exportCSV();
        return attrape ? await attrape.text() : null;
      } finally {
        URL.createObjectURL = vraiUrl;
        HTMLAnchorElement.prototype.click = vraiClic;
      }
    })()`);

    assert.ok(csv, "le CSV doit avoir été produit");
    const lignes = csv.split("\r\n").filter(Boolean);

    // 1. Personne sans déclaration n'apparaît — ni la cuisine, ni la serveuse à zéro.
    assert.ok(!/Carl Cuisine/.test(csv), "un cuisinier ne déclare rien : aucune ligne");
    assert.ok(!/Zoe Zero/.test(csv), "une serveuse sans déclaration n'a pas de ligne non plus");

    // 2. Le sous-total porte le numéro d'employé ET le restaurant.
    const sousTotal = lignes.find((l) => l.includes("SOUS-TOTAL Bea Bavarde"));
    assert.ok(sousTotal, "la personne à trois journées doit avoir un sous-total");
    const champs = sousTotal.split(",");
    assert.match(champs[0], /Resto Export/, "le restaurant suit le sous-total");
    assert.equal(champs[2].replace(/"/g, ""), "77", "le numéro d'employé aussi");

    // 3. « Moy./client » veut dire la même chose partout : ventes ÷ clients.
    // Bea : 1 500 $ sur 75 clients = 20,00 $.
    assert.equal(champs[10].replace(/"/g, ""), "20.00", `moyenne du sous-total, ligne reçue : ${sousTotal}`);
    const totalResto = lignes.find((l) => l.includes("TOTAL RESTAURANT")).split(",");
    // 1 500 + 300 = 1 800 $ sur 85 clients = 21,18 $.
    assert.equal(totalResto[10].replace(/"/g, ""), "21.18");

    // 4. Une seule journée ne produit pas de sous-total qui la répète.
    assert.ok(!/SOUS-TOTAL Uma Unique/.test(csv), "un sous-total d'une seule ligne ne totalise rien");
    assert.ok(/Uma Unique/.test(csv), "mais sa journée, elle, est bien là");

    await onglet.ev(`document.getElementById("customClear").click()`);
  });

  await t.test("le résumé : une ligne par personne, et l'argent enfin totalisé", async () => {
    // « C'est trop lourd toutes les journées » — sur une semaine normale, le détaillé fait
    // 84 lignes. Et les colonnes d'argent n'étaient totalisées nulle part : il fallait
    // additionner à la main pour savoir combien virer à qui.
    //
    // L'autre moitié du test porte sur les hôtesses : « les hôtes n'ont pas de client ».
    // Sur une journée d'hôtesse, `ventes` contient le MONTANT REÇU DES SERVEUSES, pas des
    // ventes — et ça se faisait additionner aux ventes du restaurant.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Resume" }),
    })).json();
    const creer = (nom, numero) => api("/api/admin/employees", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: nom, employee_number: numero, secteur: "salle" }),
    }).then((r) => r.json());

    const serveuse = await creer("Sara Serveuse", "41");
    const hotesse = await creer("Hugo Hotesse", "42");

    const declarer = (emp, corps) =>
      fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
      }).then((r) => r.json());

    // Deux journées de service : 1 000 $ sur 50 clients, 10 % de pourboire, 40 $ remis.
    await declarer(serveuse, { date: "2026-09-21", ventes: 600, clients: 30, pct: 10, remis: 40 });
    const avecDette = await declarer(serveuse, {
      date: "2026-09-22", ventes: 400, clients: 20, pct: 10, remis: 0,
      remit_direction: "employer_owes", remit_amount: 90,
    });
    // Une journée d'hôtesse : 40 $ reçus, aucun client, et un montant qu'ELLE me doit.
    await declarer(hotesse, {
      date: "2026-09-21", ventes: 40, clients: 0, pct: 100, remis: 0, is_hotesse: 1,
      remit_direction: "employee_owes", remit_amount: 15,
    });
    // Et un dû déjà réglé : il ne doit plus paraître dans « reste à virer ».
    const regle = await declarer(hotesse, {
      date: "2026-09-22", ventes: 25, clients: 0, pct: 100, remis: 0, is_hotesse: 1,
      remit_direction: "employer_owes", remit_amount: 30,
    });
    await api(`/api/admin/entries/${regle.id}/transferred`, {
      method: "POST", body: JSON.stringify({ transferred: true, transfer_date: "2026-09-28" }),
    });

    await ouvrirAdmin();
    await saisirDates("2026-09-01", "2026-09-30");
    await onglet.ev(`document.getElementById("customApply").click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("customClear")`), { quoi: "la période" });

    const csv = await onglet.ev(`(async () => {
      let b = null; const u = URL.createObjectURL, c = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (x) => { b = x; return "blob:faux"; };
      HTMLAnchorElement.prototype.click = function () {};
      try { exportResumeCSV(); return b ? await b.text() : null; }
      finally { URL.createObjectURL = u; HTMLAnchorElement.prototype.click = c; }
    })()`);

    // Les tests précédents ont créé d'autres restaurants, qui ont eux aussi leur ligne
    // « TOTAL RESTAURANT » : on cherche toujours DANS les lignes de celui-ci.
    const champs = (motif) => {
      const ligne = csv.split("\r\n").find((l) => l.includes("Resto Resume") && l.includes(motif));
      assert.ok(ligne, `ligne « ${motif} » introuvable dans :\n${csv}`);
      return ligne.split(",").map((c) => c.replace(/^"|"$/g, ""));
    };

    // Une seule ligne par personne : pas de ligne par journée.
    assert.equal(csv.split("\r\n").filter((l) => l.includes("Sara Serveuse")).length, 1);

    const sara = champs("Sara Serveuse");
    assert.equal(sara[3], "2", "deux journées");
    assert.equal(sara[4], "1000.00", "ses ventes");
    assert.equal(sara[5], "50", "ses clients");
    assert.equal(sara[11], "20.00", "1 000 $ sur 50 clients");
    assert.equal(sara[12], "90.00", "je lui dois");
    assert.equal(sara[13], "0.00", "rien de viré");
    assert.equal(sara[14], "90.00", "il reste 90 $ à virer");

    const hugo = champs("Hugo Hotesse");
    assert.equal(hugo[4], "—", "une hôtesse n'a pas de ventes");
    assert.equal(hugo[5], "—", "ni de clients — c'est le point soulevé");
    assert.equal(hugo[11], "—", "donc pas de moyenne par client non plus");
    assert.equal(hugo[8], "65.00", "ce qu'elle a reçu vit dans SA colonne : 40 + 25");
    assert.equal(hugo[10], "65.00", "et c'est bien son pourboire net");
    assert.equal(hugo[13], "30.00", "les 30 $ déjà virés");
    assert.equal(hugo[14], "0.00", "donc plus rien à virer");
    assert.equal(hugo[15], "15.00", "et elle me doit 15 $");

    // Le total du restaurant : les montants d'hôtesse NE sont PAS des ventes.
    const total = champs("TOTAL RESTAURANT");
    assert.equal(total[4], "1000.00", "les 65 $ reçus par l'hôtesse ne sont pas des ventes");
    assert.equal(total[5], "50", "et elle n'ajoute aucun client");
    assert.equal(total[6], "10.0", "le % moyen reste celui du service, pas 100 % gonflé par l'hôtesse");
    assert.equal(total[14], "90.00", "90 à virer en tout");
    assert.equal(total[15], "15.00", "15 qu'on me doit");

    await onglet.ev(`document.getElementById("customClear").click()`);
  });

  await t.test("DEUX corrections d'affilée, et non une seule", async () => {
    // Le bogue vécu, rapporté ainsi : « ça marchait pour un mais l'autre que j'ai voulu
    // modifier ça s'enregistre pas quand j'appuie sur le piton ».
    //
    // L'enregistrement désactive le bouton le temps de l'aller-retour, et ne le réactivait
    // que dans le `catch`. Une correction RÉUSSIE le laissait donc désactivé pour toujours :
    // la fenêtre se rouvrait normalement, les champs se remplissaient, et taper
    // « Enregistrer » ne faisait plus rien — sans un mot d'explication.
    //
    // D'où un test qui corrige DEUX journées de suite. Un test qui n'en corrige qu'une passe
    // au vert sur le bogue même, ce qui est exactement ce qui s'est produit.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Corrections" }),
    })).json();
    const emp = await (await api("/api/admin/employees", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Carla Corrige", secteur: "salle" }),
    })).json();
    const declarer = (date, ventes) =>
      fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, ventes, clients: 50, pct: 10, remis: 0 }),
      }).then((r) => r.json());
    await declarer("2026-10-02", 10000);
    await declarer("2026-10-03", 20000);

    await ouvrirAdmin();
    await onglet.ev(`[...document.querySelectorAll('[data-action="toggleFiche"]')]
      .find((b) => b.textContent.includes("Carla Corrige")).click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="editEntry"]')`), { quoi: "le crayon" });

    const corriger = async (rang, montant) => {
      await onglet.ev(`document.querySelectorAll('[data-action="editEntry"]')[${rang}].click()`);
      await jusqua(() => onglet.ev(`document.getElementById("entryModalOverlay").style.display === "flex"`), { quoi: "la fenêtre" });
      // Le cœur du test : le bouton doit être ARMÉ à chaque ouverture.
      assert.equal(
        await onglet.ev(`document.getElementById("entrySaveBtn").disabled`),
        false,
        `le bouton doit être actif à l'ouverture (correction ${rang + 1})`
      );
      await onglet.ev(`(() => { const c = document.getElementById("entryVentes");
        c.value = "${montant}"; c.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await onglet.ev(`document.getElementById("entrySaveBtn").click()`);
      await jusqua(() => onglet.ev(`document.getElementById("entryModalOverlay").style.display === "none"`), { quoi: "la fermeture" });
    };

    await corriger(0, 1000);
    // La fiche se referme au rechargement : on la rouvre pour atteindre la seconde journée.
    await onglet.ev(`[...document.querySelectorAll('[data-action="toggleFiche"]')]
      .find((b) => b.textContent.includes("Carla Corrige")).click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="editEntry"]')`), { quoi: "le crayon, encore" });
    await corriger(1, 2000);

    // On compare l'ENSEMBLE des montants plutôt que date par date : le tableau est trié du
    // plus récent au plus ancien, et accrocher le test à cet ordre le ferait tomber le jour
    // où le tri change — pour une raison qui n'a rien à voir avec ce qu'on vérifie ici.
    const journees = await (await fetch(`${serveur.base}/api/employee/${emp.access_code}`)).json();
    const montants = journees.entries.map((d) => d.ventes).sort((a, b) => a - b);
    assert.deepEqual(montants, [1000, 2000], "les DEUX corrections sont passées, pas juste la première");
  });

  await t.test("le relevé photo s'ouvre DANS la page, avec un bouton pour fermer", async () => {
    // Rapporté ainsi : « quand j'ouvre une photo pour valider dans mon admin il n'y a pas de
    // bouton fermer sur mon cell ». La vignette était un lien `target="_blank"` vers l'image
    // brute : sur un téléphone — surtout quand l'app est ajoutée à l'écran d'accueil, ce que
    // ce dépôt prévoit avec `apple-mobile-web-app-title` — cet onglet s'affiche sans barre de
    // navigateur. Ni bouton fermer, ni flèche retour.
    const resto = await (await api("/api/admin/restaurants", {
      method: "POST", body: JSON.stringify({ name: "Resto Photo" }),
    })).json();
    const emp = await (await api("/api/admin/employees", {
      method: "POST", body: JSON.stringify({ restaurant_id: resto.id, name: "Paula Photo", secteur: "salle" }),
    })).json();
    const jour = await (await fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-10-05", ventes: 800, clients: 40, pct: 10, remis: 0 }),
    })).json();
    // Un PNG rouge d'un pixel : il suffit, on vérifie le comportement et pas l'image.
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const envoi = await fetch(`${serveur.base}/api/employee/${emp.access_code}/entries/${jour.id}/photo`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoBase64: `data:image/png;base64,${pixel}` }),
    });
    assert.equal(envoi.status, 200, "le relevé est bien téléversé");

    await ouvrirAdmin();
    await onglet.ev(`[...document.querySelectorAll('[data-action="toggleFiche"]')]
      .find((b) => b.textContent.includes("Paula Photo")).click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector('[data-action="voirPhoto"]')`), { quoi: "la vignette" });

    // Le cœur du correctif : plus AUCUN lien qui emmène hors de la page.
    assert.equal(
      await onglet.ev(`document.querySelectorAll('a[href^="/api/photos"]').length`),
      0,
      "aucune vignette ne doit ouvrir l'image brute dans un onglet"
    );

    await onglet.ev(`document.querySelector('[data-action="voirPhoto"]').click()`);
    await jusqua(() => onglet.ev(`document.getElementById("photoOverlay").style.display === "flex"`), { quoi: "la fenêtre" });

    // Le bouton doit être VISIBLE à l'écran, pas seulement présent dans le document : c'est
    // tout le problème qu'on répare.
    const bouton = await onglet.ev(`(() => {
      const b = document.getElementById("photoFermerBtn");
      const r = b.getBoundingClientRect();
      return JSON.stringify({ texte: b.textContent.trim(), hauteur: Math.round(r.height),
        dansEcran: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 100 });
    })()`);
    const vu = JSON.parse(bouton);
    assert.ok(vu.texte.length > 0, "le bouton porte un libellé");
    assert.ok(vu.hauteur >= 44, `un bouton qu'on tape du pouce : ${vu.hauteur} px`);
    assert.equal(vu.dansEcran, true, "et il est visible sans défiler");

    // Une tape SUR l'image ne ferme pas — sinon on la perd en voulant la regarder.
    await onglet.ev(`document.getElementById("photoGrande").click()`);
    assert.equal(await onglet.ev(`document.getElementById("photoOverlay").style.display`), "flex");

    await onglet.ev(`document.getElementById("photoFermerBtn").click()`);
    await jusqua(() => onglet.ev(`document.getElementById("photoOverlay").style.display === "none"`), { quoi: "la fermeture" });
    // La source se vide : sinon la prochaine ouverture montre une seconde la photo
    // PRÉCÉDENTE, ce qui est trompeur sur un relevé qu'on valide.
    assert.equal(await onglet.ev(`!document.getElementById("photoGrande").getAttribute("src")`), true);
  });

  await t.test("elle demande un congé, le gérant répond, et elle lit la réponse", async () => {
    // Le trajet complet dans un vrai navigateur. Ce que ça verrouille : avant, l'employée
    // n'avait AUCUN moyen de demander une journée, et ne voyait même pas celle qu'on avait
    // notée pour elle. Rapporté ainsi : « je vois les demandes de mon côté mais quand je
    // regarde côté employé je vois rien ».
    const { employe, restoId, lien } = await creerEmploye("Noémie Demande");

    await onglet.aller(lien, ".conges-card");
    assert.equal(
      await onglet.ev(`!!document.getElementById("congeToggle")`),
      true,
      "le bouton « Demander un congé » doit exister sur sa page"
    );
    // Le formulaire est replié au départ : une page qui s'ouvre sur un formulaire de congé
    // donne à croire qu'il faut en remplir un.
    assert.equal(await onglet.ev(`!!document.getElementById("congeDebut")`), false);

    await onglet.ev(`document.getElementById("congeToggle").click()`);
    await jusqua(async () => onglet.ev(`!!document.getElementById("congeEnvoyer")`), {
      quoi: "l'ouverture du formulaire de congé",
    });
    await onglet.ev(`(() => {
      document.getElementById("congeDebut").value = "2026-11-10";
      document.getElementById("congeNote").value = "Rendez-vous médical";
      return true;
    })()`);
    await onglet.ev(`document.getElementById("congeEnvoyer").click()`);

    await jusqua(async () => onglet.ev(`!!document.querySelector(".conge-etat.attente")`), {
      quoi: "l'affichage de la demande en attente",
    });
    const ligne = await onglet.ev(`document.querySelector(".conge-ligne").innerText`);
    assert.match(ligne, /Rendez-vous médical/, "sa raison doit rester lisible");
    assert.match(ligne, /10 novembre 2026/, "la journée demandée");
    assert.equal(
      await onglet.ev(`!!document.querySelector("[data-retirer]")`),
      true,
      "tant qu'elle attend, elle peut la retirer"
    );

    // --- Côté gérant : la demande attend, et elle ne marque RIEN dans la grille.
    const demandes = (await (await api(`/api/admin/demandes-conge?restaurant_id=${restoId}`)).json()).demandes;
    assert.equal(demandes.length, 1, "le gérant voit la demande");
    assert.equal(demandes[0].employee_name, "Noémie Demande");
    const absencesAvant = (await (await api(`/api/admin/absences?restaurant_id=${restoId}`)).json()).absences;
    assert.equal(absencesAvant.length, 0, "une demande en attente ne marque aucune journée");

    await api(`/api/admin/demandes-conge/${demandes[0].id}/reponse`, {
      method: "POST",
      body: JSON.stringify({ restaurant_id: restoId, accepte: true }),
    });

    // --- Et elle le voit : accepté, et plus rien à retirer.
    await onglet.aller(lien, ".conges-card");
    await jusqua(async () => onglet.ev(`!!document.querySelector(".conge-etat.accepte")`), {
      quoi: "l'état « accepté » sur sa page",
    });
    assert.equal(
      await onglet.ev(`!!document.querySelector("[data-retirer]")`),
      false,
      "un bouton qui répondrait 409 se lirait comme un bouton brisé"
    );

    // --- Un refus porte le mot du gérant jusqu'à sa page.
    const refusee = await (
      await fetch(`${serveur.base}/api/employee/${employe.access_code}/conges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date_debut: "2026-11-20", date_fin: "2026-11-22", type: "vacances" }),
      })
    ).json();
    await api(`/api/admin/demandes-conge/${refusee.id}/reponse`, {
      method: "POST",
      body: JSON.stringify({ restaurant_id: restoId, accepte: false, reponse: "Trop de monde cette semaine-là" }),
    });

    await onglet.aller(lien, ".conges-card");
    await jusqua(async () => onglet.ev(`!!document.querySelector(".conge-etat.refuse")`), {
      quoi: "l'état « refusé » sur sa page",
    });
    const texteRefus = await onglet.ev(
      `[...document.querySelectorAll(".conge-ligne")].find((l) => l.querySelector(".conge-etat.refuse")).innerText`
    );
    assert.match(texteRefus, /Trop de monde cette semaine-là/, "un refus sans un mot fait rappeler le gérant");
  });

  await t.test("ses journées sont repliées, et une tape en ouvre une", async () => {
    // Demandé ainsi : « un moyen de rapetisser ça en laissant juste une ligne, et quand on
    // clique ça ouvre, pour que le lien serveuse et hôtesse soit moins lourd ». Une carte
    // dépliée fait près d'un écran de téléphone : cinq midis déclarés dans la semaine et la
    // page devient un corridor.
    const { employe, lien } = await creerEmploye("Repliée");
    const jour = (d) =>
      fetch(`${serveur.base}/api/employee/${employe.access_code}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: d, ventes: 1200, clients: 80, pct: 15, remis: 0, is_hotesse: false }),
      });
    await jour("2026-10-05");
    await jour("2026-10-06");
    await jour("2026-10-07");

    await onglet.taille(390, 844); // un téléphone, puisque c'est là que ça se vit
    await onglet.aller(lien, ".jour-tete");

    assert.equal(await onglet.ev(`document.querySelectorAll(".day-card").length`), 3, "les trois journées");
    assert.equal(
      await onglet.ev(`document.querySelectorAll(".day-body").length`),
      0,
      "replié veut dire NON CONSTRUIT : aucun formulaire n'existe tant qu'on n'a pas ouvert"
    );
    // Une ligne, c'est une ligne : la carte ne doit pas dépasser la hauteur d'une rangée
    // tapable. 44 px de cible + le rembourrage de la carte.
    const hauteurLigne = await onglet.ev(`Math.round(document.querySelector(".day-card").getBoundingClientRect().height)`);
    assert.ok(hauteurLigne < 100, `une journée repliée fait ${hauteurLigne} px, ce n'est plus une ligne`);

    const replie = await onglet.ev(`document.body.scrollHeight`);

    // Ce qu'on lit sans ouvrir : la date et le net.
    const ligne = await onglet.ev(`document.querySelector(".day-card .jour-tete").innerText`);
    assert.match(ligne, /oct/, "la journée doit se nommer");
    assert.match(ligne, /180,00|180\.00/, "et porter son net — 1200 × 15 %");

    // --- une tape ouvre
    await onglet.ev(`document.querySelector(".day-card .jour-tete").click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".day-body")`), { quoi: "l'ouverture" });
    assert.equal(
      await onglet.ev(`document.querySelectorAll(".day-body").length`),
      1,
      "ouvrir une journée n'ouvre pas les autres"
    );
    assert.equal(await onglet.ev(`!!document.querySelector('input[data-field="ventes"]')`), true);
    assert.equal(await onglet.ev(`!!document.querySelector('[data-action="submit"]')`), true);

    const ouvert = await onglet.ev(`document.body.scrollHeight`);
    assert.ok(ouvert > replie, "ouvrir doit allonger la page, sinon le repli ne sert à rien");

    // La date doit se donner pour ce qu'elle est : un champ. Demandé ainsi, en regardant une
    // vraie carte — « ajoute une indication à côté pour qu'il sache qu'il faut appuyer là
    // pour modifier la date ». Elle ressemblait à du texte posé là.
    assert.equal(
      await onglet.ev(`!!document.querySelector("label.date-champ > input[type=date]")`),
      true,
      "l'étiquette doit ENVELOPPER le champ : c'est ce qui ouvre le calendrier d'une tape, sans JavaScript"
    );
    assert.match(
      await onglet.ev(`document.querySelector(".date-indice").textContent`),
      /Modifier date|Edit date/,
      "le mot est l'indication ; l'icône seule ne suffit pas"
    );
    // Et la rangée tient sur le plus petit téléphone encore en service (320 px). Mesuré :
    // « Modifier date » coûte 218 px sans icône de calendrier, contre 239 px avec — et
    // 239 px débordent une rangée de 250 px. C'est la mesure qui a retiré l'icône, pas le
    // goût ; le test est là pour que personne ne la remette sans refaire le calcul.
    assert.equal(
      await onglet.ev(`(function () {
        var t = document.querySelector(".day-head").getBoundingClientRect();
        var p = document.querySelector(".date-champ").getBoundingClientRect();
        var b = document.querySelector(".del-btn").getBoundingClientRect();
        return p.right <= b.left + 1 && b.right <= t.right + 1;
      })()`),
      true,
      "la puce de date et la poubelle doivent tenir côte à côte, sans déborder"
    );
    const puce = JSON.parse(
      await onglet.ev(`JSON.stringify((function () {
        var b = document.querySelector(".date-champ").getBoundingClientRect();
        return { h: Math.round(b.height), l: Math.round(b.width), vu: b.width > 0 && b.height > 0 };
      })())`)
    );
    assert.equal(puce.vu, true, "la puce de date doit être visible à l'écran");
    assert.ok(puce.h >= 40, `la puce fait ${puce.h} px de haut : trop petit pour un pouce`);
    // Une seule icône de calendrier : Chrome dessine la sienne dans le champ, et la puce en
    // portait deux sur un ordinateur contre une seule sur l'iPhone de l'équipe.
    //
    // On regarde la RÈGLE et non le rendu : `getComputedStyle` sur un pseudo-élément de la
    // zone d'ombre de WebKit rend « block » même quand la règle s'applique bel et bien —
    // mesuré ici, et l'icône était pourtant bien partie à l'écran. Un test qui croit cette
    // mesure échoue sur du code juste.
    assert.equal(
      await onglet.ev(`[...document.styleSheets]
        .flatMap(function (f) { try { return [...f.cssRules]; } catch (e) { return []; } })
        .some(function (r) {
          return /-webkit-calendar-picker-indicator/.test(r.selectorText || "")
            && r.style && r.style.display === "none";
        })`),
      true,
      "l'icône native de Chrome doit rester cachée, sinon la puce en porte deux"
    );
    console.log(`      trois journées : ${replie} px repliées, ${ouvert} px avec UNE seule ouverte`);

    // --- une tape referme, et ce qui était tapé ne se perd pas
    await onglet.ev(`(function () {
      var champ = document.querySelector('input[data-field="ventes"]');
      champ.value = "999";
      champ.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await onglet.ev(`document.querySelector(".day-card .jour-tete").click()`);
    await jusqua(
      () => onglet.ev(`document.querySelector(".day-card .day-body").style.display === "none"`),
      { quoi: "la fermeture" }
    );
    // À deux pixels près : le « ✓ » qui clignote après un enregistrement remplace un libellé
    // plus long, et ça suffit à faire bouger la page d'un pixel. Ce qu'on vérifie, c'est que
    // la carte s'est bien refermée, pas la police du bandeau du haut.
    const refermee = await onglet.ev(`document.body.scrollHeight`);
    assert.ok(
      Math.abs(refermee - replie) <= 2,
      `refermée, la page devrait retrouver sa hauteur : ${refermee} px contre ${replie} px`
    );
    // Le net de la ligne suit la saisie : c'est ce qu'elle voit en refermant.
    assert.match(
      await onglet.ev(`document.querySelector(".day-card .jour-chiffres").innerText`),
      /149,85|149\.85/,
      "999 × 15 % = 149,85 $, affiché sans rouvrir"
    );

    await onglet.ev(`document.querySelector(".day-card .jour-tete").click()`);
    await jusqua(
      () => onglet.ev(`document.querySelector(".day-card .day-body").style.display !== "none"`),
      { quoi: "la réouverture" }
    );
    assert.equal(
      await onglet.ev(`document.querySelector('input[data-field="ventes"]').value`),
      "999",
      "le corps est CACHÉ et non effacé : un montant tapé ne disparaît pas en refermant"
    );

    // --- ce qui doit se lire SANS ouvrir
    // Une journée dont l'argent n'est pas réglé, et une journée d'hôtesse, ne se voient pas
    // dans le net : sans marque sur la ligne, il faudrait ouvrir les trois cents journées de
    // l'année pour retrouver celle où il reste 75 $ à remettre.
    await onglet.ev(`(function () {
      document.querySelector('[data-remit="employee_owes"]').click();
    })()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".remit-amount-input")`), {
      quoi: "le champ du montant dû",
    });
    await onglet.ev(`(function () {
      var champ = document.querySelector(".remit-amount-input");
      champ.value = "75";
      champ.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await jusqua(
      () => onglet.ev(`/75,00|75\\.00/.test(document.querySelector(".day-card .jour-chiffres").innerText)`),
      { quoi: "le montant dû sur la ligne repliée" }
    );
    const avecDu = await onglet.ev(`document.querySelector(".day-card .jour-chiffres").innerText`);
    assert.match(avecDu, /à remettre|to hand in/, "la ligne doit dire de quel sens il s'agit");

    await onglet.ev(`document.querySelector(".day-card .hotesse-checkbox").click()`);
    await jusqua(
      () => onglet.ev(`!!document.querySelector(".day-card .jour-marque.hotesse")`),
      { quoi: "la marque hôtesse" }
    );

    // --- « + Ajouter » ouvre d'elle-même la journée qu'on vient de créer
    await onglet.ev(`document.getElementById("addBtn").click()`);
    await jusqua(() => onglet.ev(`document.querySelectorAll(".day-card").length === 4`), {
      quoi: "la journée ajoutée",
    });
    assert.equal(
      await onglet.ev(`!!document.querySelector("#daysList .day-card:first-child .day-body")`),
      true,
      "un « + Ajouter » qui poserait une ligne repliée se lirait comme un bouton qui ne fait rien"
    );

    await onglet.taille(1000);
  });

  await t.test("la paye : des blocs de deux semaines qui commencent un lundi fixe", async () => {
    // Demandé ainsi : « peux-tu décoller le 2 semaines à partir d'un lundi précis, pour
    // suivre le détail de la paye qui est aux 2 semaines et commence un lundi ». « 2
    // dernières semaines » est une fenêtre GLISSANTE — aujourd'hui moins treize jours —
    // donc son total ne correspond à aucun talon de paye.
    const resto = await (await api("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Resto Paye" }) })).json();
    const emp = await (await api("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: "Paye Marie", secteur: "salle" }),
    })).json();
    const decl = (date, ventes) =>
      fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, ventes, clients: 50, pct: 10, remis: 0, is_hotesse: false }),
      });
    // Ancre au lundi 5 octobre 2026 : la paye court du 5 au 18, la précédente du 21 sept au
    // 4 oct. Les deux BORNES sont déclarées exprès — c'est là que ça se joue.
    await decl("2026-10-05", 1000); // premier jour de la paye → 100 $
    await decl("2026-10-18", 1000); // DERNIER jour de la paye → 100 $
    await decl("2026-10-04", 5000); // dimanche d'avant : paye précédente → 500 $
    await decl("2026-10-19", 9000); // lundi d'après : paye suivante → ne doit jamais paraître

    await ouvrirAdmin();
    const netDe = () =>
      onglet.ev(`(function () {
        var f = [...document.querySelectorAll(".fiche-nom")].find(function (n) { return /Paye Marie/.test(n.textContent); });
        return f ? f.closest(".fiche-entete").querySelector(".fiche-resume b").textContent : "(introuvable)";
      })()`);

    await onglet.ev(`document.querySelector('[data-period="paye"]').click()`);
    await jusqua(() => onglet.ev(`!!document.getElementById("payeDebutInput")`), {
      quoi: "la demande du lundi de départ",
    });
    // Sans ancre, la paye ne veut rien dire : l'écran DEMANDE plutôt que de retomber en
    // silence sur les deux dernières semaines, qui donneraient un chiffre d'allure juste.
    assert.equal(await onglet.ev(`!!document.querySelector(".paye-dates")`), false);

    // On règle un MARDI exprès : le serveur doit le ramener à son lundi, et le DIRE.
    await onglet.ev(`(function () {
      window.__alertes = [];
      window.alert = function (m) { window.__alertes.push(m); };
      document.getElementById("payeDebutInput").value = "2026-10-06";
    })()`);
    await onglet.ev(`document.getElementById("payeEnregistrer").click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".paye-dates")`), { quoi: "la navigation de paye" });
    assert.match(
      await onglet.ev(`(window.__alertes || [])[0] || ""`),
      /5 octobre|October 5/,
      "ramener la date en douce ferait afficher un autre chiffre que celui qu'on pensait régler"
    );

    const datesPaye = () => onglet.ev(`document.querySelector(".paye-dates").textContent`);
    assert.match(await datesPaye(), /5 octobre 2026.*18 octobre 2026|October 5, 2026.*October 18, 2026/);
    assert.match(await netDe(), /200,00|200\.00/, "les DEUX bornes comptent : le 5 et le 18");
    assert.equal(await onglet.ev(`!!document.querySelector(".paye-marque")`), true, "« Paye en cours »");
    // Une paye à venir n'a aucune déclaration : le bouton donnerait un écran vide qui se
    // lirait comme une perte de données.
    assert.equal(await onglet.ev(`document.getElementById("payeSuivante").disabled`), true);

    await onglet.ev(`document.getElementById("payePrecedente").click()`);
    await jusqua(async () => /21 septembre|September 21/.test(await datesPaye()), { quoi: "la paye précédente" });
    assert.match(
      await netDe(),
      /500,00|500\.00/,
      "le dimanche 4 octobre appartient à la paye PRÉCÉDENTE, pas à celle en cours"
    );
    assert.equal(await onglet.ev(`document.getElementById("payeSuivante").disabled`), false);

    // Rechargement : l'ancre vit en BASE, pas dans le navigateur — le gérant règle ça sur
    // son téléphone et ouvre /admin du bureau. Et les chiffres doivent être justes du
    // PREMIER rendu : l'ancre arrive avec l'aperçu, donc la première requête serait partie
    // sans dates et aurait ramené tout l'historique sous les bonnes dates de paye.
    await onglet.ev(`document.getElementById("payeSuivante").click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector(".paye-marque")`), { quoi: "le retour à la paye en cours" });
    await onglet.aller(`${serveur.base}/admin`, ".paye-dates");
    await jusqua(async () => /200,00|200\.00/.test(await netDe()), {
      quoi: "le bon total dès le rechargement",
    });
    assert.match(await datesPaye(), /5 octobre 2026|October 5, 2026/);

    // Pas besoin de remettre la période : `ouvrirAdmin()` repart de « tout l'historique »
    // pour chaque test, justement parce qu'elle fuit par localStorage.
  });

  await t.test("un montant à remettre reste visible tant qu'on ne l'a pas réglé", async () => {
    // Demandé ainsi : « ils doivent rester tant que je les règle pas manuel, c'est
    // important ». Le défaut : ces montants vivaient dans `entries`, donc filtrés par la
    // période affichée. Une serveuse qui doit 75 $ depuis cinq semaines disparaissait du
    // bandeau rouge dès qu'on regardait la paye en cours — ET le bouton « marquer viré »
    // avec elle, puisqu'il vit dans la rangée du tableau. Le montant devenait impossible à
    // régler sans penser à repasser en « Tout ».
    const resto = await (await api("/api/admin/restaurants", { method: "POST", body: JSON.stringify({ name: "Resto Dû" }) })).json();
    const emp = await (await api("/api/admin/employees", {
      method: "POST",
      body: JSON.stringify({ restaurant_id: resto.id, name: "Dûe Marie", secteur: "salle" }),
    })).json();
    const ilYA = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const poster = (corps) =>
      fetch(`${serveur.base}/api/employee/${emp.access_code}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
    // 75 $ qu'elle doit depuis 40 jours, jamais réglés — bien en dehors des 2 dernières
    // semaines. Plus une journée récente ordinaire, pour les totaux.
    await poster({ date: ilYA(40), ventes: 1000, clients: 60, pct: 12, remis: 0, is_hotesse: false, remit_direction: "employee_owes", remit_amount: 75 });
    await poster({ date: ilYA(2), ventes: 1200, clients: 80, pct: 15, remis: 0, is_hotesse: false });

    await ouvrirAdmin();
    // Une fenêtre qui EXCLUT la journée d'il y a 40 jours — c'est tout l'enjeu.
    await onglet.ev(`document.querySelector('[data-period="month"]').click()`);
    await jusqua(async () => (await periodeActive()) === "month", { quoi: "les 30 derniers jours" });
    const sonBandeau = () =>
      onglet.ev(`(function () {
        var b = [...document.querySelectorAll(".pending-chip")].find(function (c) { return /Dûe Marie/.test(c.textContent); });
        return b ? b.textContent.trim() : "";
      })()`);

    await jusqua(async () => /75/.test(await sonBandeau()), {
      quoi: "le montant dû dans le bandeau, malgré la période de 2 semaines",
    });

    // La pastille doit MENER quelque part : une fiche ouverte, une rangée, et un bouton.
    await onglet.ev(`[...document.querySelectorAll(".pending-chip")].find(function (c) { return /Dûe Marie/.test(c.textContent); }).click()`);
    await jusqua(() => onglet.ev(`!!document.querySelector("tr.row-hors-periode")`), {
      quoi: "la rangée de la journée hors période",
    });
    assert.match(
      await onglet.ev(`document.querySelector(".marque-hors-periode").textContent`),
      /hors période|outside period/,
      "la rangée doit se distinguer : elle n'est dans aucun total"
    );
    assert.equal(
      await onglet.ev(`!!document.querySelector("tr.row-hors-periode [data-action='markTransferred']")`),
      true,
      "sans ce bouton, le bandeau réclamerait un argent qu'on ne peut pas régler"
    );
    // Et les totaux de la période ne bougent PAS : la vieille journée n'y entre pas, sinon
    // elle fausserait la paye qu'on compare à un talon.
    const netPeriode = await onglet.ev(`(function () {
      var c = [...document.querySelectorAll(".fiche-nom")].find(function (n) { return /Dûe Marie/.test(n.textContent); }).closest(".employee-card-block");
      return [...c.querySelectorAll(".employee-stat-value")].map(function (v) { return v.textContent; })[1];
    })()`);
    assert.match(netPeriode, /180,00|180\.00/, "1200 × 15 % = 180 $ — la journée d'il y a 40 jours n'y est pas");

    // --- on règle, et là seulement ça disparaît
    await onglet.ev(`document.querySelector("tr.row-hors-periode [data-action='markTransferred']").click()`);
    await jusqua(() => onglet.ev(`document.getElementById("modalOverlay").style.display === "flex"`), {
      quoi: "la fenêtre de confirmation du virement",
    });
    await onglet.ev(`document.getElementById("modalConfirm").click()`);
    await jusqua(async () => (await sonBandeau()) === "", { quoi: "la disparition de la pastille" });

    // Et ça tient au rechargement : c'est réglé pour de bon, pas juste à l'écran.
    await onglet.aller(`${serveur.base}/admin`, ".period-bar");
    await jusqua(async () => (await sonBandeau()) === "", { quoi: "le règlement, après rechargement" });
    // Scopé à SA fiche : d'autres employés des tests précédents ont eux aussi de l'argent
    // dû, et leurs rangées hors période doivent rester — c'est exactement le comportement
    // qu'on vient d'ajouter. Une assertion sur toute la page échouerait sur du code juste.
    assert.equal(
      await onglet.ev(`(function () {
        var n = [...document.querySelectorAll(".fiche-nom")].find(function (x) { return /Dûe Marie/.test(x.textContent); });
        return n ? !!n.closest(".employee-card-block").querySelector("tr.row-hors-periode") : true;
      })()`),
      false,
      "sa rangée à elle doit avoir disparu une fois réglée"
    );
  });

  // ATTENTION : ce test DOIT rester le dernier du fichier. Il déclenche volontairement le
  // plafond de tentatives, qui bloque l'adresse 127.0.0.1 pour quinze minutes — tout test
  // de page employé placé après échouerait pour une raison sans rapport.
  await t.test("bloquée par le plafond, l'employée lit la vraie raison", async () => {
    // Le bogue que ça verrouille : la page affichait « Code invalide » pour TOUTE erreur.
    // Une employée au code parfaitement valide lisait donc « Vérifie le lien reçu » et
    // recommençait — ce qui n'arrangeait rien, et nous a fait chercher pendant une heure un
    // problème de code qui n'existait pas.
    const { lien: lienJamaisOuvert } = await creerEmploye("Jamais Ouverte");

    // Douze codes DIFFÉRENTS : c'est ce qui ressemble à une tentative de devinette.
    for (let i = 0; i < 12; i++) {
      await fetch(`${serveur.base}/api/employee/BLOQUE${String(i).padStart(2, "0")}`);
    }

    await onglet.aller(lienJamaisOuvert, ".error-box h2");
    const titre = await onglet.ev(`document.querySelector(".error-box h2").textContent`);
    assert.match(titre, /Trop de tentatives|Too many attempts/, `lu : « ${titre} »`);
    assert.doesNotMatch(titre, /Code invalide|Invalid code/, "surtout pas le message du mauvais lien");

    // Et le message dit combien de temps attendre, sinon on ne sait pas quoi faire.
    const message = await onglet.ev(`document.querySelector(".error-box p").textContent`);
    assert.match(message, /minute/i, `lu : « ${message} »`);
  });
});
