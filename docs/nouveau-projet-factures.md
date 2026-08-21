# Nouveau projet — capture et suivi des factures

Document de préparation. **Ce projet est distinct de Déclara** : nouveau dépôt, nouvelle base,
nouveau déploiement. Déclara reste en production à `declara.tips` et n'est pas touché. Ce
fichier vit ici seulement parce que la branche `claude/nouveau-coco-prep-ie8vii` est l'endroit
où la préparation a commencé ; il déménagera dans le nouveau dépôt dès sa création.

## Le but

Photographier une facture avec son téléphone et la voir apparaître, correctement ventilée,
dans le registre des dépenses — sans ressaisie manuelle.

Le parcours visé, tel que décrit par le propriétaire :

1. ouvrir un lien depuis la page d'accueil ;
2. la caméra s'ouvre ;
3. photo de la facture ;
4. la photo part vers le site principal ;
5. elle est analysée et versée aux dépenses.

## Ce que ce projet n'est PAS

À écrire noir sur blanc, parce que « faire ma comptabilité » peut vouloir dire beaucoup de
choses et que la frontière est ce qui rend le projet réalisable.

Le projet **capture, ventile, catégorise et exporte**. Il ne produit pas de bilan, pas de
T2/TP-1, pas de déductions à la source, pas de déclarations TPS/TVQ transmises aux
gouvernements. La sortie est un export propre (CSV/PDF) que le comptable ingère.

Construire la déclaration fiscale elle-même serait un autre métier, avec un vrai risque
légal et financier. Hors périmètre, sauf décision explicite contraire.

## Décisions déjà prises

- **Séparé de Déclara.** Pas de code partagé, pas de base partagée. On peut réutiliser les
  *patrons* de Déclara (voir plus bas), jamais les fichiers.
- **Rien n'entre dans les dépenses sans confirmation humaine.** Voir « Le piège principal ».
- **Aucun compte utilisateur classique** attendu au départ : le propriétaire est
  essentiellement le seul utilisateur.
- **Même pile que Déclara** : Express + better-sqlite3, pages autonomes sans build,
  déploiement Railway avec volume. Éprouvée en production et déjà maîtrisée.
- **Français seulement** à l'écran, sans dictionnaire bilingue : l'utilisateur principal est
  unique. Le patron `I18N` / `t()` de Déclara reste disponible si l'anglais devient nécessaire.
- **Nom du dépôt : `factures-app`**, privé — c'est un outil de comptabilité d'entreprise.

## Le piège principal : jamais d'écriture automatique

L'extraction ne doit **jamais** verser une dépense directement dans les livres. Le flux est :

    photo → extraction → fiche pré-remplie à confirmer → dépense enregistrée

Un tap pour confirmer quand tout est bon. C'est peu de friction et ça arrête net les erreurs
qui, autrement, se déposent en silence dans la comptabilité :

- un `1 234,56` lu `234,56` ;
- une TVQ recalculée au lieu d'être lue ;
- la même facture photographiée deux fois.

C'est la leçon déjà apprise sur Déclara avec `public/shared/tip-math.js` : le calcul existait
en double, les deux versions ont divergé, la page affichait un montant et la base en gardait
un autre. Ici l'équivalent serait pire, parce que personne ne relit un registre de dépenses.

## Les taxes du Québec

- TPS 5 %, TVQ 9,975 % (à vérifier au moment d'implémenter et à garder configurable —
  un taux changera un jour).
- **Toujours conserver les montants imprimés sur le reçu**, jamais des montants recalculés
  depuis le total : l'arrondi ne retombe pas juste, et ce sont les montants imprimés qui font
  foi pour les crédits de taxe sur les intrants (CTI/RTI).
- Capturer les **numéros de TPS/TVQ du fournisseur** quand ils figurent sur la facture : sans
  eux, un CTI peut être refusé.
- **Contrôle de cohérence** : si `sous-total + TPS + TVQ ≠ total`, lever un drapeau. C'est le
  meilleur détecteur d'erreur de lecture disponible, et il est gratuit.

## Détection de doublons

L'erreur la plus fréquente en usage réel. Deux garde-fous complémentaires :

- empreinte (hash) de l'image téléversée — attrape la photo renvoyée deux fois ;
- trio `fournisseur + date + total` — attrape la même facture rephotographiée sous un autre
  angle, qui a donc une empreinte différente.

## Modèle de données — esquisse

Une table `depenses`, à affiner :

    id, fournisseur, fournisseur_tps, fournisseur_tvq,
    date, sous_total, tps, tvq, total, devise,
    categorie, mode_paiement, note,
    photo_filename, image_hash,
    statut,              -- 'a_valider' | 'valide' | 'rejete'
    extraction_brute,    -- JSON de ce que le modèle a lu, gardé tel quel
    ecart_taxes,         -- drapeau du contrôle de cohérence
    created_at, updated_at

Garder `extraction_brute` permet de diagnostiquer une extraction douteuse après coup, et de
rejouer les corrections si le prompt d'extraction change.

## L'extraction

Vision par l'API Claude : la photo est envoyée, le modèle retourne les champs structurés.

- Node 18+ a `fetch` intégré — **aucune nouvelle dépendance nécessaire**.
- Clé `ANTHROPIC_API_KEY` en variable d'environnement, jamais dans le dépôt.
- Coût négligeable à l'échelle visée (quelques dollars par mois pour des centaines de
  factures).
- Prévoir le cas où l'API est indisponible : la photo doit être **stockée quand même** et
  rester en attente d'analyse. Ne jamais perdre une facture parce qu'un appel réseau a échoué.

## Ce qu'on réutilise de Déclara — les patrons, pas le code

- **Caméra en un tap** : `<input type="file" accept="image/*" capture="environment">`
  (voir `public/employee.html:552` dans Déclara). Le navigateur n'ouvrira jamais la caméra
  seul au chargement — il faut un geste utilisateur. « Lien → gros bouton → caméra » est le
  minimum de friction atteignable sur le web.
- **Réception et stockage des photos** : liste blanche d'extensions, type MIME imposé à la
  relecture, fichiers sur un volume persistant à côté de la base
  (voir `server.js:175-218` dans Déclara). Ce code corrige déjà une faille réelle : sans la
  liste blanche, un `data:image/html;base64,…` était écrit en `.html` puis reservi comme tel.
- **Compression côté navigateur avant l'envoi**, pour ne pas pousser des photos de 8 Mo.
- **Accès par lien privé sans mot de passe** (patron `/e/<code>` de Déclara), utile si un
  comptable doit voir les dépenses sans avoir de compte.
- **Plafond de tentatives sur les échecs seulement** (`rate-limit.js`), qui rend un code court
  acceptable.
- **Sauvegarde téléchargeable** (base + CSV lisibles dans un zip).
- Conventions : commentaires en français expliquant le *pourquoi*, toute chaîne visible passée
  par `t()` avec ses deux dictionnaires FR/EN, pas de dépendance nouvelle sans raison forte.

## Où en est le code

Une première version complète et testée vit dans `nouveau-projet-factures/` **de ce dépôt**.

C'est un **dossier de transit, pas une décision d'architecture** : le dépôt `factures-app`
n'a pas pu être créé depuis la session (l'accès GitHub y est limité à `coco-tips-app`, la
création renvoie un 403). Le code est donc committé ici pour ne pas être perdu, et déménagera
tel quel dès que le dépôt existera. Aucun fichier de Déclara n'est touché.

Ce qui fonctionne :

- caméra en un tap, compression dans le navigateur, dépôt ;
- extraction par l'API Claude en sortie JSON contrainte, avec la clé `ANTHROPIC_API_KEY` ;
- sans clé, tout marche quand même : la photo est conservée et la saisie se fait à la main ;
- contrôle de cohérence des taxes, alertes de CTI, détection de doublons ;
- registre « à valider » / « validées », export CSV ;
- lien privé `/c/<code>` pour le téléphone, qui ne peut que déposer.

23 tests passent, dont un parcours complet piloté dans un vrai navigateur.

## Ce qui reste à décider

- **Catégories de dépenses** : lesquelles, et alignées sur quel plan comptable ? À valider avec
  le comptable — c'est lui qui reçoit l'export.
- **Format d'export** attendu par le comptable (CSV brut, gabarit précis, autre ?).
- Un **comptable** doit-il avoir un accès en lecture ?
