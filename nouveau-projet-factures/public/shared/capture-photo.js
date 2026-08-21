// Compression et envoi d'une photo de facture.
//
// Chargé par la page d'accueil ET par la page de capture du téléphone. Le code vit ici pour
// la même raison que le calcul des taxes : écrit en double, il divergerait, et la moitié des
// dépôts finiraient compressés autrement que l'autre moitié sans que personne le remarque.

(function () {
  // 1600 px sur le grand côté : assez pour lire les petits caractères d'un numéro de TVQ,
  // assez petit pour passer sur une connexion cellulaire faible. La qualité JPEG à 0,82 est
  // le point où le texte reste net sans que le fichier double.
  const COTE_MAX = 1600;
  const QUALITE = 0.82;

  // Convertit aussi le HEIC de l'iPhone en JPEG au passage : le canvas ne sait ré-encoder
  // qu'en formats que l'API accepte, ce qui règle le problème sans code de conversion.
  function compresser(file) {
    return new Promise((resolve, reject) => {
      const lecteur = new FileReader();
      lecteur.onerror = () => reject(new Error("Lecture de la photo impossible"));
      lecteur.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Cette photo n'a pas pu être ouverte"));
        img.onload = () => {
          const ratio = Math.min(1, COTE_MAX / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", QUALITE));
        };
        img.src = lecteur.result;
      };
      lecteur.readAsDataURL(file);
    });
  }

  // `entetes` porte soit le mot de passe, soit le code du lien de capture — le serveur
  // accepte les deux pour un dépôt.
  async function deposer(dataUrl, entetes, forcer) {
    const r = await fetch("/api/factures", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, entetes),
      body: JSON.stringify({ photoBase64: dataUrl, forcer: Boolean(forcer) }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) return { doublon: true, facture: data.facture };
    if (!r.ok) throw new Error(data.error || "Envoi impossible");
    return data;
  }

  window.CapturePhoto = { compresser, deposer, COTE_MAX, QUALITE };
})();
