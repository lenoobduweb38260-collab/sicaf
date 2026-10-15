# GMAO SICAF

Application de **Gestion de Maintenance Assistée par Ordinateur** pour Windows 10/11, complète,
entièrement personnalisable, avec **comptes internes**, **profils hiérarchiques** (chaque profil voit
plus ou moins de choses, ajustable utilisateur par utilisateur) et **secteurs**.

- Application Windows autonome : un seul installateur `.exe`, aucun prérequis (Node.js intégré), aucune fenêtre de commandes, mises à jour automatiques.
- Vos données restent sur votre poste (fichier JSON, sauvegardes automatiques).
- Utilisable seul sur un PC, ou partagé sur le réseau local de l'entreprise.

## Modules

| Module | Contenu |
|---|---|
| **Tableau de bord** | Indicateurs (OT ouverts / en retard, demandes à valider, préventifs à échéance, alertes stock, coûts du mois), graphiques, « Mes OT », activités récentes |
| **Équipements** | Arborescence secteurs → équipements → sous-équipements, fiches (état, criticité, compteur, documents, pièces compatibles), historique des interventions |
| **Demandes d'intervention** | Signalement de panne par n'importe quel utilisateur, circuit de validation (par le supérieur hiérarchique si souhaité), conversion automatique en ordre de travail, notifications |
| **Ordres de travail** | Correctif / préventif / amélioration…, affectation aux techniciens, kanban par statut, temps passé, pièces consommées (stock), compte rendu, coûts, bon de travail imprimable |
| **Maintenance préventive** | Plans et gammes périodiques (jours, semaines, mois ou compteur), génération automatique des OT à échéance, échéancier |
| **Planning** | Calendrier mois / semaine / par technicien, glisser-déposer, charge de travail, OT non planifiés |
| **Stock & pièces** | Articles, mouvements (entrées / sorties / inventaires), seuils et alertes, valorisation, liste à commander |
| **Fournisseurs** | Fournisseurs et prestataires, contacts, articles et équipements fournis, interventions externes |
| **Rapports & historique** | MTTR, MTBF, respect des délais, taux de préventif, coûts par secteur / équipement / mois, charge des techniciens, historique complet, fiche de vie d'un équipement, exports CSV |
| **Utilisateurs** | Comptes internes, hiérarchie (supérieur N+1, organigramme), rattachement aux secteurs, droits individuels |
| **Profils & droits** | Matrice module × action, niveau hiérarchique, portée des données, tri / regroupement par secteur |
| **Configuration** | Société et logo, modules (activer / renommer / ordonner), listes de valeurs, champs personnalisés, numérotation, sites et secteurs |
| **Système & informatique** | (Pôle informatique) base de données, sauvegardes multi-sites, import / export, réseau, postes connectés, mises à jour |
| **Journal d'audit** | Qui a fait quoi, quand (filtres, export) |

## Installation sous Windows 10/11

> **Télécharger** : [dernière version de GMAO SICAF](https://github.com/lenoobduweb38260-collab/sicaf/releases/latest)
> (`GMAO-SICAF-Setup-<version>.exe`). Chaque version publiée est aussi installée automatiquement sur les
> postes déjà équipés.

GMAO SICAF est une **application Windows à part entière** : elle s'ouvre dans sa propre fenêtre,
sans navigateur ni barre d'adresse. **Aucun prérequis** (le moteur Node.js est intégré à l'exécutable)
et **aucune fenêtre de commandes**.

1. Téléchargez **`GMAO-SICAF-Setup-<version>.exe`** depuis la page
   [Releases](https://github.com/lenoobduweb38260-collab/sicaf/releases/latest) du dépôt (ou l'artefact de
   l'onglet *Actions*). Une version **portable** (`GMAO-SICAF-Portable-<version>.exe`, sans installation)
   est aussi fournie.
2. Lancez l'installateur : raccourcis « GMAO SICAF » sur le bureau et dans le menu Démarrer. Pas besoin
   d'être administrateur du poste.
3. Au premier lancement, l'assistant demande comment ce poste utilise la GMAO :
   - **Ce poste héberge la GMAO** : la base de données est sur ce PC (dossier
     `%APPDATA%\GMAO SICAF\data` ou un dossier choisi). Cochez *Partager la GMAO avec les autres postes*
     sur le PC « serveur » de l'usine ; l'assistant affiche l'adresse à utiliser sur les autres postes
     (autorisez l'application dans le pare-feu Windows quand il le demande).
   - **Se connecter à la GMAO d'un autre poste** : saisissez l'adresse du poste serveur
     (ex. `http://srv-gmao:8585`). Chaque poste client installe la même application.
   - Le **code du pôle informatique** est défini à ce moment : il protège ensuite ces paramètres
     (mode, réseau, port, dossier des données, mises à jour). Les utilisateurs ne peuvent pas les modifier.
4. L'application se place dans la **zone de notification** (à côté de l'horloge) : sur le poste serveur
   partagé, fermer la fenêtre ne coupe pas la GMAO des autres postes. Option *Démarrer avec Windows*.

### Mises à jour automatiques

L'application vérifie au démarrage puis toutes les 6 heures si une nouvelle version est publiée, la
télécharge, vérifie son empreinte (SHA-256), l'installe en silence et redémarre. Les données ne sont jamais
touchées par une mise à jour. À chaque évolution du code sur la branche principale, GitHub Actions
(`.github/workflows/build-windows.yml`) construit et publie automatiquement la nouvelle version
(`v1.0.<n>`). Pour un réseau sans accès Internet, le pôle informatique peut choisir comme source un dossier
réseau (ex. `\\NAS\gmao\mises-a-jour`, contenant `latest.json` et l'installateur).

### Pôle informatique

Le profil **Pôle informatique** (et l'administrateur) est le seul à pouvoir :
- créer, modifier et supprimer les comptes et les profils ;
- accéder à l'écran **Système & informatique** : base de données, sauvegardes (locales, multi-destinations,
  autres sites), export / import / restauration, réseau, postes connectés (déconnexion à distance),
  autorisation éventuelle de l'accès par navigateur web (désactivé par défaut), informations système ;
- modifier les paramètres de connexion des postes (code du pôle informatique) ;
- en dernier recours, si plus aucun administrateur ne peut se connecter : sur le poste serveur, icône de la zone
  de notification › **Récupérer un compte administrateur…** (code du pôle informatique) génère un code de
  réinitialisation à saisir sur l'écran de connexion (« J'ai un code de réinitialisation »).

### Première connexion

Compte initial : **admin / admin**. Le changement de mot de passe est demandé immédiatement.
Dans *Système & informatique › Base de données & sauvegardes*, le bouton **Charger les données de démonstration** ajoute des
utilisateurs (mot de passe `demo` : `mdupont` responsable, `pmartin` chef de secteur, `jbernard` et `kleroy`
techniciens, `spetit` demandeuse), équipements, interventions, articles et fournisseurs pour découvrir
l'application.

## Comptes, profils, hiérarchie et secteurs

- **Profils** : chaque profil possède une matrice de droits (module × action : voir, créer, modifier,
  supprimer, valider, affecter, clôturer, exporter), un **niveau hiérarchique** (1 = le plus élevé), une
  **portée des données** (toutes les données / ses secteurs et sous-secteurs / ses propres éléments) et,
  optionnellement, un **secteur de rattachement**. Cinq profils sont fournis (Administrateur, Responsable
  maintenance, Chef de secteur, Technicien, Demandeur) ; vous pouvez les modifier, les dupliquer ou en créer.
- **Utilisateurs** : chaque compte a un profil, des secteurs, un supérieur hiérarchique (N+1) et des
  **droits individuels** : dans la fiche utilisateur, chaque droit hérité du profil peut être **accordé en
  plus (vert)** ou **retiré (rouge)**, afin qu'une personne voie plus ou moins que son profil.
- **Règles de hiérarchie** : un gestionnaire ne peut créer ou modifier que des profils et des utilisateurs
  de niveau strictement inférieur au sien ; il ne peut accorder que des droits qu'il possède ; le dernier
  administrateur ne peut pas être supprimé ; la validation des demandes peut être réservée au supérieur
  hiérarchique du demandeur (*Configuration › Général › Circuit de travail*).
- **Secteurs** : arborescence libre (sites, ateliers, lignes…). Ils servent à classer les équipements, à
  restreindre la portée des données et à **trier / regrouper les profils et les utilisateurs par secteur**
  (*Configuration › Profils & secteurs*, et directement dans les listes).
- **Modules** : chaque module peut être désactivé, renommé ou réordonné pour tout le monde
  (*Configuration › Modules*).

## Tout est modifiable

*Configuration* permet d'adapter l'application sans toucher au code : nom et logo de la société, couleur
principale, thème clair / sombre, format des dates, devise, taux horaire, règles du circuit de validation,
génération automatique du préventif, **listes de valeurs** (statuts, types d'intervention, priorités et
délais, types et états d'équipement, criticités, unités, catégories d'articles, causes de panne…),
**champs personnalisés** sur les équipements, OT, demandes, articles, fournisseurs et utilisateurs,
gabarits de **numérotation** (`OT-{annee}-{num:4}`), sauvegardes, export / import complet.

Pour aller plus loin (ajouter un module, modifier l'interface), le code est volontairement simple et sans
framework : voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Sécurité

Mots de passe robustes et hachés, blocage des comptes après des échecs répétés, sessions limitées dans le
temps, droits contrôlés par le serveur, accès multi-site en lecture seule ou complet, journal d'activité,
en-têtes de sécurité stricts, aucune dépendance tierce, accès par navigateur désactivé par défaut, sauvegardes
chiffrables sur plusieurs sites. Détails et recommandations de déploiement : [`docs/SECURITE.md`](docs/SECURITE.md).

## Données et sauvegardes

- Base : un fichier JSON (`data/gmao.json`), écrit de manière atomique.
- Une sauvegarde quotidienne est créée automatiquement au démarrage dans `data/backups/` (30 conservées), plus
  des sauvegardes manuelles et une avant chaque import / restauration.
- Export / import complet au format JSON depuis *Système & informatique › Base de données & sauvegardes*.
- Pour déplacer la GMAO sur un autre PC : copiez le dossier `data`.

## Pour les développeurs

```bash
npm start            # (développement) serveur Node.js + navigateur sur http://127.0.0.1:8585
                     # lanceurs Windows de développement : scripts/dev/*.bat (nécessitent Node.js)
npm test             # tests API (node:test, serveur en mémoire)
node tests/e2e/run.js   # parcours d'interface avec Playwright (Chromium)
npm install && npm run dist   # construit l'installateur Windows avec Electron (nécessite Internet)
```

Structure : `server/` (API, base JSON, droits, modules métier dans `server/modules/`), `client/` (interface,
vues dans `client/js/views/`), `electron/` (enveloppe Windows), `tests/`, `docs/`.
Chaque module = un fichier serveur + un fichier de vue, chargés automatiquement.

Licence : MIT.
