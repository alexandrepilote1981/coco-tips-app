// Export de la feuille d'horaire en image (PNG), pour l'envoyer dans un groupe Messenger.
//
// Pourquoi une image alors qu'il y a déjà un PDF : sur un téléphone, un PDF partagé arrive
// souvent comme un lien ou une pièce jointe qu'il faut ouvrir. Une photo s'affiche
// directement dans la conversation — l'équipe voit son horaire sans rien toucher.
//
// L'image n'a pas sa propre mise en page : elle dessine EXACTEMENT la même feuille que le
// PDF, via public/shared/horaire-mise-en-page.js. Ce fichier n'est que la « surface »
// canvas, comme pdf-horaire.js est la surface pdfkit. C'est ce qui garantit que la photo
// envoyée le jeudi et la feuille punaisée le vendredi disent la même chose.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoraireImage = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // La feuille fait 842 × 595 points. En multipliant par 3 on obtient 2526 × 1786 pixels :
  // assez net pour qu'on puisse zoomer sur une heure depuis un téléphone, sans produire un
  // fichier trop lourd pour une conversation.
  const ECHELLE = 3;

  function policeDe(o) {
    const style = `${o.italique ? "italic " : ""}${o.gras ? "bold " : ""}`;
    return `${style}${o.taille || 10}px Helvetica, Arial, sans-serif`;
  }

  // Tous les navigateurs n'ont pas ctx.roundRect (iOS un peu ancien) : on trace le chemin
  // à la main plutôt que de laisser l'export échouer.
  function cheminArrondi(ctx, x, y, l, h, r) {
    const rayon = Math.max(0, Math.min(r, l / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rayon, y);
    ctx.lineTo(x + l - rayon, y);
    ctx.quadraticCurveTo(x + l, y, x + l, y + rayon);
    ctx.lineTo(x + l, y + h - rayon);
    ctx.quadraticCurveTo(x + l, y + h, x + l - rayon, y + h);
    ctx.lineTo(x + rayon, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rayon);
    ctx.lineTo(x, y + rayon);
    ctx.quadraticCurveTo(x, y, x + rayon, y);
    ctx.closePath();
  }

  function surfaceCanvas(ctx) {
    function tronquer(contenu, largeur) {
      if (!largeur || ctx.measureText(contenu).width <= largeur) return contenu;
      let texte = contenu;
      while (texte.length > 1 && ctx.measureText(`${texte}…`).width > largeur) {
        texte = texte.slice(0, -1);
      }
      return `${texte}…`;
    }

    return {
      rect(x, y, l, h, couleur) {
        ctx.fillStyle = couleur;
        ctx.fillRect(x, y, l, h);
      },
      rectArrondi(x, y, l, h, rayon, couleur) {
        ctx.fillStyle = couleur;
        cheminArrondi(ctx, x, y, l, h, rayon);
        ctx.fill();
      },
      ligne(x1, y1, x2, y2, epaisseur, couleur) {
        ctx.strokeStyle = couleur;
        ctx.lineWidth = epaisseur;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      },
      cadre(x, y, l, h, epaisseur, couleur) {
        ctx.strokeStyle = couleur;
        ctx.lineWidth = epaisseur;
        ctx.strokeRect(x, y, l, h);
      },
      // y est le HAUT du texte, comme dans pdfkit : d'où textBaseline = "top".
      texte(contenu, x, y, o = {}) {
        ctx.font = policeDe(o);
        ctx.fillStyle = o.couleur || "#000000";
        ctx.textBaseline = "top";
        const affiche = o.tronquer ? tronquer(String(contenu), o.largeur) : String(contenu);
        if (o.centre && o.largeur) {
          ctx.textAlign = "center";
          ctx.fillText(affiche, x + o.largeur / 2, y);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(affiche, x, y);
        }
      },
      mesurer(contenu, o = {}) {
        ctx.font = policeDe(o);
        return ctx.measureText(String(contenu)).width;
      },
    };
  }

  /**
   * Dessine la feuille et rend un Blob PNG.
   * @param {object} donnees  mêmes champs que dessinerHoraire (voir horaire-mise-en-page.js)
   * @returns {Promise<Blob>}
   */
  function construireImageHoraire(donnees) {
    const mise = window.HoraireMiseEnPage;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(mise.PAGE.largeur * ECHELLE);
    canvas.height = Math.round(mise.PAGE.hauteur * ECHELLE);

    const ctx = canvas.getContext("2d");
    // Fond blanc explicite : un canvas est transparent par défaut, et une feuille
    // transparente devient illisible sur le fond sombre d'une conversation.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ECHELLE, ECHELLE);

    const hauteurUtile = mise.dessinerHoraire(surfaceCanvas(ctx), { ...donnees, compact: true });

    // On rogne le blanc laissé sous le tableau. Dans une conversation, l'aperçu s'ajuste à
    // la taille de l'image : une image à moitié vide rapetisse d'autant ce qu'il y a à lire.
    const rogne = document.createElement("canvas");
    rogne.width = canvas.width;
    rogne.height = Math.min(canvas.height, Math.round(hauteurUtile * ECHELLE));
    rogne.getContext("2d").drawImage(canvas, 0, 0);

    return new Promise((resolve, reject) => {
      rogne.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("image"))), "image/png");
    });
  }

  function nomImage(restaurantName, weekStartISO, lang) {
    return window.HoraireMiseEnPage.nomDeFichier(restaurantName, weekStartISO, lang, "png");
  }

  return { construireImageHoraire, nomImage, ECHELLE };
});
