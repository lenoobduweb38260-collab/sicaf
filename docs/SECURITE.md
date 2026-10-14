# Sécurité de GMAO SICAF

Ce document décrit les mesures de sécurité de l'application et les recommandations de déploiement
destinées au pôle informatique.

## 1. Architecture et données

| Élément | Mesure |
|---|---|
| Application | Exécutable Windows autonome (Electron) : moteur intégré, aucune dépendance logicielle à installer, aucune fenêtre de commandes. |
| Fenêtre | Isolation du contenu (`contextIsolation`, `sandbox`, aucun accès Node.js depuis l'interface), navigation limitée à l'application, vues intégrées interdites, outils de développement absents de la version installée. |
| Exécutable | Fusibles Electron : exécution comme Node.js désactivée, options `NODE_OPTIONS` et `--inspect` ignorées, chargement uniquement depuis l'archive de l'application avec contrôle d'intégrité, chiffrement des cookies. |
| Données | Base au format JSON écrite de façon atomique dans `%APPDATA%\GMAO SICAF\data` (ou un dossier choisi par le pôle informatique). Sauvegarde quotidienne automatique (30 conservées). |
| Dépendances | Aucune bibliothèque tierce dans le serveur ni dans l'interface : pas de risque lié à la chaîne d'approvisionnement des paquets. |

## 2. Comptes et authentification

- **Mots de passe** hachés avec scrypt et sel aléatoire ; comparaison en temps constant ; jamais renvoyés au poste.
- **Politique** (Configuration › Général › Sécurité) : 10 caractères minimum par défaut, au moins 3 types de
  caractères, refus des mots de passe courants et de ceux qui contiennent l'identifiant, changement obligatoire
  du mot de passe initial, nouveau mot de passe différent de l'ancien.
- **Comptes créés par le pôle informatique** : sans mot de passe saisi, un mot de passe aléatoire conforme est
  généré et affiché une seule fois.
- **Blocage** après 8 échecs, par poste et par compte (10 minutes) ; chaque échec et chaque blocage sont inscrits
  au journal d'activité et le pôle informatique est notifié.
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

## 5. Traçabilité

- **Journal d'activité** : connexions, échecs, blocages, créations, modifications, suppressions, changements
  d'état, sauvegardes, imports, restaurations… (5 000 dernières entrées, export CSV).
- **Notifications** aux rôles responsables pour les événements choisis (Configuration › Journal & notifications).

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
