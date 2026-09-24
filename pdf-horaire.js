const PDFDocument = require("pdfkit");
const { splitName } = require("./public/shared/noms.js");

// Génération du PDF d'horaire hebdomadaire (lundi → dimanche), en paysage.
// Volontairement en thème clair : c'est fait pour être imprimé ou envoyé aux employés,
// pas pour être lu dans l'app (qui est en thème sombre).
//
// L'horaire tient toujours sur UNE page : la hauteur des lignes, et tout ce qui est écrit
// dedans, se calcule à partir du nombre d'employés. Auparavant la liste était coupée à onze
// et le douzième partait sur une deuxième page que personne ne décrochait du mur.
//
// Seule l'heure de DÉBUT est imprimée. La fin d'un quart dépend de l'achalandage du soir :
// l'heure inscrite n'est presque jamais celle où la personne part réellement, et la feuille
// affichée au mur faisait donc une promesse fausse. Les totaux d'heures ont disparu avec
// elle, pour la même raison — un total bâti sur des fins variables se lisait comme une
// garantie qu'il n'était pas. La fin reste enregistrée en base, elle n'est simplement plus
// montrée.

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
    aucunEmploye: "Aucun employé pour ce restaurant.",
    genereLe: (d) => `Généré le ${d}`,
    semaine: (d1, d2) => `Semaine du ${d1} au ${d2}`,
  },
  en: {
    titre: "Schedule",
    aucunEmploye: "No employees for this restaurant.",
    genereLe: (d) => `Generated on ${d}`,
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
  const DAY_W = (tableW - NAME_W) / 7;

  const HEAD_H = 34;
  const MAX_ROW_H = 34;

  const headerBlockH = 76;
  const footerH = 26;
  const tableTop = M + headerBlockH;
  const availableForRows = pageH - M - footerH - tableTop - HEAD_H;

  // L'horaire tient TOUJOURS sur une seule page : la feuille est affichée au mur, et une
  // deuxième page se décroche, se perd, ou se lit sans la première. On ne coupe donc jamais
  // la liste — on partage la hauteur disponible entre tous les employés, et ce qui est écrit
  // dans la ligne rétrécit avec elle. Vers la trentaine d'employés le texte devient petit,
  // mais il reste sur une feuille, ce qui est le but.
  const ROW_H =
    employees.length > 0 ? Math.min(MAX_ROW_H, availableForRows / employees.length) : MAX_ROW_H;

  // Les corps de texte suivent la hauteur de ligne, avec un plancher pour rester lisibles.
  const reduction = ROW_H / MAX_ROW_H;
  const corps = (base, plancher) => Math.max(plancher, base * reduction);
  const NAME_SIZE = corps(9.5, 5);
  const SUB_SIZE = corps(7.5, 4.5);
  const TIME_SIZE = corps(11, 5.5);
  const ROLE_SIZE = corps(7, 4);
  const LIGNE = 1.15; // hauteur d'une ligne de texte, en multiples du corps

  // Sous cette hauteur, deux lignes de nom se chevaucheraient : prénom et nom de famille
  // passent alors sur la même ligne.
  const NOM_SUR_DEUX_LIGNES = ROW_H >= 26;

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
  }

  function drawEmployeeRow(emp, y) {
    // Bandes des colonnes de fin de semaine, pour qu'on repère samedi/dimanche d'un coup d'œil.
    for (let i = 5; i < 7; i++) {
      doc.save().rect(colX(i), y, DAY_W, ROW_H).fill(COLORS.weekendBg).restore();
    }

    // Prénom en gras, nom de famille juste en dessous. Sans le nom de famille, deux
    // employées prénommées Marie donnaient deux lignes identiques sur la feuille affichée
    // au mur, et personne ne savait quel quart appartenait à qui.
    const { first, last } = splitName(emp.name);
    const sousLigne = [last, emp.employee_number ? `#${emp.employee_number}` : ""]
      .filter(Boolean)
      .join("  ·  ");
    const optionsNom = { width: NAME_W - 14, lineBreak: false, ellipsis: true };

    if (sousLigne && NOM_SUR_DEUX_LIGNES) {
      const haut = y + (ROW_H - (NAME_SIZE + SUB_SIZE) * LIGNE) / 2;
      doc.font("Helvetica-Bold").fontSize(NAME_SIZE).fillColor(COLORS.ink)
        .text(first, tableX + 8, haut, optionsNom);
      doc.font("Helvetica").fontSize(SUB_SIZE).fillColor(COLORS.muted)
        .text(sousLigne, tableX + 8, haut + NAME_SIZE * LIGNE, optionsNom);
    } else {
      const surUneLigne = sousLigne ? `${first} ${sousLigne}` : first;
      doc.font("Helvetica-Bold").fontSize(NAME_SIZE).fillColor(COLORS.ink)
        .text(surUneLigne, tableX + 8, y + (ROW_H - NAME_SIZE * LIGNE) / 2, optionsNom);
    }

    dates.forEach((d, i) => {
      const dateStr = dateStrs[i];
      const dayShifts = weekShifts.filter((s) => s.employee_id === emp.id && s.date === dateStr);
      const x = colX(i);
      if (dayShifts.length === 0) {
        const tiret = Math.min(10, TIME_SIZE);
        doc.font("Helvetica").fontSize(tiret).fillColor("#C3CAD3")
          .text("—", x, y + (ROW_H - tiret * LIGNE) / 2, { width: DAY_W, align: "center", lineBreak: false });
        return;
      }
      // Plusieurs quarts la même journée : on les empile en plus petit plutôt que d'en cacher
      // un. Mais sur une liste très longue, les lignes sont trop basses pour être coupées en
      // deux — les deux pastilles deviendraient illisibles. Dans ce cas on n'en fait qu'une,
      // portant les heures de début côte à côte : « 08:00 / 17:00 ».
      const marge = Math.max(1.5, Math.min(4, ROW_H * 0.12));
      const hauteurEmpilee = (ROW_H - marge * 2 - (dayShifts.length - 1)) / dayShifts.length;
      const empile = dayShifts.length > 1 && hauteurEmpilee >= 9;
      const tranches = empile ? dayShifts : [dayShifts];
      const ecart = empile ? 1 : 0;
      const chipH = Math.max(2, (ROW_H - marge * 2 - ecart * (tranches.length - 1)) / tranches.length);
      tranches.forEach((tranche, k) => {
        const quarts = empile ? [tranche] : tranche;
        // Une pastille qui rassemble deux rôles différents n'en annonce aucun : elle reste neutre.
        const roles = new Set(quarts.map((q) => (q.role === "hostess" ? "hostess" : "server")));
        const role = roles.size === 1 ? [...roles][0] : null;
        const bg = role === null ? COLORS.headBg : role === "hostess" ? COLORS.hostessBg : COLORS.serverBg;
        const fg = role === null ? COLORS.ink : role === "hostess" ? COLORS.hostessInk : COLORS.serverInk;
        const chipY = y + marge + k * (chipH + ecart);
        roundedBox(doc, x + 3, chipY, DAY_W - 6, chipH, Math.min(4, chipH / 3), bg);

        // Le rôle n'apparaît que si la pastille porte deux lignes sans les écraser ; sinon
        // l'heure seule, centrée, plutôt qu'un empilement illisible.
        const heures = quarts.map((q) => q.start_time).join(" / ");
        // Le texte rétrécit aussi quand plusieurs heures partagent la largeur d'une colonne.
        const heure = Math.min(TIME_SIZE, chipH * 0.62, (DAY_W - 10) / (heures.length * 0.58));
        const avecRole = role !== null && quarts.length === 1 && chipH >= (heure + ROLE_SIZE) * LIGNE + 2;
        const hauteurTexte = (avecRole ? heure + ROLE_SIZE : heure) * LIGNE;
        const hautTexte = chipY + (chipH - hauteurTexte) / 2;
        doc.font("Helvetica-Bold").fontSize(heure).fillColor(fg)
          .text(heures, x + 3, hautTexte, { width: DAY_W - 6, align: "center", lineBreak: false });
        if (avecRole) {
          doc.font("Helvetica").fontSize(ROLE_SIZE).fillColor(fg)
            .text(ROLE_LABELS[L][role], x + 3, hautTexte + heure * LIGNE, {
              width: DAY_W - 6, align: "center", lineBreak: false,
            });
        }
      });
    });

    doc.save().moveTo(tableX, y + ROW_H).lineTo(tableX + tableW, y + ROW_H)
      .lineWidth(0.5).strokeColor(COLORS.line).stroke().restore();
  }

  function drawTableBorder(bottomY) {
    doc.save().rect(tableX, tableTop, tableW, bottomY - tableTop).lineWidth(0.8).strokeColor(COLORS.lineStrong).stroke();
    // Séparateurs verticaux : après le nom, puis entre chaque jour.
    for (let i = 0; i <= 6; i++) {
      const x = colX(i);
      doc.moveTo(x, tableTop).lineTo(x, bottomY).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    }
    doc.moveTo(tableX, tableTop + HEAD_H).lineTo(tableX + tableW, tableTop + HEAD_H)
      .lineWidth(0.8).strokeColor(COLORS.lineStrong).stroke();
    doc.restore();
  }

  function drawFooter() {
    const y = pageH - M - 12;
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted)
      .text(tr.genereLe(fmtTimestamp(new Date(), L)), M, y, { width: tableW, lineBreak: false });
  }

  if (employees.length === 0) {
    drawPageHeader();
    drawTableHead();
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted)
      .text(tr.aucunEmploye, tableX, tableTop + HEAD_H + 24, { width: tableW, align: "center" });
    drawTableBorder(tableTop + HEAD_H);
    drawFooter();
  } else {
    drawPageHeader();
    drawTableHead();
    let y = tableTop + HEAD_H;
    for (const emp of employees) {
      drawEmployeeRow(emp, y);
      y += ROW_H;
    }
    drawTableBorder(y);
    drawFooter();
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
