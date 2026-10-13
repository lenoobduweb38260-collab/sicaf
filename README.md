# GMAO SICAF

Application de **Gestion de Maintenance Assistée par Ordinateur** pour Windows 10/11, complète,
entièrement personnalisable, avec **comptes internes**, **profils hiérarchiques** (chaque profil voit
plus ou moins de choses, ajustable utilisateur par utilisateur) et **secteurs**.

- Aucune dépendance à installer en dehors de Node.js (ou rien du tout avec l'exécutable).
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
| **Configuration** | Société et logo, modules (activer / renommer / ordonner), listes de valeurs, champs personnalisés, numérotation, secteurs, sauvegardes, import / export, données de démonstration |
| **Journal d'audit** | Qui a fait quoi, quand (filtres, export) |

## Installation sous Windows 10/11

### Option 1 — exécutable (recommandé)

1. Allez dans l'onglet **Actions** du dépôt GitHub (ou **Releases** si une version a été publiée) et
   téléchargez l'artefact `GMAO-SICAF-windows` : il contient l'installateur `GMAO-SICAF-<version>-x64.exe`
   et une version portable.
2. Lancez l'installateur (ou l'exécutable portable). Un raccourci « GMAO SICAF » est créé sur le bureau.
3. Les données sont stockées dans `%APPDATA%\GMAO SICAF\data` (menu *Fichier › Ouvrir le dossier des données*).

> L'exécutable est construit automatiquement par GitHub Actions (`.github/workflows/build-windows.yml`) à
> chaque mise à jour de la branche principale et à chaque tag `vX.Y.Z`.

### Option 2 — avec Node.js (aucune installation de dépendances)

1. Installez [Node.js LTS](https://nodejs.org) (une seule fois).
2. Téléchargez ou clonez ce dépôt dans un dossier, par exemple `C:\GMAO`.
3. Double-cliquez sur **`Lancer-GMAO.bat`** : le serveur démarre et l'application s'ouvre dans une fenêtre
   Microsoft Edge dédiée (mode application, sans barre d'adresse). Laissez la fenêtre noire ouverte pendant
   l'utilisation.
4. Les données sont dans le dossier `data\` à côté de l'application (`data\gmao.json` + `data\backups\`).

Pour partager la GMAO avec d'autres postes du réseau local, utilisez **`Lancer-GMAO-reseau.bat`** sur le
poste « serveur » : les autres postes ouvrent `http://<ip-du-poste>:8585/` dans Edge ou Chrome (autorisez le
port 8585 dans le pare-feu Windows si besoin). Chaque personne se connecte avec son propre compte.

Options en ligne de commande : `node server\index.js --port 8585 --host 0.0.0.0 --data D:\GMAO\data --open`.

### Première connexion

Compte initial : **admin / admin**. Le changement de mot de passe est demandé immédiatement.
Dans *Configuration › Sauvegardes & données*, le bouton **Charger les données de démonstration** ajoute des
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

## Données et sauvegardes

- Base : un fichier JSON (`data/gmao.json`), écrit de manière atomique.
- Une sauvegarde quotidienne est créée automatiquement au démarrage dans `data/backups/` (30 conservées), plus
  des sauvegardes manuelles et une avant chaque import / restauration.
- Export / import complet au format JSON depuis *Configuration › Sauvegardes & données*.
- Pour déplacer la GMAO sur un autre PC : copiez le dossier `data`.

## Pour les développeurs

```bash
npm start            # démarre le serveur et ouvre le navigateur (http://127.0.0.1:8585)
npm test             # tests API (node:test, serveur en mémoire)
node tests/e2e/run.js   # parcours d'interface avec Playwright (Chromium)
npm install && npm run dist   # construit l'installateur Windows avec Electron (nécessite Internet)
```

Structure : `server/` (API, base JSON, droits, modules métier dans `server/modules/`), `client/` (interface,
vues dans `client/js/views/`), `electron/` (enveloppe Windows), `tests/`, `docs/`.
Chaque module = un fichier serveur + un fichier de vue, chargés automatiquement.

Licence : MIT.
