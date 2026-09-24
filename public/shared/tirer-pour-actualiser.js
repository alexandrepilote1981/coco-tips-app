// « Tirer pour actualiser » — le geste que tout le monde connaît : on est déjà en haut de la
// page, on tire encore vers le bas, et les données se rechargent.
//
// Pourquoi l'écrire nous-mêmes plutôt que de laisser le navigateur le faire : le geste natif
// recharge la PAGE ENTIÈRE. Ici, les trois écrans sont construits en JavaScript et se
// souviennent d'un tas de choses — la période affichée, la semaine d'horaire consultée, la
// position de défilement. Un rechargement complet les renvoie tous à zéro. On rappelle donc
// simplement le chargement des données, et la page se redessine là où elle était.
//
// Et surtout : ajoutée à l'écran d'accueil d'un téléphone, l'application n'a plus de barre
// de navigateur du tout — le geste natif n'existe plus. C'est là que ce fichier compte le
// plus, parce que c'est comme ça que le gérant et les employées ouvrent l'app.

window.TirerPourActualiser = (function () {
  const SEUIL = 64; // distance à franchir pour que le relâchement déclenche l'actualisation
  const MAX = 96; // au-delà, l'indicateur ne suit plus : inutile de tirer plus fort
  const RESISTANCE = 0.5; // le doigt parcourt le double de ce que l'indicateur descend

  let indicateur = null;
  let etiquette = null;
  let etat = "repos"; // repos | tire | pret | chargement
  let departY = 0;
  let distance = 0;
  let arme = false;
  let surRafraichir = null;
  let libelle = null;

  function defilement() {
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  // Un tirage commencé dans une fenêtre modale ne doit pas actualiser la page en dessous :
  // la personne fait défiler le contenu de la fenêtre, pas la page.
  function dansUneFenetre(cible) {
    for (let n = cible; n && n !== document.body; n = n.parentElement) {
      if (n.nodeType === 1 && getComputedStyle(n).position === "fixed") return true;
    }
    return false;
  }

  // Le style est injecté ici plutôt que recopié dans les trois pages : c'est un morceau
  // d'interface entièrement interne à ce fichier, et trois copies auraient divergé.
  function injecterStyle() {
    if (document.getElementById("tpa-style")) return;
    const style = document.createElement("style");
    style.id = "tpa-style";
    style.textContent = `
      #tpa-indicateur {
        position: fixed; top: 0; left: 50%; z-index: 90;
        display: flex; align-items: center; gap: 8px;
        padding: 7px 14px; border-radius: 999px;
        background: #161C26; border: 1px solid rgba(255,255,255,0.1);
        color: #8993A4; font-size: 11.5px; font-weight: 700;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45);
        pointer-events: none; opacity: 0;
        transform: translate(-50%, -100%);
      }
      #tpa-indicateur.tpa-anime { transition: transform 0.22s ease, opacity 0.22s ease; }
      #tpa-indicateur .tpa-rond {
        width: 13px; height: 13px; border-radius: 50%;
        border: 2px solid rgba(111,191,147,0.25); border-top-color: #6FBF93;
      }
      #tpa-indicateur.tpa-pret .tpa-rond { border-color: #6FBF93; }
      #tpa-indicateur.tpa-charge .tpa-rond { animation: tpa-tourne 0.7s linear infinite; }
      @keyframes tpa-tourne { to { transform: rotate(360deg); } }
      /* Empêche le rebond élastique de la page de manger le geste avant nous. */
      html, body { overscroll-behavior-y: contain; }
    `;
    document.head.appendChild(style);
  }

  function creerIndicateur() {
    injecterStyle();
    indicateur = document.createElement("div");
    indicateur.id = "tpa-indicateur";
    indicateur.innerHTML = '<span class="tpa-rond"></span><span class="tpa-texte"></span>';
    document.body.appendChild(indicateur);
    etiquette = indicateur.querySelector(".tpa-texte");
  }

  function positionner(y, anime) {
    indicateur.classList.toggle("tpa-anime", !!anime);
    indicateur.style.opacity = y > 4 ? "1" : "0";
    indicateur.style.transform = `translate(-50%, ${y}px)`;
  }

  function majTexte() {
    indicateur.classList.toggle("tpa-pret", etat === "pret");
    indicateur.classList.toggle("tpa-charge", etat === "chargement");
    const cle =
      etat === "chargement" ? "actualisationEnCours" : etat === "pret" ? "relacherPourActualiser" : "tirerPourActualiser";
    etiquette.textContent = libelle(cle);
  }

  function ranger() {
    etat = "repos";
    distance = 0;
    indicateur.classList.remove("tpa-pret", "tpa-charge");
    positionner(-60, true);
  }

  function debut(e) {
    if (etat === "chargement" || e.touches.length !== 1) return;
    if (defilement() > 0 || dansUneFenetre(e.target)) return;
    departY = e.touches[0].clientY;
    distance = 0;
    arme = true;
  }

  function mouvement(e) {
    if (!arme || etat === "chargement") return;
    const dy = e.touches[0].clientY - departY;

    // Vers le haut, ou la page a commencé à défiler : ce n'est pas un tirage.
    if (dy <= 0 || defilement() > 0) {
      arme = false;
      ranger();
      return;
    }

    distance = Math.min(MAX, dy * RESISTANCE);
    // Sans ça, le navigateur fait partir la page en élastique par-dessus notre geste.
    if (e.cancelable) e.preventDefault();
    positionner(distance, false);
    etat = distance >= SEUIL ? "pret" : "tire";
    majTexte();
  }

  async function fin() {
    if (!arme) return;
    arme = false;
    if (etat !== "pret") {
      ranger();
      return;
    }

    etat = "chargement";
    positionner(SEUIL, true);
    majTexte();
    try {
      await surRafraichir();
    } catch (e) {
      /* la page affiche déjà ses propres erreurs : ne pas en ajouter une par-dessus */
    }
    // Un court temps d'arrêt : sans lui, sur une connexion rapide, l'indicateur apparaît et
    // disparaît si vite qu'on doute que quelque chose se soit produit.
    await new Promise((r) => setTimeout(r, 350));
    ranger();
  }

  /**
   * @param {object} options
   * @param {() => Promise<void>} options.surRafraichir  recharge les données de la page
   * @param {(cle: string) => string} options.libelle    traduction ; trois clés sont lues :
   *        tirerPourActualiser, relacherPourActualiser, actualisationEnCours
   */
  function init({ surRafraichir: f, libelle: l }) {
    if (indicateur) return; // une seule installation par page
    surRafraichir = f;
    libelle = l;
    creerIndicateur();
    positionner(-60, false);

    // passive: false, sinon preventDefault() est ignoré et le rebond natif l'emporte.
    document.addEventListener("touchstart", debut, { passive: true });
    document.addEventListener("touchmove", mouvement, { passive: false });
    document.addEventListener("touchend", fin, { passive: true });
    document.addEventListener("touchcancel", () => {
      arme = false;
      if (etat !== "chargement") ranger();
    }, { passive: true });
  }

  return { init, SEUIL };
})();
