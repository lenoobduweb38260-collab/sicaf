# Sécurité de GMAO SICAF

Ce document décrit les mesures de sécurité de l'application et les recommandations de déploiement
destinées au pôle informatique.

## 1. Architecture et données

| Élément | Mesure |
|---|---|
| Application | Exécutable Windows autonome (Electron) : moteur intégré, aucune dépendance logicielle à installer, aucune fenêtre de commandes. |
| Fenêtre | Isolation du contenu (`contextIsolation`, `sandbox`, aucun accès Node.js depuis l'interface), navigation limitée à l'application, vues intégrées interdites, outils de développement absents de la version installée. |
| Exécutable | Fusibles Electron : exécution comme Node.js désactivée, options `NODE_OPTIONS` et `--inspect` ignorées, chargement uniquement depuis l'archive de l'application, chiffrement des cookies. |
| Données | Base au format JSON écrite de façon atomique dans `%APPDATA%\GMAO SICAF\data` (ou un dossier choisi par le pôle informatique). Sauvegarde quotidienne automatique (30 conservées). |
| Dépendances | Aucune bibliothèque tierce dans le serveur ni dans l'interface : pas de risque lié à la chaîne d'approvisionnement des paquets. |

## 2. Comptes et authentification

- **Mots de passe** hachés avec scrypt et sel aléatoire ; comparaison en temps constant ; jamais renvoyés au poste.
- **Politique** (Configuration › Général › Sécurité) : 10 caractères minimum par défaut, au moins 3 types de
  caractères, refus des mots de passe courants et de ceux qui contiennent l'identifiant, changement obligatoire
  du mot de passe initial, nouveau mot de passe différent de l'ancien.
- **Changement imposé par le serveur** : tant qu'un mot de passe initial (si la configuration l'exige), réinitialisé,
  expiré ou défini par un administrateur n'a pas été changé, le serveur refuse toute opération autre que
  l'authentification (aucune donnée de l'application, notifications comprises).
- **Historique** : les 5 derniers mots de passe (réglable de 0 à 24) sont refusés, en plus du mot de passe actuel ;
  seules leurs empreintes scrypt sont conservées.
- **Expiration** (désactivée par défaut, 30 à 730 jours) avec rappel avant l'échéance ; l'activer ne fait pas expirer
  d'un coup les comptes jamais changés (date de référence posée à la première évaluation).
- **Comptes créés par le pôle informatique** : sans mot de passe saisi, un mot de passe aléatoire conforme est
  généré et affiché une seule fois.
- **Mot de passe oublié** : depuis l'écran de connexion, l'utilisateur adresse une demande au pôle informatique.
  La réponse est identique que le compte existe ou non (aucune énumération des identifiants), 5 demandes au plus
  par poste en 15 minutes ; les gestionnaires du compte et son titulaire sont prévenus (au plus toutes les 30 minutes).
- **Codes de réinitialisation** (recommandé plutôt qu'un mot de passe temporaire) : 8 caractères sans ambiguïté de
  lecture, à usage unique, valables 60 minutes par défaut, affichés une seule fois au pôle informatique ; seule leur
  empreinte scrypt est conservée ; annulés après 5 essais incorrects, par un changement de mot de passe, une nouvelle
  réinitialisation ou la désactivation du compte. L'utilisateur choisit lui-même son nouveau mot de passe ; ses sessions
  sont fermées et **la double authentification reste exigée** à la connexion suivante (aucune session n'est ouverte
  par la réinitialisation). Réponses génériques et blocage après 8 échecs, comme la connexion.
- **Réinitialisation autonome** (désactivée par défaut) : un utilisateur dont la double authentification est active peut
  définir un nouveau mot de passe avec un code de son application d'authentification (jamais avec un code de secours) ;
  le pôle informatique en est informé.
- **Récupération d'urgence** (application de bureau, mode serveur) : sur le poste serveur (icône de la zone de
  notification › « Récupérer un compte administrateur… »), après le code du pôle informatique, un code de
  réinitialisation peut être généré pour un compte actif administrateur ou du pôle informatique. Le code du pôle
  informatique est redemandé pour chaque code généré (saisie valable 5 minutes) ; le code de réinitialisation est
  affiché une seule fois et n'est conservé nulle part sur le poste ; l'opération est journalisée (auteur : poste
  serveur et session Windows) et signalée à tout le pôle informatique. Indisponible en mode client et depuis les
  pages de la GMAO (canaux réservés à la fenêtre ouverte par l'application pour cet usage).
- **Code du pôle informatique** (paramètres du poste, récupération d'urgence) : seule son empreinte scrypt est
  conservée ; essais traités un par un et freinés, saisie bloquée 15 minutes après 8 essais incorrects consécutifs
  (même après un redémarrage de l'application) ; sur le poste serveur, chaque échec est inscrit au journal
  d'activité et chaque blocage signalé au pôle informatique.
- **Blocage** après 8 échecs, par poste et par compte (10 minutes) ; chaque échec et chaque blocage sont inscrits
  au journal d'activité et le pôle informatique est notifié. En plus, **20 échecs en 15 minutes depuis un même poste**,
  tous identifiants confondus (connexion, codes de vérification, codes de réinitialisation), bloquent ce poste 15 minutes
  avant tout calcul d'empreinte : un poste qui change d'identifiant à chaque essai ne peut ni saturer le journal ni
  noyer les alertes (une seule alerte « Poste temporairement bloqué », regroupée). Les identifiants saisis sont cités dans
  le journal et les alertes sans caractères de mise en forme (direction d'écriture, séparateurs de ligne).
- **Double authentification** (TOTP, applications Microsoft Authenticator, Google Authenticator, FreeOTP…) :
  facultative par défaut, ou obligatoire pour les comptes sensibles (administrateurs, gestion du système, des utilisateurs,
  des profils ou de la configuration) ou pour tous (Configuration › Général › Sécurité). La session n'est ouverte qu'après le
  code (5 essais, puis nouveau mot de passe ; blocage du compte après des codes incorrects répétés) ; anti-rejeu ; 10 codes de
  secours à usage unique affichés une seule fois ; clé chiffrée au repos (AES-256-GCM) avec une clé conservée hors de la base
  (`cle-double-authentification.key`, à copier avec les données lors d'un changement de serveur) ; désactivation et nouveaux
  codes de secours avec mot de passe **et** code ; réinitialisation par le pôle informatique depuis la fiche de l'utilisateur
  (journalisée, notifiée), jamais contournée par un code de réinitialisation ni par la récupération d'urgence.
- **Prise en main d'un compte** (mot de passe défini ou réinitialisé, code, double authentification) : réservée à un gestionnaire
  de niveau hiérarchique supérieur qui possède lui-même tous les droits du compte (surcharges, portée, secteurs, sites) ; sinon
  seul un administrateur peut agir. Changer son mot de passe exige le mot de passe actuel, y compris quand il expire pendant une
  session ouverte (sauf si le changement était imposé dès la connexion, où il vient d'être saisi).
- **Sessions** : jeton aléatoire de 256 bits dans un cookie `HttpOnly`, `SameSite=Strict` (et `Secure` en HTTPS) ;
  déconnexion après inactivité (60 minutes par défaut) et durée maximale (12 heures) ; changer son mot de passe
  ferme les autres sessions ; le pôle informatique peut fermer une session à distance
  (Système & informatique › Réseau & postes).
- L'aide « admin / admin » de l'écran de connexion n'apparaît que tant que le compte administrateur initial n'a
  jamais été utilisé.

## 3. Droits

- Matrice de droits par profil (module × action) et surcharges individuelles ; un utilisateur ne peut accorder
  que des droits qu'il possède et ne gère que des comptes de niveau hiérarchique inférieur.
- **Pôle informatique** : seul profil (avec l'administrateur) à gérer les comptes, les profils, la base de
  données, les sauvegardes, le réseau et les mises à jour.
- **Portée des données** : tous les sites, ses sites, ses secteurs ou ses propres éléments ; accès aux autres
  sites en lecture seule ou complet ; toute modification sur un site en lecture seule est refusée par le serveur.
- Chaque requête est contrôlée côté serveur : l'interface masque les actions interdites, mais la règle est
  appliquée par le serveur.

## 4. Protection du serveur

- **En-têtes** : politique de contenu stricte (aucun script en ligne ni externe, aucune intégration dans une page
  tierce), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Resource-Policy`, `Strict-Transport-Security` en HTTPS.
- **Requêtes intersites** : en-tête applicatif obligatoire pour toute modification et cookie `SameSite=Strict`.
- **Noms d'hôte** : seules les adresses IP, `localhost`, le nom du poste et les noms déclarés par le pôle
  informatique sont acceptés (protection contre le « DNS rebinding »).
- **Entrées** : validation stricte côté serveur, lecture JSON sans clés dangereuses (pollution de prototype),
  tailles limitées (25 Mo par requête), contrôle des chemins de fichiers, délais contre les connexions lentes.
- **Erreurs** : aucun détail technique n'est renvoyé au poste ; une référence d'incident permet au pôle
  informatique de retrouver l'erreur dans le journal du serveur.
- **Accès par navigateur web** : refusé par défaut, l'application GMAO SICAF est seule autorisée
  (Système & informatique › Réseau & postes).
- **Chiffrement du réseau (HTTPS)** : quand le poste serveur partage la GMAO, il sert l'application en HTTPS avec un
  certificat généré sur ce poste (TLS 1.2 minimum, HSTS, cookie `Secure`) ; le HTTP en clair est redirigé. Sur chaque poste
  client, le pôle informatique **confirme l'empreinte** du certificat (affichée sur le poste serveur : icône de la zone de
  notification › « Empreinte du certificat… », et dans Système & informatique › Réseau & postes) ; le poste n'accepte ensuite
  que ce certificat (épinglage, reconnu aussi par l'empreinte de sa clé lors d'un renouvellement). Une empreinte différente
  signifie une usurpation possible ou un poste serveur réinstallé : ne pas confirmer sans vérification.
- **Fichiers reçus** : les secrets de sauvegarde (clés, mot de passe de chiffrement, destinations) ne figurent dans aucun
  export ni aucune réponse ; un import ou une restauration contrôle le fichier (collections attendues, identifiants, au moins
  un administrateur actif) avant de remplacer quoi que ce soit, conserve les paramètres de sauvegarde de ce serveur, et n'est
  possible qu'avec l'accès à tous les sites. Les routes brutes publiques (réception d'une sauvegarde) peuvent vérifier la clé
  avant de lire le corps (`avantCorps`).

## 5. Traçabilité

- **Journal d'activité** : connexions, échecs, blocages, créations, modifications, suppressions, changements
  d'état, sauvegardes, imports, restaurations, demandes et réinitialisations de mot de passe, récupérations d'urgence…
  (5 000 dernières entrées dans l'application, les plus anciennes archivées dans `data\journal\audit-AAAA-MM.jsonl`, export CSV).
- **Notifications** aux rôles responsables pour les événements choisis (Configuration › Journal & notifications) : seuls
  les comptes qui ont accès au journal d'activité et qui peuvent consulter l'élément concerné (portée, sites) les reçoivent,
  car leur texte reprend les détails de l'événement.

## 6. Sauvegardes

- Sauvegarde locale quotidienne, sauvegardes manuelles, sauvegarde avant chaque import ou restauration.
- **Destinations multiples** : dossier local, clé USB, NAS ou partage réseau, serveur GMAO d'un autre site.
  Compression, chiffrement AES-256-GCM optionnel (clé dérivée par scrypt), empreinte SHA-256 vérifiée.
- **Réception** des sauvegardes d'un autre site protégée par une clé aléatoire (comparaison en temps constant,
  limitation des essais) ; les sauvegardes reçues ne sont jamais importées automatiquement.
- Les secrets (clés, mots de passe de chiffrement, destinations) ne sont jamais envoyés à l'interface.

## 7. Mises à jour

- L'application vérifie la présence d'une nouvelle version, télécharge l'installateur, contrôle son empreinte
  SHA-256 puis l'installe en silence. Les données ne sont pas modifiées par une mise à jour.
- Source au choix : publications GitHub du dépôt, dossier réseau interne ou adresse web interne.
- **Signature des mises à jour** : dès qu'une clé publique est configurée (`clePubliqueMaj` dans `package.json`, voir
  `docs/MISES-A-JOUR.md`), le manifeste de chaque version doit être signé avec la clé privée Ed25519 de l'entreprise ;
  un manifeste non signé ou mal signé est refusé, le retour à une version antérieure est interdit et, pour la source GitHub,
  seuls les hôtes GitHub sont acceptés. Sans clé configurée, l'empreinte SHA-256 reste vérifiée.

## 8. Recommandations de déploiement

1. **Poste serveur** : PC dédié ou serveur Windows, compte Windows réservé, disque chiffré (BitLocker), antivirus à
   jour, onduleur.
2. **Réseau** : n'autorisez le port de la GMAO (8585 par défaut) dans le pare-feu Windows que pour le réseau privé
   de l'entreprise ; aucune exposition sur Internet.
3. **Sauvegardes** : au moins une destination hors du poste serveur (NAS ou serveur d'un autre site), chiffrée ;
   testez une restauration chaque trimestre.
4. **Comptes** : un compte nominatif par personne ; changez immédiatement le mot de passe initial de
   l'administrateur ; limitez le profil Pôle informatique à quelques personnes.
5. **Signature de code** : pour éviter l'avertissement Windows SmartScreen, signez l'exécutable avec un certificat
   de signature de code de l'entreprise (voir `docs/MISES-A-JOUR.md`).
6. **Revue régulière** : consultez le journal d'activité (échecs de connexion, blocages, suppressions) et la liste
   des postes connectés.
