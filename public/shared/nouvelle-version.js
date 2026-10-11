// « Une nouvelle version est prête » — la bande qui apparaît quand le code servi a changé.
//
// Pourquoi ce fichier existe, et ce n'est pas théorique : le propriétaire a passé une heure
// à regarder une vieille page. Il envoyait des captures d'un écran que j'avais déjà changé
// deux fois, et on a cherché le bogue dans le code alors qu'il n'y en avait pas.
//
// Trois choses se combinent pour produire ça :
//
//   1. L'app est ajoutée à l'écran d'accueil (`apple-mobile-web-app-title`). iOS garde alors
//      la page vivante dans sa vue web : rouvrir l'icône ne redemande rien au serveur.
//   2. Il n'y a PAS de barre de navigateur, donc aucun bouton « recharger ».
//   3. « Tirer pour actualiser » ne recharge que les DONNÉES, pas la page — c'est une
//      décision assumée (voir tirer-pour-actualiser.js), mais elle veut dire que le
//      JavaScript, lui, ne change jamais.
//
// Les en-têtes `no-cache` du serveur n'y peuvent rien : le navigateur ne redemande pas la
// page, donc il ne lit pas ses en-têtes.
//
// Ce qu'on fait : le serveur rend une empreinte de ses fichiers servis. La page la retient
// au premier chargement et la redemande à chaque actualisation. Quand elle change, une
// bande apparaît.
//
// UNE BANDE, PAS UN RECHARGEMENT AUTOMATIQUE. Le gérant peut être en train de taper un
// montant ou de monter un horaire ; recharger sous ses doigts lui ferait perdre sa saisie,
// et c'est exactement le genre de perte qu'on passe le reste de ce dépôt à éviter. Il tape
// quand il est prêt.

window.NouvelleVersion = (function () {
  let connue = null;
  let bande = null;
  let libelle = null;

  async function lire() {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.version ? String(data.version) : null;
    } catch (e) {
      // Hors ligne, ou serveur qui redémarre : ce n'est pas une nouvelle version, c'est pas
      // de réponse du tout. On ne montre rien plutôt que d'inventer.
      return null;
    }
  }

  function montrer() {
    if (bande) return;
    bande = document.createElement("div");
    bande.className = "nouvelle-version-bande";
    bande.innerHTML = `
      <span class="nv-texte">${libelle("nouvelleVersion")}</span>
      <button type="button" class="nv-bouton">${libelle("nouvelleVersionRecharger")}</button>`;
    // `location.reload()` suffit : la page porte déjà `no-cache`, donc le serveur renverra
    // la dernière. C'est de ne JAMAIS la redemander qui posait problème.
    bande.querySelector(".nv-bouton").addEventListener("click", () => window.location.reload());
    document.body.appendChild(bande);
  }

  /**
   * À appeler une fois au démarrage, puis à chaque actualisation des données.
   * Le premier appel ne fait que retenir l'empreinte : il n'y a rien à comparer.
   */
  async function verifier() {
    const vue = await lire();
    if (!vue) return;
    if (connue === null) {
      connue = vue;
      return;
    }
    if (vue !== connue) montrer();
  }

  function init(options) {
    libelle = (options && options.libelle) || ((c) => c);
    const style = document.createElement("style");
    style.textContent = `
      .nouvelle-version-bande {
        position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 300;
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px; border-radius: 14px;
        background: #D4A857; color: #10151D;
        font-size: 13px; font-weight: 700; line-height: 1.3;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      }
      .nouvelle-version-bande .nv-texte { flex: 1 1 auto; }
      /* 44 px : on le tape une fois, mais d'une main et sans viser. */
      .nouvelle-version-bande .nv-bouton {
        flex: 0 0 auto; min-height: 44px; padding: 0 16px; border: 0; border-radius: 10px;
        background: #10151D; color: #F1EFEA; font-size: 13px; font-weight: 700; cursor: pointer;
      }`;
    document.head.appendChild(style);
    verifier();
  }

  return { init, verifier, _lire: lire };
})();
