// Lecture d'une photo de facture par l'API Claude.
//
// Le résultat de ce fichier n'entre JAMAIS directement dans les livres : il pré-remplit un
// formulaire que l'utilisateur confirme. Une extraction est une hypothèse, pas une écriture
// comptable — un « 1 234,56 » lu « 234,56 » qui se déposerait tout seul dans le registre ne
// serait jamais rattrapé, parce que personne ne relit un registre de dépenses ligne par ligne.

const Anthropic = require("@anthropic-ai/sdk");

// Le modèle est configurable pour pouvoir en changer sans redéployer du code, mais le défaut
// est le plus capable : une taxe mal lue coûte plus cher que la différence de prix par appel.
const MODELE = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const EFFORT = process.env.ANTHROPIC_EFFORT || "high";

// Formats acceptés par l'API. Le HEIC de l'iPhone n'en fait pas partie : le navigateur le
// reconvertit en JPEG avant l'envoi (voir la compression dans capture.html), donc on ne
// devrait jamais en voir ici — mais on refuse proprement plutôt que d'envoyer un appel voué
// à l'échec et à la facturation.
const TYPES_ACCEPTES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Schéma de sortie. `additionalProperties: false` et la liste `required` complète sont exigés
// par l'API en mode json_schema : sans eux, la contrainte n'est pas appliquée.
// Chaque champ accepte null — un reçu froissé peut ne rien montrer de lisible, et un null
// honnête vaut mieux qu'un montant inventé.
const SCHEMA = {
  type: "object",
  properties: {
    fournisseur: { type: ["string", "null"], description: "Nom commercial du fournisseur" },
    fournisseur_tps: { type: ["string", "null"], description: "Numéro de TPS/GST du fournisseur, tel qu'imprimé" },
    fournisseur_tvq: { type: ["string", "null"], description: "Numéro de TVQ/QST du fournisseur, tel qu'imprimé" },
    date: { type: ["string", "null"], description: "Date de la facture au format AAAA-MM-JJ" },
    sous_total: { type: ["number", "null"], description: "Montant avant taxes, tel qu'imprimé" },
    tps: { type: ["number", "null"], description: "Montant de TPS/GST tel qu'imprimé, jamais recalculé" },
    tvq: { type: ["number", "null"], description: "Montant de TVQ/QST tel qu'imprimé, jamais recalculé" },
    total: { type: ["number", "null"], description: "Montant total payé, tel qu'imprimé" },
    devise: { type: ["string", "null"], description: "Code de devise, CAD par défaut" },
    categorie: { type: ["string", "null"], description: "Catégorie de dépense suggérée" },
    mode_paiement: { type: ["string", "null"], description: "Comptant, débit, crédit, ou autre" },
    lisible: { type: "boolean", description: "false si la photo est trop floue ou coupée pour être lue avec confiance" },
  },
  required: [
    "fournisseur", "fournisseur_tps", "fournisseur_tvq", "date",
    "sous_total", "tps", "tvq", "total", "devise",
    "categorie", "mode_paiement", "lisible",
  ],
  additionalProperties: false,
};

const CONSIGNE = `Tu lis la photo d'une facture ou d'un reçu commercial québécois.

Extrais uniquement ce qui est RÉELLEMENT IMPRIMÉ sur le document.

Règles absolues :
- Ne calcule jamais un montant qui n'est pas imprimé. Si la TPS n'apparaît pas, renvoie null
  pour la TPS — surtout pas 5 % du sous-total. Ce sont les montants imprimés qui font foi
  pour les crédits de taxe sur les intrants, et un montant recalculé peut différer de
  quelques cents de celui réellement facturé.
- Les nombres sont des nombres, sans symbole de devise et avec un point décimal.
- La date est au format AAAA-MM-JJ. Attention aux formats ambigus : au Québec un reçu affiche
  souvent JJ/MM/AAAA. Si l'année n'est pas visible, renvoie null plutôt que de la deviner.
- Les numéros de TPS et de TVQ du fournisseur sont souvent en petits caractères en bas ou en
  en-tête. Recopie-les tels quels s'ils sont présents, null sinon.
- Mets "lisible" à false si la photo est floue, coupée, ou si tu dois deviner l'essentiel.

Pour la catégorie, propose une catégorie de dépense courte et courante (par exemple
"Nourriture et boissons", "Fournitures", "Entretien et réparations", "Transport",
"Télécommunications", "Loyer", "Équipement"). Null si rien ne s'impose.`;

// Extrait la data URL en ses deux parties. Séparé pour être testable sans réseau.
function decouperDataUrl(dataUrl) {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Format d'image invalide");
  const mediaType = match[1].toLowerCase();
  if (!TYPES_ACCEPTES.has(mediaType)) throw new Error(`Format d'image non supporté : ${mediaType}`);
  return { mediaType, base64: match[2] };
}

function extractionDisponible() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function extraireFacture(dataUrl) {
  const { mediaType, base64 } = decouperDataUrl(dataUrl);
  const client = new Anthropic();

  const reponse = await client.messages.create({
    model: MODELE,
    max_tokens: 16000,
    system: CONSIGNE,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Lis cette facture." },
        ],
      },
    ],
  });

  // Un refus de sécurité renvoie un HTTP 200 sans contenu exploitable : il faut le regarder
  // avant de lire content, sinon on plante sur un tableau vide.
  if (reponse.stop_reason === "refusal") {
    throw new Error("L'analyse a été refusée par le modèle");
  }

  const bloc = reponse.content.find((b) => b.type === "text");
  if (!bloc) throw new Error("Réponse d'analyse vide");
  return JSON.parse(bloc.text);
}

module.exports = { extraireFacture, extractionDisponible, decouperDataUrl, SCHEMA, MODELE };
