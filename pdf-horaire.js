const PDFDocument = require("pdfkit");
const mise = require("./public/shared/horaire-mise-en-page.js");

// PDF de l'horaire hebdomadaire (lundi → dimanche), en paysage.
//
// Ce fichier ne décide plus de la mise en page : elle vit dans
// public/shared/horaire-mise-en-page.js, parce que la même feuille doit aussi pouvoir être
// exportée en image depuis le navigateur, pour être envoyée dans un groupe Messenger. Écrite
// en double, la version imprimée et la version envoyée par message auraient fini par ne plus
// dire la même chose. Ce qui reste ici est la « surface » : la traduction des ordres de
// dessin en appels pdfkit.
//
// Volontairement en thème clair : c'est fait pour être imprimé ou envoyé aux employés, pas
// pour être lu dans l'app (qui est en thème sombre).

function policeDe(o) {
  if (o.gras && o.italique) return "Helvetica-BoldOblique";
  if (o.gras) return "Helvetica-Bold";
  if (o.italique) return "Helvetica-Oblique";
  return "Helvetica";
}

function surfacePdf(doc) {
  return {
    rect(x, y, l, h, couleur) {
      doc.save().rect(x, y, l, h).fill(couleur).restore();
    },
    rectArrondi(x, y, l, h, rayon, couleur) {
      doc.save().roundedRect(x, y, l, h, rayon).fill(couleur).restore();
    },
    ligne(x1, y1, x2, y2, epaisseur, couleur) {
      doc.save().moveTo(x1, y1).lineTo(x2, y2).lineWidth(epaisseur).strokeColor(couleur).stroke().restore();
    },
    cadre(x, y, l, h, epaisseur, couleur) {
      doc.save().rect(x, y, l, h).lineWidth(epaisseur).strokeColor(couleur).stroke().restore();
    },
    // y est le HAUT du texte : c'est déjà la convention de pdfkit, rien à corriger ici.
    texte(contenu, x, y, o = {}) {
      doc
        .font(policeDe(o))
        .fontSize(o.taille || 10)
        .fillColor(o.couleur || "#000000")
        .text(contenu, x, y, {
          width: o.largeur,
          align: o.centre ? "center" : "left",
          lineBreak: false,
          ellipsis: !!o.tronquer,
        });
    },
    mesurer(contenu, o = {}) {
      return doc.font(policeDe(o)).fontSize(o.taille || 10).widthOfString(contenu);
    },
  };
}

/**
 * Construit le PDF de l'horaire d'une semaine et le retourne en Buffer.
 * @param {object} opts
 * @param {string} opts.restaurantName
 * @param {Array<{id:string,name:string,employee_number?:string}>} opts.employees
 * @param {Array<{employee_id:string,date:string,start_time:string,role?:string}>} opts.shifts
 * @param {string} opts.weekStartISO  n'importe quelle date de la semaine voulue (YYYY-MM-DD)
 * @param {"fr"|"en"} opts.lang
 * @returns {Promise<Buffer>}
 */
function buildSchedulePdf({ restaurantName, employees, shifts, weekStartISO, lang = "fr", avecHeureFin = false }) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32 });
  const morceaux = [];
  doc.on("data", (c) => morceaux.push(c));
  const fini = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
  });

  mise.dessinerHoraire(surfacePdf(doc), { restaurantName, employees, shifts, weekStartISO, lang, avecHeureFin });

  doc.end();
  return fini;
}

function schedulePdfFilename(restaurantName, weekStartISO, lang = "fr") {
  return mise.nomDeFichier(restaurantName, weekStartISO, lang, "pdf");
}

module.exports = {
  buildSchedulePdf,
  schedulePdfFilename,
  getMonday: mise.getMonday,
  isoDate: mise.isoDate,
  parseISO: mise.parseISO,
};
