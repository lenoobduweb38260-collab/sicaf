# Mises à jour de l'application de bureau : signature et publication

Procédure destinée au pôle informatique. Elle couvre la signature des mises à jour (clé Ed25519), la
signature de code Windows (Authenticode) et la publication interne par dossier réseau, sans accès Internet.

> **Prérequis de livraison.** La version livrée n'intègre aucune clé publique (`gmao.clePubliqueMaj` absent de
> `package.json`) : tant que les sections 2 à 4 n'ont pas été appliquées, aucun poste n'exige de signature et seuls
> les contrôles de la colonne « sans clé publique » ci-dessous s'appliquent. Le pôle informatique les applique avant
> le premier déploiement, **dans l'ordre** : paire de clés, secret `MAJ_CLE_PRIVEE`, puis clé publique. Une clé
> publique intégrée sans le secret correspondant bloquerait toutes les mises à jour suivantes (section 8).

## 1. Principe

À chaque version publiée, GitHub Actions (`.github/workflows/build-windows.yml`) construit l'installateur
`GMAO-SICAF-Setup-<version>.exe` et son manifeste `latest.json`. Les postes consultent ce manifeste, puis
téléchargent et installent la nouvelle version.

Sans signature, une personne qui prendrait le contrôle de la publication (compte GitHub, jeton d'accès,
dossier réseau) pourrait remplacer l'installateur **et** son empreinte. Le manifeste est donc signé avec
une clé privée Ed25519 détenue par l'entreprise. La clé publique correspondante est intégrée à
l'application : un poste n'installe que ce que cette clé a signé.

Contrôles effectués par chaque poste avant l'installation :

| Contrôle | Sans clé publique configurée | Avec clé publique configurée |
|---|---|---|
| Signature Ed25519 du manifeste (version, fichier, empreinte, taille, date, notes) | non | **obligatoire** : manifeste non signé ou mal signé → refus |
| Version publiée strictement supérieure à la version installée | oui | oui, même pour un manifeste signé |
| Source GitHub : HTTPS, hôtes `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, y compris pour chaque redirection (contrôlée avant d'être suivie) | oui | oui |
| Taille de l'installateur | oui | oui (obligatoire dans le manifeste) |
| Empreinte SHA-256 de l'installateur | oui si le manifeste `latest.json` la publie ; publication GitHub sans manifeste : taille seule | oui (obligatoire dans le manifeste) |

Les contrôles s'appliquent quelle que soit la source : publications GitHub, dossier réseau ou adresse web
interne. Les notes de version affichées aux utilisateurs font partie du contenu signé.

> Pour revenir au code d'une version antérieure (régression), publiez une **nouvelle** version, de numéro
> supérieur, contenant ce code : les postes n'acceptent jamais une version inférieure ou égale.

## 2. Générer la paire de clés

Sur un poste d'administration de confiance disposant de Node.js 18 ou supérieur et d'une copie du dépôt :

```powershell
node scripts\generer-cle-maj.js E:\Coffre\gmao-signature-maj.pem
```

- Le fichier de clé privée doit se trouver **hors du dossier du dépôt**. Le script refuse un chemin du
  dépôt non ignoré par `.gitignore`, un chemin embarqué dans l'application (`electron`, `server`,
  `client`) et un fichier existant (une clé n'est jamais écrasée).
- Le script affiche la clé publique (ligne `"clePubliqueMaj": "MCowBQYDK2VwAyEA…"`), son empreinte
  SHA-256 et la même clé au format PEM. La clé privée n'est jamais affichée.
- Pour réafficher la clé publique d'une clé privée existante :
  `node scripts\generer-cle-maj.js --afficher E:\Coffre\gmao-signature-maj.pem`.

Conservation de la clé privée :

1. Enregistrez-la dans le coffre-fort de mots de passe de l'entreprise et sur un support chiffré rangé en
   lieu sûr (deux exemplaires).
2. Ajoutez-la comme secret de l'environnement GitHub `publication` (section 3).
3. Supprimez le fichier du poste d'administration.

Sans cette clé, plus aucune mise à jour ne peut être installée automatiquement par les postes qui
intègrent la clé publique (voir section 5).

## 3. Secret GitHub `MAJ_CLE_PRIVEE` (environnement protégé `publication`)

Les secrets de signature ne doivent **jamais** être des secrets du dépôt : ceux-ci sont transmis à toute
exécution lancée par une personne ou un jeton disposant du droit d'écriture, depuis n'importe quelle branche,
avec le workflow de cette branche (éventuellement modifié) ; la protection de la branche par défaut ne s'y
applique pas. Ils sont rangés dans l'environnement GitHub `publication`, que seule la branche par défaut peut
utiliser.

1. Sur la page du dépôt : **Settings › Environments › New environment**, nom : `publication`.
2. **Deployment branches and tags** : « Selected branches and tags », avec une seule règle : la branche par
   défaut (par exemple `main`). Aucune autre branche, aucune étiquette.
3. (Recommandé) **Required reviewers** : un ou deux membres du pôle informatique, qui approuvent chaque
   publication, avec « Prevent self-review ».
4. **Environment secrets › Add environment secret** : nom `MAJ_CLE_PRIVEE`, valeur : tout le contenu du fichier
   de clé privée, lignes `-----BEGIN PRIVATE KEY-----` et `-----END PRIVATE KEY-----` comprises.
5. Supprimez les éventuels secrets `MAJ_CLE_PRIVEE`, `CSC_LINK` et `CSC_KEY_PASSWORD` de
   **Settings › Secrets and variables › Actions › Repository secrets**.

Avec l'outil en ligne de commande GitHub :
`gh secret set MAJ_CLE_PRIVEE --env publication < E:\Coffre\gmao-signature-maj.pem`.

Utilisation par le workflow :

- le job de construction n'utilise l'environnement `publication`, donc ses secrets, que pour une version
  publiée : push sur la branche par défaut hors commit `[wip]`, ou exécution manuelle (« Run workflow ») sur
  cette branche. GitHub refuse cet environnement à toute autre branche, même si le workflow y est modifié ;
  aucune étiquette ne déclenche de construction ni de publication. Les constructions de branches produisent
  des exécutables et un manifeste non signés ;
- le secret n'est transmis qu'à l'étape « Manifeste de mise à jour » ; la clé n'est jamais écrite sur disque
  ni affichée dans le journal ;
- la Release GitHub est créée par un job distinct (« Publication de la version »), seul à disposer du droit
  d'écriture sur le dépôt, qui n'exécute ni le code du dépôt ni aucun paquet npm et ne reçoit aucun secret ;
- le résumé du job indique si le manifeste est signé et l'empreinte de la clé publique utilisée ;
- si une clé publique est configurée dans `package.json` et que la clé privée ne lui correspond pas, la
  construction s'arrête (les postes refuseraient la mise à jour).

Chaîne de construction verrouillée (le contenu signé ne doit dépendre que de fichiers relus) :

- les actions GitHub sont épinglées par empreinte de commit complète, leur version en commentaire : une
  nouvelle version d'action n'est utilisée qu'après une modification relue du workflow (Dependabot peut
  proposer ces mises à jour avec les écosystèmes `github-actions` et `npm`) ;
- Electron et electron-builder sont installés par `npm ci` depuis `package-lock.json`, versionné avec le code.
  Une version publiée n'est jamais construite sans ce fichier (le job s'arrête). Pour le créer ou le mettre à
  jour, sur un poste de confiance : `npm install --package-lock-only --ignore-scripts`, puis relisez la
  différence (paquets, versions, empreintes `integrity`) avant de la pousser.

Recommandations pour le dépôt : authentification à deux facteurs obligatoire, protection de la branche par
défaut avec relecture obligatoire des modifications (en particulier `.github/workflows/`, `scripts/`,
`electron/`, `package.json` et `package-lock.json`), nombre d'administrateurs limité, règle (ruleset) qui
réserve la création, la modification et la suppression des étiquettes `v*` aux administrateurs. Toute personne
qui peut fusionner sur la branche par défaut sans relecture peut utiliser les secrets. Enfin, tant que la clé
publique n'est pas intégrée aux postes (section 4), une personne disposant du droit d'écriture peut encore
publier une Release acceptée par les postes : seule la signature du manifeste protège réellement les postes.

## 4. Intégrer la clé publique à l'application

Ajoutez la ligne affichée par le script dans la rubrique `gmao` de `package.json` :

```json
"gmao": {
  "depotMisesAJour": "organisation/sicaf",
  "clePubliqueMaj": "MCowBQYDK2VwAyEA…"
}
```

Formats acceptés : SPKI encodé en base64 sur une ligne (recommandé) ou PEM `-----BEGIN PUBLIC KEY-----`.
Une valeur illisible bloque les mises à jour (le poste ne revient jamais à l'empreinte seule). Une clé
**privée** placée ici par erreur est refusée : considérez-la alors comme compromise et générez une
nouvelle paire.

Mise en service :

1. Créez d'abord le secret `MAJ_CLE_PRIVEE` (section 3), puis poussez la modification de `package.json`.
2. Cette première version est encore acceptée par les postes selon l'ancienne règle (empreinte du manifeste non
   signé ; taille seule pour une publication GitHub sans `latest.json`). Une fois installée, chaque poste exige une
   signature valide pour toutes les versions suivantes.
3. Pour une confiance complète dès la mise en service, installez cette version manuellement ou par votre
   outil de déploiement (GPO, Intune…) à partir d'un installateur signé Authenticode (section 6).

## 5. Rotation, clé de secours et compromission

`clePubliqueMaj` accepte un tableau de clés (cinq au plus) : une signature valide pour l'une d'elles suffit.

- **Rotation planifiée** : générez une paire B. Publiez une version contenant
  `"clePubliqueMaj": ["<clé A>", "<clé B>"]`, encore signée avec A. Lorsque tous les postes l'ont installée,
  remplacez le secret `MAJ_CLE_PRIVEE` par la clé B ; retirez la clé A du tableau dans une version ultérieure.
- **Clé de secours** : une deuxième clé publique peut figurer en permanence dans le tableau, sa clé privée
  restant hors ligne (coffre). Elle permet de continuer à publier si la clé principale est perdue.
- **Clé privée compromise** : publiez au plus vite une version signée avec une clé saine (secours ou
  nouvelle clé) dont le tableau ne contient plus la clé compromise ; remplacez le secret GitHub.
- **Version signée défectueuse ou vulnérable** : publier une version corrective ne suffit pas toujours. Un poste
  encore en version inférieure accepte toute version signée supérieure à la sienne, même antérieure à la
  dernière publiée : la date signée n'est pas comparée. Une personne qui contrôle une source (dossier réseau,
  adresse web interne) peut donc y remettre le manifeste et l'installateur, intacts, d'une version signée
  remplacée depuis, et y maintenir les postes (rejeu d'une version signée). Retirez cette version de toutes
  les sources (Release GitHub, dossiers, serveurs internes), vérifiez la version installée sur chaque poste
  (**Aide › À propos**) et mettez à jour manuellement ceux qui ne l'ont pas dépassée.
- **Clé perdue sans clé de secours** : les postes devront être mis à jour manuellement avec une version
  intégrant une nouvelle clé publique.

## 6. Signature de code Windows (Authenticode)

La signature Authenticode atteste l'éditeur des exécutables, évite les avertissements Windows SmartScreen
et permet les politiques de contrôle d'applications (AppLocker, WDAC). Elle complète la signature du
manifeste, qui reste la référence pour l'installation automatique : l'application ne contrôle pas la
signature Authenticode avant l'installation silencieuse.

### Choix du certificat

- **Autorité de certification interne** (Active Directory Certificate Services, modèle « Signature de
  code ») : le certificat est exportable en `.pfx`. Déployez le certificat racine sur les postes par
  stratégie de groupe et, si vous utilisez AppLocker ou WDAC, autorisez cet éditeur.
- **Autorité publique** (certificat OV ou EV) : depuis juin 2023, la clé privée de ces certificats doit être
  conservée sur un support matériel (jeton ou HSM) et ne peut plus être exportée en `.pfx`. Les secrets
  ci-dessous ne s'appliquent donc pas ; il faut un service de signature en ligne compatible avec
  electron-builder, à mettre en place avec le fournisseur du certificat.

### Secrets `CSC_LINK` et `CSC_KEY_PASSWORD`

1. Encodez le fichier `.pfx` en base64 (PowerShell) :

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('E:\Coffre\gmao-signature-code.pfx')) | Set-Clipboard
   ```

   Le résultat de `certutil -encode` est également accepté (les lignes `BEGIN` / `END` sont ignorées).
2. Dans l'environnement `publication` (section 3, jamais dans les secrets du dépôt), créez le secret
   `CSC_LINK` avec ce texte, puis le secret `CSC_KEY_PASSWORD` avec le mot de passe du fichier `.pfx`.

Fonctionnement dans le workflow :

- la signature n'a lieu que pour une version publiée et seulement si `CSC_LINK` est renseigné ; sinon les
  exécutables sont produits sans signature ;
- le certificat est décodé dans le dossier temporaire du job **après** l'installation des paquets npm, utilisé
  par electron-builder, puis supprimé ; le mot de passe est retiré de l'environnement des étapes suivantes ;
- l'étape « Contrôle de la signature Authenticode » inscrit l'état de chaque exécutable dans le résumé du job
  et échoue si un exécutable n'est pas signé. L'état `UnknownError` est normal avec une autorité interne :
  la machine de construction de GitHub ne connaît pas votre certificat racine.

Vérification sur un poste : clic droit sur l'exécutable › **Propriétés › Signatures numériques**, ou :

```powershell
Get-AuthenticodeSignature .\GMAO-SICAF-Setup-1.0.42.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

## 7. Publication interne par dossier réseau (sans Internet)

Les postes peuvent recevoir les mises à jour depuis un partage réseau, par exemple
`\\NAS\gmao\mises-a-jour`. La signature y est vérifiée exactement comme pour GitHub : même un partage
compromis ne permet pas d'installer un exécutable modifié. Il permet en revanche de retenir les postes sur
une version (en retirant `latest.json`) ou d'y remettre une version signée plus ancienne que la dernière
publiée mais supérieure à celle des postes : ne laissez sur le partage que la dernière version et appliquez
la section 5 (« Version signée défectueuse ou vulnérable ») si une version doit être retirée.

### Obtenir les fichiers

- **Depuis une version publiée** : téléchargez `GMAO-SICAF-Setup-<version>.exe` et `latest.json` depuis la
  Release GitHub (ou depuis les artefacts de l'exécution du workflow qui l'a publiée), sur un poste ayant
  accès à Internet. Ne modifiez pas ces fichiers : toute modification invalide la signature.
- **Construction interne** (poste de construction de l'entreprise, Node.js et dépendances déjà installés) :

  ```powershell
  npm run dist
  $env:MAJ_CLE_PRIVEE = Get-Content -Raw 'E:\Coffre\gmao-signature-maj.pem'
  node scripts\manifeste-maj.js dist 1.0.42 notes.txt
  Remove-Item Env:\MAJ_CLE_PRIVEE
  ```

  La version indiquée doit être celle de l'installateur (`dist\GMAO-SICAF-Setup-1.0.42.exe`, c'est-à-dire la
  version de `package.json`) et être supérieure à la version installée sur les postes. Le fichier de notes est
  facultatif. Le script affiche « Manifeste signé (ed25519) » et l'empreinte de la clé publique.

### Déposer les fichiers

1. Copiez d'abord l'installateur, puis `latest.json` (un poste ne doit pas lire le nouveau manifeste avant
   que l'installateur soit complet).
2. Droits NTFS et de partage : **lecture seule** pour les utilisateurs et les comptes d'ordinateurs,
   **modification** réservée au groupe du pôle informatique.
3. Sur chaque poste, application fermée, indiquez la source dans la rubrique `misesAJour` du fichier
   `%APPDATA%\GMAO SICAF\parametres.json` (déployable par stratégie de groupe ou script de connexion) :

   ```json
   "misesAJour": { "automatique": true, "source": "dossier", "chemin": "\\\\NAS\\gmao\\mises-a-jour" }
   ```

   Valeurs de `source` : `github` (par défaut), `dossier`, `url` (avec `"url": "https://serveur-interne/gmao/"`)
   ou `aucune`. Les autres réglages du fichier sont conservés.
4. Contrôle : sur un poste, **Aide › Rechercher les mises à jour**.

## 8. Messages affichés par les postes

| Message | Cause probable | Action |
|---|---|---|
| « le manifeste de la version publiée n'est pas signé » | secret `MAJ_CLE_PRIVEE` absent lors de la construction, ou `latest.json` absent | créer le secret, republier ; vérifier le résumé du job |
| « la signature du manifeste est invalide » | fichier modifié après signature, ou signé avec une clé non intégrée aux postes | ne rien installer manuellement ; vérifier l'origine des fichiers et la clé (section 5) |
| « algorithme de signature absent ou non pris en charge » / « signature mal formée » | manifeste altéré ou produit par un autre outil | republier avec `scripts/manifeste-maj.js` |
| « Clé publique de mise à jour invalide » | valeur de `gmao.clePubliqueMaj` erronée dans `package.json` | corriger la clé et redéployer l'application manuellement |
| « La version publiée (…) est antérieure à la version installée » | publication d'un numéro inférieur | publier un numéro supérieur |
| « l'hôte … n'appartient pas à GitHub » / « Redirection refusée » | réponse ou redirection vers un autre serveur (mandataire, détournement) : chaque redirection est contrôlée avant d'être suivie | vérifier le mandataire réseau ; utiliser la source « dossier » si nécessaire |
| « l'adresse finale de la réponse est inconnue » | outil de téléchargement qui ne permet pas de contrôler les redirections (version de l'application modifiée) | réinstaller l'application depuis un installateur signé ; prévenir le pôle informatique |
| « Empreinte de l'installateur incorrecte » / « Taille de l'installateur incorrecte » | téléchargement corrompu ou fichier substitué | relancer ; si le problème persiste, vérifier la source |

## 9. Publication refusée par GitHub

Lorsqu'un commit modifie lui-même un fichier de `.github/workflows`, GitHub refuse au jeton du workflow la
création de l'étiquette de version. L'exécution n'échoue pas : le résumé du job affiche « version non
publiée » et les exécutables, déjà signés avec leur manifeste, restent disponibles dans les artefacts. Pour
publier, poussez un commit suivant qui ne modifie pas les workflows, ou créez la Release depuis un poste
autorisé (compte d'un administrateur) avec ces fichiers, sans les modifier :

```bash
gh run download <numéro de l'exécution> --name GMAO-SICAF-1.0.42 --dir dist
gh release create v1.0.42 dist/GMAO-SICAF-Setup-1.0.42.exe dist/GMAO-SICAF-Portable-1.0.42.exe dist/latest.json \
  --target <commit> --title "GMAO SICAF 1.0.42" --notes-file dist/notes.txt --latest
```

Pousser une étiquette `v*` ne déclenche plus aucune publication : une étiquette peut être posée sur n'importe
quel commit, y compris un commit d'une branche jamais relue.

## 10. Liste de contrôle

Avant le premier déploiement (prérequis de livraison, dans cet ordre) :

- [ ] Paire de clés générée hors du dépôt ; deux copies hors ligne de la clé privée ; fichier supprimé du poste.
- [ ] Environnement `publication` créé, réservé à la branche par défaut (relecteurs obligatoires recommandés) ;
      aucun secret de signature dans les secrets du dépôt.
- [ ] Secret `MAJ_CLE_PRIVEE` créé dans l'environnement `publication` ; résumé du dernier job : « Signature : ed25519 ».
- [ ] `package-lock.json` généré sur un poste de confiance, relu et versionné (sans lui, aucune version n'est publiée).
- [ ] `gmao.clePubliqueMaj` renseigné dans `package.json` ; empreinte identique à celle du résumé du job.

Ensuite :

- [ ] (Facultatif) clé de secours ajoutée au tableau, clé privée au coffre.
- [ ] Certificat de signature de code : secrets `CSC_LINK` et `CSC_KEY_PASSWORD` dans l'environnement
      `publication` ; état des exécutables vérifié dans le résumé du job.
- [ ] Branche par défaut protégée, relecture obligatoire, authentification à deux facteurs.
- [ ] Étiquettes `v*` protégées par une règle (création, modification et suppression réservées aux administrateurs).
- [ ] Partage réseau de mises à jour (si utilisé) : lecture seule pour les postes.
