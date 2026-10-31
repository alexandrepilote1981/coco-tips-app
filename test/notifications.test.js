// Les notifications par courriel, sans réseau.
//
// On vérifie trois choses : le jeton qui signe les liens (impossible à falsifier, propre à
// une demande), le contenu des deux courriels (l'objet dit tout, les liens portent le jeton,
// le texte est échappé), et surtout que RIEN ne part tant que ce n'est pas configuré — et
// qu'un envoi qui rate ne lève jamais.

const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../notifications");

// Un faux `fetch` qui note l'appel et répond ce qu'on lui dit, sans toucher au réseau.
function fauxFetch(reponse) {
  const appels = [];
  const f = async (url, opts) => {
    appels.push({ url, opts });
    if (reponse instanceof Error) throw reponse;
    return reponse;
  };
  f.appels = appels;
  return f;
}

// Pose les variables qui ALLUMENT la fonction, le temps d'un test.
function avecEnv(vars, fn) {
  const avant = {};
  for (const k of Object.keys(vars)) {
    avant[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) {
      if (avant[k] === undefined) delete process.env[k];
      else process.env[k] = avant[k];
    }
  });
}

const SECRET = "secret-de-test-12345";
const DEMANDE = {
  id: "ABC123XYZ0",
  date_debut: "2026-10-30",
  date_fin: "2026-10-30",
  type: "conge",
  note: "Rendez-vous médical",
};
const EMPLOYE = { name: "Marie Tremblay" };
const RESTO = { name: "Le Coco Resto" };

test("le jeton est stable, propre à une demande, et se vérifie", () => {
  const t = N.jeton(SECRET, DEMANDE.id);
  assert.equal(t, N.jeton(SECRET, DEMANDE.id), "même id, même secret → même jeton");
  assert.notEqual(t, N.jeton(SECRET, "autre-id"), "un autre id donne un autre jeton");
  assert.notEqual(t, N.jeton("autre-secret", DEMANDE.id), "un autre secret aussi");
  assert.ok(N.jetonValide(SECRET, DEMANDE.id, t), "le bon jeton passe");
});

test("un jeton falsifié ou vide est refusé", () => {
  const t = N.jeton(SECRET, DEMANDE.id);
  assert.ok(!N.jetonValide(SECRET, DEMANDE.id, ""), "vide refusé");
  assert.ok(!N.jetonValide(SECRET, DEMANDE.id, t + "x"), "trop long refusé");
  assert.ok(!N.jetonValide(SECRET, DEMANDE.id, t.slice(0, -1)), "trop court refusé");
  assert.ok(!N.jetonValide(SECRET, DEMANDE.id, t.replace(/.$/, (c) => (c === "a" ? "b" : "a"))), "un caractère changé refusé");
  assert.ok(!N.jetonValide(SECRET, "autre-id", t), "le jeton d'une AUTRE demande ne vaut pas ici");
});

test("le courriel de congé : objet complet, liens signés, note échappée", () => {
  const { sujet, html } = N.courrielDemandeConge({ demande: DEMANDE, employe: EMPLOYE, restaurant: RESTO, secret: SECRET });
  assert.match(sujet, /Congé demandé/);
  assert.match(sujet, /Marie Tremblay/);
  assert.match(sujet, /30 oct\./, "l'objet porte la date");

  const t = N.jeton(SECRET, DEMANDE.id);
  assert.match(html, new RegExp(`id=${DEMANDE.id}&t=${t}&a=accepte`), "lien Accepter signé");
  assert.match(html, new RegExp(`id=${DEMANDE.id}&t=${t}&a=refuse`), "lien Refuser signé");
  assert.match(html, /Rendez-vous médical/, "la note est dans le corps");
  // Le 30 octobre 2026 est un vendredi.
  assert.match(html, /vendredi 30 octobre/, "la date longue est écrite");
  assert.match(html, /demande un congé/, "la tournure se lit bien");
});

test("le courriel de congé pointe sur APP_URL quand elle est posée", async () => {
  await avecEnv({ APP_URL: "https://declara.tips" }, () => {
    const { html } = N.courrielDemandeConge({ demande: DEMANDE, employe: EMPLOYE, restaurant: RESTO, secret: SECRET });
    assert.match(html, /https:\/\/declara\.tips\/conge\?id=/);
  });
});

test("une plage de plusieurs jours se dit « du … au … »", () => {
  const { sujet, html } = N.courrielDemandeConge({
    demande: { ...DEMANDE, date_fin: "2026-11-02" },
    employe: EMPLOYE, restaurant: RESTO, secret: SECRET,
  });
  assert.match(html, /du vendredi 30 octobre au lundi 2 novembre/);
  assert.match(sujet, /→/, "l'objet montre la plage courte avec une flèche");
});

test("le courriel de message : objet, texte échappé, lien vers l'app", () => {
  const { sujet, html } = N.courrielMessage({
    message: { body: "Allo <b>patron</b> & merci" },
    employe: EMPLOYE, restaurant: RESTO,
  });
  assert.match(sujet, /Message de Marie Tremblay/);
  assert.match(html, /Allo &lt;b&gt;patron&lt;\/b&gt; &amp; merci/, "le HTML du message est échappé, pas interprété");
  assert.match(html, /\/admin/);
  assert.ok(!/<b>patron<\/b>/.test(html), "aucune balise injectée");
});

test("rien ne part tant que ce n'est pas configuré", async () => {
  await avecEnv({ RESEND_API_KEY: undefined, NOTIF_EMAIL: undefined }, async () => {
    assert.equal(N.activee(), false);
    const f = fauxFetch({ ok: true });
    const r = await N.envoyer({ sujet: "x", html: "y" }, f);
    assert.equal(r.envoye, false);
    assert.equal(r.raison, "desactive");
    assert.equal(f.appels.length, 0, "aucun appel réseau");
  });
});

test("quand c'est configuré, l'envoi appelle Resend avec la bonne clé et le bon destinataire", async () => {
  await avecEnv(
    { RESEND_API_KEY: "re_test_abc", NOTIF_EMAIL: "chicoutimi@cocofrutti.com", NOTIF_FROM: "Declara <notifications@declara.tips>" },
    async () => {
      assert.equal(N.activee(), true);
      const f = fauxFetch({ ok: true });
      const r = await N.envoyer({ sujet: "Objet test", html: "<p>corps</p>" }, f);
      assert.equal(r.envoye, true);
      assert.equal(f.appels.length, 1);
      const { url, opts } = f.appels[0];
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(opts.headers.Authorization, "Bearer re_test_abc");
      const corps = JSON.parse(opts.body);
      assert.equal(corps.to, "chicoutimi@cocofrutti.com");
      assert.equal(corps.from, "Declara <notifications@declara.tips>");
      assert.equal(corps.subject, "Objet test");
    }
  );
});

test("un refus de Resend ne lève pas — il revient en échec propre", async () => {
  await avecEnv({ RESEND_API_KEY: "re_x", NOTIF_EMAIL: "a@b.c" }, async () => {
    const f = fauxFetch({ ok: false, status: 422, text: async () => "domaine non vérifié" });
    const r = await N.envoyer({ sujet: "x", html: "y" }, f);
    assert.equal(r.envoye, false);
    assert.equal(r.code, 422);
  });
});

test("une panne réseau ne lève pas non plus", async () => {
  await avecEnv({ RESEND_API_KEY: "re_x", NOTIF_EMAIL: "a@b.c" }, async () => {
    const f = fauxFetch(new Error("ECONNRESET"));
    const r = await N.envoyer({ sujet: "x", html: "y" }, f);
    assert.equal(r.envoye, false);
    assert.equal(r.raison, "erreur");
  });
});

test("notifierDemandeConge n'envoie rien quand c'est désactivé", async () => {
  await avecEnv({ RESEND_API_KEY: undefined, NOTIF_EMAIL: undefined }, async () => {
    const f = fauxFetch({ ok: true });
    const r = await N.notifierDemandeConge({ demande: DEMANDE, employe: EMPLOYE, restaurant: RESTO, secret: SECRET }, f);
    assert.equal(r.envoye, false);
    assert.equal(f.appels.length, 0);
  });
});

test("notifierMessage envoie quand c'est activé", async () => {
  await avecEnv({ RESEND_API_KEY: "re_x", NOTIF_EMAIL: "a@b.c" }, async () => {
    const f = fauxFetch({ ok: true });
    const r = await N.notifierMessage({ message: { body: "allo" }, employe: EMPLOYE, restaurant: RESTO }, f);
    assert.equal(r.envoye, true);
    assert.equal(f.appels.length, 1);
    assert.match(JSON.parse(f.appels[0].opts.body).subject, /Message de Marie Tremblay/);
  });
});
