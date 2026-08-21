// Calcul et vérification des taxes québécoises.
//
// Ce fichier est chargé des DEUX côtés — require() sous Node, window.Taxes dans le
// navigateur. C'est délibéré : sur le projet précédent, le même calcul avait été écrit en
// double, les deux versions ont divergé en silence, et la page affichait un montant pendant
// que la base en gardait un autre. Ici l'erreur serait pire, parce que personne ne relit un
// registre de dépenses ligne par ligne.

// Taux en vigueur au Québec. Gardés ici et nulle part ailleurs : un taux changera un jour,
// et il ne doit y avoir qu'un seul endroit à modifier.
const TAUX = { tps: 0.05, tvq: 0.09975 };

// Tolérance du contrôle de cohérence, en dollars. Deux cents : un reçu légitime peut avoir
// un écart d'un cent par arrondi sur chaque taxe, et refuser ça noierait l'utilisateur sous
// de faux drapeaux.
const TOLERANCE = 0.02;

function arrondirCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Estime les taxes à partir d'un sous-total. Sert UNIQUEMENT à pré-remplir un formulaire
// quand le reçu est illisible : les montants imprimés font foi pour les CTI/RTI, et une
// taxe recalculée peut différer de quelques cents de celle réellement facturée.
function estimerTaxes(sousTotal) {
  const st = arrondirCent(sousTotal);
  const tps = arrondirCent(st * TAUX.tps);
  const tvq = arrondirCent(st * TAUX.tvq);
  return { sous_total: st, tps, tvq, total: arrondirCent(st + tps + tvq) };
}

// Le meilleur détecteur d'erreur de lecture disponible, et il est gratuit : si les montants
// extraits ne s'additionnent pas, c'est qu'au moins un chiffre a été mal lu.
function verifierCoherence({ sous_total, tps, tvq, total }) {
  const somme = arrondirCent((Number(sous_total) || 0) + (Number(tps) || 0) + (Number(tvq) || 0));
  const attendu = arrondirCent(total);
  const ecart = arrondirCent(somme - attendu);
  return { coherent: Math.abs(ecart) <= TOLERANCE, ecart, somme, total: attendu };
}

// Un fournisseur qui ne facture aucune taxe est plausible (petit fournisseur non inscrit),
// mais un CTI réclamé sur une facture sans numéro de TPS/TVQ peut être refusé à la
// vérification. On signale plutôt que de bloquer : c'est au comptable de trancher.
function alertesCTI(facture) {
  const alertes = [];
  const aDesTaxes = (Number(facture.tps) || 0) > 0 || (Number(facture.tvq) || 0) > 0;
  if (aDesTaxes && !facture.fournisseur_tps && !facture.fournisseur_tvq) {
    alertes.push("numeros_taxes_manquants");
  }
  if (!facture.fournisseur) alertes.push("fournisseur_manquant");
  if (!facture.date) alertes.push("date_manquante");
  return alertes;
}

const Taxes = { TAUX, TOLERANCE, arrondirCent, estimerTaxes, verifierCoherence, alertesCTI };

if (typeof module !== "undefined" && module.exports) module.exports = Taxes;
if (typeof window !== "undefined") window.Taxes = Taxes;
