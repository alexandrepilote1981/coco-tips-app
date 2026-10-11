// Les périodes de paye. Ce qui se joue ici : des totaux qu'on compare à un talon de paye.
// Une borne d'un jour de travers et le chiffre affiché ne correspond à rien, sans que rien
// n'ait l'air anormal.

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/shared/periode-paye.js");

test("le lundi d'une semaine, y compris le piège du dimanche", () => {
  // 2026-10-05 est un lundi ; le 11 est le dimanche de la MÊME semaine.
  assert.equal(P.lundiDe("2026-10-05"), "2026-10-05", "un lundi est son propre lundi");
  assert.equal(P.lundiDe("2026-10-07"), "2026-10-05");
  // Le piège : getDay() rend 0 le dimanche, donc « 1 - jour » le ferait avancer d'un jour
  // au lieu de reculer de six. La paye commencerait le lendemain.
  assert.equal(P.lundiDe("2026-10-11"), "2026-10-05", "un dimanche appartient à la semaine qui vient de finir");
  assert.equal(P.lundiDe("2026-10-12"), "2026-10-12", "et le lundi suivant ouvre la sienne");
});

test("une date qui n'en est pas une ne devine rien", () => {
  for (const faux of ["", null, undefined, "demain", "2026-2-3", "2026-13-01"]) {
    assert.equal(P.lundiDe(faux), null, JSON.stringify(faux));
    assert.equal(P.periode(faux, "2026-10-07", 0), null);
    assert.equal(P.periode("2026-10-05", faux, 0), null);
  }
});

test("la période court du lundi au dimanche, quatorze jours plus tard", () => {
  const p = P.periode("2026-10-05", "2026-10-07", 0);
  assert.equal(p.debut, "2026-10-05");
  assert.equal(p.fin, "2026-10-18", "14 jours : lundi au DIMANCHE de la semaine suivante");
  assert.equal(p.index, 0);
  assert.equal(P.estLundi(p.debut), true);
});

test("les bornes appartiennent à leur période, pas à la voisine", () => {
  // C'est la borne qui compte : un dimanche de fin de paye qui bascule dans la suivante
  // déplace une journée de travail d'un talon à l'autre.
  assert.equal(P.periode("2026-10-05", "2026-10-05", 0).index, 0, "le premier jour");
  assert.equal(P.periode("2026-10-05", "2026-10-18", 0).index, 0, "le dernier jour");
  assert.equal(P.periode("2026-10-05", "2026-10-19", 0).index, 1, "le lendemain ouvre la suivante");
});

test("on recule et on avance d'une paye à l'autre", () => {
  const precedente = P.periode("2026-10-05", "2026-10-07", -1);
  assert.deepEqual([precedente.debut, precedente.fin], ["2026-09-21", "2026-10-04"]);
  const suivante = P.periode("2026-10-05", "2026-10-07", 1);
  assert.deepEqual([suivante.debut, suivante.fin], ["2026-10-19", "2026-11-01"]);
  assert.equal(P.periode("2026-10-05", "2026-10-07", -3).index, -3);
});

test("une paye d'AVANT l'ancre se calcule aussi", () => {
  // Il règle son ancre en octobre et veut revenir sur septembre. `Math.floor` sur un écart
  // négatif fait le travail ; `Math.trunc` rangerait les treize jours d'avant l'ancre dans
  // la période courante et gonflerait la paye en cours.
  const p = P.periode("2026-10-05", "2026-10-04", 0);
  assert.equal(p.index, -1);
  assert.deepEqual([p.debut, p.fin], ["2026-09-21", "2026-10-04"]);
  const vieille = P.periode("2026-10-05", "2026-09-21", 0);
  assert.equal(vieille.index, -1, "le premier jour de la période -1 y est encore");
  assert.equal(P.periode("2026-10-05", "2026-09-20", 0).index, -2);
});

test("une ancre qui n'est pas un lundi est ramenée à son lundi", () => {
  // Le réglage vient d'un calendrier où le doigt glisse. Une paye qui commencerait un mardi
  // fausserait tout sans rien afficher d'anormal, donc on corrige plutôt que d'accepter.
  for (const presqueLundi of ["2026-10-07", "2026-10-11", "2026-10-05"]) {
    const p = P.periode(presqueLundi, "2026-10-07", 0);
    assert.equal(p.debut, "2026-10-05", `${presqueLundi} doit retomber sur son lundi`);
    assert.equal(P.estLundi(p.debut), true);
  }
});

test("le changement d'heure ne décale pas la paye", () => {
  // L'heure d'automne au Québec tombe le premier dimanche de novembre. À minuit local, une
  // date reculerait d'un cran et la paye commencerait un dimanche. Tout passe donc par midi
  // UTC, comme feries.js.
  const p = P.periode("2026-10-05", "2026-11-03", 0);
  assert.equal(P.estLundi(p.debut), true);
  assert.deepEqual([p.debut, p.fin], ["2026-11-02", "2026-11-15"]);
  // Et au printemps.
  const mars = P.periode("2026-10-05", "2027-03-10", 0);
  assert.equal(P.estLundi(mars.debut), true);
});

test("un an de périodes s'enchaîne sans trou ni recouvrement", () => {
  // La vraie garantie : chaque journée appartient à exactement UNE paye. Un trou d'un jour
  // ferait disparaître une journée déclarée de tous les talons.
  let precedente = null;
  for (let i = -13; i <= 13; i++) {
    const p = P.periode("2026-10-05", "2026-10-07", i);
    assert.equal(P.estLundi(p.debut), true, `période ${i}`);
    if (precedente) {
      const lendemain = P.periode("2026-10-05", p.debut, 0);
      assert.equal(lendemain.index, p.index, "le premier jour appartient bien à sa période");
      assert.equal(
        new Date(p.debut + "T12:00:00Z") - new Date(precedente.fin + "T12:00:00Z"),
        86400000,
        `pas de trou entre ${precedente.fin} et ${p.debut}`
      );
    }
    precedente = p;
  }
});

test("reculer et avancer d'un jour ne saute rien, même aux changements d'heure", () => {
  // Demandé ainsi : « valide qu'il n'y a pas de décalage de date à venir ». Le pas est
  // volontairement de l'arithmétique PURE sur une date déjà fixée — pas de `new Date()` à
  // chaque clic — donc le fuseau de l'appareil ne peut plus s'en mêler. Ce test verrouille
  // ça aux quatre endroits où une erreur de fuseau se verrait.
  const jours = (a, b) => (new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000;
  for (const autour of [
    "2026-11-01", // changement d'heure d'automne au Québec
    "2027-03-14", // changement d'heure du printemps
    "2027-01-01", // le Nouvel An
    "2028-02-29", // un 29 février
  ]) {
    const vus = [];
    for (let d = -5; d <= 5; d++) vus.push(P.decalerJour(autour, d));
    for (let i = 1; i < vus.length; i++) {
      assert.equal(jours(vus[i - 1], vus[i]), 1, `${vus[i - 1]} → ${vus[i]} autour du ${autour}`);
    }
    assert.equal(new Set(vus).size, vus.length, `une journée revient deux fois autour du ${autour}`);
    assert.equal(P.decalerJour(autour, 0), autour, "décalage nul = la même journée");
  }
});

test("un décalage de journée sur une date impossible ne devine rien", () => {
  for (const faux of ["", null, undefined, "demain", "2026-13-01", "2027-02-30"]) {
    assert.equal(P.decalerJour(faux, -1), null, JSON.stringify(faux));
  }
  // Un décalage de travers vaut zéro : mieux vaut rester sur aujourd'hui que sauter au
  // hasard dans le calendrier.
  assert.equal(P.decalerJour("2026-10-11", "n'importe quoi"), "2026-10-11");
  assert.equal(P.decalerJour("2026-10-11", undefined), "2026-10-11");
});
