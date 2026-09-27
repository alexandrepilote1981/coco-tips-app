// Les disponibilités disent l'habitude d'une personne : « pas avant 9h le mardi ». Ce
// fichier existe surtout pour verrouiller deux choses qu'on pourrait casser sans s'en
// apercevoir : le défaut (qui ne doit JAMAIS barrer quelqu'un qui n'a rien rempli) et la
// différence entre « j'ai dit oui à tout » et « j'ai jamais ouvert la page ».

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../public/shared/disponibilites.js");

test("lundi est le jour 0, comme dans les grilles d'horaire", () => {
  // 21 septembre 2026 est un lundi, le 27 un dimanche.
  assert.equal(D.jourDeSemaine("2026-09-21"), 0, "lundi");
  assert.equal(D.jourDeSemaine("2026-09-24"), 3, "jeudi");
  assert.equal(D.jourDeSemaine("2026-09-26"), 5, "samedi");
  assert.equal(D.jourDeSemaine("2026-09-27"), 6, "dimanche");
});

test("une date abîmée ne fait pas lire la mauvaise ligne", () => {
  for (const valeur of [null, undefined, "", "pas une date", 20260921, {}]) {
    assert.equal(D.jourDeSemaine(valeur), null, JSON.stringify(valeur));
  }
});

test("sans rien de rempli, la semaine est disponible au complet", () => {
  // C'est LA règle de sûreté : quelqu'un qui n'a jamais ouvert la page reste cédulable.
  const s = D.semaine([]);
  assert.equal(s.length, 7);
  for (const j of s) {
    assert.equal(j.disponible, true);
    assert.equal(j.heure_debut, "");
    assert.equal(j.heure_fin, "");
  }
});

test("la semaine est toujours complète, même avec une seule ligne enregistrée", () => {
  const s = D.semaine([{ jour: 2, disponible: false }]);
  assert.equal(s.length, 7, "l'affichage ne doit jamais avoir à gérer un trou");
  assert.equal(s[2].disponible, false);
  assert.equal(s[0].disponible, true, "les autres gardent le défaut");
});

test("« a répondu » se lit dans l'existence des lignes, pas dans leur contenu", () => {
  // Sans ça, « dispo partout » et « jamais ouvert la page » seraient identiques, et on ne
  // saurait plus qui relancer.
  assert.equal(D.aRepondu([]), false);
  assert.equal(D.aRepondu(null), false);
  assert.equal(D.aRepondu([{ jour: 0, disponible: true }]), true, "même si elle dit oui à tout");
  assert.equal(D.aRepondu([{ jour: 99 }]), false, "une ligne inexploitable ne compte pas");
});

test("une ligne disponible sans heures veut dire toute la journée", () => {
  const n = D.normaliser({ jour: 0, disponible: true });
  assert.equal(n.heure_debut, "");
  assert.equal(n.heure_fin, "");
  assert.equal(D.libelle(n, "fr"), "Toute la journée");
});

test("des heures à l'envers se remettent dans l'ordre", () => {
  const n = D.normaliser({ jour: 1, disponible: true, heure_debut: "15:00", heure_fin: "09:00" });
  assert.equal(n.heure_debut, "09:00");
  assert.equal(n.heure_fin, "15:00");
});

test("une plage de durée nulle retombe sur toute la journée", () => {
  const n = D.normaliser({ jour: 1, disponible: true, heure_debut: "09:00", heure_fin: "09:00" });
  assert.equal(n.heure_debut, "", "une faute de frappe, pas une disponibilité de zéro seconde");
});

test("une heure qui n'en est pas une est ignorée plutôt que gardée", () => {
  const n = D.normaliser({ jour: 1, disponible: true, heure_debut: "25:99", heure_fin: "abc" });
  assert.equal(n.heure_debut, "");
  assert.equal(n.heure_fin, "");
  assert.equal(n.disponible, true);
});

test("un jour qui n'existe pas ne donne pas de ligne", () => {
  for (const jour of [-1, 7, 99, "lundi", null, undefined]) {
    assert.equal(D.normaliser({ jour, disponible: true }), null, JSON.stringify(jour));
  }
});

test("« pas disponible » efface les heures", () => {
  const n = D.normaliser({ jour: 3, disponible: false, heure_debut: "09:00", heure_fin: "15:00" });
  assert.equal(n.heure_debut, "");
  assert.equal(n.heure_fin, "");
});

// ---------------------------------------------------------------- conflits

const LIGNES = [
  { jour: 0, disponible: true },                                        // lundi : toute la journée
  { jour: 1, disponible: true, heure_debut: "09:00" },                  // mardi : pas avant 9h
  { jour: 2, disponible: false },                                       // mercredi : pas dispo
  { jour: 3, disponible: true, heure_fin: "13:00" },                    // jeudi : part à 13h
  { jour: 4, disponible: true, heure_debut: "05:30", heure_fin: "11:00" }, // vendredi : 5h30–11h
];

const quart = (date, debut) => ({ date, start_time: debut, end_time: "15:00" });

test("un quart dans la disponibilité ne dit rien", () => {
  assert.equal(D.conflit(LIGNES, quart("2026-09-21", "05:30")), null, "lundi, toute la journée");
  assert.equal(D.conflit(LIGNES, quart("2026-09-22", "09:00")), null, "mardi, pile à 9h");
  assert.equal(D.conflit(LIGNES, quart("2026-09-22", "10:00")), null, "mardi, après 9h");
  assert.equal(D.conflit(LIGNES, quart("2026-09-25", "05:30")), null, "vendredi, dans la plage");
});

test("un quart un jour marqué « pas disponible » est signalé", () => {
  const c = D.conflit(LIGNES, quart("2026-09-23", "08:00"));
  assert.ok(c);
  assert.equal(c.raison, "absent");
});

test("un quart avant l'heure déclarée est signalé", () => {
  const c = D.conflit(LIGNES, quart("2026-09-22", "05:30"));
  assert.ok(c, "mardi 5h30 alors qu'elle a dit 9h");
  assert.equal(c.raison, "heures");
  assert.equal(c.dispo.heure_debut, "09:00", "l'heure déclarée revient, pour pouvoir la dire");
});

test("un quart qui commence après l'heure de fin déclarée est signalé", () => {
  const c = D.conflit(LIGNES, quart("2026-09-24", "13:00"));
  assert.ok(c, "jeudi 13h alors qu'elle part à 13h");
  assert.equal(c.raison, "heures");
  assert.equal(D.conflit(LIGNES, quart("2026-09-24", "12:45")), null, "juste avant, rien à dire");
});

test("seule l'heure de DÉBUT est comparée", () => {
  // En salle, la fin d'un quart n'est jamais celle qui est inscrite — une serveuse part
  // quand la salle est vide. Comparer les fins donnerait des avertissements faux en
  // permanence, et un avertissement qui crie toujours, on cesse de le lire.
  const tard = { date: "2026-09-25", start_time: "06:00", end_time: "23:00" };
  assert.equal(D.conflit(LIGNES, tard), null, "vendredi : commence dans la plage, finit après");
});

test("un jour jamais rempli n'accroche sur rien", () => {
  assert.equal(D.conflit(LIGNES, quart("2026-09-26", "05:30")), null, "samedi, jamais rempli");
  assert.equal(D.conflit([], quart("2026-09-23", "05:30")), null, "personne n'a rien rempli");
});

test("un quart abîmé ne fait pas planter la grille", () => {
  // La grille appelle conflit() pour chaque case : si ça lève, c'est toute la semaine qui
  // cesse de s'afficher.
  for (const q of [null, undefined, {}, { date: "pas une date", start_time: "05:30" }, { date: "2026-09-22" }]) {
    assert.doesNotThrow(() => D.conflit(LIGNES, q), JSON.stringify(q));
  }
  assert.equal(D.conflit(LIGNES, { date: "2026-09-22", start_time: "pas une heure" }), null);
});

test("les libellés disent la bonne chose dans les deux langues", () => {
  assert.equal(D.libelle({ jour: 0, disponible: false }, "fr"), "Pas disponible");
  assert.equal(D.libelle({ jour: 0, disponible: false }, "en"), "Not available");
  assert.equal(D.libelle({ jour: 1, disponible: true, heure_debut: "09:00" }, "fr"), "À partir de 09:00");
  assert.equal(D.libelle({ jour: 1, disponible: true, heure_fin: "13:00" }, "fr"), "Jusqu'à 13:00");
  assert.equal(D.libelle({ jour: 1, disponible: true, heure_debut: "05:30", heure_fin: "11:00" }, "en"), "From 05:30 to 11:00");
  for (const lang of ["fr", "en"]) {
    for (const j of D.JOURS) assert.ok(D.nomDuJour(j, lang).length > 0, `jour ${j} en ${lang}`);
  }
});
