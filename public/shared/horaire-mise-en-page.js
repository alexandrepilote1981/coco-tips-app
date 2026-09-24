// Mise en page de la feuille d'horaire — SOURCE UNIQUE, dessinée en PDF ET en image.
//
// Le gérant a besoin des deux : un PDF pour imprimer et afficher au mur, une image pour
// l'envoyer dans le groupe Messenger de l'équipe. Les deux doivent montrer EXACTEMENT la
// même feuille — sinon la photo envoyée le jeudi et la feuille punaisée le vendredi ne
// disent plus la même chose, et personne ne sait laquelle fait foi.
//
// Ce fichier ne sait pas dessiner. Il calcule la mise en page et décrit ce qu'il faut
// tracer ; c'est la « surface » reçue en paramètre qui trace pour de vrai — pdfkit côté
// serveur, un canvas côté navigateur. C'est la même séparation que schedule-ui.js avec son
// objet « host ».
//
// Ce qu'une surface doit savoir faire :
//   rect(x, y, l, h, couleur)                       rectangle plein
//   rectArrondi(x, y, l, h, rayon, couleur)         rectangle plein à coins ronds
//   ligne(x1, y1, x2, y2, epaisseur, couleur)       trait
//   cadre(x, y, l, h, epaisseur, couleur)           rectangle vide
//   texte(contenu, x, y, options)                   y = HAUT du texte, pas sa ligne de base
//   mesurer(contenu, options)                       largeur du texte, pour tronquer
// options du texte : { taille, gras, italique, couleur, largeur, centre, tronquer }

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./noms.js"));
  else root.HoraireMiseEnPage = factory(root.Noms);
})(typeof self !== "undefined" ? self : this, function (Noms) {
  // A4 paysage, en points — la feuille est faite pour être imprimée. L'image reprend les
  // mêmes proportions, simplement agrandie.
  const PAGE = { largeur: 841.89, hauteur: 595.28 };

  const NOMS_JOURS = {
    fr: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
    en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  };

  const NOMS_MOIS = {
    fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  };

  const LIBELLES_ROLE = {
    fr: { server: "Serveur", hostess: "Hôtesse", cuisinier: "Cuisinier", plongeur: "Plongeur" },
    en: { server: "Server", hostess: "Host", cuisinier: "Cook", plongeur: "Dishwasher" },
  };

  const T = {
    fr: {
      titre: "Horaire",
      cuisine: "Cuisine",
      employe: "EMPLOYÉ",
      aucunEmploye: "Aucun employé pour ce restaurant.",
      genereLe: (d) => `Généré le ${d}`,
      semaine: (d1, d2) => `Semaine du ${d1} au ${d2}`,
    },
    en: {
      titre: "Schedule",
      cuisine: "Kitchen",
      employe: "EMPLOYEE",
      aucunEmploye: "No employees for this restaurant.",
      genereLe: (d) => `Generated on ${d}`,
      semaine: (d1, d2) => `Week of ${d1} to ${d2}`,
    },
  };

  const COULEURS = {
    encre: "#1B2430",
    gris: "#78828F",
    filet: "#DCE1E8",
    filetFort: "#B9C1CC",
    fondFinSemaine: "#F5F7FA",
    fondEntete: "#EFF2F6",
    fondEnteteFinSemaine: "#E7EBF1",
    vert: "#6FBF93",
    noir: "#10151D",
    tiret: "#C3CAD3",
    serveurFond: "#E7F4EC",
    serveurEncre: "#2E7A56",
    hotesseFond: "#FBF2DC",
    hotesseEncre: "#8A6516",
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
  // Ramène n'importe quelle date au lundi de sa semaine — la feuille couvre toujours
  // lundi → dimanche, même si l'appelant envoie un mercredi.
  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return date;
  }

  function fmtLongDate(d, lang) {
    const mois = NOMS_MOIS[lang][d.getMonth()];
    return lang === "fr" ? `${d.getDate()} ${mois} ${d.getFullYear()}` : `${mois} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function fmtWeekLabel(monday, lang) {
    const sunday = addDays(monday, 6);
    if (lang === "fr") {
      const debut =
        monday.getMonth() === sunday.getMonth()
          ? `${monday.getDate()}`
          : `${monday.getDate()} ${NOMS_MOIS.fr[monday.getMonth()]}`;
      return T.fr.semaine(debut, fmtLongDate(sunday, "fr"));
    }
    const start =
      monday.getMonth() === sunday.getMonth()
        ? `${NOMS_MOIS.en[monday.getMonth()]} ${monday.getDate()}`
        : fmtLongDate(monday, "en").replace(/, \d{4}$/, "");
    return T.en.semaine(start, fmtLongDate(sunday, "en"));
  }

  function fmtTimestamp(d, lang) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${fmtLongDate(d, lang)}, ${hh}:${mm}`;
  }

  // ---------- mise en page ----------

  /**
   * Dessine la feuille d'horaire d'une semaine sur la surface fournie.
   * @param {object} surface  voir le contrat en tête de fichier
   * @param {object} donnees
   * @param {string} donnees.restaurantName
   * @param {Array<{id:string,name:string,employee_number?:string}>} donnees.employees
   * @param {Array<{employee_id:string,date:string,start_time:string,role?:string}>} donnees.shifts
   * @param {string} donnees.weekStartISO  n'importe quelle date de la semaine voulue
   * @param {"fr"|"en"} donnees.lang
   * @param {boolean} [donnees.compact]  colle le pied sous le tableau au lieu du bas de page
   * @param {boolean} [donnees.avecHeureFin]  affiche « début–fin » au lieu du début seul
   * @returns {number} hauteur réellement occupée, pour rogner une image
   */
  function dessinerHoraire(
    surface,
    { restaurantName, employees, shifts, weekStartISO, lang = "fr", compact = false, avecHeureFin = false }
  ) {
    const L = lang === "en" ? "en" : "fr";
    const tr = T[L];
    const lundi = getMonday(parseISO(weekStartISO));
    const dates = Array.from({ length: 7 }, (_, i) => addDays(lundi, i));
    const datesISO = dates.map(isoDate);

    const idsEmployes = new Set(employees.map((e) => e.id));
    const quartsSemaine = shifts.filter((s) => idsEmployes.has(s.employee_id) && datesISO.includes(s.date));

    const M = 32;
    const largeurPage = PAGE.largeur;
    const hauteurPage = PAGE.hauteur;
    const tableX = M;
    const tableL = largeurPage - M * 2;

    const NOM_L = 108;
    const JOUR_L = (tableL - NOM_L) / 7;

    const ENTETE_H = 34;
    const LIGNE_H_MAX = 34;

    const blocTitreH = 76;
    const piedH = 26;
    const tableHaut = M + blocTitreH;
    const placeDisponible = hauteurPage - M - piedH - tableHaut - ENTETE_H;

    // La feuille tient TOUJOURS sur une seule page : elle est affichée au mur, et une
    // deuxième page se décroche, se perd, ou se lit sans la première. On ne coupe donc
    // jamais la liste — on partage la hauteur disponible entre tous les employés, et ce qui
    // est écrit dans la ligne rétrécit avec elle.
    const LIGNE_H = employees.length > 0 ? Math.min(LIGNE_H_MAX, placeDisponible / employees.length) : LIGNE_H_MAX;

    // Les corps de texte suivent la hauteur de ligne, avec un plancher pour rester lisibles.
    const reduction = LIGNE_H / LIGNE_H_MAX;
    const corps = (base, plancher) => Math.max(plancher, base * reduction);
    const NOM_T = corps(9.5, 5);
    const SOUS_T = corps(7.5, 4.5);
    const HEURE_T = corps(11, 5.5);
    const ROLE_T = corps(7, 4);
    const INTERLIGNE = 1.15; // hauteur d'une ligne de texte, en multiples du corps

    // Sous cette hauteur, deux lignes de nom se chevaucheraient : prénom et nom de famille
    // passent alors sur la même ligne.
    const NOM_SUR_DEUX_LIGNES = LIGNE_H >= 26;

    function colX(i) {
      return tableX + NOM_L + i * JOUR_L;
    }

    function dessinerTitre() {
      surface.rectArrondi(M, M, 26, 26, 7, COULEURS.vert);
      surface.texte("D", M, M + 6, { taille: 15, gras: true, italique: true, couleur: COULEURS.noir, largeur: 26, centre: true });

      surface.texte(`${tr.titre} — ${restaurantName}`, M + 36, M + 3, {
        taille: 17, gras: true, couleur: COULEURS.encre, largeur: tableL - 36, tronquer: true,
      });
      surface.texte(fmtWeekLabel(lundi, L), M + 36, M + 24, {
        taille: 10.5, couleur: COULEURS.gris, largeur: tableL - 36, tronquer: true,
      });

      surface.ligne(M, M + 50, M + tableL, M + 50, 2, COULEURS.vert);
    }

    function dessinerEnteteTable() {
      const y = tableHaut;
      surface.rect(tableX, y, tableL, ENTETE_H, COULEURS.fondEntete);
      surface.texte(tr.employe, tableX + 8, y + 13, {
        taille: 8, gras: true, couleur: COULEURS.gris, largeur: NOM_L - 16, tronquer: true,
      });

      dates.forEach((d, i) => {
        const x = colX(i);
        if (i >= 5) surface.rect(x, y, JOUR_L, ENTETE_H, COULEURS.fondEnteteFinSemaine);
        surface.texte(NOMS_JOURS[L][i].toUpperCase(), x, y + 7, {
          taille: 8.5, gras: true, couleur: COULEURS.gris, largeur: JOUR_L, centre: true,
        });
        surface.texte(String(d.getDate()), x, y + 18, {
          taille: 12, gras: true, couleur: COULEURS.encre, largeur: JOUR_L, centre: true,
        });
      });
    }

    function dessinerLigneEmploye(emp, y) {
      // Bandes des colonnes de fin de semaine, pour repérer samedi/dimanche d'un coup d'œil.
      for (let i = 5; i < 7; i++) {
        surface.rect(colX(i), y, JOUR_L, LIGNE_H, COULEURS.fondFinSemaine);
      }

      // Prénom en gras, nom de famille juste en dessous. Sans le nom de famille, deux
      // employées prénommées Marie donnaient deux lignes identiques sur la feuille affichée
      // au mur, et personne ne savait quel quart appartenait à qui.
      const { first: prenom, last: famille } = Noms.splitName(emp.name);
      const sousLigne = [famille, emp.employee_number ? `#${emp.employee_number}` : ""].filter(Boolean).join("  ·  ");
      const largeurNom = NOM_L - 14;

      if (sousLigne && NOM_SUR_DEUX_LIGNES) {
        const haut = y + (LIGNE_H - (NOM_T + SOUS_T) * INTERLIGNE) / 2;
        surface.texte(prenom, tableX + 8, haut, {
          taille: NOM_T, gras: true, couleur: COULEURS.encre, largeur: largeurNom, tronquer: true,
        });
        surface.texte(sousLigne, tableX + 8, haut + NOM_T * INTERLIGNE, {
          taille: SOUS_T, couleur: COULEURS.gris, largeur: largeurNom, tronquer: true,
        });
      } else {
        const surUneLigne = sousLigne ? `${prenom} ${sousLigne}` : prenom;
        surface.texte(surUneLigne, tableX + 8, y + (LIGNE_H - NOM_T * INTERLIGNE) / 2, {
          taille: NOM_T, gras: true, couleur: COULEURS.encre, largeur: largeurNom, tronquer: true,
        });
      }

      dates.forEach((d, i) => {
        const jour = datesISO[i];
        const quartsDuJour = quartsSemaine.filter((s) => s.employee_id === emp.id && s.date === jour);
        const x = colX(i);

        if (quartsDuJour.length === 0) {
          const tiret = Math.min(10, HEURE_T);
          surface.texte("—", x, y + (LIGNE_H - tiret * INTERLIGNE) / 2, {
            taille: tiret, couleur: COULEURS.tiret, largeur: JOUR_L, centre: true,
          });
          return;
        }

        // Plusieurs quarts la même journée : on les empile en plus petit plutôt que d'en
        // cacher un. Mais sur une liste très longue, les lignes sont trop basses pour être
        // coupées en deux — les deux pastilles deviendraient illisibles. Dans ce cas on n'en
        // fait qu'une, portant les heures de début côte à côte : « 08:00 / 17:00 ».
        const marge = Math.max(1.5, Math.min(4, LIGNE_H * 0.12));
        const hauteurEmpilee = (LIGNE_H - marge * 2 - (quartsDuJour.length - 1)) / quartsDuJour.length;
        const empile = quartsDuJour.length > 1 && hauteurEmpilee >= 9;
        const tranches = empile ? quartsDuJour.map((q) => [q]) : [quartsDuJour];
        const ecart = empile ? 1 : 0;
        const pastilleH = Math.max(2, (LIGNE_H - marge * 2 - ecart * (tranches.length - 1)) / tranches.length);

        tranches.forEach((quarts, k) => {
          // Une pastille qui rassemble deux rôles différents n'en annonce aucun : neutre.
          // Deux teintes seulement, pour que la feuille reste lisible d'un coup d'œil :
          // le poste « principal » (serveur, cuisinier) en vert, le second (hôtesse,
          // plongeur) en or. Une pastille qui mélange deux postes reste neutre.
          const roles = new Set(quarts.map((q) => (LIBELLES_ROLE[L][q.role] ? q.role : "server")));
          const role = roles.size === 1 ? [...roles][0] : null;
          const secondaire = role === "hostess" || role === "plongeur";
          const fond = role === null ? COULEURS.fondEntete : secondaire ? COULEURS.hotesseFond : COULEURS.serveurFond;
          const encre = role === null ? COULEURS.encre : secondaire ? COULEURS.hotesseEncre : COULEURS.serveurEncre;
          const pastilleY = y + marge + k * (pastilleH + ecart);

          surface.rectArrondi(x + 3, pastilleY, JOUR_L - 6, pastilleH, Math.min(4, pastilleH / 3), fond);

          // L'heure de fin n'est montrée qu'en cuisine, et seulement sur une pastille seule :
          // deux plages complètes côte à côte dans une colonne de jour deviennent illisibles.
          const heures = quarts
            .map((q) => (avecHeureFin && quarts.length === 1 && q.end_time ? `${q.start_time}–${q.end_time}` : q.start_time))
            .join(" / ");
          // Le texte rétrécit aussi quand plusieurs heures partagent la largeur d'une colonne.
          const tailleHeure = Math.min(HEURE_T, pastilleH * 0.62, (JOUR_L - 10) / (heures.length * 0.58));
          // Le rôle n'apparaît que si la pastille porte deux lignes sans les écraser.
          const avecRole = role !== null && quarts.length === 1 && pastilleH >= (tailleHeure + ROLE_T) * INTERLIGNE + 2;
          const hauteurTexte = (avecRole ? tailleHeure + ROLE_T : tailleHeure) * INTERLIGNE;
          const hautTexte = pastilleY + (pastilleH - hauteurTexte) / 2;

          surface.texte(heures, x + 3, hautTexte, {
            taille: tailleHeure, gras: true, couleur: encre, largeur: JOUR_L - 6, centre: true,
          });
          if (avecRole) {
            surface.texte(LIBELLES_ROLE[L][role], x + 3, hautTexte + tailleHeure * INTERLIGNE, {
              taille: ROLE_T, couleur: encre, largeur: JOUR_L - 6, centre: true,
            });
          }
        });
      });

      surface.ligne(tableX, y + LIGNE_H, tableX + tableL, y + LIGNE_H, 0.5, COULEURS.filet);
    }

    function dessinerCadreTable(bas) {
      surface.cadre(tableX, tableHaut, tableL, bas - tableHaut, 0.8, COULEURS.filetFort);
      // Séparateurs verticaux : après le nom, puis entre chaque jour.
      for (let i = 0; i <= 6; i++) {
        surface.ligne(colX(i), tableHaut, colX(i), bas, 0.5, COULEURS.filet);
      }
      surface.ligne(tableX, tableHaut + ENTETE_H, tableX + tableL, tableHaut + ENTETE_H, 0.8, COULEURS.filetFort);
    }

    function dessinerPied(y) {
      surface.texte(tr.genereLe(fmtTimestamp(new Date(), L)), M, y, {
        taille: 7.5, couleur: COULEURS.gris, largeur: tableL, tronquer: true,
      });
    }

    dessinerTitre();
    dessinerEnteteTable();

    let basTable = tableHaut + ENTETE_H;
    if (employees.length === 0) {
      surface.texte(tr.aucunEmploye, tableX, basTable + 24, {
        taille: 10, couleur: COULEURS.gris, largeur: tableL, centre: true,
      });
      dessinerCadreTable(basTable);
      basTable += 48; // le message s'écrit sous le cadre : le pied doit passer dessous
    } else {
      for (const emp of employees) {
        dessinerLigneEmploye(emp, basTable);
        basTable += LIGNE_H;
      }
      dessinerCadreTable(basTable);
    }

    // Le PDF garde toujours la page entière : c'est une feuille A4, on ne la raccourcit pas.
    // L'image, elle, est rognée sous le tableau — une photo envoyée dans une conversation ne
    // doit pas être à moitié vide, sinon l'aperçu rapetisse le seul contenu qui compte.
    const yPied = compact ? basTable + 12 : hauteurPage - M - 12;
    dessinerPied(yPied);
    return compact ? yPied + 10 + M : hauteurPage;
  }

  // Titre de la feuille. La cuisine le dit : deux feuilles du même restaurant se retrouvent
  // côte à côte sur le babillard, et rien d'autre ne les distingue au premier coup d'œil.
  function nomFeuille(restaurantName, secteur, lang) {
    const L = lang === "en" ? "en" : "fr";
    return secteur === "cuisine" ? `${restaurantName} — ${T[L].cuisine}` : restaurantName;
  }

  // Nom de fichier proposé, partagé par le PDF et l'image pour qu'on retrouve les deux
  // côte à côte dans le dossier de téléchargements.
  function nomDeFichier(restaurantName, weekStartISO, lang, extension) {
    const lundi = getMonday(parseISO(weekStartISO));
    const propre = String(restaurantName || "restaurant")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const prefixe = lang === "en" ? "Schedule" : "Horaire";
    return `${prefixe}_${propre || "restaurant"}_${isoDate(lundi)}.${extension}`;
  }

  return {
    PAGE,
    COULEURS,
    NOMS_JOURS,
    NOMS_MOIS,
    LIBELLES_ROLE,
    T,
    parseISO,
    addDays,
    isoDate,
    getMonday,
    fmtLongDate,
    fmtWeekLabel,
    fmtTimestamp,
    dessinerHoraire,
    nomFeuille,
    nomDeFichier,
  };
});
