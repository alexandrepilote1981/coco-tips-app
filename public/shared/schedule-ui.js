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

  function cle(restaurantId, secteur) {
    return `${restaurantId}:${secteur}`;
  }

  function contexteDe(restaurantId, secteur) {
    return contextes[cle(restaurantId, secteur)] || { secteur: secteur || "salle", employees: [], peutModifier: true, voitMontants: false, chargesPct: 0 };
  }

  // Ce que la semaine affichée va coûter — et surtout combien elle coûte DE MOINS que la
  // précédente. C'est le troisième chiffre qui compte : un total tout seul ne dit rien, un
  // total qui baisse se regarde. Et c'est le coût du PLAN : personne ne poinçonne.
  function barreCoutHTML(restaurantId, secteur, employees, chargesPct) {
    const t = host.t;
    const lang = host.lang();
    const C = window.CoutMainOeuvre;
    const quarts = host.shifts();

    const actuelle = C.coutSurPeriode(employees, quarts, weekDates(weekStart).map(isoDate), chargesPct);
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

    return `
    ${voitMontants ? barreCoutHTML(restaurantId, secteur, employees, chargesPct) : ""}
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
    <div class="week-grid ${secteur === "cuisine" ? "grille-cuisine" : ""}" style="grid-template-columns: 96px repeat(7, 1fr);">
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
        .map(
          (emp) => `
        ${empNameCellHTML(emp)}
        ${dates
          .map((d) => {
            const dateStr = isoDate(d);
            const shift = shifts.find((s) => s.employee_id === emp.id && s.date === dateStr);
            // Seule l'heure de début est affichée : la fin d'un quart dépend de l'achalandage
            // et n'est jamais celle qui avait été inscrite. L'afficher donnait une promesse
            // fausse. Elle reste enregistrée — c'est elle qui sert à calculer les heures.
            return `
            <div class="shift-cell">
              ${
                shift
                  ? `<div class="shift-chip role-${roleSecondaire(shift.role) ? "hostess" : "server"} ${peutModifier ? "" : "lecture"}"
                          ${peutModifier ? `data-action="editShift" data-id="${shift.id}"` : ""}>
                       <div class="st">${heuresAffichees(shift, secteur)}</div>
                       <div class="rl">${libelleRole(shift.role, lang)}</div>
                     </div>`
                  : peutModifier
                  ? `<button class="empty-cell" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}" data-secteur="${secteur}">+</button>`
                  : `<div class="empty-cell lecture">—</div>`
              }
            </div>
          `;
          })
          .join("")}
      `
        )
        .join("")}
    </div>
  `;
  }

  // Prénom sur une ligne, nom de famille en dessous. Deux employées prénommées Marie
  // donnaient auparavant deux lignes rigoureusement identiques dans la grille.
  function empNameCellHTML(emp) {
    const { first, last } = window.Noms.splitName(emp.name);
    return `<div class="emp-name-cell">
        <span class="emp-first">${first}</span>
        ${last ? `<span class="emp-last">${last}</span>` : ""}
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

  // Deux teintes seulement : le poste principal en vert, le second en or.
  function roleSecondaire(role) {
    return role === "hostess" || role === "plongeur";
  }

  // Heures valides de 5 h à 22 h par tranches de 15 min. On construit la liste nous-mêmes
  // parce que le sélecteur natif <input type="time"> ignore parfois l'attribut step sur iOS.
  function timeOptionsHTML(selected) {
    let opts = "";
    for (let h = 5; h <= 22; h++) {
      for (let m = 0; m < 60; m += 15) {
        if (h === 22 && m > 0) break;
        const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        opts += `<option value="${val}" ${val === selected ? "selected" : ""}>${val}</option>`;
      }
    }
    return opts;
  }

  // ---------- fenêtre de modification d'un quart ----------

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
    document.getElementById("shiftNoteInput").value = existing ? existing.note || "" : "";
    document.getElementById("shiftNoteInput").placeholder = t("noteQuartPlaceholder");
    document.getElementById("shiftDeleteBtn").textContent = t("supprimerQuart");
    document.getElementById("shiftDeleteBtn").style.display = existing ? "block" : "none";
    document.getElementById("shiftSaveBtn").textContent = t("enregistrer");

    overlay.style.display = "flex";
  }

  function closeShiftModal() {
    document.getElementById("shiftModalOverlay").style.display = "none";
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
        });
        const nomFichier = window.HoraireImage.nomImage(nomFeuille, weekISO, host.lang());
        await partagerOuEnregistrer(blob, nomFichier, host.t("titrePartage"));
      } catch (e) {
        alert(host.t("erreurPhoto"));
      }
    });
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
    rolesDe,
    downloadWeekImage,
    downloadWeekPdf,
    bindGridEvents,
    bindShiftModal,
    getWeekStart: () => weekStart,
  };
})();
