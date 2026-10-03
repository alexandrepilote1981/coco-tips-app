// Les dates de fériés se calculent, elles ne se saisissent pas. Ce fichier est ce qui permet
// de le faire sans crainte : si un jour Pâques ou la fête des Mères tombait à côté, toute la
// grille afficherait une couleur sur le mauvais jour, et personne ne le verrait avant que le
// restaurant soit à court de monde.

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../public/shared/feries.js");

test("Pâques tombe aux bonnes dates", () => {
  // Valeurs connues, vérifiables dans n'importe quel calendrier.
  const attendu = {
    2024: "2024-03-31",
    2025: "2025-04-20",
    2026: "2026-04-05",
    2027: "2027-03-28",
    2028: "2028-04-16",
    2030: "2030-04-21",
  };
  for (const [annee, date] of Object.entries(attendu)) {
    assert.equal(F.paques(Number(annee)).toISOString().slice(0, 10), date, `Pâques ${annee}`);
  }
});

test("Vendredi saint et lundi de Pâques encadrent Pâques", () => {
  for (const annee of [2026, 2027, 2028]) {
    const liste = F.feriesDeLAnnee(annee);
    const dimanche = F.paques(annee).toISOString().slice(0, 10);
    const vendredi = liste.find((f) => f.cle === "vendrediSaint").date;
    const lundi = liste.find((f) => f.cle === "lundiPaques").date;
    const ecart = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
    assert.equal(ecart(vendredi, dimanche), 2, `vendredi saint ${annee}`);
    assert.equal(ecart(dimanche, lundi), 1, `lundi de Pâques ${annee}`);
  }
});

test("la fête des Mères est le deuxième dimanche de mai", () => {
  const attendu = { 2025: "2025-05-11", 2026: "2026-05-10", 2027: "2027-05-09", 2028: "2028-05-14" };
  for (const [annee, date] of Object.entries(attendu)) {
    const f = F.ferieDuJour(date);
    assert.ok(f, `rien le ${date}`);
    assert.equal(f.cle, "feteDesMeres");
    // C'est une journée d'affluence, pas un férié : elle ne change rien à la paie.
    assert.equal(f.type, "occasion");
    assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 0, "un dimanche");
  }
});

test("la Journée des patriotes est le lundi précédant le 25 mai", () => {
  for (const annee of [2024, 2025, 2026, 2027, 2028, 2029]) {
    const f = F.feriesDeLAnnee(annee).find((x) => x.cle === "patriotes");
    const d = new Date(`${f.date}T12:00:00Z`);
    assert.equal(d.getUTCDay(), 1, `${f.date} devrait être un lundi`);
    const numero = d.getUTCDate();
    assert.ok(numero >= 18 && numero <= 24, `${f.date} hors de la fenêtre 18–24 mai`);
  }
});

test("fête du Travail et Action de grâce tombent sur leur lundi", () => {
  const attendu = {
    2026: { feteDuTravail: "2026-09-07", actionDeGrace: "2026-10-12" },
    2027: { feteDuTravail: "2027-09-06", actionDeGrace: "2027-10-11" },
  };
  for (const [annee, jours] of Object.entries(attendu)) {
    const liste = F.feriesDeLAnnee(Number(annee));
    for (const [cle, date] of Object.entries(jours)) {
      assert.equal(liste.find((f) => f.cle === cle).date, date, `${cle} ${annee}`);
    }
  }
});

test("les dates fixes sont là, quelle que soit l'année", () => {
  for (const annee of [2026, 2031]) {
    const parCle = Object.fromEntries(F.feriesDeLAnnee(annee).map((f) => [f.cle, f.date]));
    assert.equal(parCle.jourDeLAn, `${annee}-01-01`);
    assert.equal(parCle.feteNationale, `${annee}-06-24`);
    assert.equal(parCle.feteDuCanada, `${annee}-07-01`);
    assert.equal(parCle.noel, `${annee}-12-25`);
  }
});

test("les huit fériés du Québec sont tous là", () => {
  const feries = F.feriesDeLAnnee(2026).filter((f) => f.type === "ferie");
  assert.equal(feries.length, 9, "huit fériés, dont deux au choix pour Pâques");
  assert.deepEqual(
    feries.map((f) => f.cle),
    ["jourDeLAn", "vendrediSaint", "lundiPaques", "patriotes", "feteNationale", "feteDuCanada", "feteDuTravail", "actionDeGrace", "noel"]
  );
});

test("la liste est en ordre de date", () => {
  const dates = F.feriesDeLAnnee(2026).map((f) => f.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("une journée ordinaire ne renvoie rien", () => {
  assert.equal(F.ferieDuJour("2026-03-17"), null);
  assert.equal(F.ferieDuJour("2026-09-21"), null);
});

test("une date abîmée ne fait pas planter la grille", () => {
  // La grille demande le férié de chaque jour affiché : une valeur inattendue doit rendre
  // « aucun férié », jamais lever — sinon toute la semaine cesse de s'afficher.
  for (const valeur of [null, undefined, "", "pas une date", "2026-13-45x", 20260101, {}]) {
    assert.equal(F.ferieDuJour(valeur), null, `pour ${JSON.stringify(valeur)}`);
  }
  assert.deepEqual(F.feriesDeLAnnee("pas une année"), []);
});

test("les libellés existent dans les deux langues", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    for (const lang of ["fr", "en"]) {
      assert.ok(F.libelle(f.cle, lang).length > 0, `${f.cle} en ${lang}`);
      assert.ok(F.libelleCourt(f.cle, lang).length > 0, `${f.cle} court en ${lang}`);
    }
  }
  assert.equal(F.libelle("feteDesMeres", "fr"), "Fête des Mères");
  assert.equal(F.libelle("feteDesMeres", "en"), "Mother's Day");
});

test("le nom court n'est jamais plus long que le nom complet", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    for (const lang of ["fr", "en"]) {
      assert.ok(
        F.libelleCourt(f.cle, lang).length <= F.libelle(f.cle, lang).length,
        `${f.cle} en ${lang} : « ${F.libelleCourt(f.cle, lang)} » n'est pas plus court`
      );
    }
  }
});

test("demander deux fois la même date donne la même réponse", () => {
  // Le résultat est mis en cache par année : le cache ne doit pas rendre un objet abîmé au
  // deuxième appel.
  const a = F.ferieDuJour("2026-05-10");
  const b = F.ferieDuJour("2026-05-10");
  assert.deepEqual(a, b);
  assert.equal(b.cle, "feteDesMeres");
});

// ---------------------------------------------------------------- affluence

test("les grosses journées de restaurant sont marquées comme telles", () => {
  const attendu = {
    "2027-02-14": "saintValentin",
    "2027-03-28": "dimanchePaques",
    "2027-05-09": "feteDesMeres",
    "2027-06-20": "feteDesPeres",
    "2027-10-11": "actionDeGrace",
  };
  for (const [date, cle] of Object.entries(attendu)) {
    const f = F.ferieDuJour(date);
    assert.ok(f, `rien le ${date}`);
    assert.equal(f.cle, cle);
    assert.equal(f.affluence, true, `${cle} devrait remplir la salle`);
  }
});

test("la fête des Pères est le troisième dimanche de juin", () => {
  const attendu = { 2026: "2026-06-21", 2027: "2027-06-20", 2028: "2028-06-18" };
  for (const [annee, date] of Object.entries(attendu)) {
    const f = F.feriesDeLAnnee(Number(annee)).find((x) => x.cle === "feteDesPeres");
    assert.equal(f.date, date, `fête des Pères ${annee}`);
    assert.equal(new Date(`${date}T12:00:00Z`).getUTCDay(), 0, "un dimanche");
  }
});

test("le dimanche de Pâques tombe entre Vendredi saint et lundi de Pâques", () => {
  for (const annee of [2026, 2027, 2028]) {
    const liste = F.feriesDeLAnnee(annee);
    const parCle = Object.fromEntries(liste.map((f) => [f.cle, f]));
    assert.equal(parCle.dimanchePaques.date, F.paques(annee).toISOString().slice(0, 10));
    assert.ok(parCle.vendrediSaint.date < parCle.dimanchePaques.date);
    assert.ok(parCle.dimanchePaques.date < parCle.lundiPaques.date);
    // Le dimanche n'est PAS un férié de la loi, contrairement aux deux qui l'encadrent.
    assert.equal(parCle.dimanchePaques.type, "occasion");
    assert.equal(parCle.vendrediSaint.type, "ferie");
  }
});

test("un férié tranquille n'est pas une grosse journée", () => {
  for (const cle of ["jourDeLAn", "vendrediSaint", "lundiPaques", "patriotes", "feteNationale", "feteDuCanada", "feteDuTravail", "noel"]) {
    const f = F.feriesDeLAnnee(2027).find((x) => x.cle === cle);
    assert.equal(f.affluence, false, `${cle} ne devrait pas être marqué « salle pleine »`);
  }
});

test("l'Action de grâce est les deux à la fois", () => {
  const f = F.ferieDuJour("2027-10-11");
  assert.equal(f.type, "ferie", "la paie change");
  assert.equal(f.affluence, true, "et la salle se remplit");
});

test("« férié » se dit en mots, jamais par la couleur", () => {
  // Toutes les journées marquées portent la même teinte : c'est le NOM qui dit laquelle, et
  // l'infobulle qui ajoute « férié » là où ça compte. Rien dans le module ne rend une
  // couleur — l'affichage n'a donc aucune teinte à choisir.
  assert.equal(F.estFerie(F.ferieDuJour("2027-12-25")), true, "Noël");
  assert.equal(F.estFerie(F.ferieDuJour("2027-10-11")), true, "Action de grâce");
  assert.equal(F.estFerie(F.ferieDuJour("2027-05-09")), false, "la fête des Mères n'est pas un férié");
  assert.equal(F.estFerie(null), false);
  for (const lang of ["fr", "en"]) assert.ok(F.mentionFerie(lang).length > 0);
  assert.equal(typeof F.teinte, "undefined", "plus aucune notion de teinte dans le module");
});

test("toutes les journées portent les deux champs", () => {
  for (const f of F.feriesDeLAnnee(2026)) {
    assert.ok(["ferie", "occasion"].includes(f.type), `${f.cle} : type inattendu`);
    assert.equal(typeof f.affluence, "boolean", `${f.cle} : affluence manquante`);
  }
});

test("aucune journée n'en écrase une autre le même jour", () => {
  // Deux entrées à la même date rendraient l'une des deux invisible : seule la dernière
  // survivrait à l'index. Pâques encadrée de ses deux fériés est le cas serré.
  for (const annee of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
    const dates = F.feriesDeLAnnee(annee).map((f) => f.date);
    assert.equal(new Set(dates).size, dates.length, `doublon de date en ${annee}`);
  }
});

// ---------------------------------------------------------------- alertes de commande

// Le cycle : la commande se passe une fois par semaine, la semaine d'avant. L'alerte doit
// donc sortir le samedi qui précède cette semaine-là — la veille du dimanche où l'horaire se
// monte. Tout ce bloc existe parce qu'une alerte qui sort un jour trop tard ne sert à rien.

const cles = (a) => a.journees.map((j) => j.cle);

test("l'alerte sort le samedi, neuf jours avant le lundi de la semaine visée", () => {
  // L'exemple donné par le gérant : un férié le mercredi 14 octobre 2026, alerte le samedi
  // 3 octobre. La semaine du 5 au 11 reste entière pour passer la commande.
  assert.equal(F.samediDAlerte("2026-10-12"), "2026-10-03");
  assert.equal(new Date("2026-10-03T12:00:00Z").getUTCDay(), 6, "un samedi");
});

test("le samedi d'alerte est toujours un samedi, quelle que soit l'année", () => {
  for (const annee of [2026, 2027, 2028, 2029, 2030]) {
    for (const f of F.feriesDeLAnnee(annee)) {
      const lundi = F.lundiDe(f.date).toISOString().slice(0, 10);
      const samedi = F.samediDAlerte(lundi);
      assert.equal(new Date(`${samedi}T12:00:00Z`).getUTCDay(), 6, `${f.cle} ${annee} → ${samedi}`);
    }
  }
});

test("une semaine de commande complète sépare toujours l'alerte du férié", () => {
  // C'est la promesse de toute la fonctionnalité : peu importe le jour où tombe la fête, il
  // reste un lundi-au-samedi entier entre l'alerte et elle.
  for (const annee of [2026, 2027, 2028]) {
    for (const f of F.feriesDeLAnnee(annee)) {
      const lundi = F.lundiDe(f.date).toISOString().slice(0, 10);
      const samedi = F.samediDAlerte(lundi);
      const jours = Math.round((Date.parse(`${f.date}T12:00:00Z`) - Date.parse(`${samedi}T12:00:00Z`)) / 86400000);
      assert.ok(jours >= 9 && jours <= 15, `${f.cle} ${annee} : ${jours} jours d'avance`);
    }
  }
});

test("l'alerte apparaît le bon samedi et pas la veille", () => {
  assert.equal(F.alertes("2026-10-02").length, 0, "le vendredi 2, rien");
  const samedi = F.alertes("2026-10-03");
  assert.equal(samedi.length, 1, "le samedi 3, elle sort");
  assert.deepEqual(cles(samedi[0]), ["actionDeGrace"]);
});

test("l'alerte reste jusqu'au férié, puis s'arrête", () => {
  for (const jour of ["2026-10-03", "2026-10-07", "2026-10-11", "2026-10-12"]) {
    assert.equal(F.alertes(jour).length, 1, `elle devrait être là le ${jour}`);
  }
  // Une fois l'Action de grâce passée, « commande d'avance » ne veut plus rien dire.
  assert.equal(F.alertes("2026-10-13").length, 0, "le lendemain, elle est partie");
});

test("une semaine qui porte trois journées ne donne qu'une alerte", () => {
  // Vendredi saint (26 mars 2027) et dimanche de Pâques (28) sont dans la même semaine :
  // une semaine, une commande, une alerte.
  const a = F.alertes("2027-03-13");
  assert.equal(a.length, 1);
  assert.deepEqual(cles(a[0]), ["vendrediSaint", "dimanchePaques"]);
});

test("le lundi de Pâques a sa propre alerte, une semaine plus tard", () => {
  // Il tombe dans la semaine SUIVANTE, donc il relève d'une autre commande. Deux alertes
  // décalées d'une semaine, c'est exactement ce qu'il faut.
  assert.equal(F.samediDAlerte(F.lundiDe("2027-03-29").toISOString().slice(0, 10)), "2027-03-20");
  const a = F.alertes("2027-03-20");
  assert.equal(a.length, 2, "les deux se chevauchent ce samedi-là");
  assert.deepEqual(cles(a[0]), ["vendrediSaint", "dimanchePaques"]);
  assert.deepEqual(cles(a[1]), ["lundiPaques"]);
});

test("Noël et le Jour de l'An se préparent en parallèle à la mi-décembre", () => {
  assert.deepEqual(F.alertes("2026-12-12").map(cles), [["noel"]]);
  // Le 19, les deux commandes sont en jeu : celle de la semaine de Noël et celle d'après.
  assert.deepEqual(F.alertes("2026-12-19").map(cles), [["noel"], ["jourDeLAn"]]);
  assert.deepEqual(F.alertes("2026-12-26").map(cles), [["jourDeLAn"]]);
});

test("une alerte à cheval sur deux années se calcule quand même", () => {
  // La semaine du 28 décembre 2026 contient le 1er janvier 2027 : l'alerte sort en 2026
  // pour une journée de 2027.
  const a = F.alertes("2026-12-19").find((x) => cles(x).includes("jourDeLAn"));
  assert.ok(a, "le Jour de l'An doit être trouvé depuis décembre");
  assert.equal(a.debutISO, "2026-12-19");
  assert.equal(a.finISO, "2027-01-01");
});

test("une journée ordinaire ne déclenche aucune alerte", () => {
  for (const jour of ["2026-09-27", "2026-11-15", "2027-08-03"]) {
    assert.deepEqual(F.alertes(jour), [], jour);
  }
});

test("une date abîmée ne fait pas planter l'ouverture de l'app", () => {
  // L'alerte se calcule au chargement de la page : si elle lève, c'est toute la page qui ne
  // s'affiche plus.
  for (const valeur of [null, undefined, "", "pas une date", 20261003, {}]) {
    assert.deepEqual(F.alertes(valeur), [], `pour ${JSON.stringify(valeur)}`);
  }
});

test("le 25 décembre est la seule journée où le restaurant ferme", () => {
  const fermees = F.feriesDeLAnnee(2027).filter((f) => f.ferme);
  assert.equal(fermees.length, 1);
  assert.equal(fermees[0].cle, "noel");
  // Toutes les autres portent le champ explicitement : « absent » ne doit jamais vouloir
  // dire « ouvert » par accident.
  for (const f of F.feriesDeLAnnee(2027)) assert.equal(typeof f.ferme, "boolean", f.cle);
});

// ------------------------------------------- deux portes, deux propos
//
// « Je veux des notifications pour toutes les fêtes dans les deux horaires. » Les deux portes
// voient donc les MÊMES journées, et c'est le texte qui change. Ces tests verrouillent les
// deux moitiés de cette phrase : l'égalité des journées ici, le texte juste en dessous.
//
// Il y a eu une version où la porte d'horaire ne retenait que les journées d'`affluence` —
// cinq par année. Elle taisait le Vendredi saint, qui change la paie, et le 25 décembre, où
// le restaurant est fermé. `alertes()` n'a plus qu'un paramètre, et ces tests sont là pour
// qu'un filtre ne revienne pas par la porte de derrière.

test("une journée marquée sort, qu'elle remplisse la salle ou non", () => {
  // Fête du Travail 2026 (lundi 7 septembre) : un férié que la salle ne remplit pas. Avant,
  // c'est exactement celle-là qui ne sortait jamais sur un lien d'horaire.
  const travail = F.alertes("2026-09-01");
  assert.equal(travail.length, 1);
  assert.deepEqual(travail[0].journees.map((j) => j.cle), ["feteDuTravail"]);
  assert.equal(travail[0].journees[0].affluence, false, "elle ne remplit pas la salle");

  // Fête des Mères 2026 (dimanche 10 mai) : l'inverse, elle remplit la salle sans être un
  // férié. Elle sortait déjà, et elle sort encore.
  const mai = F.alertes("2026-05-02");
  assert.equal(mai.length, 1);
  assert.deepEqual(mai[0].journees.map((j) => j.cle), ["feteDesMeres"]);
});

test("une semaine mêlée garde ses journées ensemble", () => {
  // Semaine de Pâques 2026 : Vendredi saint le 3 (férié, pas d'affluence) et le dimanche 5
  // (affluence, pas férié). Une semaine = une alerte, et elle porte les deux.
  //
  // Le lundi de Pâques, lui, tombe la semaine SUIVANTE : c'est une autre commande, donc sa
  // propre alerte — et le 3 avril les deux sont déjà ouvertes en même temps.
  assert.deepEqual(
    F.alertes("2026-04-03").map((a) => a.journees.map((j) => j.cle)),
    [["vendrediSaint", "dimanchePaques"], ["lundiPaques"]]
  );
  // Celle de Pâques s'arrête au dimanche, la dernière journée marquée de SA semaine.
  assert.equal(F.alertes("2026-04-03")[0].finISO, "2026-04-05");
  assert.deepEqual(
    F.alertes("2026-04-06").map((a) => a.journees.map((j) => j.cle)),
    [["lundiPaques"]],
    "le dimanche passé, il ne reste que la sienne"
  );
});

test("alertes() ne prend qu'un argument", () => {
  // Un second paramètre a existé ici. Si quelqu'un le remet, ce test tombe — et c'est le but,
  // parce qu'un filtre silencieux rendrait des fêtes invisibles sans que rien ne le dise.
  assert.equal(F.alertes.length, 1);
  assert.deepEqual(
    F.alertes("2026-09-01").map((a) => a.journees.map((j) => j.cle)),
    F.alertes("2026-09-01", (j) => j.affluence).map((a) => a.journees.map((j) => j.cle)),
    "un second argument ne doit plus rien changer"
  );
});

// --------------------------------------------- ce que chaque porte LIT
//
// alerte-ferie.js se charge avec un faux `window` : son contenu se construit en chaîne, sans
// toucher au DOM, donc on peut le relire ici. C'est le seul endroit où l'on vérifie que les
// deux modes disent deux choses différentes des mêmes journées.

function texteDe(iso, mode) {
  const fenetre = { Feries: F };
  global.window = fenetre;
  delete require.cache[require.resolve("../public/shared/alerte-ferie.js")];
  require("../public/shared/alerte-ferie.js");
  const alertes = F.alertes(iso);
  assert.ok(alertes.length > 0, `aucune alerte le ${iso}`);
  return fenetre.AlerteFerie._contenuHTML(alertes, "fr", false, mode);
}

test("le mode avis parle de paie et de monde, jamais de fournisseurs", () => {
  // Fête du Travail : un férié tranquille. Le lien d'horaire doit dire que la paie change.
  const avis = texteDe("2026-09-01", "avis");
  assert.match(avis, /Fête à venir/);
  assert.match(avis, /Fête du Travail/);
  assert.match(avis, /la paie n'est pas la même/);
  assert.doesNotMatch(avis, /fournisseur/i, "ces portes-là ne commandent rien");
  assert.doesNotMatch(avis, /épicerie/i);
  // Pas de liste de rappels, ni du texte ni du bouton qui l'ouvre.
  assert.doesNotMatch(avis, /Tes rappels/);
  assert.doesNotMatch(avis, /Modifier la liste/);
});

test("le mode commande parle de la commande", () => {
  const commande = texteDe("2026-09-01", "commande");
  assert.match(commande, /Commande à prévoir/);
  assert.match(commande, /Commande d'avance/);
  assert.doesNotMatch(commande, /la paie n'est pas la même/, "ce n'est pas sa question");
});

test("Noël : les deux portes le disent, chacune à sa façon", () => {
  // 25 décembre, la seule journée de fermeture. C'est la journée qu'un filtre d'affluence
  // cachait le plus gravement : fermé, et personne n'était prévenu sur le lien d'horaire.
  const avis = texteDe("2026-12-12", "avis");
  assert.match(avis, /Le restaurant est fermé le vendredi 25 décembre\./);
  assert.doesNotMatch(avis, /réouverture/, "l'avis s'arrête au fait, sans consigne de commande");

  const commande = texteDe("2026-12-12", "commande");
  assert.match(commande, /Le restaurant est fermé le vendredi 25 décembre\./);
  assert.match(commande, /jusqu'à la réouverture/);
});

test("une journée d'affluence met du monde au plancher des deux bords", () => {
  const avis = texteDe("2026-05-02", "avis");
  assert.match(avis, /La salle va être pleine/);
  assert.match(avis, /monde au plancher/);
  assert.doesNotMatch(avis, /la paie n'est pas la même/, "la fête des Mères n'est pas un férié");

  const commande = texteDe("2026-05-02", "commande");
  assert.match(commande, /Prévois le stock/);
});
