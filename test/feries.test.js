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

// ------------------------------------------- deux portes, deux questions
//
// La cuisine veut savoir quand COMMANDER, la salle quand il faudra PLUS DE MONDE. Ce ne sont
// pas les mêmes journées, et c'est tout l'intérêt d'avoir gardé `type` et `affluence` comme
// deux faits séparés.

test("le filtre de la salle ne retient que les journées qui la remplissent", () => {
  const salle = (iso) => F.alertes(iso, (j) => j.affluence);

  // Fête des Mères 2026 : dimanche 10 mai. Elle remplit la salle sans être un férié.
  const mai = salle("2026-05-02");
  assert.equal(mai.length, 1);
  assert.deepEqual(mai[0].journees.map((j) => j.cle), ["feteDesMeres"]);

  // Fête du Travail : un férié que la salle n'a aucune raison de préparer autrement — les
  // fournisseurs ferment, mais la salle ne se remplit pas plus que d'habitude.
  assert.ok(
    F.alertes("2026-09-01").length > 0,
    "la cuisine, elle, a bien une alerte cette semaine-là"
  );
  assert.equal(salle("2026-09-01").length, 0, "la salle n'en a aucune");

  // Et l'inverse d'une semaine mêlée : la Saint-Jean et la fête du Canada sont des fériés,
  // la fête des Pères remplit la salle. La salle ne garde que la troisième.
  assert.deepEqual(
    salle("2026-06-20").map((a) => a.journees.map((j) => j.cle)),
    [["feteDesPeres"]]
  );
});

test("sans filtre, rien ne change pour la cuisine", () => {
  // La signature a gagné un second paramètre ; les appels d'avant doivent se comporter
  // exactement pareil.
  assert.deepEqual(
    F.alertes("2026-05-02").map((a) => a.journees.map((j) => j.cle)),
    F.alertes("2026-05-02", null).map((a) => a.journees.map((j) => j.cle))
  );
});

test("la fenêtre de la salle se ferme quand SA journée est passée, pas celle du férié", () => {
  // Semaine de Pâques 2026 : Vendredi saint le 3 avril (férié, pas d'affluence) et le
  // dimanche 5 (affluence, pas férié). Le filtre doit s'appliquer AVANT le regroupement,
  // sinon la fenêtre de la salle resterait ouverte jusqu'au dernier férié de la semaine.
  const paques = F.alertes("2026-04-05", (j) => j.affluence);
  assert.equal(paques.length, 1);
  assert.equal(paques[0].finISO, "2026-04-05", "elle s'arrête au dimanche, sa grosse journée");

  // Le lundi de Pâques est un férié : la cuisine a encore une alerte, la salle non.
  assert.ok(F.alertes("2026-04-06").length > 0);
  assert.equal(F.alertes("2026-04-06", (j) => j.affluence).length, 0);
});

test("les journées qui remplissent la salle sont celles qu'on attend", () => {
  // Cinq par année. Assez rare pour qu'une annonce se lise encore quand elle sort.
  const grosses = F.feriesDeLAnnee(2026).filter((j) => j.affluence).map((j) => j.cle);
  assert.deepEqual(grosses.sort(), [
    "actionDeGrace", "dimanchePaques", "feteDesMeres", "feteDesPeres", "saintValentin",
  ]);
});
