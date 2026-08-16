const PDFDocument = require("pdfkit");

// Génération du PDF d'horaire hebdomadaire (lundi → dimanche), en paysage.
// Volontairement en thème clair : c'est fait pour être imprimé ou envoyé aux employés,
// pas pour être lu dans l'app (qui est en thème sombre).

const DAY_NAMES = {
  fr: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};

const MONTH_NAMES = {
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

const ROLE_LABELS = {
  fr: { server: "Serveur", hostess: "Hôtesse" },
  en: { server: "Server", hostess: "Host" },
};

const T = {
  fr: {
    titre: "Horaire",
    total: "Total",
    totalJour: "Total / jour",
    aucunEmploye: "Aucun employé pour ce restaurant.",
    genereLe: (d) => `Généré le ${d}`,
    page: (n, tot) => `Page ${n} de ${tot}`,
    semaine: (d1, d2) => `Semaine du ${d1} au ${d2}`,
  },
  en: {
    titre: "Schedule",
    total: "Total",
    totalJour: "Total / day",
    aucunEmploye: "No employees for this restaurant.",
    genereLe: (d) => `Generated on ${d}`,
    page: (n, tot) => `Page ${n} of ${tot}`,
    semaine: (d1, d2) => `Week of ${d1} to ${d2}`,
  },
};

const COLORS = {
  ink: "#1B2430",
  muted: "#78828F",
  line: "#DCE1E8",
  lineStrong: "#B9C1CC",
  weekendBg: "#F5F7FA",
  headBg: "#EFF2F6",
  totalBg: "#F8F5EC",
  green: "#6FBF93",
  serverBg: "#E7F4EC",
  serverInk: "#2E7A56",
  hostessBg: "#FBF2DC",
  hostessInk: "#8A6516",
};

// ---------- dates ----------

// On passe par midi pour ne jamais se faire décaler d'un jour par un fuseau horaire.
function parseISO(iso) {
  return new Date(`${iso}T12:00:00`);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Ramène n'importe quelle date au lundi de sa semaine — le PDF couvre toujours lundi → dimanche,
// même si l'appelant envoie un mercredi.
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return date;
}

function fmtLongDate(d, lang) {
  const month = MONTH_NAMES[lang][d.getMonth()];
  return lang === "fr"
    ? `${d.getDate()} ${month} ${d.getFullYear()}`
    : `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtWeekLabel(monday, lang) {
  const sunday = addDays(monday, 6);
  if (lang === "fr") {
    const debut =
      monday.getMonth() === sunday.getMonth()
        ? `${monday.getDate()}`
        : `${monday.getDate()} ${MONTH_NAMES.fr[monday.getMonth()]}`;
    return T.fr.semaine(debut, fmtLongDate(sunday, "fr"));
  }
  const start =
    monday.getMonth() === sunday.getMonth()
      ? `${MONTH_NAMES.en[monday.getMonth()]} ${monday.getDate()}`
      : fmtLongDate(monday, "en").replace(/, \d{4}$/, "");
  return T.en.semaine(start, fmtLongDate(sunday, "en"));
}

function fmtTimestamp(d, lang) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${fmtLongDate(d, lang)}, ${hh}:${mm}`;
}

// ---------- heures ----------

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Durée d'un quart en heures. Un quart qui finit "avant" son début a franchi minuit
// (ex: 18:00 → 02:00) : on ajoute 24 h plutôt que de retourner un négatif.
function shiftHours(shift) {
  const start = minutesOf(shift.start_time);
  const end = minutesOf(shift.end_time);
  if (start === null || end === null) return 0;
  const diff = end >= start ? end - start : end + 24 * 60 - start;
  return diff / 60;
}

function fmtHours(h, lang) {
  if (!h) return "—";
  const rounded = Math.round(h * 100) / 100;
  const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
  return `${lang === "fr" ? str.replace(".", ",") : str} h`;
}

// ---------- rendu ----------

function roundedBox(doc, x, y, w, h, r, fill) {
  doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
}

/**
 * Construit le PDF de l'horaire d'une semaine et le retourne en Buffer.
 * @param {object} opts
 * @param {string} opts.restaurantName
 * @param {Array<{id:string,name:string,employee_number?:string}>} opts.employees
 * @param {Array<{employee_id:string,date:string,start_time:string,end_time:string,role?:string}>} opts.shifts
 * @param {string} opts.weekStartISO  n'importe quelle date de la semaine voulue (YYYY-MM-DD)
 * @param {"fr"|"en"} opts.lang
 * @returns {Promise<Buffer>}
 */
function buildSchedulePdf({ restaurantName, employees, shifts, weekStartISO, lang = "fr" }) {
  const L = lang === "en" ? "en" : "fr";
  const tr = T[L];
  const monday = getMonday(parseISO(weekStartISO));
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const dateStrs = dates.map(isoDate);

  // On ne garde que les quarts de la semaine et des employés affichés, pour que les
  // totaux collent exactement à ce qui est imprimé.
  const empIds = new Set(employees.map((e) => e.id));
  const weekShifts = shifts.filter((s) => empIds.has(s.employee_id) && dateStrs.includes(s.date));

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, bufferPages: true });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const M = 32;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const tableX = M;
  const tableW = pageW - M * 2;

  const NAME_W = 108;
  const TOTAL_W = 62;
  const DAY_W = (tableW - NAME_W - TOTAL_W) / 7;

  const HEAD_H = 34;
  const ROW_H = 34;
  const TOTALS_ROW_H = 26;

  const headerBlockH = 76;
  const footerH = 26;
  const tableTop = M + headerBlockH;
  const availableForRows = pageH - M - footerH - tableTop - HEAD_H - TOTALS_ROW_H;
  const rowsPerPage = Math.max(1, Math.floor(availableForRows / ROW_H));
  const pages = employees.length === 0 ? 1 : Math.ceil(employees.length / rowsPerPage);

  function colX(i) {
    return tableX + NAME_W + i * DAY_W;
  }

  function drawPageHeader() {
    // Pastille de marque + nom du restaurant
    roundedBox(doc, M, M, 26, 26, 7, COLORS.green);
    doc.font("Helvetica-BoldOblique").fontSize(15).fillColor("#10151D").text("D", M, M + 6, { width: 26, align: "center" });

    doc.font("Helvetica-Bold").fontSize(17).fillColor(COLORS.ink)
      .text(`${tr.titre} — ${restaurantName}`, M + 36, M + 3, { width: tableW - 36, lineBreak: false });

    doc.font("Helvetica").fontSize(10.5).fillColor(COLORS.muted)
      .text(fmtWeekLabel(monday, L), M + 36, M + 24, { width: tableW - 36, lineBreak: false });

    doc.save().moveTo(M, M + 50).lineTo(M + tableW, M + 50).lineWidth(2).strokeColor(COLORS.green).stroke().restore();
  }

  function drawTableHead() {
    const y = tableTop;
    doc.save().rect(tableX, y, tableW, HEAD_H).fill(COLORS.headBg).restore();

    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted)
      .text(L === "fr" ? "EMPLOYÉ" : "EMPLOYEE", tableX + 8, y + 13, { width: NAME_W - 16, lineBreak: false });

    dates.forEach((d, i) => {
      const x = colX(i);
      const weekend = i >= 5;
      if (weekend) doc.save().rect(x, y, DAY_W, HEAD_H).fill("#E7EBF1").restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.muted)
        .text(DAY_NAMES[L][i].toUpperCase(), x, y + 7, { width: DAY_W, align: "center", lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.ink)
        .text(String(d.getDate()), x, y + 18, { width: DAY_W, align: "center", lineBreak: false });
    });

    const tx = tableX + NAME_W + 7 * DAY_W;
    doc.save().rect(tx, y, TOTAL_W, HEAD_H).fill(COLORS.totalBg).restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted)
      .text(tr.total.toUpperCase(), tx, y + 13, { width: TOTAL_W, align: "center", lineBreak: false });
  }

  function drawEmployeeRow(emp, y) {
    // Bandes des colonnes de fin de semaine, pour qu'on repère samedi/dimanche d'un coup d'œil.
    for (let i = 5; i < 7; i++) {
      doc.save().rect(colX(i), y, DAY_W, ROW_H).fill(COLORS.weekendBg).restore();
    }

    const firstName = (emp.name || "").trim();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.ink)
      .text(firstName, tableX + 8, y + (emp.employee_number ? 8 : 12), {
        width: NAME_W - 14,
        lineBreak: false,
        ellipsis: true,
      });
    if (emp.employee_number) {
      doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted)
        .text(`#${emp.employee_number}`, tableX + 8, y + 21, { width: NAME_W - 14, lineBreak: false, ellipsis: true });
    }

    let totalHours = 0;
    dates.forEach((d, i) => {
      const dateStr = dateStrs[i];
      const dayShifts = weekShifts.filter((s) => s.employee_id === emp.id && s.date === dateStr);
      const x = colX(i);
      if (dayShifts.length === 0) {
        doc.font("Helvetica").fontSize(10).fillColor("#C3CAD3")
          .text("—", x, y + 12, { width: DAY_W, align: "center", lineBreak: false });
        return;
      }
      // Plusieurs quarts la même journée : on les empile en plus petit plutôt que d'en cacher un.
      const stacked = dayShifts.length > 1;
      dayShifts.forEach((shift, k) => {
        totalHours += shiftHours(shift);
        const role = shift.role === "hostess" ? "hostess" : "server";
        const bg = role === "hostess" ? COLORS.hostessBg : COLORS.serverBg;
        const fg = role === "hostess" ? COLORS.hostessInk : COLORS.serverInk;
        const chipH = stacked ? (ROW_H - 8) / dayShifts.length - 1 : ROW_H - 8;
        const chipY = y + 4 + k * (chipH + 1);
        roundedBox(doc, x + 3, chipY, DAY_W - 6, chipH, 4, bg);
        if (stacked) {
          doc.font("Helvetica-Bold").fontSize(6.8).fillColor(fg)
            .text(`${shift.start_time}–${shift.end_time}`, x + 3, chipY + chipH / 2 - 4, {
              width: DAY_W - 6, align: "center", lineBreak: false,
            });
        } else {
          doc.font("Helvetica-Bold").fontSize(9).fillColor(fg)
            .text(`${shift.start_time}–${shift.end_time}`, x + 3, chipY + 4, { width: DAY_W - 6, align: "center", lineBreak: false });
          doc.font("Helvetica").fontSize(7).fillColor(fg)
            .text(ROLE_LABELS[L][role], x + 3, chipY + 15, { width: DAY_W - 6, align: "center", lineBreak: false });
        }
      });
    });

    const tx = tableX + NAME_W + 7 * DAY_W;
    doc.save().rect(tx, y, TOTAL_W, ROW_H).fill(COLORS.totalBg).restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(totalHours ? COLORS.ink : "#C3CAD3")
      .text(fmtHours(totalHours, L), tx, y + 12, { width: TOTAL_W, align: "center", lineBreak: false });

    doc.save().moveTo(tableX, y + ROW_H).lineTo(tableX + tableW, y + ROW_H)
      .lineWidth(0.5).strokeColor(COLORS.line).stroke().restore();
  }

  // Totaux de TOUTE la semaine, pas seulement des employés de la page courante — c'est
  // pour ça qu'on ne dessine cette ligne que sur la dernière page.
  function drawTotalsRow(y) {
    doc.save().rect(tableX, y, tableW, TOTALS_ROW_H).fill(COLORS.headBg).restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted)
      .text(tr.totalJour.toUpperCase(), tableX + 8, y + 9, { width: NAME_W - 16, lineBreak: false });

    let grand = 0;
    dates.forEach((d, i) => {
      const dayTotal = weekShifts
        .filter((s) => s.date === dateStrs[i])
        .reduce((sum, s) => sum + shiftHours(s), 0);
      grand += dayTotal;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(dayTotal ? COLORS.ink : "#C3CAD3")
        .text(fmtHours(dayTotal, L), colX(i), y + 9, { width: DAY_W, align: "center", lineBreak: false });
    });

    const tx = tableX + NAME_W + 7 * DAY_W;
    doc.save().rect(tx, y, TOTAL_W, TOTALS_ROW_H).fill("#F0E7CF").restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink)
      .text(fmtHours(grand, L), tx, y + 9, { width: TOTAL_W, align: "center", lineBreak: false });
  }

  function drawTableBorder(bottomY) {
    doc.save().rect(tableX, tableTop, tableW, bottomY - tableTop).lineWidth(0.8).strokeColor(COLORS.lineStrong).stroke();
    // Séparateurs verticaux : après le nom, entre chaque jour, puis avant la colonne Total.
    for (let i = 0; i <= 7; i++) {
      const x = colX(i);
      doc.moveTo(x, tableTop).lineTo(x, bottomY).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    }
    doc.moveTo(tableX + NAME_W + 7 * DAY_W, tableTop).lineTo(tableX + NAME_W + 7 * DAY_W, bottomY)
      .lineWidth(0.8).strokeColor(COLORS.lineStrong).stroke();
    doc.moveTo(tableX, tableTop + HEAD_H).lineTo(tableX + tableW, tableTop + HEAD_H)
      .lineWidth(0.8).strokeColor(COLORS.lineStrong).stroke();
    doc.restore();
  }

  function drawFooter(pageNum) {
    const y = pageH - M - 12;
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted)
      .text(tr.genereLe(fmtTimestamp(new Date(), L)), M, y, { width: tableW / 2, lineBreak: false });
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted)
      .text(tr.page(pageNum, pages), M + tableW / 2, y, { width: tableW / 2, align: "right", lineBreak: false });
  }

  if (employees.length === 0) {
    drawPageHeader();
    drawTableHead();
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted)
      .text(tr.aucunEmploye, tableX, tableTop + HEAD_H + 24, { width: tableW, align: "center" });
    drawTableBorder(tableTop + HEAD_H);
    drawFooter(1);
  } else {
    for (let p = 0; p < pages; p++) {
      if (p > 0) doc.addPage();
      const pageEmployees = employees.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
      drawPageHeader();
      drawTableHead();
      let y = tableTop + HEAD_H;
      for (const emp of pageEmployees) {
        drawEmployeeRow(emp, y);
        y += ROW_H;
      }
      if (p === pages - 1) {
        drawTotalsRow(y);
        y += TOTALS_ROW_H;
      }
      drawTableBorder(y);
      drawFooter(p + 1);
    }
  }

  doc.end();
  return done;
}

// Nom de fichier propre : "Horaire_Chez-Coco_2026-08-17.pdf"
function schedulePdfFilename(restaurantName, weekStartISO, lang = "fr") {
  const monday = isoDate(getMonday(parseISO(weekStartISO)));
  const slug = (restaurantName || "restaurant")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "restaurant";
  return `${lang === "en" ? "Schedule" : "Horaire"}_${slug}_${monday}.pdf`;
}

module.exports = { buildSchedulePdf, schedulePdfFilename, getMonday, isoDate, parseISO };
