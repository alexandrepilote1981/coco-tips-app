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
  const congesOuverts = new Set();

  function cle(restaurantId, secteur) {
    return `${restaurantId}:${secteur}`;
  }

  function contexteDe(restaurantId, secteur) {
    return contextes[cle(restaurantId, secteur)] || { secteur: secteur || "salle", employees: [], peutModifier: true, voitMontants: false, chargesPct: 0 };
  }

  // Ce que la semaine affichée va coûter — et surtout combien elle coûte DE MOINS que la
  // précédente. C'est le troisième chiffre qui compte : un total tout seul ne dit rien, un
  // total qui baisse se regarde. Et c'est le coût du PLAN : personne ne poinçonne.
  function barreCoutHTML(restaurantId, secteur, employees, chargesPct, actuelle) {
    const t = host.t;
    const lang = host.lang();
    const C = window.CoutMainOeuvre;
    const quarts = host.shifts();

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
    const chargesPct = options.chargesPct || 0;
    contextes[cle(restaurantId, secteur)] = { secteur, employees, peutModifier, voitMontants, chargesPct };
    for (const emp of employees) secteurParEmploye[emp.id] = secteur;

    const dates = weekDates(weekStart);
    const todayStr = todayISO();
    const t = host.t;
    const icon = host.icon;
    const lang = host.lang();
    const shifts = host.shifts();
    const marque = `data-resto="${restaurantId}" data-secteur="${secteur}"`;

    // Le bilan de la semaine sert deux fois : à la barre du haut, et à chaque rangée pour
    // savoir si la personne dépasse son plafond d'heures. On ne le calcule qu'une fois.
    const bilan = voitMontants
      ? window.CoutMainOeuvre.coutSurPeriode(employees, shifts, dates.map(isoDate), chargesPct)
      : null;

    const absences = absencesDuSecteur(employees);

    return `
    ${blocCongesHTML(restaurantId, secteur, employees, peutModifier)}
    ${voitMontants ? barreCoutHTML(restaurantId, secteur, employees, chargesPct, bilan) : ""}
    <div class="week-header">
      <div class="week-title">${fmtWeekLabel(weekStart)}</div>
      <div class="week-nav">
        <button data-action="prevWeek" ${marque}>‹</button>
        <button data-action="thisWeek" ${marque}>${t("aujourdhui")}</button>
        <button data-action="nextWeek" ${marque}>›</button>
      </div>
    </div>
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
        <div class="day-head ${isoDate(d) === todayStr ? "today" : ""}">
          <div class="dow">${d.toLocaleDateString(t("locale"), { weekday: "short" })}</div>
          <div class="dnum">${d.getDate()}</div>
        </div>
      `
        )
        .join("")}
      ${employees
        .map((emp) => {
          // Une personne qui dépasse son plafond d'heures fait rougir TOUTE sa rangée, pas
          // seulement son nom : c'est en parcourant la semaine du regard qu'on doit le voir.
          const depasse = (bilanEmploye(emp, bilan) || {}).depasse ? "depasse" : "";
          return `
        ${empNameCellHTML(emp, bilan)}
        ${dates
          .map((d) => {
            const dateStr = isoDate(d);
            const shift = shifts.find((s) => s.employee_id === emp.id && s.date === dateStr);
            // Le congé était noté et quelqu'un a quand même été placé ce jour-là : c'est
            // exactement l'oubli qu'on cherche à empêcher, donc ça se voit de loin.
            const absence = window.Absences.absenceDuJour(absences, emp.id, dateStr);
            // Seule l'heure de début est affichée : la fin d'un quart dépend de l'achalandage
            // et n'est jamais celle qui avait été inscrite. L'afficher donnait une promesse
            // fausse. Elle reste enregistrée — c'est elle qui sert à calculer les heures.
            return `
            <div class="shift-cell ${depasse}">
              ${
                shift
                  ? `<div class="shift-chip role-${roleSecondaire(shift.role) ? "hostess" : "server"} ${peutModifier ? "" : "lecture"} ${absence ? "conflit" : ""}"
                          ${absence ? `title="${host.t("congeConflit", window.Absences.libelleType(absence.type, lang))}"` : ""}
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
                  : peutModifier
                  ? `<button class="empty-cell" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}" data-secteur="${secteur}">+</button>`
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

  // Heures cédulées de la semaine, et plafond quand il y en a un. Le plafond n'est pas
  // affiché pour tout le monde : la plupart des employés n'en ont pas, et écrire « / 0 h »
  // partout ne dirait rien. La ligne, elle, s'affiche pour toute la grille — sinon les
  // rangées n'auraient pas toutes la même hauteur.
  function bilanEmploye(emp, bilan) {
    if (!bilan) return null;
    const heures = (bilan.parEmploye[emp.id] || { heures: 0 }).heures;
    const plafond = Number(emp.heures_max) || 0;
    return { heures, plafond, depasse: plafond > 0 && heures > plafond + 1e-9 };
  }

  // Prénom sur une ligne, nom de famille en dessous. Deux employées prénommées Marie
  // donnaient auparavant deux lignes rigoureusement identiques dans la grille.
  function empNameCellHTML(emp, bilan) {
    const { first, last } = window.Noms.splitName(emp.name);
    const b = bilanEmploye(emp, bilan);
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
    const quarts = host
      .shifts()
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
    const weekShifts = host.shifts().filter((s) => empIds.includes(s.employee_id) && dates.includes(s.date));

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
        const alreadyExists = host.shifts().some((x) => x.employee_id === s.employee_id && x.date === newDate);
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
    const weekShifts = host.shifts().filter((s) => empIds.includes(s.employee_id) && dates.includes(s.date));

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
          shifts: host.shifts(),
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
