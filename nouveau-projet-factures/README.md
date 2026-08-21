# Factures — capture et suivi des dépenses

Photographier une facture avec son téléphone et la voir apparaître, correctement ventilée,
dans le registre des dépenses — sans ressaisie.

**Projet distinct de Déclara.** Base séparée, déploiement séparé, aucun code partagé.

## Démarrer

```bash
npm install
npm start                 # écoute sur PORT, 3000 par défaut
npm test                  # node --test : tout ce qui est sous test/
```

Variables d'environnement (toutes avec une valeur de repli — l'app démarre sans configuration,
seule l'analyse automatique demande une clé) :

| Variable            | Défaut                        | Rôle                                   |
| ------------------- | ----------------------------- | -------------------------------------- |
| `PORT`              | `3000`                        | port d'écoute                          |
| `APP_PASSWORD`      | `changeme`                    | accès au site et au registre           |
| `ANTHROPIC_API_KEY` | *(aucune)*                    | lecture automatique des factures       |
| `ANTHROPIC_MODEL`   | `claude-opus-5`               | modèle d'extraction                    |
| `ANTHROPIC_EFFORT`  | `high`                        | profondeur d'analyse                   |
| `DB_PATH`           | `./data.sqlite`               | fichier SQLite                         |
| `PHOTOS_DIR`        | `<dossier de DB_PATH>/photos` | photos de factures                     |

Sans `ANTHROPIC_API_KEY`, tout fonctionne : les photos sont enregistrées et les factures se
saisissent à la main. C'est aussi le mode dans lequel tournent les tests.

Instance jetable :

```bash
DB_PATH=/tmp/essai.sqlite PORT=3999 APP_PASSWORD=changeme node server.js
```

La base se crée et se migre toute seule au démarrage (`db.js`) — aucune étape manuelle.

## Le parcours

1. `/` — connexion, puis un bouton unique : la caméra arrière s'ouvre en un tap.
2. La photo est compressée dans le navigateur, envoyée, **écrite sur disque**, puis analysée.
3. L'analyse pré-remplit une fiche. **Rien n'entre dans les dépenses à ce stade.**
4. `/depenses` — on vérifie, on corrige, on valide. C'est la validation qui inscrit la dépense.
5. Export CSV des dépenses validées, pour le comptable.

### La règle qui structure tout : jamais d'écriture automatique

Une extraction est une hypothèse, pas une écriture comptable. Un « 1 234,56 » lu « 234,56 »
qui se déposerait tout seul dans le registre ne serait jamais rattrapé — personne ne relit un
registre de dépenses ligne par ligne. Le flux est donc toujours :

    photo → extraction → fiche pré-remplie à confirmer → dépense enregistrée

Trois garde-fous complètent la confirmation :

- **Contrôle de cohérence** — si `sous-total + TPS + TVQ ≠ total`, un drapeau rouge apparaît.
  C'est le meilleur détecteur d'erreur de lecture disponible, et il est gratuit.
- **Doublons** — par empreinte de l'image au dépôt (la photo renvoyée deux fois), et par
  `fournisseur + date + total` à la validation (le même reçu rephotographié autrement).
- **Alertes de CTI** — des taxes sans numéro de TPS/TVQ du fournisseur sont signalées : un
  crédit peut être refusé sans eux.

### Les montants imprimés font foi

Le modèle ne recalcule jamais une taxe absente du reçu : il renvoie `null`. Les taux servent
uniquement à *estimer* quand un montant est illisible, jamais à remplacer un montant imprimé —
l'arrondi ne retombe pas juste, et ce sont les montants imprimés qui comptent pour les CTI/RTI.

## Ce que ce projet n'est pas

Il **capture, ventile, catégorise et exporte**. Il ne produit pas de bilan, pas de T2/TP-1,
pas de déductions à la source, pas de déclaration TPS/TVQ transmise aux gouvernements. La
sortie est un CSV que le comptable ingère.

## Les fichiers

```
server.js                     toutes les routes HTTP, un seul fichier
db.js                         ouverture SQLite, schéma, migrations idempotentes
extraction.js                 lecture d'une photo par l'API Claude
rate-limit.js                 plafond de tentatives, sur les échecs seulement
public/index.html             accueil : connexion, bouton caméra, lien privé
public/capture.html           page du lien privé du téléphone (dépôt seulement)
public/depenses.html          le registre : vérifier, corriger, valider, exporter
public/shared/taxes.js        taxes et cohérence — chargé par le serveur ET le navigateur
public/shared/capture-photo.js compression et envoi — partagé par index et capture
test/                         tests node:test
```

## Deux portes d'entrée

- **Mot de passe** (`APP_PASSWORD`) — le site complet. Gardé dans `sessionStorage` sous
  `appToken`, envoyé en en-tête `X-App-Token`.
- **Lien privé** `/c/<code>` — ouvre la caméra sans mot de passe et ne peut **que** déposer une
  photo. Il vit dans les favoris d'un téléphone qui peut se perdre : il n'expose jamais un
  montant ni le registre. Un test le vérifie explicitement.

`rate-limit.js` ne compte que les échecs : rouvrir le lien avec un code valide n'est jamais
pénalisé, enchaîner des codes faux l'est. C'est ce qui rend un code de 6 caractères
acceptable — ne pas affaiblir ce principe.

## Tests

```bash
npm test
npm install --no-save playwright && npm test    # ajoute le test navigateur
```

- `test/taxes.test.js` — cohérence, estimation, alertes de CTI.
- `test/extraction.test.js` — découpage des data URL et forme du schéma, sans réseau.
- `test/api.test.js` — parcours complet sur une base jetable, sans clé API : dépôt, doublon,
  validation, export, suppression.
- `test/ui-smoke.test.mjs` — les vraies pages dans un vrai navigateur. Se saute tout seul,
  sans échouer, quand Playwright ou Chromium est absent.

## Déploiement

Railway, avec un volume monté pour que la base et les photos survivent aux redéploiements.
`DB_PATH` doit pointer dans le volume. `data.sqlite` et `photos/` sont ignorés par git —
ne jamais les committer.
