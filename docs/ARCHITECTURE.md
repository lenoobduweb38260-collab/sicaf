# Architecture de la GMAO SICAF

Application de GMAO (Gestion de Maintenance Assistée par Ordinateur) pour Windows 10/11,
**sans aucune dépendance externe** : serveur Node.js (modules intégrés uniquement), interface
HTML/CSS/JS « vanilla », données JSON. Tout le code et l'interface sont en **français**.

```
server/                 serveur HTTP + API JSON
  index.js              point d'entrée (CLI : --port --host --data --open)
  server.js             createApp() : routes cœur (auth, mot de passe oublié, amorçage, notifications), statiques, sessions, ctx
  db.js                 base documentaire JSON (collections, ids, sauvegardes, numérotation)
  router.js             mini routeur (HttpError, patterns /api/x/:id, opts { public, perm })
  auth.js               scrypt, sessions, anti-force-brute, quotas, codes de réinitialisation
  permissions.js        catalogue MODULES/ACTIONS, droits effectifs, portée, hiérarchie
  seed.js               configuration et données par défaut (profils, secteurs, admin)
  modules/              UN FICHIER PAR MODULE MÉTIER, chargé automatiquement (ordre alphabétique)
client/
  index.html, css/app.css, js/api.js, js/ui.js, js/app.js
  js/lib/<lib>.js       BIBLIOTHÈQUES PARTAGÉES (ex. codebarre.js, moteur3d.js), chargées automatiquement
                        AVANT les vues, dans l'ordre alphabétique (GET /api/views → { libs, vues })
  js/views/<module>.js  UNE VUE PAR MODULE, chargée automatiquement
tests/                  node:test (API) + tests/e2e (Playwright)
electron/               enveloppe Electron (fenêtre native, données dans %APPDATA%)
```

## 1. Module serveur (`server/modules/<module>.js`)

```js
'use strict';
const nom = 'Ordres de travail';
function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  router.get('/api/ot', async (req) => ctx.scope(req, db.list('ot')), { perm: ['ot', 'voir'] });
  router.post('/api/ot', async (req) => { /* ... */ }, { perm: ['ot', 'creer'] });
  // services exposés aux autres modules (appelés paresseusement, au moment des requêtes)
  ctx.services.ot = { creerDepuisDemande(demande, req) { /* ... */ } };
  // événements inter-modules
  ctx.on('demande:validee', (d) => { /* ... */ });
}
function seedDemo(ctx) { /* données de démonstration idempotentes ; retourne une chaîne descriptive */ }
module.exports = { nom, register, seedDemo };
```

### `ctx` (contexte partagé)
| Membre | Rôle |
|---|---|
| `ctx.db` | base : `list(col, pred?)`, `get(col, id)`, `findOne(col, pred)`, `count(col, pred?)`, `insert(col, doc)`, `update(col, id, patch)`, `remove(col, id)`, `nextNumber(cle, gabarit)`, `getConfig()`, `touch()` |
| `ctx.router` | `get/post/put/delete(pattern, handler, { perm: [module, action], public })` ; handler `async (req, res, ctx)` retourne la valeur JSON (ou écrit `res` lui-même, ex. CSV) |
| `ctx.HttpError` | `throw new HttpError(400, 'message en français')` |
| `ctx.requirePerm(req, module, action)` | lève 403 |
| `ctx.scope(req, rows)` | filtre une liste selon la **portée** de l'utilisateur (voir §4) |
| `ctx.canSee(req, record)` / `ctx.getVisible(req, col, id)` | contrôle de portée sur un enregistrement (404 sinon) |
| `ctx.audit(req, action, entite, entiteId, details, options?)` | journal d'audit (actions : creation, modification, suppression, validation, refus, cloture, affectation, statut, mouvement, generation…) ; `options.notifier === false` : sans notification des rôles responsables |
| `ctx.notify(userIds, { titre, message, lien, type })` | notifications internes (`lien` = hash de vue, ex. `#/ot/12`) |
| `ctx.usersAvecDroit(module, action, filtre?)` | utilisateurs actifs possédant un droit (ex. valideurs) |
| `ctx.liste(nom)` / `ctx.codeListe(nom, code, obligatoire)` | listes de valeurs configurées (voir §5) et validation d'un code |
| `ctx.champsPerso(entite, input)` | valide les champs personnalisés configurés → objet `{ cle: valeur }` à stocker dans `record.champs` |
| `ctx.config()` | configuration complète (copie) |
| `ctx.nomUser(id)` | nom affichable |
| `ctx.utilisateurVisible(lecteur, droits, compte, ecriture)` | règle de visibilité d'un compte utilisateur (soi-même, sans secteur, secteur partagé, site courant) — module utilisateurs et destinataires des demandes de réinitialisation |
| `ctx.motsDePasse` | cycle de vie des mots de passe (cœur, `server/server.js`) : `changementImpose(user)`, `raison(user)`, `infos(user)`, `refus(user, nouveau)` (async : politique + historique), `champsNouveau(user, nouveau, { doitChanger, raison })`, `poserCode(user, { creePar, origine })`, `annulerCode(userId)`, `etatCode(user)`, `traiterDemandes(userId, { mode, par })`, `gestionnaires(user)`, `purger()` |
| `ctx.on(evt, fn)` / `ctx.emit(evt, data)` | événements |
| `ctx.services` | **objet partagé** `{}` : chaque module peut y publier des fonctions ; les consommateurs y accèdent **au moment de la requête** (`ctx.services.stock && ctx.services.stock.sortir(...)`) |
| `req.user`, `req.perms`, `req.profil`, `req.body`, `req.query`, `req.params` | requête authentifiée |

Règles :
- Toujours valider le corps (`req.body`) : types, champs obligatoires, codes de listes (`ctx.codeListe`), références (`db.get`).
- Toujours appliquer la portée : listes via `ctx.scope`, détail via `ctx.getVisible`.
- Enregistrer `createdBy: req.user.id` à la création.
- Les `secteurId` sont des nombres ou `null`. Lorsqu'un enregistrement référence un équipement, reprendre son `secteurId`.
- Messages d'erreur et libellés en français.
- Les fichiers du cœur (`server/*.js`, `client/js/app.js`, `client/js/ui.js`, `client/js/api.js`, `client/css/app.css`, modules `utilisateurs/profils/secteurs/configuration/systeme/audit`) sont partagés par tous les modules : toute évolution doit y rester rétrocompatible et être couverte par les tests du cœur (`tests/core.test.js`, `tests/sites.test.js`, `tests/securite.test.js`, `tests/systeme.test.js`).
- Sécurité : aucun script en ligne (la politique de contenu l'interdit) ni attribut `onclick=…` dans du HTML généré, ni URL `javascript:` ; fenêtres d'impression via `ui.lancerImpression(w)` ; préférer `ui.el` (texte) à `innerHTML`, et échapper toute donnée avec `ui.esc` sinon. Voir aussi `docs/SECURITE.md`.

## 2. Vue client (`client/js/views/<module>.js`)

```js
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  GMAO.registerView('ot', {
    titre: 'Ordres de travail', icone: 'ot',
    async rendu(container, { params, query }) {   // #/ot → params = [] ; #/ot/12 → params = ['12']
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel('ot'), icone: 'ot', actions: [ GMAO.can('ot', 'creer') ? ui.bouton('Nouvel OT', { icone: 'plus', classe: 'btn-primaire', onClic: ... }) : null ] }));
      // ...
    },
  });
})();
```

### API globale `GMAO`
`GMAO.user`, `GMAO.perms`, `GMAO.config`, `GMAO.modules`, `GMAO.refs` (`users`, `secteurs`, `profils`), `GMAO.catalogue`, `GMAO.deuxFacteurs`, `GMAO.motDePasse` (voir §8), `GMAO.changementMdpRequis()`,
`GMAO.can(module, action)`, `GMAO.estAdmin()`, `GMAO.liste(nom)`, `GMAO.moduleLabel(key)`, `GMAO.navigate('#/ot/12')`, `GMAO.refreshRefs()`, `GMAO.setNavBadge(module, n)`, `GMAO.route`.

### API `api`
`api.get(url, query?)`, `api.post(url, body)`, `api.put(url, body)`, `api.del(url)`, `api.telecharger(url, nomFichier)`. Les erreurs sont des exceptions `{ status, message }` → `ui.erreur(e)` affiche un toast.

### Composants `ui` (voir `client/js/ui.js`)
- DOM : `ui.el(tag, attrs, ...enfants)`, `ui.frag`, `ui.vider`, `ui.icone(nom)` (noms : dashboard, equipements, demandes, ot, preventif, planning, stock, fournisseurs, rapports, plus, modifier, supprimer, voir, fermer, recherche, export, import, imprimer, check, alerte, info, horloge, fleche_droite, fleche_gauche, chevron_bas, chevron_droite, dossier, copier, utilisateur, secteur, sauvegarde, liste, filtre, rafraichir, piece, euro, piece_jointe, commentaire, lecture, pause, haut, bas, engrenage, cle, cloche).
- Formats : `ui.formatDate`, `ui.formatDateHeure`, `ui.formatNombre(n, dec)`, `ui.formatMontant`, `ui.formatDuree(heures)`, `ui.relatif`, `ui.dateISO`, `ui.aujourdhui()`, `ui.joursEntre(a, b)`.
- Références : `ui.nomUser(id)`, `ui.nomSecteur(id)`, `ui.cheminSecteur(id)`, `ui.libelle(liste, code)`, `ui.couleur(liste, code)`, `ui.badgeListe(liste, code)`, `ui.optionsListe(liste, { vide })`, `ui.optionsUsers({ filtre, vide })`, `ui.optionsSecteurs({ vide })`.
- Tableau : `ui.table({ colonnes: [{ cle, label, rendu(row), type: 'date'|'datetime'|'nombre'|'montant'|'user'|'secteur'|'booleen', liste: 'statutsOT', aligner, largeur, tri }], lignes, onClic(row), actions: [{ icone, titre, onClic(row), visible(row), classe }], recherche, exportCsv: 'fichier.csv', groupe: { cle(row), label(val, rows) }, triInitial: { cle, sens }, ligneClasse(row), pagination, compact })` → `{ el, maj(lignes), setGroupe(g), setTri(t) }`.
- Formulaires : `ui.form({ champs, valeurs, colonnes })` → `{ el, valeurs(), valider(), set(nom, v), get(nom), majOptions(nom, opts), erreur(nom, msg) }` ; `ui.formModal({ titre, champs, valeurs, taille: 'large'|'tres-large'|'petite', onSubmit(valeurs, modal, form), submitLabel, boutonsSupp })`.
  Types de champs : texte, texte_long, nombre, date, datetime, heure, select (`options` [{value,label}] ou `liste: 'priorites'`), multiselect, cases, radio, booleen, interrupteur, couleur, mdp, email, tel, fichier, image, lecture, separateur, html (`rendu(form)`), cache. Options : `requis, placeholder, aide, pleineLargeur, disabled, min, max, step, onChange(valeur, form), afficherSi(valeurs), valider(v, valeurs)`.
- Mots de passe : le type de champ `mdp` porte un bouton afficher / masquer ; `ui.reglesMdp(input, { politique: { longueurMin, complexite, interdireIdentifiant }, login, confirmation, historique })` → `{ el, maj(), conforme() }` affiche les règles cochées pendant la saisie et la robustesse ; `ui.copier(texte)` → Promise<bool> (repli par sélection sur une adresse http).
- Champs personnalisés : `...ui.champsPersoDefs('ot')` dans `champs` ; `ui.champsPersoInitiaux(record)` dans `valeurs` ; à l'envoi `body.champs = ui.champsPersoValeurs(v)` et supprimer les clés `champs.*` ; affichage `ui.champsPersoAffichage('ot', record)` (tableau `{label, valeur}` pour `ui.details`).
- Modales : `ui.modal({ titre, contenu, boutons: [{ label, classe, icone, onClic(modal) }], taille })`, `ui.confirm({ titre, message, okLabel, danger })` → Promise<bool>, `ui.prompt({ titre, label, type })`, `ui.toast(msg, 'succes'|'erreur'|'alerte'|'info')`, `ui.erreur(e)`.
- Mise en page : `ui.pageEntete({ titre, icone, sousTitre, actions, filAriane })`, `ui.bouton(label, { icone, classe, onClic, disabled })`, `ui.carte(titre, contenu, { actions })`, `ui.onglets([{ cle, label, icone, rendu(cont) | contenu, badge }], { hash: true })`, `ui.kpi({ label, valeur, couleur, icone, detail, onClic })`, `ui.details([{ label, valeur }], { colonnes: 2 })`, `ui.arbre(noeuds, { label, enfants, icone, onSelect, compteur, couleur, niveauReplie })`, `ui.badge(label, couleur)`, `ui.pastille(couleur)`, `ui.alerte(msg, type)`, `ui.vide(msg)`, `ui.chargement()`, `ui.graphiqueBarres([{ label, valeur, couleur }])`, `ui.imprimer(titre, html)`, `ui.exportCsv(nom, colonnes, lignes)`, `ui.telecharger(nom, contenu, type)`, `ui.avatar(nom)`.
- Classes CSS utiles : `carte`, `grille grille-2/3/4/auto`, `barre-outils` (+ `espace`), `badge`, `texte-2`, `texte-petit`, `texte-gras`, `texte-danger/ok/alerte`, `mt/mb`, `inline`, `calendrier` (+ `cal-entete`, `cal-jour`, `cal-num`, `cal-evt`, `hors-mois`, `aujourdhui`), `chronologie`, `commentaires`, `barre-progression`, `tableau-conteneur` + `table.tableau`, `matrice`, `details`, `masque`.

Conventions d'interface :
- Liste → fiche détaillée (`#/module/:id`) avec onglets, actions contextuelles selon `GMAO.can`.
- Boutons d'action masqués si le droit manque ; le serveur reste la référence (403).
- Filtres en haut (`barre-outils`), recherche, export CSV, impression quand pertinent.
- Toujours `ui.toast` après une action réussie, `ui.erreur(e)` en cas d'échec.
- Mettre à jour la liste après modification sans recharger la page.

## 3. Modèles de données (collections de `db`)

Champs communs : `id` (nombre), `createdAt`, `updatedAt`, `createdBy` (id utilisateur), `champs` (champs personnalisés `{cle: valeur}`).

### `equipements`
`numero` (auto, gabarit `numerotation.eq`), `nom`, `description`, `typeCode` (liste `typesEquipement`), `etatCode` (liste `etatsEquipement`), `criticiteCode` (liste `criticites`), `secteurId`, `parentId` (équipement parent → arborescence), `localisation`, `marque`, `modele`, `numeroSerie`, `fournisseurId`, `dateMiseEnService`, `dateAchat`, `valeurAchat`, `garantieFin`, `compteur` `{ valeur, unite }` (heures / cycles / km), `documents` `[{ nom, type, taille, contenu(dataURL), date, userId }]`, `notes`, `actif`.

### `demandes` (demandes d'intervention, DI)
`numero` (gabarit `numerotation.di`), `titre`, `description`, `equipementId`, `secteurId`, `prioriteCode` (liste `priorites`), `typeCode` (liste `typesIntervention`), `statut` (liste `statutsDemande` : soumise → validee/refusee → convertie → cloturee), `demandeurId`, `dateDemande`, `validateurId`, `dateValidation`, `motifRefus`, `otId`, `arretProduction` (bool), `commentaires` `[{ userId, date, texte }]`, `pieceJointes` (comme `documents`).

### `ot` (ordres de travail)
`numero` (gabarit `numerotation.ot`), `titre`, `description`, `typeCode` (liste `typesIntervention`), `prioriteCode`, `statut` (liste `statutsOT` : nouveau, planifie, en_cours, en_attente, termine, annule — ne jamais coder en dur ailleurs qu'en repli : utiliser `ctx.liste('statutsOT')`, `final: true` = clôturé), `equipementId`, `secteurId`, `demandeId`, `planPreventifId`, `technicienId` (responsable), `techniciens` `[ids]`, `datePrevue`, `dateDebut`, `dateFin`, `dureeEstimee` (heures), `tempsPasse` `[{ userId, date, heures, commentaire }]`, `pieces` `[{ articleId, designation, quantite, prixUnitaire, mouvementId }]`, `causeCode` (liste `causesPanne`), `rapport` (compte rendu), `commentaires`, `documents`, `coutPieces`, `coutMainOeuvre` (= Σ heures × `config.general.tauxHoraire`), `coutExterne`, `fournisseurId` (prestataire), `compteurReleve`, `taches` `[{ ordre, libelle, fait }]` (gamme copiée du plan préventif), `cloturePar`, `dateCloture`.

### `plansPreventifs`
`numero` (gabarit `numerotation.pp`), `nom`, `description`, `equipementId`, `secteurId`, `typeCode` (défaut `preventif`), `prioriteCode`, `periodicite` `{ type: 'jours'|'semaines'|'mois'|'compteur', valeur }` (compteur : tous les N `compteur.unite` de l'équipement), `derniereExecution` (date ou valeur compteur), `prochaineEcheance` (date ISO ou valeur compteur), `gamme` `[{ ordre, libelle, duree }]`, `dureeEstimee`, `technicienId`, `pieces` `[{ articleId, quantite }]`, `actif`, `genererJoursAvant` (défaut `config.preventif.horizonJours`).

### `articles` (stock)
`code` (gabarit `numerotation.art` si vide), `designation`, `description`, `categorieCode` (liste `categoriesArticles`), `uniteCode` (liste `unites`), `quantite`, `seuilMin`, `quantiteCommande`, `emplacement`, `prixUnitaire`, `fournisseurId`, `referenceFournisseur`, `equipementIds` `[ids compatibles]`, `secteurId` (magasin, optionnel), `actif`.

### `mouvementsStock`
`articleId`, `type` (`entree` | `sortie` | `inventaire` | `retour`), `quantite` (positif), `quantiteAvant`, `quantiteApres`, `date`, `userId`, `otId`, `motif`, `prixUnitaire`, `fournisseurId`.

### `fournisseurs`
`nom`, `typeCode` (liste `typesFournisseur`), `contact`, `telephone`, `email`, `adresse`, `siteWeb`, `siret`, `notes`, `delaiLivraisonJours`, `actif`.

### Collections existantes
`users`, `profils`, `secteurs`, `audit`, `notifications`, `documents` (libre), `demandesMdp` (voir §8).

### `users` : champs liés au mot de passe (jamais envoyés au poste)
`passwordHash` (scrypt), `historiqueMdp` (empreintes des `config.securite.historiqueMdp` mots de passe précédents),
`reinitialisation` `{ empreinte (scrypt du code), expireLe, creeLe, creePar (id, ou null pour la récupération d'urgence), origine ('pole_informatique' | 'recuperation_urgence'), essais }` (un seul code actif par compte).
Champs transmis : `dateMdp` (dernier changement), `dateReferenceMdp` (date de référence de l'expiration pour un compte sans `dateMdp`), `doitChangerMdp`, `raisonChangementMdp` (`initial` | `reinitialise` | `expire` | `administrateur`).
`auth.cleanUser` retire les secrets ; en dernier recours, toute réponse JSON contenant un `passwordHash`, un `historiqueMdp` (tableau) ou un objet `reinitialisation` en est expurgée (`sendJson`, `server/server.js`).

## 4. Droits, portée, hiérarchie, multi-site

- Modules et actions : `server/permissions.js` (`MODULES`, `ACTIONS`). Actions existantes par module (ne pas en inventer) :
  dashboard[voir] · equipements[voir,creer,modifier,supprimer,exporter] · demandes[voir,creer,modifier,supprimer,valider,exporter] · ot[voir,creer,modifier,supprimer,affecter,cloturer,exporter] · preventif[voir,creer,modifier,supprimer,exporter] · planning[voir,modifier] · stock[voir,creer,modifier,supprimer,exporter] · fournisseurs[voir,creer,modifier,supprimer,exporter] · rapports[voir,exporter].
- Modules ajoutés : plans[voir,creer,modifier,supprimer] · inventaire[voir,creer,modifier,valider,supprimer,exporter] · achats[voir,creer,modifier,supprimer,valider,exporter] · rh[voir,creer,modifier,supprimer,valider,exporter].
- Portée (`req.perms.portee`) : `tous` | `site` (tous les secteurs des sites de rattachement de l'utilisateur) | `secteurs` (`req.perms.secteurIds`, sous-secteurs inclus ; un enregistrement sans `secteurId` est visible) | `perso` (visible si `createdBy`, `demandeurId`, `technicienId`, `responsableId`, `assigneA` ou `techniciens[]` contient l'utilisateur).
- **Multi-site** : un *site* est un secteur de `type: 'site'` (liste `typesSecteur` : site, batiment, service, atelier, ligne, zone, magasin). L'arborescence par défaut est `Site principal (SITE) › Production (PROD), Maintenance (MAINT), Logistique (LOG), Qualité (QUAL), Services généraux (SG)`. `ctx.siteDuSecteur(secteurId)` donne le site d'un secteur. Un utilisateur peut recevoir des accès à d'autres sites (`user.siteAcces = [{ siteId, mode: 'lecture' | 'complet' }]`).
  - `req.perms.secteurIds` = secteurs **modifiables** ; `req.perms.secteurIdsLecture` = secteurs des sites en **lecture seule** ; `req.perms.sites` = sites accessibles `[{ id, nom, mode, attache }]`.
  - Sélecteur de site dans l'en-tête → en-tête HTTP `X-GMAO-Site` → `req.perms.siteCourantId` et `req.perms.siteFiltre` (secteurs du site choisi). **Tout est automatique si vous utilisez `ctx.scope`, `ctx.canSee` et `ctx.getVisible`** : le filtre de site et la lecture seule s'appliquent (pendant une requête POST/PUT/DELETE, `req.ecriture` est vrai et les sites en lecture seule sont exclus ; `ctx.getVisible` lève alors 403 « lecture seule »). N'appelez `perms.canSeeRecord` directement qu'avec `{ ecriture: req.ecriture }`.
  - Côté client : `GMAO.siteCourant()` (id ou null), `GMAO.siteLectureSeule(secteurId)` (masquer les boutons d'action), `ui.optionsSecteurs()` / `ui.optionsUsers()` sont déjà restreints au site courant (option `{ tousSites: true }` pour tout lister), `GMAO.refs.secteurs[i].siteId`.
- Hiérarchie : `req.perms.niveau` (1 = plus haut), `req.user.managerId` (N+1). Option `config.workflow.validerParSuperieurUniquement` : seul le N+1 du demandeur (ou un administrateur) valide.
- Options workflow (`config.workflow`) : `validationDemandes`, `validerParSuperieurUniquement`, `otAutoDepuisDemande`, `cloturerDemandeAvecOt`, `notifierValidateurs`, `autoriserTechnicienCloture`, `stockNegatif`. Préventif : `config.preventif.genererAuto`, `horizonJours`.

## 5. Listes de valeurs configurables (`config.listes`)
`statutsOT`, `statutsDemande` (avec `final`), `typesIntervention`, `priorites` (avec `delaiHeures`), `typesEquipement`, `etatsEquipement`, `criticites`, `unites`, `categoriesArticles`, `typesFournisseur`, `causesPanne`, `typesSecteur`, `typesHabilitation` (avec `dureeMois`), `typesAbsence`, `typesContrat`, `statutsCommande` (avec `final`), `statutsFacture` (avec `final`), `categoriesDepense`.

Sections de configuration des modules (valeurs par défaut dans `server/seed.js`, modifiables via `PUT /api/configuration { section: {...} }` — seules les clés existantes sont acceptées, avec le même type) : `etiquettes` (format, symbologie, hauteurCodeMm, decalage, contenu{…}, formatPersonnalise{…}), `inventaire` (aveugle, modeScan, sons, nonComptesAZero, scanGlobal), `achats` (tauxTVA, seuilValidationHT, delaiPaiementJours, entreeStockAReception, alerteEcheanceJours), `rh` (alerteJoursAvantEcheance, afficherAbsencesPlanning, heuresHebdo), `plans` (grilleM, uniteAffichage, couleurParDefaut, afficherEtiquettes), `sauvegardes` (automatique, frequenceHeures, heure, conserverLocal, compresser, chiffrer — `destinations`, `cleReception`, `motDePasseChiffrement` sont des **secrets** : jamais renvoyés au client ni modifiables par PUT /api/configuration ; le module sauvegardes les gère par ses propres routes et `db.getConfig()/db.setConfig()`). Numérotation : `numerotation.{ot,di,eq,art,pp,inv,cmd,fac,pl,mat}`. Champs personnalisés : entités `personnel`, `commandes`, `factures` en plus des précédentes. Chaque élément : `{ code, label, couleur?, ordre, final?, delaiHeures? }`. Toujours lire via `ctx.liste(...)` / `GMAO.liste(...)` et afficher via `ui.badgeListe`.

## 6. Services et événements inter-modules (contrat)

| Fournisseur | Membre | Description |
|---|---|---|
| ot | `ctx.services.ot.creerDepuisDemande(demande, req)` | crée un OT (statut initial, type/priorité/équipement/secteur/description repris, `demandeId`), retourne l'OT |
| ot | `ctx.services.ot.ouvertsPour({ equipementId?, planPreventifId? })` | OT non clôturés |
| stock | `ctx.services.stock.sortir({ articleId, quantite, otId, userId, motif })` | décrémente, crée un mouvement, retourne `{ mouvement, article }` ; respecte `config.workflow.stockNegatif` |
| stock | `ctx.services.stock.entrer({ articleId, quantite, userId, motif, prixUnitaire, fournisseurId })` | incrémente |
| stock | `ctx.services.stock.annulerSortie(mouvementId, userId)` | retour en stock (mouvement `retour`) |
| preventif | `ctx.services.preventif.generer(options?)` | génère les OT à échéance (idempotent : pas de doublon si un OT ouvert existe pour le plan), retourne la liste des OT créés |
| equipements | `ctx.services.equipements.releverCompteur(equipementId, valeur, req)` | met à jour `compteur.valeur` |
| cœur | `ctx.services.motsDePasse.comptesRecuperables()` | application de bureau (mode serveur) : comptes actifs administrateurs ou avec Système › Modifier, `[{ login, nom }]` |
| cœur | `ctx.services.motsDePasse.recuperationUrgence({ login, origine })` | synchrone : code de réinitialisation (origine `recuperation_urgence`, `creePar` null), journal `recuperation_urgence` (auteur `origine`, ex. « Poste serveur »), notification à tous les comptes Système › Modifier ; renvoie `{ login, nom, code, expireLe }` ; lève une erreur pour un compte non récupérable |

Événements (`ctx.emit`) : `demande:soumise`, `demande:validee`, `demande:refusee`, `ot:cree`, `ot:statut` (`{ ot, ancien, nouveau }`), `ot:termine` (OT passé à un statut final `termine`), `ot:annule`, `stock:sousSeuil` (`article`), `preventif:genere` (`{ plan, ot }`).
Réactions attendues : demandes écoute `ot:termine` (clôture la DI si `cloturerDemandeAvecOt`) ; preventif écoute `ot:termine` (met à jour `derniereExecution` / `prochaineEcheance` du plan) ; stock émet `stock:sousSeuil` et notifie les utilisateurs ayant `stock.modifier`.

## 7. Tests

- API : `tests/<module>.test.js` avec `node:test` et `tests/helpers.js` (`demarrer()` → `{ client(), db, ctx, stop }`, serveur en mémoire sur port aléatoire ; `client().login('admin','admin')`, `.ok(method, url, body)`). Dans les tests, la politique de mot de passe est assouplie et le mot de passe initial (admin / admin) utilisable sans changement préalable (`forcerChangementMdpInitial: false`) ; `demarrer({ politiqueReelle: true })` conserve la politique réelle : le serveur refuse alors toute route hors `/api/auth/*` (403 `changementMdpRequis`) tant que le mot de passe initial n'est pas changé. Un test qui démarre son serveur sans `tests/helpers.js` doit faire de même (ou changer le mot de passe initial). Tester : CRUD, validation, droits (403), portée par secteur et par site, workflow.
- Lancer : `npm test` (tous) ou `node --test tests/ot.test.js`.
- Démo : chaque module fournit `seedDemo(ctx)` idempotent (vérifier l'existence avant d'insérer) produisant des données réalistes en français (équipements industriels, pannes, pièces…), utilisées par le bouton « Charger les données de démonstration ».
- Interface : `node tests/e2e/run.js` (Playwright) parcourt toutes les vues ; pour un nouveau parcours, se connecter avec admin / admin puis changer le mot de passe dans la fenêtre imposée (`#f_nouveau`, `#f_confirmation`, mot de passe conforme à la politique), et surveiller `page.on('pageerror')` et les violations de la politique de contenu en console.

## 8. Mots de passe : changer, oublier, recréer

Configuration (`config.securite`) : `motDePasseOublie` (défaut vrai), `dureeCodeReinitialisationMinutes` (5–1440, défaut 60),
`reinitialisationAutonome` (défaut faux), `expirationMdpJours` (0 = jamais, sinon 30–730), `rappelExpirationJours` (1–60, défaut 14),
`historiqueMdp` (0–24, défaut 5 : mots de passe précédents refusés, en plus de l'actuel), `forcerChangementMdpInitial`.

**Amorçage** (`GET /api/auth/me`, réponse de `POST /api/auth/login` ou `/api/auth/login/code`) : clé de premier niveau
`motDePasse` = `{ doitChanger, raison, dateMdp, expireLe, joursRestants, rappel }` → `GMAO.motDePasse` côté client.
`doitChanger` : changement **imposé par le serveur** (raison `reinitialise`, `expire`, `administrateur`, ou `initial` si
`forcerChangementMdpInitial !== false`) ; `raison` : raison du changement attendu (ou null) ; `expireLe` / `joursRestants` : null sans
expiration ; `rappel` : vrai si `joursRestants ≤ rappelExpirationJours` (et pas de changement imposé). L'expiration est évaluée à la
connexion et à chaque amorçage ; un compte sans `dateMdp` reçoit une `dateReferenceMdp` à la première évaluation (rien n'expire d'un coup).

**Changement imposé** : tant que `doitChanger` est vrai, toute route authentifiée hors `/api/auth/*` (notifications comprises : aucune
donnée de l'application avant le changement) renvoie `403 { erreur, changementMdpRequis: true, details: { changementMdpRequis: true, raison } }`.
Côté client, `api.js` n'interroge plus le serveur (hors authentification) tant que `GMAO.changementMdpRequis()` est vrai et appelle
`GMAO.onChangementMdpRequis()` sur un tel 403 ; `app.js` n'affiche aucune vue et impose une seule fenêtre de changement.

**Routes publiques** (aucune n'ouvre de session : le poste enchaîne une connexion normale, double authentification comprise) :
- `POST /api/auth/mot-de-passe-oublie { login, message? }` → toujours `200 { ok: true }` (traitement après la réponse ; compte inconnu
  ou désactivé : journal seulement) ; `403` si `motDePasseOublie` est faux ; `429` au-delà de 5 demandes par poste en 15 minutes.
  Une demande en attente est mise à jour (`repetitions` = nombre de demandes reçues), notifications au plus toutes les 30 minutes aux
  comptes ayant Utilisateurs › Modifier qui peuvent gérer et voir le compte, et au titulaire.
- `POST /api/auth/reinitialiser { login, code, nouveau }` → `200 { ok: true }` ; sinon `400` générique ; message de la politique
  seulement après un code valide (code non consommé) ; `429` après 8 échecs (clés `reinit|ip|login` et `reinit-compte|login`).
- `POST /api/auth/reinitialiser-autonome { login, code, nouveau }` (si `reinitialisationAutonome`) : code à 6 chiffres de
  l'application d'authentification (jamais un code de secours), anti-rejeu, même blocage que les codes de vérification du compte.
- `GET /api/auth/infos` : `motDePasseOublie`, `reinitialisationAutonome`, `politiqueMdp { longueurMin, complexite, interdireIdentifiant }`.

**Codes de réinitialisation** : 8 caractères de `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, affichés `XXXX-XXXX`, saisie tolérante ;
empreinte scrypt seule conservée ; usage unique ; expiration ; 5 essais incorrects puis annulation (pôle informatique prévenu) ;
annulés par un changement de mot de passe, une nouvelle réinitialisation ou la désactivation du compte.

**Routes de gestion** (droit Utilisateurs › Modifier, règle hiérarchique `canManageUser` et portée, sites compris) :
- `POST /api/utilisateurs/:id/reinitialiser-mdp { mode: 'code' | 'temporaire', password?, demandeId? }` → `{ ok, mode: 'code', code, expireLe, login }`
  (renvoyé une seule fois ; mot de passe et sessions inchangés) ou `{ ok, mode: 'temporaire', motDePasse }` (changement imposé, sessions
  fermées) ; refusé pour soi-même et pour un compte désactivé ; demandes en attente du compte traitées, titulaire prévenu.
- `DELETE /api/utilisateurs/:id/code-reinitialisation` : annule le code actif.
- `GET /api/utilisateurs/:id` : `motDePasse { dateMdp, expireLe, doitChanger (indicateur du compte), raison, codeActif, codeExpireLe, codeOrigine }` pour les gestionnaires.
- `GET /api/utilisateurs-demandes-mdp` : demandes en attente `{ id, userId, login, nom, profilNom, message, ip, poste, repetitions,
  createdAt, derniereDemande, statut }` ; `?toutes=1` ajoute les 50 dernières traitées ou rejetées (`mode`, `traiteePar`, `traiteeParNom`, `traiteeLe`, `motifRejet`).
- `POST /api/utilisateurs-demandes-mdp/:id/rejeter { motif? }`.

Collection `demandesMdp` : `{ id, userId, login, message (≤ 300 caractères, texte brut), ip, poste (≤ 200), statut ('en_attente' | 'traitee' |
'rejetee'), repetitions, derniereDemande, createdAt, traiteePar, traiteeLe, mode ('code' | 'temporaire' | 'utilisateur' | 'rejet'), motifRejet,
derniereNotification }` ; demandes traitées ou rejetées purgées après 90 jours. Journal : `demande_reinitialisation_mdp`,
`rejet_demande_reinitialisation_mdp`, `code_reinitialisation_mdp`, `annulation_code_reinitialisation`, `echec_reinitialisation_mdp`,
`reinitialisation_mdp_code`, `reinitialisation_mdp_autonome`, `recuperation_urgence`, `expiration_mdp` (libellés : `ctx.libellesActions`,
renvoyés par `GET /api/audit` dans `libellesActions`).
