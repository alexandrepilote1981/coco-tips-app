// La fenêtre qui s'ouvre avant un férié pour rappeler la commande.
//
// D'où ça vient, dans les mots du gérant : « pendant nos fériés, les horaires de livraison
// de nos fournisseurs peuvent changer… nous devrions faire attention à notre commande avant
// férié car ceux-ci seront peut-être fermés le lundi et toutes les épiceries aussi… si on
// manque de bananes, nous sommes dans la schnoutte! »
//
// L'app ne peut pas savoir si Dufour & Fils est fermé le lundi — personne ne le lui a dit,
// et le gérant lui-même écrit « peut-être ». Elle ne répond donc pas à la question. Ce
// qu'elle fait, c'est s'assurer que la question se POSE toujours à temps : l'oubli qu'on
// vise n'est pas « je ne savais pas », c'est « j'ai pas pensé à vérifier ».
//
// Deux décisions prises avec le propriétaire, et il ne faut pas les défaire par distraction :
//
// 1. Elle réapparaît à CHAQUE ouverture de l'app tant que le férié n'est pas passé. Pas de
//    bouton « ne plus afficher », pas de cases à cocher qui la font taire. On peut la fermer,
//    elle revient la prochaine fois. C'est voulu : une alerte qu'on peut éteindre pour de
//    bon, c'est une alerte qu'on éteint le samedi et qu'on oublie le jeudi.
// 2. Aucun son. Jamais.
//
// Le moment où elle sort est calculé dans feries.js (`alertes`) : le samedi, neuf jours
// avant le lundi de la semaine visée, parce que la commande se passe une fois par semaine,
// la semaine d'avant.

window.AlerteFerie = (function () {
  const T = {
    fr: {
      locale: "fr-CA",
      titre: "Commande à prévoir",
      semaine: (d1, d2) => `Semaine du ${d1} au ${d2}`,
      ferme: (jour) =>
        `Le restaurant est fermé le ${jour}. Les fournisseurs aussi — la commande doit couvrir jusqu'à la réouverture.`,
      ferie: "Les fournisseurs et les épiceries peuvent être fermés. Commande d'avance.",
      affluence: "La salle va être pleine. Prévois le stock.",
      mesRappels: "Tes rappels",
      aucunRappel: "Aucun rappel écrit pour l'instant.",
      modifier: "Modifier la liste",
      exemple: "Une ligne par rappel.\nEx. : Appeler Dufour & Fils pour confirmer la livraison",
      enregistrer: "Enregistrer",
      annuler: "Annuler",
      fermer: "FERMER",
    },
    en: {
      locale: "en-CA",
      titre: "Order ahead",
      semaine: (d1, d2) => `Week of ${d1} to ${d2}`,
      ferme: (jour) =>
        `The restaurant is closed on ${jour}. So are the suppliers — the order has to cover until you reopen.`,
      ferie: "Suppliers and grocery stores may be closed. Order ahead.",
      affluence: "The dining room will be full. Stock up.",
      mesRappels: "Your reminders",
      aucunRappel: "No reminders written yet.",
      modifier: "Edit the list",
      exemple: "One reminder per line.\nE.g.: Call Dufour & Fils to confirm the delivery",
      enregistrer: "Save",
      annuler: "Cancel",
      fermer: "CLOSE",
    },
  };

  let installee = false;
  let hote = null;
  let restaurants = [];
  let fond = null;

  function tr(lang) {
    return T[lang === "en" ? "en" : "fr"];
  }

  // Une date ISO se construit en heure LOCALE, jamais par new Date("2026-10-12") : celle-là
  // est lue en UTC et recule d'une journée dès qu'on est à l'ouest de Greenwich — ce qui est
  // le cas ici. Un férié affiché la veille, c'est pire que pas de férié.
  function dateLocale(iso) {
    return new Date(parseInt(iso.slice(0, 4), 10), parseInt(iso.slice(5, 7), 10) - 1, parseInt(iso.slice(8, 10), 10));
  }

  function aujourdhuiISO() {
    const d = new Date();
    const deux = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;
  }

  function echapper(texte) {
    return String(texte == null ? "" : texte)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtJour(iso, locale) {
    const texte = dateLocale(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
    // Le français dit « 1er janvier », pas « 1 janvier ». Intl ne le fait pas, alors on le
    // fait ici. Le « 1 » isolé ne peut être que le quantième : ni le jour de la semaine ni
    // le nom du mois ne contiennent un chiffre seul.
    return locale.startsWith("fr") ? texte.replace(/\b1\b/, "1er") : texte;
  }

  function fmtSemaine(lundiISO, locale, t) {
    const lundi = dateLocale(lundiISO);
    const dimanche = new Date(lundi.getFullYear(), lundi.getMonth(), lundi.getDate() + 6);
    const memeMois = lundi.getMonth() === dimanche.getMonth();
    return t.semaine(
      lundi.toLocaleDateString(locale, memeMois ? { day: "numeric" } : { day: "numeric", month: "long" }),
      dimanche.toLocaleDateString(locale, { day: "numeric", month: "long" })
    );
  }

  function injecterStyle() {
    if (document.getElementById("af-style")) return;
    const style = document.createElement("style");
    style.id = "af-style";
    style.textContent = `
      #af-fond {
        position: fixed; inset: 0; z-index: 200;
        background: rgba(6,9,14,0.78);
        display: flex; align-items: center; justify-content: center;
        padding: 18px; overflow-y: auto;
      }
      #af-fond .af-boite {
        background: #161C26; border: 1px solid rgba(226,104,90,0.45); border-radius: 16px;
        max-width: 460px; width: 100%; padding: 22px 20px 20px;
        box-shadow: 0 18px 50px rgba(0,0,0,0.6);
        font-family: 'IBM Plex Sans', system-ui, sans-serif;
      }
      #af-fond .af-titre {
        font-family: 'Fraunces', Georgia, serif; font-size: 19px; font-weight: 600;
        color: #E2685A; margin-bottom: 4px;
      }
      #af-fond .af-bloc { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.08); }
      #af-fond .af-bloc:first-of-type { border-top: none; padding-top: 0; }
      #af-fond .af-semaine {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        color: #8993A4;
      }
      /* Surtout PAS de text-transform: capitalize ici. Il y en avait un, pour relever le
         « lundi » que toLocaleDateString rend en minuscule — sauf qu'il relevait aussi tous
         les autres mots : « Action De Grâce ». Le français ne met pas de majuscule à chaque
         mot. La ligne se lit très bien telle quelle : « Action de grâce — lundi 12 octobre ». */
      #af-fond .af-jour {
        font-size: 15px; font-weight: 700; color: #F1EFEA; margin-top: 3px;
      }
      #af-fond .af-conseil { font-size: 13px; line-height: 1.45; color: #F1EFEA; margin-top: 8px; }
      #af-fond .af-resto {
        font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        color: #8993A4; margin-top: 14px;
      }
      #af-fond .af-etiq {
        font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        color: #D4A857; margin-top: 14px;
      }
      #af-fond .af-rappel {
        font-size: 13px; color: #F1EFEA; line-height: 1.4; margin-top: 5px; padding-left: 17px;
        position: relative;
      }
      #af-fond .af-rappel::before { content: "—"; position: absolute; left: 0; color: #6FBF93; }
      #af-fond .af-vide { font-size: 12.5px; color: #8993A4; margin-top: 5px; font-style: italic; }
      #af-fond textarea {
        width: 100%; margin-top: 8px; min-height: 96px; resize: vertical;
        background: #10151D; color: #F1EFEA; border: 1px solid rgba(255,255,255,0.14);
        border-radius: 9px; padding: 9px 10px; font: inherit; font-size: 13px; line-height: 1.45;
      }
      #af-fond .af-lien {
        background: none; border: none; color: #8993A4; font: inherit; font-size: 12px;
        text-decoration: underline; cursor: pointer; padding: 6px 0 0; margin-top: 4px;
      }
      #af-fond .af-lien:hover { color: #F1EFEA; }
      #af-fond .af-petits { display: flex; gap: 8px; margin-top: 8px; }
      #af-fond .af-petits button {
        font: inherit; font-size: 12px; font-weight: 700; padding: 7px 13px; border-radius: 8px;
        border: none; cursor: pointer;
      }
      #af-fond .af-ok { background: #6FBF93; color: #10151D; }
      #af-fond .af-non { background: rgba(255,255,255,0.08); color: #F1EFEA; }
      /* Le gros piton. Il prend toute la largeur parce qu'on le cherche sur un téléphone,
         souvent d'une main, à cinq heures du matin. */
      #af-fond .af-fermer {
        width: 100%; margin-top: 20px; padding: 15px; border: none; border-radius: 11px;
        background: #6FBF93; color: #10151D; cursor: pointer;
        font: inherit; font-size: 15px; font-weight: 700; letter-spacing: 0.05em;
      }
    `;
    document.head.appendChild(style);
  }

  function blocRappelsHTML(t) {
    const avec = restaurants.filter((r) => (r.rappels || "").trim());
    const plusieurs = restaurants.length > 1;

    if (avec.length === 0) {
      return `<div class="af-etiq">${t.mesRappels}</div><div class="af-vide">${t.aucunRappel}</div>`;
    }
    return (
      `<div class="af-etiq">${t.mesRappels}</div>` +
      avec
        .map(
          (r) =>
            (plusieurs ? `<div class="af-resto">${echapper(r.name)}</div>` : "") +
            r.rappels
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => `<div class="af-rappel">${echapper(l)}</div>`)
              .join("")
        )
        .join("")
    );
  }

  function formeHTML(t) {
    return restaurants
      .map(
        (r, i) => `
      ${restaurants.length > 1 ? `<div class="af-resto">${echapper(r.name)}</div>` : ""}
      <textarea data-i="${i}" placeholder="${echapper(t.exemple)}">${echapper(r.rappels || "")}</textarea>`
      )
      .join("");
  }

  function contenuHTML(alertes, lang, enEdition) {
    const t = tr(lang);
    const L = t.locale;
    return `
      <div class="af-boite" role="dialog" aria-modal="true">
        <div class="af-titre">${t.titre}</div>
        ${alertes
          .map((a) => {
            const jours = a.journees
              .map((j) => `${window.Feries.libelle(j.cle, lang)} — ${fmtJour(j.date, L)}`)
              .join("<br>");
            const ferme = a.journees.find((j) => j.ferme);
            const conseils = [];
            if (ferme) conseils.push(t.ferme(fmtJour(ferme.date, L)));
            if (a.journees.some((j) => j.type === "ferie" && !j.ferme)) conseils.push(t.ferie);
            if (a.journees.some((j) => j.affluence)) conseils.push(t.affluence);
            return `
          <div class="af-bloc">
            <div class="af-semaine">${fmtSemaine(a.lundiISO, L, t)}</div>
            <div class="af-jour">${jours}</div>
            ${conseils.map((c) => `<div class="af-conseil">${c}</div>`).join("")}
          </div>`;
          })
          .join("")}
        ${
          enEdition
            ? `${formeHTML(t)}
               <div class="af-petits">
                 <button class="af-ok" data-af="enregistrer">${t.enregistrer}</button>
                 <button class="af-non" data-af="annuler">${t.annuler}</button>
               </div>`
            : `${blocRappelsHTML(t)}
               <button class="af-lien" data-af="modifier">${t.modifier}</button>`
        }
        <button class="af-fermer" data-af="fermer">${t.fermer}</button>
      </div>`;
  }

  function dessiner(alertes, enEdition) {
    const lang = hote.lang();
    fond.innerHTML = contenuHTML(alertes, lang, enEdition);

    fond.querySelector('[data-af="fermer"]').onclick = fermer;
    const modifier = fond.querySelector('[data-af="modifier"]');
    if (modifier) modifier.onclick = () => dessiner(alertes, true);
    const annuler = fond.querySelector('[data-af="annuler"]');
    if (annuler) annuler.onclick = () => dessiner(alertes, false);
    const enregistrer = fond.querySelector('[data-af="enregistrer"]');
    if (enregistrer) {
      enregistrer.onclick = async () => {
        enregistrer.disabled = true;
        const zones = [...fond.querySelectorAll("textarea")];
        try {
          for (const zone of zones) {
            const r = restaurants[parseInt(zone.dataset.i, 10)];
            const texte = zone.value;
            if (texte === (r.rappels || "")) continue; // rien changé, rien à envoyer
            const rep = await hote.enregistrer(r.id, texte);
            // On garde ce que le SERVEUR a retenu, pas ce qui a été tapé : c'est lui qui
            // coupe les lignes trop longues et les lignes vides.
            r.rappels = rep && typeof rep.rappels === "string" ? rep.rappels : texte;
          }
          dessiner(alertes, false);
        } catch (e) {
          enregistrer.disabled = false;
        }
      };
    }
  }

  function fermer() {
    if (!fond) return;
    fond.remove();
    fond = null;
    document.removeEventListener("keydown", surEchap);
  }

  function surEchap(e) {
    if (e.key === "Escape") fermer();
  }

  /**
   * @param {object} options
   * @param {() => string} options.lang
   * @param {() => Promise<Array<{id,name,rappels}>>} options.charger  rejette si la porte n'y
   *        a pas droit — c'est le serveur qui décide qui voit la fenêtre, pas cette page.
   * @param {(id: string, rappels: string) => Promise<any>} options.enregistrer
   */
  async function init(options) {
    if (installee) return; // une seule fenêtre par ouverture de l'app
    installee = true;
    hote = options;

    const alertes = window.Feries.alertes(aujourdhuiISO());
    if (alertes.length === 0) return;

    try {
      restaurants = (await hote.charger()) || [];
    } catch (e) {
      return; // porte sans droit, ou réseau : pas de fenêtre, et aucun message d'erreur
    }

    injecterStyle();
    fond = document.createElement("div");
    fond.id = "af-fond";
    // Un clic à côté de la boîte ferme aussi. Sans risque : la fenêtre revient à la
    // prochaine ouverture de l'app de toute façon.
    fond.onclick = (e) => {
      if (e.target === fond) fermer();
    };
    document.body.appendChild(fond);
    document.addEventListener("keydown", surEchap);
    dessiner(alertes, false);
  }

  return { init, fermer, _contenuHTML: contenuHTML };
})();
