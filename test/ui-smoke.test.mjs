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
    await onglet.aller(lien, "[data-action='submit']");
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
