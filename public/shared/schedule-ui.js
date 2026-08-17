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
  };

  // ---------- grille ----------

  function renderWeekGrid(restaurantId, employees) {
    const dates = weekDates(weekStart);
    const todayStr = todayISO();
    const t = host.t;
    const icon = host.icon;
    const lang = host.lang();
    const shifts = host.shifts();

    return `
    <div class="week-header">
      <div class="week-title">${fmtWeekLabel(weekStart)}</div>
      <div class="week-nav">
        <button data-action="prevWeek" data-resto="${restaurantId}">‹</button>
        <button data-action="thisWeek" data-resto="${restaurantId}">${t("aujourdhui")}</button>
        <button data-action="nextWeek" data-resto="${restaurantId}">›</button>
      </div>
    </div>
    <div class="week-actions">
      <button class="duplicate-week-btn" data-action="duplicateWeek" data-resto="${restaurantId}">${icon("copy", 13)} ${t("copierSemaineSuivante")}</button>
      <button class="pdf-week-btn" data-action="pdfWeek" data-resto="${restaurantId}">${icon("download", 13)} ${t("telechargerPdf")}</button>
    </div>
    <div class="week-grid" style="grid-template-columns: 96px repeat(7, 1fr);">
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
        <div class="emp-name-cell">${emp.name.split(" ")[0]}</div>
        ${dates
          .map((d) => {
            const dateStr = isoDate(d);
            const shift = shifts.find((s) => s.employee_id === emp.id && s.date === dateStr);
            return `
            <div class="shift-cell">
              ${
                shift
                  ? `<div class="shift-chip role-${shift.role || "server"}" data-action="editShift" data-id="${shift.id}">
                       <div class="st">${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}</div>
                       <div class="rl">${ROLES[shift.role || "server"][lang]}</div>
                     </div>`
                  : `<button class="empty-cell" data-action="newShift" data-emp="${emp.id}" data-date="${dateStr}">+</button>`
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

  function openShiftModal({ shiftId, employeeId, date }) {
    const overlay = document.getElementById("shiftModalOverlay");
    const existing = shiftId ? host.shifts().find((s) => s.id === shiftId) : null;
    const t = host.t;
    overlay.dataset.shiftId = shiftId || "";
    overlay.dataset.employeeId = existing ? existing.employee_id : employeeId;

    document.getElementById("shiftModalTitle").textContent = existing ? t("modifierQuart") : t("ajouterQuart");
    document.getElementById("shiftModalEmpName").textContent = employeeName(existing ? existing.employee_id : employeeId);
    document.getElementById("shiftDateInput").value = existing ? existing.date : date;
    document.getElementById("shiftStartInput").innerHTML = timeOptionsHTML(existing ? existing.start_time : "09:00");
    document.getElementById("shiftEndInput").innerHTML = timeOptionsHTML(existing ? existing.end_time : "17:00");
    document.getElementById("shiftRoleInput").innerHTML = Object.entries(ROLES)
      .map(([val, labels]) => `<option value="${val}">${labels[host.lang()]}</option>`)
      .join("");
    document.getElementById("shiftRoleInput").value = existing ? existing.role || "server" : "server";
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
  async function duplicateWeekToNext(restaurantId, btn) {
    const restaurant = host.restaurants().find((r) => r.id === restaurantId);
    if (!restaurant) return;
    const empIds = restaurant.employees.map((e) => e.id);
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

  // ---------- PDF ----------

  // Le fichier est récupéré en blob plutôt que par un lien <a href> direct, parce qu'il faut
  // pouvoir envoyer le jeton d'accès en en-tête.
  async function downloadWeekPdf(restaurantId, btn) {
    const weekISO = isoDate(weekStart);
    const { url, options } = host.pdfRequest(restaurantId, weekISO, host.lang());

    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = host.t("pdfEnCours");
    let objectUrl = null;
    try {
      const res = await fetch(url, options || {});
      if (!res.ok) throw new Error("PDF");
      const blob = await res.blob();

      // Le serveur propose déjà un nom propre (Horaire_Chez-Coco_2026-08-17.pdf).
      const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
      const filename = match ? match[1] : `horaire-${weekISO}.pdf`;

      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      alert(host.t("erreurPdf"));
    } finally {
      // On libère l'URL après coup : la révoquer tout de suite couperait le téléchargement
      // sur certains navigateurs mobiles.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
      btn.disabled = false;
      btn.innerHTML = originalHTML;
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
      btn.addEventListener("click", () => openShiftModal({ employeeId: btn.dataset.emp, date: btn.dataset.date }));
    });
    document.querySelectorAll('[data-action="editShift"]').forEach((btn) => {
      btn.addEventListener("click", () => openShiftModal({ shiftId: btn.dataset.id }));
    });
    document.querySelectorAll('[data-action="duplicateWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => duplicateWeekToNext(btn.dataset.resto, btn));
    });
    document.querySelectorAll('[data-action="pdfWeek"]').forEach((btn) => {
      btn.addEventListener("click", () => downloadWeekPdf(btn.dataset.resto, btn));
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
    downloadWeekPdf,
    bindGridEvents,
    bindShiftModal,
    getWeekStart: () => weekStart,
  };
})();
