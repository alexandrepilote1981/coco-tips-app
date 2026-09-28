// Grille d'horaire hebdomadaire — SOURCE UNIQUE, partagée par /admin et /horaire.
//
// Ces deux pages affichent exactement la même grille lundi → dimanche, avec la même fenêtre
// de modification de quart, la même copie vers la semaine suivante et le même bouton PDF.
// Tout ça existait en double, recopié d'un fichier à l'autre : ajouter le bouton PDF a
// demandé de faire six fois les mêmes modifications, deux fois de suite.
//
// Ce qui diffère réellement entre les deux pages, ce n'est pas l'affichage — c'est la façon
// de parler au serveur (jeton admin d'un côté, code de restaurant de l'autre) et l'endroit
// où vivent les données de la page. Ces différences passent par l'objet « host » fourni à
// init(), et tout le reste est commun.
//
// Contrat attendu du host :
//   t(cle, ...args)        traduction
//   icon(nom, taille)      icône SVG
//   lang()                 "fr" | "en"
//   restaurants()          [{ id, name, employees: [{ id, name }] }]
//   shifts()               tableau des quarts actuellement chargés
//   heuresAilleurs()       [{ employee_id, date, heures }] — les heures faites dans L'AUTRE
//                          secteur, pour les employés qui travaillent des deux bords.
//                          Facultatif : le tableau de bord a déjà tous les quarts, seules
//                          les portes par code en ont besoin (elles ne reçoivent que les
//                          quarts de leur secteur, et ne pourraient donc pas compter le reste).
//   setShifts(tableau)     remplace ce tableau
//   reloadShifts()         recharge les quarts depuis le serveur (async)
//   absences()             congés et vacances chargés
//   setAbsences(tableau)   remplace ce tableau
//   reloadAbsences()       recharge les absences depuis le serveur (async)
//   shiftApi(chemin, opts) appelle l'API des quarts ; chemin = "/shifts" ou "/shifts/ID"
//   pdfRequest(idResto, semaineISO, langue)  -> { url, options } pour le téléchargement
//   rerender()             redessine la page

window.ScheduleUI = (function () {
  let host = null;

  // La semaine affichée vit ici : les deux pages la manipulaient à l'identique.
  let weekStart = getMonday(new Date());

  function init(h) {
    host = h;
  }

  // ---------- dates ----------

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay(); // 0 = dimanche .. 6 = samedi
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day)); // recule jusqu'au lundi
    date.setHours(0, 0, 0, 0);
    return date;
  }
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function weekDates(start) {
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  function todayISO() {
    return isoDate(new Date());
  }
  function fmtTime(tm) {
    return tm || "";
  }
  function fmtWeekLabel(start) {
    const end = addDays(start, 6);
    const startStr = start.toLocaleDateString(host.t("locale"), { day: "numeric" });
    const endStr = end.toLocaleDateString(host.t("locale"), { day: "numeric", month: "long" });
    return host.t("semaineDu", startStr, endStr);
  }

  const ROLES = {
    server: { fr: "Serveur", en: "Server" },
    hostess: { fr: "Hôtesse", en: "Host" },
    cuisinier: { fr: "Cuisinier", en: "Cook" },
    plongeur: { fr: "Plongeur", en: "Dishwasher" },
  };

  // Chaque secteur a ses propres postes : proposer « Hôtesse » à un plongeur n'a aucun sens,
  // et l'inverse non plus.
  const ROLES_PAR_SECTEUR = {
    salle: ["server", "hostess"],
    cuisine: ["cuisinier", "plongeur"],
  };

  function rolesDe(secteur) {
    return ROLES_PAR_SECTEUR[secteur] || ROLES_PAR_SECTEUR.salle;
  }

  // Une même page peut afficher deux grilles (la salle et la cuisine). Les boutons portent
  // donc leur secteur, et on garde ici de quoi retrouver le contexte de chacune au moment du
  // clic — les nœuds sont refaits à chaque rendu, mais pas cet objet.
  const contextes = {};
  const secteurParEmploye = {};
  // Quelles sections « Congés » sont dépliées. Comme pour le reste, ça vit ici et pas dans le
  // HTML : render() refait toute la page, et une section qui se referme à chaque
  // rafraîchissement serait insupportable.
  // Quelles sections « liens » sont dépliées, même logique que les congés : ça vit ici parce
  // que les nœuds sont refaits à chaque rendu.
  const liensOuverts = new Set();
  const congesOuverts = new Set();

  function cle(restaurantId, secteur) {
    return `${restaurantId}:${secteur}`;
  }

  function contexteDe(restaurantId, secteur) {
    return contextes[cle(restaurantId, secteur)] || { secteur: secteur || "salle", employees: [], peutModifier: true, voitMontants: false, chargesPct: 0 };
  }

  // Les quarts de CETTE grille, et rien d'autre.
  //
  // Le piège qu'on ferme ici : la grille suppose UN quart par personne par jour (elle fait
  // un `find` sur employé + date). Tant qu'une personne n'était que d'un bord, c'était vrai.
  // Un employé qui travaille des deux bords peut avoir un quart de cuisine le lundi et un
  // quart de salle le mardi — sans ce filtre, chaque grille attraperait le quart de l'autre,
  // et pire, « effacer la semaine » depuis la cuisine effacerait les quarts de salle.
  //
  // C'est le POSTE du quart qui tranche, jamais le secteur de la personne : voir
  // public/shared/secteurs.js.
  function quartsDe(secteur) {
    const S = window.Secteurs;
    const quarts = host.shifts();
    // Sans le module — un vieux cache qui n'a pas rechargé la page — mieux vaut tout
    // montrer que vider la grille : une grille vide se lit comme une semaine non faite.
    if (!S) return quarts;
    return quarts.filter((q) => S.duRole(q.role) === S.valide(secteur));
  }

  // Ce que la semaine affichée va coûter — et surtout combien elle coûte DE MOINS que la
  // précédente. C'est le troisième chiffre qui compte : un total tout seul ne dit rien, un
  // total qui baisse se regarde. Et c'est le coût du PLAN : personne ne poinçonne.
  function barreCoutHTML(restaurantId, secteur, employees, chargesPct, actuelle) {
    const t = host.t;
    const lang = host.lang();
    const C = window.CoutMainOeuvre;
    const quarts = quartsDe(secteur);

    const precedente = C.coutSurPeriode(employees, quarts, weekDates(addDays(weekStart, -7)).map(isoDate), chargesPct);
    const diff = C.ecart(actuelle, precedente);
    const sens = diff.cout < -0.005 ? "baisse" : diff.cout > 0.005 ? "hausse" : "egal";

    return `
      <div class="cout-bar" data-resto="${restaurantId}" data-secteur="${secteur}">
        <div class="cout-bloc">
          <div class="cout-etiq">${t("heuresSemaine")}</div>
          <div class="cout-val">${C.fmtHeures(actuelle.heures, lang)}</div>
        </div>
        <div class="cout-bloc">
          <div class="cout-etiq">${t("masseSalariale")}</div>
          <div class="cout-val cout-gros">${C.fmtMontant(actuelle.cout, lang)}</div>
        </div>
        <div class="cout-bloc">
          <div class="cout-etiq">${t("vsSemainePassee")}</div>
          <div class="cout-val cout-${sens}">${C.fmtEcart(diff.cout, lang)}</div>
        </div>
      </div>
      <div class="cout-notes">
        <span>${chargesPct > 0 ? t("chargesIncluses", chargesPct) : t("chargesNonIncluses")}</span>
        ${actuelle.sansTaux > 0 ? `<span class="cout-manque">${t("employesSansTaux", actuelle.sansTaux)}</span>` : ""}
      </div>
    `;
  }

  // Largeur minimale d'une colonne de jour. En dessous, tout se coupe : sur un téléphone,
  // « 08:00 » devenait « 08:0 » et « Serveur » devenait « Ser… ». La grille glisse
  // latéralement plutôt que d'écraser ce qu'on est venu lire.
  //
  // La cuisine en demande plus : elle affiche une plage (« 17:30–01:30 »), et lui donner la
  // place de tenir sur une seule ligne garde aussi la case à la même hauteur qu'ailleurs.
  // 96 px en cuisine : c'est ce qu'il faut pour qu'une tâche de longueur maximale
  // (TACHE_MAX, soit « Commande à défaire ») s'écrive en entier plutôt que de finir en « … ».
  const COLONNE_MIN = { salle: 62, cuisine: 100 };

  // ---------- congés et vacances ----------

  function absencesDuSecteur(employees) {
    const ids = new Set(employees.map((e) => e.id));
    return (host.absences ? host.absences() : []).filter((a) => ids.has(a.employee_id));
  }

  // Les disponibilités de ces employés-là. Même patron que les absences : l'hôte les fournit,
  // la grille ne sait pas d'où elles viennent.
  function disposDeEmploye(employeeId) {
    return (host.disponibilites ? host.disponibilites() : []).filter((d) => d.employee_id === employeeId);
  }

  // Qui n'a jamais rempli. On regarde l'absence de lignes, pas leur contenu : quelqu'un qui
  // a répondu « disponible partout » et quelqu'un qui n'a jamais ouvert sa page ont la même
  // disponibilité effective, mais pas du tout le même besoin de relance.
  function jamaisRepondu(employees) {
    return employees.filter((e) => !window.Disponibilites.aRepondu(disposDeEmploye(e.id)));
  }

  // Les liens personnels à distribuer à l'équipe. N'apparaît que là où l'hôte les fournit :
  // le tableau de bord a déjà sa propre liste, et les portes sans droit ne les reçoivent
  // même pas du serveur.
  function blocLiensHTML(restaurantId, secteur, employees) {
    if (!host.liensEmployes) return "";
    const liens = host.liensEmployes();
    if (!liens) return "";
    const avecLien = employees.filter((e) => liens[e.id]);
    if (avecLien.length === 0) return "";

    const cleSection = cle(restaurantId, secteur);
    const ouvert = liensOuverts.has(cleSection);
    const marque = `data-resto="${restaurantId}" data-secteur="${secteur}"`;
    const manquants = avecLien.filter((e) => !window.Disponibilites.aRepondu(disposDeEmploye(e.id))).length;

    return `
    <button class="liens-toggle ${ouvert ? "ouvert" : ""}" data-action="toggleLiens" ${marque}>
      <span class="conges-fleche">${ouvert ? "▾" : "▸"}</span>
      ${host.icon("copy", 13)} ${host.t("liensTitre", avecLien.length, manquants)}
    </button>
    <div class="liens-body" style="display:${ouvert ? "block" : "none"};">
      <p class="liens-aide">${host.t("liensAide")}</p>
      ${avecLien
        .map((e) => {
          const aRepondu = window.Disponibilites.aRepondu(disposDeEmploye(e.id));
          return `
        <div class="lien-ligne">
          <div class="lien-nom">
            ${echapper(e.name)}
            ${aRepondu ? "" : `<span class="lien-relance">${host.t("liensPasRempli")}</span>`}
          </div>
          <div class="lien-boite">${echapper(liens[e.id])}</div>
          <button class="copy-btn" data-action="copyLien" data-lien="${echapper(liens[e.id])}">${host.t("liensCopier")}</button>
        </div>`;
        })
        .join("")}
    </div>`;
  }

  function nomDeEmploye(employees, id) {
    const e = employees.find((x) => x.id === id);
    return e ? e.name : "";
  }

  // Posés d'avance pour ne pas les oublier. La liste ne suffit pas — personne ne va la relire
  // à chaque quart — d'où le marquage dans la grille elle-même, plus bas.
  function blocCongesHTML(restaurantId, secteur, employees, peutModifier) {
    const t = host.t;
    const icon = host.icon;
    const lang = host.lang();
    const A = window.Absences;
    const cleSection = cle(restaurantId, secteur);
    const ouvert = congesOuverts.has(cleSection);
    const marque = `data-resto="${restaurantId}" data-secteur="${secteur}"`;
    const aVenir = A.prochaines(absencesDuSecteur(employees), todayISO());

    return `
    <button class="conges-toggle ${ouvert ? "ouvert" : ""}" data-action="toggleConges" ${marque}>
      <span class="conges-fleche">${ouvert ? "▾" : "▸"}</span>
      ${icon("calendar", 13)} ${t("congesTitre", aVenir.length)}
    </button>
    <div class="conges-body" style="display:${ouvert ? "block" : "none"};">
      ${
        peutModifier
          ? `<div class="conges-form">
        <label>
          <span class="employee-stat-label">${t("congeEmploye")}</span>
          <select class="congeEmploye" ${marque}>
            <option value="">${t("congeChoisir")}</option>
            ${employees.map((e) => `<option value="${e.id}">${echapper(e.name)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span class="employee-stat-label">${t("congeDu")}</span>
          <input type="date" class="congeDebut" ${marque} />
        </label>
        <label>
          <span class="employee-stat-label">${t("congeAu")}</span>
          <input type="date" class="congeFin" ${marque} />
        </label>
        <label>
          <span class="employee-stat-label">${t("congeType")}</span>
          <select class="congeType" ${marque}>
            ${A.TYPES.map((v) => `<option value="${v}">${A.libelleType(v, lang)}</option>`).join("")}
          </select>
        </label>
        <button class="conge-ajouter" data-action="ajouterConge" ${marque}>${t("congeAjouter")}</button>
      </div>`
          : ""
      }
      ${
        aVenir.length === 0
          ? `<p class="conges-vide">${t("congeAucun")}</p>`
          : `<div class="conges-liste">${aVenir
              .map(
                (a) => `
        <div class="conge-ligne conge-${a.type}">
          <div>
            <div class="conge-nom">${echapper(nomDeEmploye(employees, a.employee_id))}</div>
            <div class="conge-dates">${A.libelleType(a.type, lang)} · ${A.fmtPeriode(a, lang)} · ${t(
                  "congeJours",
                  A.nombreDeJours(a)
                )}</div>
            ${a.note ? `<div class="conge-note">${echapper(a.note)}</div>` : ""}
          </div>
          ${peutModifier ? `<button class="danger conge-retirer" data-action="retirerConge" data-id="${a.id}" ${marque}>${t("congeRetirer")}</button>` : ""}
        </div>`
              )
              .join("")}</div>`
      }
    </div>`;
  }

  // ---------- grille ----------

  /**
   * @param {object} [options]
   * @param {"salle"|"cuisine"} [options.secteur]
   * @param {boolean} [options.peutModifier]  false = lien en lecture seule (les cuisiniers)
   * @param {boolean} [options.voitMontants]  true = affiche la masse salariale
   * @param {number}  [options.chargesPct]
   */
  function renderWeekGrid(restaurantId, employees, options = {}) {
    const secteur = options.secteur === "cuisine" ? "cuisine" : "salle";
    const peutModifier = options.peutModifier !== false;
    const voitMontants = !!options.voitMontants;
    // Les heures suivent les montants par défaut — c'était le comportement d'avant — mais
    // peuvent s'ouvrir seules : le tableau de bord montre les heures de la salle sans jamais
    // lui inventer de masse salariale.
    const avecHeures = options.avecHeures === undefined ? voitMontants : !!options.avecHeures;
    const chargesPct = options.chargesPct || 0;
    contextes[cle(restaurantId, secteur)] = { secteur, employees, peutModifier, voitMontants, chargesPct };
    for (const emp of employees) secteurParEmploye[emp.id] = secteur;

    const dates = weekDates(weekStart);
    const todayStr = todayISO();
    const t = host.t;
    const icon = host.icon;
    const lang = host.lang();
    const shifts = quartsDe(secteur);
    const marque = `data-resto="${restaurantId}" data-secteur="${secteur}"`;

    // Le bilan sert à la barre de masse salariale : de l'argent, donc la cuisine seulement.
    const bilan = voitMontants
      ? window.CoutMainOeuvre.coutSurPeriode(employees, shifts, dates.map(isoDate), chargesPct)
      : null;

    // Les HEURES sont une autre affaire que l'argent, et elles se donnent à des portes
    // différentes. Un plafond de visa étudiant ou une limite d'overtime se lit en salle
    // comme en cuisine — mais il ne se montre pas à une porte partagée à toute l'équipe :
    // « 15 h / 20 h » sur la rangée de quelqu'un dit à ses collègues qu'il est limité, et
    // pourquoi. D'où une permission séparée de celle des montants.
    const joursHeures = avecHeures ? new Set(dates.map(isoDate)) : null;

    const absences = absencesDuSecteur(employees);

    return `
    ${blocCongesHTML(restaurantId, secteur, employees, peutModifier)}
    ${blocLiensHTML(restaurantId, secteur, employees)}
    ${voitMontants ? barreCoutHTML(restaurantId, secteur, employees, chargesPct, bilan) : ""}
    <div class="week-header">
      <div class="week-title">${fmtWeekLabel(weekStart)}</div>
      <div class="week-nav">
        <button data-action="prevWeek" ${marque}>‹</button>
        <button data-action="thisWeek" ${marque}>${t("aujourdhui")}</button>
        <button data-action="nextWeek" ${marque}>›</button>
      </div>
    </div>
    ${
      peutModifier && jamaisRepondu(employees).length > 0
        ? `<div class="dispo-manquantes">${host.t(
            "disposManquantes",
            jamaisRepondu(employees).length,
            jamaisRepondu(employees).map((e) => echapper(e.name)).join(", ")
          )}</div>`
        : ""
    }
    <div class="week-actions">
      ${peutModifier ? `<button class="duplicate-week-btn" data-action="duplicateWeek" ${marque}>${icon("copy", 13)} ${t("copierSemaineSuivante")}</button>` : ""}
      <button class="pdf-week-btn" data-action="pdfWeek" ${marque}>${icon("download", 13)} ${t("telechargerPdf")}</button>
      <button class="photo-week-btn" data-action="photoWeek" ${marque}>${icon("image", 13)} ${t("photoSemaine")}</button>
      ${peutModifier ? `<button class="clear-week-btn" data-action="clearWeek" ${marque}>${icon("trash2", 13)} ${t("effacerSemaine")}</button>` : ""}
    </div>
    <div class="week-grid ${secteur === "cuisine" ? "grille-cuisine" : ""}" style="grid-template-columns: 96px repeat(7, minmax(${COLONNE_MIN[secteur]}px, 1fr));">
      <div></div>
      ${dates
        .map(
          (d) => `
        ${(() => {
          // Un férié se planifie à l'envers d'une semaine ordinaire : plus de monde, pas
          // moins. Il est donc écrit dans l'en-tête du jour, là où le regard passe déjà en
          // cherchant la date — pas dans une liste à côté que personne ne relit.
          const fete = window.Feries.ferieDuJour(isoDate(d));
          // Une seule couleur pour toutes les journées marquées : elle dit « celle-là n'est
          // pas ordinaire », et le nom écrit en dessous dit laquelle. Le détail qui ne rentre
          // pas dans une colonne va dans l'infobulle, où il ne coûte rien.
          const infobulle = fete
            ? window.Feries.libelle(fete.cle, lang) +
              (window.Feries.estFerie(fete) ? ` · ${window.Feries.mentionFerie(lang)}` : "")
            : "";
          return `
        <div class="day-head ${isoDate(d) === todayStr ? "today" : ""} ${fete ? "jour-marque" : ""}">
          <div class="dow">${d.toLocaleDateString(t("locale"), { weekday: "short" })}</div>
          <div class="dnum">${d.getDate()}</div>
          ${fete ? `<div class="fete" title="${echapper(infobulle)}">${echapper(window.Feries.libelleCourt(fete.cle, lang))}</div>` : ""}
        </div>
      `;
        })()}`
        )
        .join("")}
      ${employees
        .map((emp) => {
          // Une personne qui dépasse son plafond d'heures fait rougir TOUTE sa rangée, pas
          // seulement son nom : c'est en parcourant la semaine du regard qu'on doit le voir.
          const depasse = (bilanEmploye(emp, joursHeures) || {}).depasse ? "depasse" : "";
          return `
        ${empNameCellHTML(emp, joursHeures)}
        ${dates
          .map((d) => {
            const dateStr = isoDate(d);
            const shift = shifts.find((s) => s.employee_id === emp.id && s.date === dateStr);
            // Le congé était noté et quelqu'un a quand même été placé ce jour-là : c'est
            // exactement l'oubli qu'on cherche à empêcher, donc ça se voit de loin.
            const absence = window.Absences.absenceDuJour(absences, emp.id, dateStr);
            // La disponibilité déclarée de cette personne ce jour-là. Elle n'INTERDIT rien —
            // elle pâlit la case et, si on place quand même quelqu'un, elle se signale.
            const dispoJour = window.Disponibilites.duJour(disposDeEmploye(emp.id), dateStr);
            const pasDispo = dispoJour && !dispoJour.disponible;
            const dispoTexte = dispoJour ? window.Disponibilites.libelle(dispoJour, lang) : "";
            const horsDispo = shift && window.Disponibilites.conflit(disposDeEmploye(emp.id), shift);
            // La teinte descend sur toute la colonne : un en-tête coloré seul se perd dès
            // qu'on regarde le bas d'une grille de quatorze personnes.
            const jourMarque = !!window.Feries.ferieDuJour(dateStr);
            // Seule l'heure de début est affichée : la fin d'un quart dépend de l'achalandage
            // et n'est jamais celle qui avait été inscrite. L'afficher donnait une promesse
            // fausse. Elle reste enregistrée — c'est elle qui sert à calculer les heures.
            return `
            <div class="shift-cell ${depasse} ${jourMarque ? "col-marque" : ""}">
              ${
                shift
                  ? `<div class="shift-chip role-${roleSecondaire(shift.role) ? "hostess" : "server"} ${peutModifier ? "" : "lecture"} ${absence ? "conflit" : ""} ${horsDispo ? "hors-dispo" : ""}"
                          ${
                            absence
                              ? `title="${host.t("congeConflit", window.Absences.libelleType(absence.type, lang))}"`
                              : horsDispo
                                ? `title="${echapper(host.t("dispoConflit", dispoTexte))}"`
                                : ""
                          }
                          ${peutModifier ? `data-action="editShift" data-id="${shift.id}"` : ""}>
                       <div class="st">${heuresAffichees(shift, secteur)}</div>
                       <div class="rl">${echapper(libelleRole(shift.role, lang))}</div>
                       ${tacheDuQuart(shift, secteur) ? `<div class="tk">${echapper(tacheDuQuart(shift, secteur))}</div>` : ""}
                     </div>`
                  : absence
                  ? // Une journée d'absence reste cliquable : il arrive qu'on doive quand même
                    // céduler quelqu'un. Mais on ne peut plus le faire sans le savoir.
                    peutModifier
                    ? `<button class="empty-cell absent absent-${absence.type}" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}" data-secteur="${secteur}">${window.Absences.libelleType(absence.type, lang)}</button>`
                    : `<div class="empty-cell lecture absent absent-${absence.type}">${window.Absences.libelleType(absence.type, lang)}</div>`
                  : pasDispo
                  ? peutModifier
                    ? `<button class="empty-cell pas-dispo" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}" data-secteur="${secteur}" title="${echapper(dispoTexte)}">${host.t("dispoCourt")}</button>`
                    : `<div class="empty-cell lecture pas-dispo" title="${echapper(dispoTexte)}">${host.t("dispoCourt")}</div>`
                  : peutModifier
                  ? `<button class="empty-cell ${dispoJour && (dispoJour.heure_debut || dispoJour.heure_fin) ? "dispo-partielle" : ""}" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}" data-secteur="${secteur}" ${dispoJour && (dispoJour.heure_debut || dispoJour.heure_fin) ? `title="${echapper(dispoTexte)}"` : ""}>+</button>`
                  : `<div class="empty-cell lecture">—</div>`
              }
            </div>
          `;
          })
          .join("")}
      `;
        })
        .join("")}
    </div>
  `;
  }

  /**
   * Les AUTRES fiches de la même personne — celles qui portent le même numéro d'employé.
   *
   * Le propriétaire inscrit les gens qui travaillent des deux bords avec une fiche par
   * équipe et le même matricule de paie sur les deux. Ce sont donc deux id différents pour
   * la même personne, et tout ce qui raisonne « par employé » doit les réunir.
   *
   * Le cas qui l'a fait remonter : « Try était cédulée mardi cuisine. Je l'ai ajoutée
   * serveuse et ça rien fait. » L'avertissement de double quart ne cherchait que son id à
   * elle, et son quart de mardi vivait sur l'autre fiche.
   *
   * Ne marche que là où l'effectif COMPLET est connu — le tableau de bord. Une porte par
   * code ne reçoit que son secteur : la fiche jumelle n'y est pas, et c'est le serveur qui
   * envoie ses heures à part (heuresAilleurs). Les deux chemins ne se recouvrent donc jamais,
   * et rien n'est compté deux fois.
   *
   * Jamais sur un numéro vide : sinon toutes les fiches sans matricule n'en feraient qu'une.
   */
  function autresFichesDe(empId) {
    for (const r of host.restaurants() || []) {
      const equipe = r.employees || [];
      const moi = equipe.find((e) => e.id === empId);
      if (!moi) continue;
      const numero = String(moi.employee_number || "").trim();
      if (!numero) return [];
      return equipe.filter((e) => e.id !== empId && String(e.employee_number || "").trim() === numero);
    }
    return [];
  }

  /**
   * Les heures d'une personne sur les jours affichés — TOUS ses quarts, les deux bords.
   *
   * Pourquoi le total et pas seulement les heures de cette grille-ci, dans les mots du
   * propriétaire : « si un employé dit qu'il peut faire 20 h, c'est 20 h total, c'est
   * souvent des restrictions de visa étudiant, et le reste est indiqué à 40 h vu que je
   * veux pas payer de overtime ». Un plafond porte sur la PERSONNE, pas sur un poste : une
   * limite de visa ne se divise pas entre la cuisine et la salle, et l'overtime non plus.
   *
   * Le piège qu'on ferme : la grille de cuisine ne reçoit que les quarts de cuisine. Sans
   * heuresAilleurs(), quelqu'un à 15 h de cuisine et 16 h de salle s'affichait « 15 h / 20 h »
   * — sous son plafond, en vert, alors qu'il était à 31 h.
   */
  function heuresSemaine(empId, quartsGrille, jours) {
    const C = window.CoutMainOeuvre;
    let total = quartsGrille
      .filter((q) => q.employee_id === empId && jours.has(q.date))
      .reduce((somme, q) => somme + C.heuresDuQuart(q), 0);

    // Ce que font ses AUTRES fiches, quand on les connaît (tableau de bord).
    const autres = autresFichesDe(empId).map((e) => e.id);
    if (autres.length) {
      total += quartsGrille
        .filter((q) => autres.indexOf(q.employee_id) !== -1 && jours.has(q.date))
        .reduce((somme, q) => somme + C.heuresDuQuart(q), 0);
    }

    // Le tableau de bord voit déjà tous les quarts : lui ajouter heuresAilleurs() compterait
    // les mêmes heures deux fois. Seules les portes par code en fournissent.
    for (const h of (host.heuresAilleurs ? host.heuresAilleurs() : [])) {
      if (h.employee_id === empId && jours.has(h.date)) total += Number(h.heures) || 0;
    }
    return total;
  }

  // Heures cédulées de la semaine, et plafond quand il y en a un. Le plafond n'est pas
  // affiché pour tout le monde : la plupart des employés n'en ont pas, et écrire « / 0 h »
  // partout ne dirait rien. La ligne, elle, s'affiche pour toute la grille — sinon les
  // rangées n'auraient pas toutes la même hauteur.
  function bilanEmploye(emp, jours) {
    if (!jours) return null;
    // TOUTES les heures de la personne, les deux bords confondus : un plafond de visa ou une
    // limite d'overtime porte sur elle, pas sur un poste.
    const heures = heuresSemaine(emp.id, host.shifts(), jours);
    const plafond = Number(emp.heures_max) || 0;
    return { heures, plafond, depasse: plafond > 0 && heures > plafond + 1e-9 };
  }

  // Prénom sur une ligne, nom de famille en dessous. Deux employées prénommées Marie
  // donnaient auparavant deux lignes rigoureusement identiques dans la grille.
  function empNameCellHTML(emp, jours) {
    const { first, last } = window.Noms.splitName(emp.name);
    const b = bilanEmploye(emp, jours);
    const lang = host.lang();
    const C = window.CoutMainOeuvre;
    const heuresTexte = b
      ? b.plafond > 0
        ? `${C.fmtHeures(b.heures, lang)} / ${C.fmtHeures(b.plafond, lang)}`
        : C.fmtHeures(b.heures, lang)
      : "";
    return `<div class="emp-name-cell ${b && b.depasse ? "depasse" : ""}">
        <span class="emp-first">${first}</span>
        ${last ? `<span class="emp-last">${last}</span>` : ""}
        ${b ? `<span class="emp-heures">${heuresTexte}</span>` : ""}
      </div>`;
  }

  // En cuisine, l'heure de fin est prévisible : on l'affiche, elle sert à tout le monde. En
  // salle, une serveuse part quand la salle est vide — l'écrire serait une promesse fausse.
  function heuresAffichees(shift, secteur) {
    if (secteur === "cuisine" && shift.end_time) return `${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}`;
    return fmtTime(shift.start_time);
  }

  function libelleRole(role, lang) {
    return (ROLES[role] || ROLES.server)[lang];
  }

  // Une tâche est du texte tapé à la main, et la grille est construite par concaténation de
  // chaînes : sans ça, une tâche contenant « < » casserait l'affichage de toute la semaine.
  function echapper(texte) {
    return String(texte == null ? "" : texte)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // La tâche s'ajoute SOUS le poste, elle ne le remplace pas. On avait d'abord misé sur la
  // couleur de la pastille pour dire le poste — dans une grille de quatorze personnes, on lit
  // les mots, pas les teintes, et le poste disparaissait dès qu'une tâche était écrite.
  function tacheDuQuart(shift, secteur) {
    return secteur === "cuisine" ? String(shift.note || "").trim() : "";
  }

  // Les tâches déjà employées dans cette équipe, les plus récentes d'abord. Rien à
  // configurer : l'app apprend de ce qui a vraiment été écrit.
  function tachesRecentes(secteur, employees) {
    if (secteur !== "cuisine") return [];
    const ids = new Set((employees || []).map((e) => e.id));
    const vues = [];
    const quarts = quartsDe(secteur)
      .filter((q) => ids.has(q.employee_id) && String(q.note || "").trim())
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    for (const q of quarts) {
      const tache = q.note.trim();
      if (!vues.some((v) => v.toLowerCase() === tache.toLowerCase())) vues.push(tache);
      if (vues.length >= 8) break;
    }
    return vues;
  }

  // Deux teintes seulement : le poste principal en vert, le second en or.
  function roleSecondaire(role) {
    return role === "hostess" || role === "plongeur";
  }

  // Les 24 heures par tranches de 15 min. On construit la liste nous-mêmes parce que le
  // sélecteur natif <input type="time"> ignore parfois l'attribut step sur iOS.
  //
  // Elle allait de 5 h à 22 h, ce qui paraissait suffisant pour un restaurant. Ça ne l'était
  // pas : une cuisine qui ferme à 1 h 30 n'avait pas son heure dans la liste, le sélecteur
  // retombait silencieusement sur la première (5 h) et le quart repartait avec la mauvaise
  // heure de fin dès qu'on le rouvrait pour autre chose. Depuis que l'heure de fin sert à
  // calculer la masse salariale, cette bévue coûtait de l'argent.
  function timeOptionsHTML(selected) {
    let opts = "";
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        opts += `<option value="${val}" ${val === selected ? "selected" : ""}>${val}</option>`;
      }
    }
    return opts;
  }

  // ---------- fenêtre de modification d'un quart ----------

  function restaurantDeEmploye(empId) {
    for (const r of host.restaurants()) {
      if (r.employees.some((e) => e.id === empId)) return r.id;
    }
    return "";
  }

  function employeeName(empId) {
    for (const r of host.restaurants()) {
      const e = r.employees.find((x) => x.id === empId);
      if (e) return e.name;
    }
    return "";
  }

  function openShiftModal({ shiftId, employeeId, date, secteur }) {
    const overlay = document.getElementById("shiftModalOverlay");
    const existing = shiftId ? host.shifts().find((s) => s.id === shiftId) : null;
    const t = host.t;
    const empId = existing ? existing.employee_id : employeeId;
    // Les postes proposés suivent l'équipe de la personne : on ne propose pas « Hôtesse » à
    // un plongeur. Pour un quart existant, l'équipe se déduit de l'employé.
    const equipe = secteur || secteurParEmploye[empId] || "salle";
    overlay.dataset.shiftId = shiftId || "";
    overlay.dataset.employeeId = empId;
    overlay.dataset.secteur = equipe;
    overlay.dataset.resto = restaurantDeEmploye(empId);

    document.getElementById("shiftModalTitle").textContent = existing ? t("modifierQuart") : t("ajouterQuart");
    document.getElementById("shiftModalEmpName").textContent = employeeName(existing ? existing.employee_id : employeeId);
    document.getElementById("shiftDateInput").value = existing ? existing.date : date;
    document.getElementById("shiftStartInput").innerHTML = timeOptionsHTML(existing ? existing.start_time : "09:00");
    document.getElementById("shiftEndInput").innerHTML = timeOptionsHTML(existing ? existing.end_time : "17:00");
    const postes = rolesDe(equipe);
    document.getElementById("shiftRoleInput").innerHTML = postes
      .map((val) => `<option value="${val}">${ROLES[val][host.lang()]}</option>`)
      .join("");
    document.getElementById("shiftRoleInput").value =
      existing && postes.includes(existing.role) ? existing.role : postes[0];
    const champTache = document.getElementById("shiftNoteInput");
    champTache.value = existing ? existing.note || "" : "";
    preparerBlocTache(equipe, champTache);
    document.getElementById("shiftDeleteBtn").textContent = t("supprimerQuart");
    document.getElementById("shiftDeleteBtn").style.display = existing ? "block" : "none";
    document.getElementById("shiftSaveBtn").textContent = t("enregistrer");

    overlay.style.display = "flex";
  }

  function closeShiftModal() {
    document.getElementById("shiftModalOverlay").style.display = "none";
  }

  // Le bloc n'apparaît qu'en cuisine : « Prép » ou « Commande à défaire » ne veulent rien
  // dire pour une serveuse, et l'utilisateur a demandé que ça reste à la cuisine.
  function preparerBlocTache(equipe, champ) {
    const bloc = document.getElementById("shiftTacheBloc");
    if (!bloc) return;
    if (equipe !== "cuisine") {
      bloc.style.display = "none";
      return;
    }
    bloc.style.display = "block";

    const max = window.HoraireMiseEnPage.TACHE_MAX;
    champ.maxLength = max;
    champ.placeholder = host.t("tachePlaceholder");
    document.getElementById("shiftTacheLabel").textContent = host.t("tacheDuQuart");

    const reste = document.getElementById("shiftTacheReste");
    const majReste = () => {
      const restant = max - champ.value.length;
      reste.textContent = host.t("tacheReste", restant, max);
      reste.classList.toggle("tache-plein", restant === 0);
    };
    champ.oninput = majReste;
    majReste();

    const ctx = contexteDe(document.getElementById("shiftModalOverlay").dataset.resto || "", equipe);
    const boutons = document.getElementById("shiftTachesRecentes");
    const recentes = tachesRecentes(equipe, ctx.employees);
    boutons.innerHTML = recentes.map((tache) => `<button type="button">${echapper(tache)}</button>`).join("");
    [...boutons.children].forEach((bouton, i) => {
      bouton.addEventListener("click", () => {
        champ.value = recentes[i];
        majReste();
      });
    });
  }

  /**
   * Les heures déjà cédulées à cette personne, ce jour-là, DANS L'AUTRE secteur.
   *
   * Deux sources, parce que les deux portes ne reçoivent pas la même chose : le tableau de
   * bord a tous les quarts et les filtre lui-même, une porte par code n'a que ceux de son
   * secteur et reçoit le reste en heures (voir heuresAilleurs dans le contrat du host).
   */
  function quartsAilleursLeMemeJour(payload) {
    const S = window.Secteurs;
    const C = window.CoutMainOeuvre;
    const secteurDuNouveau = S ? S.duRole(payload.role) : null;
    let heures = 0;

    const autres = autresFichesDe(payload.employee_id).map((e) => e.id);
    if (S) {
      for (const q of host.shifts()) {
        if (q.date !== payload.date) continue;
        // Son propre quart, quand on le modifie, n'est pas un double.
        if (payload.id && q.id === payload.id) continue;
        if (q.employee_id === payload.employee_id) {
          // Sur SA fiche, seul un quart de l'autre équipe compte : deux quarts du même
          // secteur le même jour, la grille ne les permet pas de toute façon.
          if (S.duRole(q.role) === secteurDuNouveau) continue;
        } else if (autres.indexOf(q.employee_id) === -1) {
          continue;
        }
        heures += C.heuresDuQuart(q);
      }
    }
    for (const h of (host.heuresAilleurs ? host.heuresAilleurs() : [])) {
      if (h.employee_id === payload.employee_id && h.date === payload.date) heures += Number(h.heures) || 0;
    }
    return { heures };
  }

  // Retourne false seulement si la personne répond « non » à la question.
  async function confirmerAccroc(payload) {
    const nom = nomDeEmploye(
      (host.restaurants() || []).flatMap((r) => r.employees || []),
      payload.employee_id
    );
    const lang = host.lang();
    const quart = { date: payload.date, start_time: payload.start_time, end_time: payload.end_time };

    // Le congé d'abord : il est plus fort qu'une disponibilité générale. Un congé a été
    // accordé, alors qu'une disponibilité n'est qu'une habitude.
    const absence = window.Absences.absenceDuJour(
      (host.absences ? host.absences() : []).filter((a) => a.employee_id === payload.employee_id),
      payload.employee_id,
      payload.date
    );
    if (absence) {
      const message = host.t(
        "confirmMalgreConge",
        nom,
        window.Absences.libelleType(absence.type, lang),
        window.Absences.fmtPeriode(absence, lang)
      );
      return confirm(message);
    }

    // Déjà cédulé de l'AUTRE bord ce jour-là. C'est le risque que « les deux » a créé : la
    // grille de cuisine ne montre pas les quarts de salle et l'inverse, donc rien à l'écran
    // ne dit qu'on est en train d'inscrire quelqu'un deux fois le même jour.
    //
    // Avant la disponibilité mais après le congé : c'est un fait de CETTE semaine, alors
    // qu'une disponibilité n'est qu'une habitude ; un congé, lui, veut dire que la personne
    // ne rentre pas du tout, dans aucune des deux équipes.
    const ailleurs = quartsAilleursLeMemeJour(payload);
    if (ailleurs.heures > 0) {
      return confirm(
        host.t(
          "confirmDejaCeduleAilleurs",
          nom,
          // Une journée s'écrit déjà quelque part : une période dont le début et la fin sont
          // le même jour. Pas de deuxième formateur de date à garder en phase avec celui-là.
          window.Absences.fmtPeriode({ date_debut: payload.date, date_fin: payload.date }, lang),
          window.CoutMainOeuvre.fmtHeures(ailleurs.heures, lang)
        )
      );
    }

    const accroc = window.Disponibilites.conflit(disposDeEmploye(payload.employee_id), quart);
    if (!accroc) return true;
    const jour = window.Disponibilites.nomDuJour(window.Disponibilites.jourDeSemaine(payload.date), lang);
    const message =
      accroc.raison === "absent"
        ? host.t("confirmMalgreDispoAbsent", nom, jour.toLowerCase())
        : host.t("confirmMalgreDispoHeures", nom, jour.toLowerCase(), window.Disponibilites.libelle(accroc.dispo, lang), payload.start_time);
    return confirm(message);
  }

  async function saveShiftFromModal() {
    const overlay = document.getElementById("shiftModalOverlay");
    const shiftId = overlay.dataset.shiftId;
    const payload = {
      employee_id: overlay.dataset.employeeId,
      date: document.getElementById("shiftDateInput").value,
      start_time: document.getElementById("shiftStartInput").value,
      end_time: document.getElementById("shiftEndInput").value,
      role: document.getElementById("shiftRoleInput").value,
      note: document.getElementById("shiftNoteInput").value,
    };
    if (!payload.date || !payload.start_time || !payload.end_time) return;

    // La question se pose À L'ENREGISTREMENT et pas au clic sur la case : tant que l'heure
    // n'est pas choisie, on ne peut pas savoir s'il y a un accroc. Une seule règle, un seul
    // moment.
    //
    // Et c'est une QUESTION, pas un refus. Un samedi matin où quelqu'un lâche, le gérant
    // doit pouvoir inscrire la personne qui vient dépanner, même si elle avait écrit « pas
    // le samedi ». Si l'app bloquait, il faudrait aller falsifier la disponibilité déclarée
    // pour la contourner.
    // shiftId à part du payload : il ne part pas au serveur (l'URL le porte déjà), mais
    // confirmerAccroc en a besoin pour ne pas compter comme un double le quart qu'on est
    // justement en train de modifier.
    if (!(await confirmerAccroc({ ...payload, id: shiftId || null }))) return;

    const btn = document.getElementById("shiftSaveBtn");
    btn.disabled = true;
    try {
      await host.shiftApi(shiftId ? `/shifts/${shiftId}` : "/shifts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      host.setShifts(await host.reloadShifts());
      closeShiftModal();
      host.rerender();
    } catch (err) {
      alert(host.t("erreurAjoutQuart"));
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteShiftFromModal() {
    const overlay = document.getElementById("shiftModalOverlay");
    const shiftId = overlay.dataset.shiftId;
    if (!shiftId) return;
    if (!confirm(host.t("confirmSupprimerQuart"))) return;
    await host.shiftApi(`/shifts/${shiftId}`, { method: "DELETE" });
    host.setShifts(host.shifts().filter((s) => s.id !== shiftId));
    closeShiftModal();
    host.rerender();
  }

  // ---------- copie de semaine ----------

  // Copie tous les quarts de la semaine affichée vers la suivante (mêmes employés, mêmes
  // heures, même rôle), en sautant les cases déjà remplies pour ne rien écraser.
  async function duplicateWeekToNext(restaurantId, btn, secteur) {
    const ctx = contexteDe(restaurantId, secteur);
    const empIds = ctx.employees.map((e) => e.id);
    const dates = weekDates(weekStart).map((d) => isoDate(d));
    const weekShifts = quartsDe(ctx.secteur).filter((s) => empIds.includes(s.employee_id) && dates.includes(s.date));

    if (weekShifts.length === 0) {
      alert(host.t("aucunQuartACopier"));
      return;
    }
    if (!confirm(host.t("confirmCopierSemaine", weekShifts.length))) return;

    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.textContent = host.t("copieEnCours");
    try {
      let skipped = 0;
      for (const s of weekShifts) {
        const newDate = isoDate(addDays(new Date(s.date + "T12:00:00"), 7));
        const alreadyExists = quartsDe(ctx.secteur).some((x) => x.employee_id === s.employee_id && x.date === newDate);
        if (alreadyExists) {
          skipped++;
          continue;
        }
        await host.shiftApi("/shifts", {
          method: "POST",
          body: JSON.stringify({
            employee_id: s.employee_id,
            date: newDate,
            start_time: s.start_time,
            end_time: s.end_time,
            role: s.role,
            note: s.note,
          }),
        });
      }
      host.setShifts(await host.reloadShifts());
      weekStart = addDays(weekStart, 7); // on suit la copie : on affiche la semaine remplie
      host.rerender();
      if (skipped > 0) alert(host.t("quartsIgnores", skipped));
    } catch (err) {
      alert(host.t("erreurAjoutQuart"));
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  // ---------- effacement d'une semaine ----------

  // Vide d'un coup la semaine affichée. Le serveur le fait en une seule requête : effacer
  // quart par quart depuis le navigateur laisserait une grille à moitié vide si la connexion
  // tombait au milieu, et rien ne permet de revenir en arrière ensuite. La confirmation
  // nomme la semaine ET le nombre de quarts, parce qu'on efface souvent en ayant la mauvaise
  // semaine sous les yeux.
  async function clearWeekShifts(restaurantId, btn, secteur) {
    const ctx = contexteDe(restaurantId, secteur);
    const empIds = ctx.employees.map((e) => e.id);
    const dates = weekDates(weekStart).map((d) => isoDate(d));
    const weekShifts = quartsDe(ctx.secteur).filter((s) => empIds.includes(s.employee_id) && dates.includes(s.date));

    if (weekShifts.length === 0) {
      alert(host.t("aucunQuartAEffacer"));
      return;
    }
    if (!confirm(host.t("confirmEffacerSemaine", weekShifts.length, fmtWeekLabel(weekStart)))) return;

    btn.disabled = true;
    btn.textContent = host.t("effacementEnCours");
    try {
      const params = `restaurant_id=${encodeURIComponent(restaurantId)}&from=${dates[0]}&to=${dates[6]}&secteur=${ctx.secteur}`;
      await host.shiftApi(`/shifts?${params}`, { method: "DELETE" });
      host.setShifts(await host.reloadShifts());
      host.rerender();
    } catch (err) {
      // On recharge quand même avant de redessiner : si l'effacement est passé côté serveur
      // mais que la réponse s'est perdue, l'écran doit montrer l'état réel, pas l'ancien.
      try {
        host.setShifts(await host.reloadShifts());
      } catch (_) {}
      host.rerender();
      alert(host.t("erreurEffacerSemaine"));
    }
  }

  // ---------- exports : PDF et photo ----------

  // Sur un téléphone, le partage natif propose directement Messenger, Photos, les courriels…
  // C'est ce que le gérant veut faire de la feuille : l'envoyer au groupe, pas la retrouver
  // dans un dossier de téléchargements. Sur un ordinateur, ou si le partage est refusé, on
  // retombe sur l'enregistrement classique.
  async function partagerOuEnregistrer(blob, nomFichier, titre) {
    const fichier = typeof File === "function" ? new File([blob], nomFichier, { type: blob.type }) : null;
    if (fichier && navigator.canShare && navigator.canShare({ files: [fichier] })) {
      try {
        await navigator.share({ files: [fichier], title: titre });
        return;
      } catch (err) {
        // AbortError = la feuille de partage a été fermée volontairement. On s'arrête là :
        // lui imposer un téléchargement qu'elle vient de refuser serait pire que rien.
        if (err && err.name === "AbortError") return;
      }
    }
    enregistrer(blob, nomFichier);
  }

  function enregistrer(blob, nomFichier) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichier;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // On libère l'URL après coup : la révoquer tout de suite couperait le téléchargement
    // sur certains navigateurs mobiles.
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // Pendant qu'un export travaille, son bouton dit ce qu'il fait et ne peut pas être
  // recliqué. Il est remis en état dans tous les cas, même en cas d'échec.
  async function pendantExport(btn, libelle, travail) {
    const avant = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = host.t(libelle);
    try {
      await travail();
    } finally {
      btn.disabled = false;
      btn.innerHTML = avant;
    }
  }

  // Le PDF est récupéré en blob plutôt que par un lien <a href> direct, parce qu'il faut
  // pouvoir envoyer le jeton d'accès en en-tête.
  async function downloadWeekPdf(restaurantId, btn, secteur) {
    const weekISO = isoDate(weekStart);
    const { url, options } = host.pdfRequest(restaurantId, weekISO, host.lang(), contexteDe(restaurantId, secteur).secteur);

    await pendantExport(btn, "pdfEnCours", async () => {
      try {
        const res = await fetch(url, options || {});
        if (!res.ok) throw new Error("PDF");
        const blob = await res.blob();

        // Le serveur propose déjà un nom propre (Horaire_Chez-Coco_2026-08-17.pdf).
        const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
        const nomFichier = match ? match[1] : `horaire-${weekISO}.pdf`;

        await partagerOuEnregistrer(blob, nomFichier, host.t("titrePartage"));
      } catch (e) {
        alert(host.t("erreurPdf"));
      }
    });
  }

  // La photo est dessinée ici, dans le navigateur, à partir des quarts déjà chargés : aucun
  // aller-retour au serveur, et la feuille est exactement celle du PDF — même mise en page,
  // même fichier partagé (public/shared/horaire-mise-en-page.js).
  async function downloadWeekImage(restaurantId, btn, secteur) {
    const restaurant = host.restaurants().find((r) => r.id === restaurantId);
    if (!restaurant) return;
    const ctx = contexteDe(restaurantId, secteur);
    const weekISO = isoDate(weekStart);
    const nomFeuille = window.HoraireMiseEnPage.nomFeuille(restaurant.name, ctx.secteur, host.lang());

    await pendantExport(btn, "photoEnCours", async () => {
      try {
        const blob = await window.HoraireImage.construireImageHoraire({
          restaurantName: nomFeuille,
          employees: ctx.employees,
          shifts: quartsDe(ctx.secteur),
          weekStartISO: weekISO,
          lang: host.lang(),
          avecHeureFin: ctx.secteur === "cuisine",
          avecTaches: ctx.secteur === "cuisine",
        });
        const nomFichier = window.HoraireImage.nomImage(nomFeuille, weekISO, host.lang());
        await partagerOuEnregistrer(blob, nomFichier, host.t("titrePartage"));
      } catch (e) {
        alert(host.t("erreurPhoto"));
      }
    });
  }

  // ---------- actions des congés ----------

  function champ(classe, restaurantId, secteur) {
    return document.querySelector(`.${classe}[data-resto="${restaurantId}"][data-secteur="${secteur}"]`);
  }

  async function ajouterConge(restaurantId, secteur, btn) {
    const employeeId = champ("congeEmploye", restaurantId, secteur).value;
    const debut = champ("congeDebut", restaurantId, secteur).value;
    const fin = champ("congeFin", restaurantId, secteur).value;
    const type = champ("congeType", restaurantId, secteur).value;

    if (!employeeId || !debut) {
      alert(host.t("congeIncomplet"));
      return;
    }

    congesOuverts.add(cle(restaurantId, secteur)); // la section reste ouverte après le rendu
    btn.disabled = true;
    try {
      await host.shiftApi("/absences", {
        method: "POST",
        body: JSON.stringify({ restaurant_id: restaurantId, employee_id: employeeId, date_debut: debut, date_fin: fin, type }),
      });
      host.setAbsences(await host.reloadAbsences());
      host.rerender();
    } catch (err) {
      alert(host.t("congeErreur"));
      btn.disabled = false;
    }
  }

  async function retirerConge(restaurantId, secteur, id) {
    if (!confirm(host.t("congeConfirmRetirer"))) return;
    congesOuverts.add(cle(restaurantId, secteur));
    try {
      await host.shiftApi(`/absences/${id}?restaurant_id=${encodeURIComponent(restaurantId)}`, { method: "DELETE" });
      host.setAbsences(await host.reloadAbsences());
      host.rerender();
    } catch (err) {
      alert(host.t("congeErreur"));
    }
  }

  // ---------- branchement des boutons ----------

  // À rappeler après chaque rendu : les boutons sont recréés à chaque fois.
  function bindGridEvents() {
    document.querySelectorAll('[data-action="prevWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        weekStart = addDays(weekStart, -7);
        host.rerender();
      });
    });
    document.querySelectorAll('[data-action="nextWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        weekStart = addDays(weekStart, 7);
        host.rerender();
      });
    });
    document.querySelectorAll('[data-action="thisWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        weekStart = getMonday(new Date());
        host.rerender();
      });
    });
    document.querySelectorAll('[data-action="newShift"]').forEach((btn) => {
      btn.addEventListener("click", () =>
        openShiftModal({ employeeId: btn.dataset.emp, date: btn.dataset.date, secteur: btn.dataset.secteur })
      );
    });
    document.querySelectorAll('[data-action="editShift"]').forEach((btn) => {
      btn.addEventListener("click", () => openShiftModal({ shiftId: btn.dataset.id }));
    });
    document.querySelectorAll('[data-action="duplicateWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => duplicateWeekToNext(btn.dataset.resto, btn, btn.dataset.secteur));
    });
    document.querySelectorAll('[data-action="pdfWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => downloadWeekPdf(btn.dataset.resto, btn, btn.dataset.secteur));
    });
    document.querySelectorAll('[data-action="toggleConges"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = cle(btn.dataset.resto, btn.dataset.secteur);
        if (congesOuverts.has(k)) congesOuverts.delete(k);
        else congesOuverts.add(k);
        host.rerender();
      });
    });
    document.querySelectorAll('[data-action="toggleLiens"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = cle(btn.dataset.resto, btn.dataset.secteur);
        if (liensOuverts.has(k)) liensOuverts.delete(k);
        else liensOuverts.add(k);
        host.rerender();
      });
    });
    document.querySelectorAll('[data-action="copyLien"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const lien = btn.dataset.lien;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(lien);
          } else {
            // Sans l'API presse-papier — un vieux Safari, ou une page servie en http — on
            // passe par une zone de texte invisible. Sinon le bouton ne ferait rien du tout.
            const zone = document.createElement("textarea");
            zone.value = lien;
            zone.style.position = "fixed";
            zone.style.opacity = "0";
            document.body.appendChild(zone);
            zone.select();
            document.execCommand("copy");
            document.body.removeChild(zone);
          }
          const avant = btn.textContent;
          btn.textContent = host.t("liensCopie");
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = avant;
            btn.classList.remove("copied");
          }, 1500);
        } catch (e) {
          prompt(host.t("liensCopieImpossible"), lien);
        }
      });
    });
    document.querySelectorAll('[data-action="ajouterConge"]').forEach((btn) => {
      btn.addEventListener("click", () => ajouterConge(btn.dataset.resto, btn.dataset.secteur, btn));
    });
    document.querySelectorAll('[data-action="retirerConge"]').forEach((btn) => {
      btn.addEventListener("click", () => retirerConge(btn.dataset.resto, btn.dataset.secteur, btn.dataset.id));
    });
    document.querySelectorAll('[data-action="photoWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => downloadWeekImage(btn.dataset.resto, btn, btn.dataset.secteur));
    });
    document.querySelectorAll('[data-action="clearWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => clearWeekShifts(btn.dataset.resto, btn, btn.dataset.secteur));
    });
  }

  // À appeler une fois au chargement : ferme la fenêtre de quart et branche ses boutons.
  function bindShiftModal() {
    document.getElementById("shiftModalCloseX").addEventListener("click", closeShiftModal);
    document.getElementById("shiftModalOverlay").addEventListener("click", (ev) => {
      if (ev.target === document.getElementById("shiftModalOverlay")) closeShiftModal();
    });
    document.getElementById("shiftSaveBtn").addEventListener("click", saveShiftFromModal);
    document.getElementById("shiftDeleteBtn").addEventListener("click", deleteShiftFromModal);
  }

  return {
    init,
    ROLES,
    getMonday,
    isoDate,
    addDays,
    weekDates,
    todayISO,
    fmtTime,
    fmtWeekLabel,
    timeOptionsHTML,
    renderWeekGrid,
    openShiftModal,
    closeShiftModal,
    saveShiftFromModal,
    deleteShiftFromModal,
    duplicateWeekToNext,
    clearWeekShifts,
    bilanEmploye,
    quartsAilleursLeMemeJour,
    ajouterConge,
    retirerConge,
    rolesDe,
    echapper,
    tachesRecentes,
    downloadWeekImage,
    downloadWeekPdf,
    bindGridEvents,
    bindShiftModal,
    getWeekStart: () => weekStart,
  };
})();
