/**
 * Interface des sauvegardes multi-destinations / multi-sites (Système & informatique › Base de données & sauvegardes).
 *
 *   GMAO.rendreSauvegardesAvancees(container)  → { rafraichir() }
 *
 * Cartes : indicateurs, « Sauvegarde automatique » (interrupteur à effet immédiat, puis planification, compression,
 * chiffrement — mot de passe en écriture seule — enregistrées par le bouton « Enregistrer les paramètres »),
 * « Destinations » (dossiers, clés USB, partages réseau, serveurs GMAO d'autres sites : tester, sauvegarder
 * maintenant, voir les fichiers, modifier, supprimer), « Recevoir les sauvegardes d'autres sites » (activation, clé
 * affichée une seule fois, adresse et empreinte du certificat à communiquer, sauvegardes reçues par site),
 * « Restauration » (copies locales, état précédent, fichier téléversé) et « Historique ».
 * Droits : Configuration et Système › Voir pour consulter ; › Modifier pour agir ; la gestion des destinations, les
 * paramètres, la clé et la restauration exigent l'accès à tous les sites (le serveur reste la référence).
 * Un rechargement de la page conserve le défilement, les recherches, les filtres et la saisie non enregistrée.
 */
(function (racine, fabrique) {
  'use strict';
  const lib = fabrique();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib.outils;
  if (racine && racine.GMAO && racine.ui && racine.api) lib.installer(racine);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const BASE = '/api/sauvegardes-avancees';
  const FREQUENCES = [
    { value: 1, label: 'Toutes les heures' },
    { value: 2, label: 'Toutes les 2 heures' },
    { value: 4, label: 'Toutes les 4 heures' },
    { value: 6, label: 'Toutes les 6 heures' },
    { value: 12, label: 'Deux fois par jour (toutes les 12 h)' },
    { value: 24, label: 'Quotidienne' },
    { value: 48, label: 'Tous les deux jours' },
    { value: 168, label: 'Hebdomadaire' },
  ];
  const TYPES_HISTO = {
    sauvegarde: { label: 'Sauvegarde', couleur: '#2563eb' },
    reception: { label: 'Réception', couleur: '#0891b2' },
    restauration: { label: 'Restauration', couleur: '#8b5cf6' },
  };

  // ----- Outils purs (testables sous Node) -----
  function formatTaille(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    const f = (x, d) => x.toFixed(d).replace('.', ',');
    if (v < 1024) return `${v} o`;
    if (v < 1024 * 1024) return `${f(v / 1024, 0)} Ko`;
    if (v < 1024 * 1024 * 1024) return `${f(v / 1024 / 1024, 1)} Mo`;
    return `${f(v / 1024 / 1024 / 1024, 2)} Go`;
  }
  function formatDureeMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(1).replace('.', ',')} s`;
    const m = Math.floor(v / 60000); const s = Math.round((v % 60000) / 1000);
    return `${m} min ${String(s).padStart(2, '0')} s`;
  }
  function libelleFrequence(h, heure) {
    const n = Number(h) || 24;
    const f = FREQUENCES.find((x) => x.value === n);
    const base = f ? f.label : (n % 24 === 0 ? `Tous les ${n / 24} jours` : `Toutes les ${n} heures`);
    return n >= 24 && heure ? `${base} à ${heure}` : base;
  }
  function empreinteCourte(sha) { return sha ? `${String(sha).slice(0, 12)}…` : '—'; }
  /** Valeur courte du KPI « Prochaine sauvegarde » (la date complète est reportée dans le détail). */
  function libelleProchaine(iso, now = new Date()) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return { valeur: '—', detail: '' };
    const p = (n) => String(n).padStart(2, '0');
    const heure = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const date = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    const detail = `${date} ${heure}`;
    if (d.getTime() <= now.getTime() + 5 * 60000) return { valeur: 'Imminente', detail };
    const jour = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ecart = Math.round((jour(d) - jour(now)) / 86400000);
    if (ecart === 0) return { valeur: `Aujourd'hui ${heure}`, detail };
    if (ecart === 1) return { valeur: `Demain ${heure}`, detail };
    return { valeur: date, detail };
  }
  /**
   * Segments d'un chemin ou d'une adresse, coupés après chaque séparateur (retour à la ligne possible entre les
   * segments, jamais au milieu d'un mot) ; les séparateurs de tête (« \\ » d'un partage, « // » d'une adresse) restent
   * attachés au segment qui les suit ou les précède.
   */
  function morceauxChemin(chemin) {
    const s = String(chemin == null ? '' : chemin);
    const out = [];
    let courant = '';
    for (const c of s) {
      const sep = c === '\\' || c === '/';
      if (!sep && /[\\/]$/.test(courant) && /[^\\/]/.test(courant)) { out.push(courant); courant = ''; }
      courant += c;
    }
    if (courant) out.push(courant);
    return out;
  }

  const outils = { formatTaille, formatDureeMs, libelleFrequence, empreinteCourte, libelleProchaine, morceauxChemin, FREQUENCES };

  // ----- Interface -----
  function installer(win) {
    const GMAO = win.GMAO;
    const ui = win.ui;
    const api = win.api;
    const { el, icone, toast, erreur, frag } = ui;
    const doc = win.document;

    const peutModifierDroits = () => GMAO.can('systeme', 'modifier');

    function injecterStyles() {
      if (doc.getElementById('sav-styles')) return;
      const css = `
.sav-titre { display: flex; align-items: center; gap: 8px; font-size: 18px; margin: 26px 0 2px; color: var(--texte); }
.sav-titre svg { width: 20px; height: 20px; color: var(--primaire); }
.sav-intro { margin: 0 0 12px; }
.sav-kpis { margin: 12px 0 16px; }
.sav-kpis .kpi-valeur { overflow-wrap: anywhere; }
.sav-cartes { align-items: start; }
.sav-aide { background: var(--surface-2); border: 1px dashed var(--bordure-2); border-radius: var(--rayon); padding: 10px 14px; font-size: 12.5px; color: var(--texte-2); margin-top: 12px; }
.sav-aide summary { cursor: pointer; font-weight: 600; color: var(--texte); }
.sav-aide ul { margin: 8px 0 2px; padding-left: 18px; }
.sav-aide li { margin: 4px 0; }
.sav-aide code { white-space: nowrap; }
.sav-emplacement { font-family: Consolas, "Courier New", monospace; font-size: 12px; overflow-wrap: anywhere; color: var(--texte); }
.sav-empreinte { display: inline-block; font-family: Consolas, "Courier New", monospace; font-size: 12px; padding: 4px 8px; background: var(--fond-2); border: 1px solid var(--bordure-2); border-radius: 6px; overflow-wrap: anywhere; user-select: all; color: var(--texte); }
.sav-cle { font-family: Consolas, "Courier New", monospace; font-size: 14px; padding: 12px 14px; background: var(--fond-2); border: 1px solid var(--bordure-2); border-radius: 6px; word-break: break-all; user-select: all; color: var(--texte); margin: 10px 0; }
.sav-resultats { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.sav-resultats li { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--bordure); border-left: 4px solid var(--ok); border-radius: 6px; background: var(--surface-2); }
.sav-resultats li.ko { border-left-color: var(--danger); }
.sav-resultats li > svg { width: 18px; height: 18px; flex-shrink: 0; margin-top: 2px; color: var(--ok); }
.sav-resultats li.ko > svg { color: var(--danger); }
.sav-resultats .sav-res-nom { font-weight: 600; }
.sav-resultats .sav-res-msg { font-size: 12.5px; color: var(--texte-2); margin-top: 2px; word-break: break-word; }
.sav-ligne { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sav-ligne + .sav-ligne { margin-top: 10px; }
.sav-separateur { border-top: 1px solid var(--bordure); margin: 14px 0; }
.sav-site { border: 1px solid var(--bordure); border-radius: var(--rayon); margin-top: 12px; overflow: hidden; background: var(--surface); }
.sav-site-entete { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--bordure); flex-wrap: wrap; }
.sav-site-entete svg { width: 18px; height: 18px; color: var(--info); }
.sav-site-nom { font-weight: 600; color: var(--texte); }
.sav-site-corps { padding: 6px 10px 2px; }
.sav-site-corps .barre-outils { display: none; }
.sav-adresses { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.sav-adresse { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sav-fichier { font-family: Consolas, "Courier New", monospace; font-size: 12px; white-space: nowrap; color: var(--texte); }
.sav-lecture .interrupteur { opacity: 0.55; cursor: not-allowed; }
.sav-mono { font-family: Consolas, "Courier New", monospace; font-size: 11.5px; color: var(--texte-2); }
.sav-nom-dest { display: flex; align-items: center; gap: 8px; }
.sav-nom-dest > svg { width: 18px; height: 18px; flex-shrink: 0; color: var(--primaire); }
.sav-nom-dest.serveur > svg { color: var(--info); }
.sav-nom-dest .cellule-principale { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sav-notes { max-width: 380px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sav-dest-tableau td { vertical-align: middle; }
.sav-actions-carte { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sav-modifie { display: inline-flex; align-items: center; }
.sav-modifie.masque { display: none; }
.sav-rien { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; }
.sav-rien svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--info); }
.sav-confirmation { margin-top: 6px; }
.sav-etape { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
.sav-etape-num { width: 22px; height: 22px; border-radius: 50%; background: var(--primaire); color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
@media (max-width: 1440px) { .sav-notes { max-width: 220px; } .sav-kpis .kpi-valeur { font-size: 20px; } }
@media (max-width: 1100px) { .sav-cartes.grille-2 { grid-template-columns: 1fr; } }
`;
      doc.head.appendChild(el('style', { id: 'sav-styles' }, css));
    }

    async function copier(texte) {
      try { if (win.navigator.clipboard && win.isSecureContext) { await win.navigator.clipboard.writeText(texte); return true; } } catch (e) { /* repli */ }
      try {
        const ta = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
        ta.value = texte; doc.body.appendChild(ta); ta.select();
        const ok = doc.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    function boutonCopier(texte, label) {
      return ui.bouton(label || 'Copier', { icone: 'copier', classe: 'btn-sm', onClic: async () => {
        if (await copier(texte)) toast('Copié dans le presse-papiers', 'succes');
        else toast('Copie impossible : sélectionnez le texte puis Ctrl+C', 'alerte');
      } });
    }
    const badgeOk = (ok, labels) => ui.badge(ok ? (labels ? labels[0] : 'Réussie') : (labels ? labels[1] : 'Échec'), ok ? '#16a34a' : '#dc2626');
    const dateTitre = (d) => (d ? ui.formatDateHeure(d) : '');
    function cellDerniere(d) {
      const x = d.derniere;
      if (!x) return el('span', { class: 'texte-2' }, 'Jamais');
      return el('div', null,
        el('div', { class: 'sav-ligne', style: { gap: '6px' } }, badgeOk(x.ok, ['OK', 'Échec']), el('span', { title: dateTitre(x.date) }, ui.relatif(x.date))),
        el('div', { class: 'cellule-secondaire', title: x.message || '' }, x.ok ? `${formatTaille(x.taille)} · ${formatDureeMs(x.dureeMs)}` : String(x.message || '').slice(0, 90)));
    }
    function badgesFormat(f) {
      return frag(f.compresse ? ui.badge('Compressée', '#0891b2') : null, ' ', f.chiffre ? ui.badge('Chiffrée', '#7c3aed') : null, !f.compresse && !f.chiffre ? ui.badge('JSON') : null);
    }
    /** Chemin ou adresse : retour à la ligne possible après chaque séparateur (le texte copié reste intact). */
    function renduChemin(chemin) {
      const span = el('span', { class: 'sav-emplacement' });
      morceauxChemin(chemin).forEach((m, i) => { if (i) span.appendChild(el('wbr')); span.appendChild(doc.createTextNode(m)); });
      return span;
    }
    const empreinteEl = (e) => el('code', { class: 'sav-empreinte' }, e || '—');
    const badgeEtatPrecedent = () => ui.badge('État avant restauration', '#8b5cf6', { titre: 'Copie de l\'état de la base faite automatiquement avant une restauration ou un import : la restaurer annule cette opération' });

    /** Fenêtre d'attente non fermable, remplacée ensuite par un résultat. */
    function modaleAttente(titre, message) {
      return ui.modal({ titre, fermable: false, taille: 'petite', contenu: ui.chargement(message) });
    }

    // ===================================================================================
    GMAO.rendreSauvegardesAvancees = function (container) {
      injecterStyles();
      const zone = el('div', { class: 'sav' });
      container.appendChild(zone);
      let etat = null;
      let tableauDest = null; // tableau des destinations (recherche conservée lors d'un rechargement)
      let tableauHisto = null;
      let formAuto = null; // formulaire « Sauvegarde automatique » (saisie non enregistrée conservée)
      const filtresHisto = { type: '', resultat: '' };

      const modifiable = () => peutModifierDroits() && !!(etat && etat.droits && etat.droits.modifier);
      const global = () => modifiable() && !!(etat && etat.droits && etat.droits.global);
      const restaurable = () => modifiable() && !!(etat && etat.droits && etat.droits.restaurer);
      /** Gestion des destinations (ajout, modification, suppression) : réservée aux accès à tous les sites. */
      const gestion = () => modifiable() && !!(etat && etat.droits && (etat.droits.destinations !== undefined ? etat.droits.destinations : etat.droits.global));
      /** Destination que l'utilisateur peut tester et utiliser pour une sauvegarde manuelle. */
      const destUtilisable = (d) => modifiable() && !GMAO.siteLectureSeule(d.secteurId) && (d.secteurId != null || global());
      const destGerable = (d) => gestion() && destUtilisable(d);
      const siteCourantLecture = () => GMAO.siteLectureSeule(GMAO.siteCourant());
      const titre = () => el('h2', { class: 'sav-titre' }, icone('serveur'), 'Sauvegardes multi-destinations et multi-sites');

      /** Ce que l'utilisateur a saisi ou positionné sur la page, conservé lors d'un rechargement. */
      function memoriser() {
        const recherche = (t) => { const i = t ? t.el.querySelector('input[type=search]') : null; return i ? i.value : ''; };
        return { defilement: win.scrollY, rechercheDest: recherche(tableauDest), rechercheHisto: recherche(tableauHisto), saisieAuto: formAuto && formAuto.modifie() ? formAuto.valeurs() : null };
      }
      function restaurerAffichage(memo, conserverSaisie) {
        if (memo.rechercheDest && tableauDest) tableauDest.rechercher(memo.rechercheDest);
        if (memo.rechercheHisto && tableauHisto) tableauHisto.rechercher(memo.rechercheHisto);
        if (conserverSaisie && memo.saisieAuto && formAuto) formAuto.reprendre(memo.saisieAuto);
        win.scrollTo(0, memo.defilement);
      }
      /** Recharge les données puis reconstruit les cartes ; l'affichage précédent reste en place pendant le chargement. */
      async function rendre({ conserverSaisie = true } = {}) {
        const memo = etat ? memoriser() : null;
        if (!memo) {
          ui.vider(zone);
          zone.appendChild(titre());
          zone.appendChild(ui.chargement('Chargement des sauvegardes…'));
        }
        try { etat = await api.get(BASE); } catch (e) {
          ui.vider(zone);
          zone.appendChild(titre());
          zone.appendChild(ui.alerte(e.status === 403 ? 'Consultation réservée au pôle informatique (droit Système › Voir).' : 'Sauvegardes multi-sites indisponibles : ' + e.message, e.status === 403 ? 'info' : 'alerte'));
          return;
        }
        construire();
        if (memo) restaurerAffichage(memo, conserverSaisie);
      }
      function construire() {
        ui.vider(zone);
        const s = etat.serveur || {};
        const p = etat.parametres || {};
        zone.appendChild(el('div', { class: 'carte-titre', style: { marginBottom: '0' } }, titre(), ui.bouton('Actualiser', { icone: 'rafraichir', classe: 'btn-sm', onClic: () => rendre() })));
        zone.appendChild(el('p', { class: 'texte-2 texte-petit sav-intro' },
          `Ce serveur : « ${s.nom || 'GMAO'} » (version ${s.version || '—'}). Chaque sauvegarde est copiée localement puis envoyée à toutes les destinations actives : disques, clés USB, partages réseau et serveurs GMAO des autres sites (ex. Carpentras ⇄ Valréas).`));
        if (s.memoire) zone.appendChild(ui.alerte('Serveur de démonstration sans stockage sur disque : la copie locale et la réception des sauvegardes d\'autres sites sont désactivées.', 'info'));
        if (!modifiable()) zone.appendChild(ui.alerte('Consultation seule : les modifications sont réservées au pôle informatique (droit Système › Modifier).', 'info'));
        else if (!global()) zone.appendChild(ui.alerte('Votre accès est limité à vos sites : les paramètres globaux, la clé de réception, la restauration et la gestion des destinations (ajout, modification, suppression) sont réservés aux utilisateurs ayant accès à tous les sites. Vous pouvez tester les destinations de vos sites et lancer une sauvegarde vers elles.', 'info'));
        else if (GMAO.siteCourant() != null) zone.appendChild(ui.alerte(`Sélecteur de site positionné sur « ${ui.nomSecteur(GMAO.siteCourant())} » : seules les destinations de ce site et les destinations communes sont affichées et utilisées par « Sauvegarder maintenant » ; la planification automatique ne tient pas compte d'une telle sauvegarde. Choisissez « Tous les sites » dans l'en-tête pour une sauvegarde complète du serveur.`, 'info'));
        if (p.derniereExecution && p.derniereExecution.ok === false) {
          zone.appendChild(ui.alerte(frag(el('strong', null, 'Dernière sauvegarde en échec '), `(${ui.formatDateHeure(p.derniereExecution.date)}) : ${p.derniereExecution.message || ''}`), 'alerte'));
        }
        if (s.enCours) zone.appendChild(ui.alerte(s.enCours === 'restauration' ? 'Une restauration est en cours…' : 'Une sauvegarde est en cours…', 'info'));

        zone.appendChild(indicateurs());
        zone.appendChild(el('div', { class: 'grille grille-2 sav-cartes' }, carteAutomatique(), carteReception()));
        zone.appendChild(carteDestinations());
        zone.appendChild(carteRecues());
        zone.appendChild(carteRestauration());
        zone.appendChild(carteHistorique());
      }

      // ----- Cibles d'une sauvegarde manuelle (mêmes règles que le serveur) -----
      /** Destinations actives que « Sauvegarder maintenant vers toutes les destinations » utiliserait pour cet utilisateur. */
      function ciblesExecution() {
        return (etat.destinations || []).filter((d) => d.actif && destUtilisable(d));
      }
      function copieLocaleDisponible() {
        return global() && !(etat.serveur || {}).memoire && Number((etat.parametres || {}).conserverLocal) > 0;
      }
      /** Pourquoi « Sauvegarder maintenant vers toutes les destinations » n'a rien à faire. */
      function raisonRien() {
        const s = etat.serveur || {};
        const p = etat.parametres || {};
        if (siteCourantLecture()) return 'Le site sélectionné dans l\'en-tête n\'est accessible qu\'en lecture : aucune sauvegarde possible dans ce contexte';
        if (!global()) return (etat.destinations || []).some((d) => d.actif) ? 'Aucune destination active utilisable dans votre périmètre : les destinations communes à tous les sites et la copie locale sont réservées aux utilisateurs ayant accès à tous les sites' : 'Aucune destination active dans votre périmètre : demandez l\'ajout d\'une destination à un utilisateur ayant accès à tous les sites';
        if (GMAO.siteCourant() != null) return 'Aucune destination active pour le site sélectionné : choisissez « Tous les sites » dans l\'en-tête, ou rattachez une destination active à ce site';
        if (s.memoire) return 'Aucune destination active : ajoutez une destination (dossier ou serveur d\'un autre site). La copie locale est indisponible sur ce serveur de démonstration';
        return Number(p.conserverLocal) > 0 ? 'Aucune destination active : ajoutez une destination (dossier ou serveur d\'un autre site)' : 'Aucune destination active et copie locale désactivée : rien à sauvegarder';
      }

      // ----- Indicateurs -----
      function prochaine(p, actives) {
        const s = etat.serveur || {};
        let valeur, detail, couleur = '#2563eb';
        if (!p.automatique) { valeur = 'Désactivée'; detail = 'Sauvegardes manuelles uniquement'; couleur = '#6b7280'; }
        else if (s.planification === false) { valeur = 'Non planifiée'; detail = 'Serveur sans stockage (démonstration)'; couleur = '#6b7280'; }
        else if (!actives && !(p.conserverLocal > 0)) { valeur = 'Rien à sauvegarder'; detail = 'Aucune destination active ni copie locale'; couleur = '#f59e0b'; }
        else {
          const x = libelleProchaine(p.prochaineExecution);
          valeur = x.valeur;
          detail = [x.detail, libelleFrequence(p.frequenceHeures, p.heure)].filter(Boolean).join(' · ');
        }
        return ui.kpi({ label: 'Prochaine sauvegarde automatique', valeur, icone: 'horloge', couleur, detail });
      }
      /** Dernière sauvegarde réussie visible par l'utilisateur : exécution complète du serveur, historique ou dernier envoi réussi vers une destination. */
      function derniereReussieVisible() {
        const dates = [(etat.parametres || {}).derniereReussite];
        const h = (etat.historique || []).find((x) => x.type === 'sauvegarde' && x.ok);
        if (h) dates.push(h.date);
        for (const d of etat.destinations || []) if (d.derniere && d.derniere.ok && d.derniere.date) dates.push(d.derniere.date);
        return dates.filter(Boolean).sort().pop() || null;
      }
      function indicateurs() {
        const p = etat.parametres || {};
        const dests = etat.destinations || [];
        const actives = dests.filter((d) => d.actif).length;
        const nbRecues = (etat.recues || []).reduce((t, r) => t + (r.nombre || 0), 0);
        const ok = derniereReussieVisible();
        const complete = p.derniereReussite || null;
        let detail;
        if (!ok) detail = 'Lancez une première sauvegarde';
        else if (!global()) detail = ui.formatDateHeure(ok);
        else if (complete && complete >= ok) detail = `${ui.formatDateHeure(ok)} · sauvegarde complète du serveur`;
        else detail = `${ui.formatDateHeure(ok)} · dernière sauvegarde complète du serveur : ${complete ? ui.relatif(complete) : 'jamais'}`;
        return el('div', { class: 'grille grille-4 sav-kpis' },
          ui.kpi({ label: 'Dernière sauvegarde réussie', valeur: ok ? ui.relatif(ok) : 'Jamais', icone: 'check', couleur: ok ? '#16a34a' : '#dc2626', detail }),
          prochaine(p, actives),
          ui.kpi({ label: 'Destinations actives', valeur: `${actives} / ${dests.length}`, icone: 'dossier', couleur: actives ? '#0f766e' : '#f59e0b', detail: actives ? `${dests.filter((d) => d.actif && d.type === 'serveur').length} serveur(s) d'autres sites` : 'Ajoutez au moins une destination externe' }),
          ui.kpi({ label: 'Sauvegardes reçues', valeur: String(nbRecues), icone: 'import', couleur: '#0891b2', detail: p.accepterReception ? `Réception active · ${(etat.recues || []).length} site(s)` : 'Réception désactivée', onClic: () => { const c = doc.getElementById('sav-carte-recues'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }));
      }

      // ----- Carte : sauvegarde automatique -----
      function carteAutomatique() {
        const p = etat.parametres || {};
        const dis = !global();
        // Interrupteur principal : prend effet immédiatement, comme celui de la réception dans la carte voisine
        const inter = el('div', { class: 'interrupteur' + (p.automatique ? ' actif' : ''), role: 'switch', tabindex: 0, 'aria-checked': p.automatique ? 'true' : 'false', title: dis ? 'Réservé au pôle informatique (accès à tous les sites)' : '', style: dis ? { opacity: '0.6', cursor: 'not-allowed' } : null });
        const bascule = async () => {
          if (dis) return;
          const nouveau = !inter.classList.contains('actif');
          try { await api.put(BASE + '/parametres', { automatique: nouveau }); toast(nouveau ? 'Sauvegarde automatique activée' : 'Sauvegarde automatique désactivée', 'succes'); rendre(); } catch (e) { erreur(e); }
        };
        inter.addEventListener('click', bascule);
        inter.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); bascule(); } });

        const freqs = FREQUENCES.slice();
        if (!freqs.some((f) => f.value === p.frequenceHeures)) freqs.push({ value: p.frequenceHeures, label: libelleFrequence(p.frequenceHeures) });
        // Saisie non enregistrée : signalée, et conservée si la page est rechargée par une autre action
        const indicateur = el('span', { class: 'sav-modifie masque' }, ui.badge('Modifications non enregistrées', '#f59e0b'));
        const majModif = () => { indicateur.classList.toggle('masque', !modifie()); };
        const f = ui.form({ colonnes: 2, valeurs: {
          frequenceHeures: p.frequenceHeures || 24, heure: p.heure || '22:00', conserverLocal: p.conserverLocal == null ? 30 : p.conserverLocal,
          compresser: p.compresser !== false, chiffrer: !!p.chiffrer, nomServeur: p.nomServeur || '',
        }, champs: [
          { nom: 'frequenceHeures', label: 'Fréquence', type: 'select', options: freqs, disabled: dis, onChange: majModif },
          { nom: 'heure', label: 'Heure de la sauvegarde', type: 'heure', disabled: dis, aide: 'Heure de référence pour une sauvegarde quotidienne ou espacée de plusieurs jours', afficherSi: (v) => Number(v.frequenceHeures) >= 24, onChange: majModif },
          { nom: 'conserverLocal', label: 'Copies locales conservées', type: 'nombre', min: 0, max: 365, step: 1, disabled: dis, aide: '0 = aucune copie locale', requis: true, onChange: majModif },
          { nom: 'nomServeur', label: 'Nom de ce serveur pour les autres sites', type: 'texte', disabled: dis, placeholder: (etat.serveur || {}).nom || '', aide: 'Facultatif (par défaut : nom du site principal)', onChange: majModif },
          { nom: 'compresser', label: 'Compresser (gzip, environ 10 fois plus petit)', type: 'interrupteur', disabled: dis, onChange: majModif },
          { nom: 'chiffrer', label: 'Chiffrer (AES-256)', type: 'interrupteur', disabled: dis, onChange: majModif },
          { nom: 'motDePasseChiffrement', label: p.motDePasseDefini ? 'Nouveau mot de passe de chiffrement' : 'Mot de passe de chiffrement', type: 'mdp', disabled: dis,
            placeholder: p.motDePasseDefini ? '•••••••• (inchangé si vide)' : 'Au moins 8 caractères', afficherSi: (v) => v.chiffrer && !dis, onChange: majModif,
            valider: (v, vals) => (vals.chiffrer && !p.motDePasseDefini && !v ? 'Mot de passe obligatoire pour chiffrer' : (v && v.length < 8 ? 'Au moins 8 caractères' : '')) },
          { nom: 'confirmationMdp', label: 'Confirmer le mot de passe', type: 'mdp', disabled: dis, afficherSi: (v) => v.chiffrer && !dis, onChange: majModif,
            valider: (v, vals) => (vals.motDePasseChiffrement && v !== vals.motDePasseChiffrement ? 'Les mots de passe ne correspondent pas' : '') },
          { nom: 'avertissement', type: 'html', afficherSi: (v) => v.chiffrer, rendu: () => ui.alerte(frag(icone('alerte'), ' ', el('strong', null, 'Conservez ce mot de passe en lieu sûr : '), 'sans ce mot de passe, les sauvegardes chiffrées sont irrécupérables. Il est mémorisé sur ce serveur (en écriture seule, jamais réaffiché) et devra être saisi pour restaurer une sauvegarde chiffrée sur un autre serveur.'), 'alerte') },
        ] });
        if (dis) f.el.classList.add('sav-lecture');
        const lire = () => { try { return JSON.stringify(f.valeurs()); } catch (e) { return ''; } };
        const initiales = lire();
        const modifie = () => lire() !== initiales;
        f.el.addEventListener('input', majModif);
        formAuto = {
          valeurs: () => f.valeurs(), modifie,
          reprendre(v) { for (const [k, x] of Object.entries(v || {})) f.set(k, x); f.rafraichirVisibilite(); majModif(); },
        };
        const enregistrer = async () => {
          if (!f.valider()) return;
          const v = f.valeurs();
          const corps = { frequenceHeures: Number(v.frequenceHeures), heure: v.heure || p.heure || '22:00', conserverLocal: Number(v.conserverLocal), compresser: v.compresser, chiffrer: v.chiffrer, nomServeur: v.nomServeur || '' };
          if (v.chiffrer && v.motDePasseChiffrement) corps.motDePasseChiffrement = v.motDePasseChiffrement;
          try { await api.put(BASE + '/parametres', corps); toast('Paramètres de sauvegarde enregistrés', 'succes'); rendre({ conserverSaisie: false }); } catch (e) { erreur(e); }
        };
        const actions = global() ? el('div', { class: 'sav-actions-carte mt' },
          ui.bouton('Enregistrer les paramètres', { icone: 'check', classe: 'btn-primaire', onClic: enregistrer }),
          indicateur,
          p.motDePasseDefini && !p.chiffrer ? ui.bouton('Oublier le mot de passe', { icone: 'supprimer', classe: 'btn-sm btn-lien', onClic: async () => {
            if (!(await ui.confirm({ titre: 'Mot de passe de chiffrement', message: 'Supprimer le mot de passe mémorisé ? Les sauvegardes chiffrées existantes ne pourront être restaurées qu\'en ressaisissant ce mot de passe.', okLabel: 'Supprimer', danger: true }))) return;
            try { await api.put(BASE + '/parametres', { supprimerMotDePasse: true }); toast('Mot de passe supprimé', 'succes'); rendre(); } catch (e) { erreur(e); }
          } }) : null) : null;
        const s = etat.serveur || {};
        const locales = etat.locales || [];
        const info = el('div', { class: 'texte-2 texte-petit mt' },
          s.dossierLocal ? frag('Copies locales : ', el('code', null, s.dossierLocal), ` — ${locales.length} sauvegarde${locales.length > 1 ? 's' : ''}`) : 'Copie locale indisponible (serveur sans stockage)');
        const contenu = frag(
          el('div', { class: 'sav-ligne' }, inter, el('span', null, 'Sauvegarde automatique activée'), dis ? null : el('span', { class: 'texte-2 texte-petit' }, '(prend effet immédiatement)')),
          el('div', { class: 'sav-separateur' }),
          dis ? null : el('p', { class: 'texte-2 texte-petit', style: { margin: '0 0 8px' } }, 'Les réglages ci-dessous s\'appliquent au clic sur « Enregistrer les paramètres ».'),
          f.el, actions, info);
        return ui.carte('Sauvegarde automatique', contenu, { actions: [ui.badge(p.automatique ? 'Active' : 'Désactivée', p.automatique ? '#16a34a' : '#6b7280')] });
      }

      // ----- Carte : réception -----
      function carteReception() {
        const p = etat.parametres || {};
        const s = etat.serveur || {};
        const dis = !global() || !!s.memoire;
        const inter = el('div', { class: 'interrupteur' + (p.accepterReception ? ' actif' : ''), role: 'switch', tabindex: 0, 'aria-checked': p.accepterReception ? 'true' : 'false', title: s.memoire ? 'Indisponible sur un serveur sans stockage' : (dis ? 'Réservé au pôle informatique (accès à tous les sites)' : ''), style: dis ? { opacity: '0.6', cursor: 'not-allowed' } : null });
        const bascule = async () => {
          if (dis) return;
          const nouveau = !inter.classList.contains('actif');
          if (nouveau && !p.cleReceptionDefinie && !(await ui.confirm({ titre: 'Réception des sauvegardes', message: 'Aucune clé de réception n\'est encore définie : générez-en une juste après pour que les autres sites puissent envoyer leurs sauvegardes. Activer la réception ?', okLabel: 'Activer' }))) return;
          try { await api.put(BASE + '/parametres', { accepterReception: nouveau }); toast(nouveau ? 'Réception des sauvegardes activée' : 'Réception des sauvegardes désactivée', 'succes'); rendre(); } catch (e) { erreur(e); }
        };
        inter.addEventListener('click', bascule);
        inter.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); bascule(); } });

        const cle = el('div', { class: 'sav-ligne' },
          el('span', { class: 'texte-gras' }, 'Clé de réception :'),
          p.cleReceptionDefinie ? ui.badge('Définie', '#16a34a') : ui.badge('Aucune clé', '#f59e0b'),
          p.cleReceptionDefinie && p.cleReceptionDate ? el('span', { class: 'texte-2 texte-petit', title: dateTitre(p.cleReceptionDate) }, `générée ${ui.relatif(p.cleReceptionDate)}`) : null,
          el('span', { style: { flex: '1' } }),
          global() ? ui.bouton(p.cleReceptionDefinie ? 'Générer une nouvelle clé' : 'Générer la clé', { icone: 'cle', classe: 'btn-sm' + (p.cleReceptionDefinie ? '' : ' btn-primaire'), onClic: genererCle }) : null,
          global() && p.cleReceptionDefinie ? ui.bouton('Révoquer', { icone: 'fermer', classe: 'btn-sm btn-lien', onClic: async () => {
            if (!(await ui.confirm({ titre: 'Révoquer la clé', message: 'Les autres sites ne pourront plus envoyer leurs sauvegardes sur ce serveur tant qu\'une nouvelle clé n\'aura pas été générée et saisie chez eux. Continuer ?', okLabel: 'Révoquer', danger: true }))) return;
            try { await api.del(BASE + '/cle-reception'); toast('Clé de réception révoquée', 'succes'); rendre(); } catch (e) { erreur(e); }
          } }) : null);

        const adresses = el('div', { class: 'sav-adresses' }, (s.adresses || []).map((a) => el('div', { class: 'sav-adresse' }, el('code', null, a), boutonCopier(a))));
        // Serveur en HTTPS (poste serveur de l'application de bureau) : l'autre site épingle ce certificat avant tout envoi
        const chiffre = s.protocole === 'https' && !!s.empreinte;
        const empreinte = chiffre ? frag(
          el('div', { class: 'sav-ligne', style: { marginTop: '10px' } }, el('span', { class: 'texte-gras' }, 'Empreinte du certificat HTTPS de ce serveur :')),
          el('div', { class: 'sav-adresse', style: { marginTop: '6px' } }, empreinteEl(s.empreinte), boutonCopier(s.empreinte, 'Copier l\'empreinte')),
          el('div', { class: 'aide texte-2 texte-petit', style: { marginTop: '6px' } }, 'Ce serveur répond en HTTPS avec son propre certificat : sur l\'autre site, saisissez cette empreinte dans la destination (champ « Empreinte du certificat HTTPS ») ou confirmez-la lors du premier test. Rien n\'est envoyé avant cette confirmation.')) : null;
        const conserver = el('input', { type: 'number', min: 1, max: 365, step: 1, value: String(p.conserverRecues || 10), disabled: dis, style: { width: '80px', minWidth: '0' }, 'aria-label': 'Sauvegardes reçues conservées par site' });
        const ligneConserver = el('div', { class: 'sav-ligne' },
          el('label', { class: 'texte-petit texte-gras' }, 'Conserver par site :'), conserver, el('span', { class: 'texte-2 texte-petit' }, 'sauvegardes'),
          !dis ? ui.bouton('Appliquer', { classe: 'btn-sm', onClic: async () => {
            const n = Number(conserver.value);
            if (!Number.isInteger(n) || n < 1 || n > 365) { toast('Indiquez un nombre entier entre 1 et 365', 'alerte'); return; }
            try { await api.put(BASE + '/parametres', { conserverRecues: n }); toast('Rétention des sauvegardes reçues enregistrée', 'succes'); rendre(); } catch (e) { erreur(e); }
          } }) : null);

        const contenu = frag(
          el('p', { class: 'texte-2 texte-petit', style: { marginTop: '0' } }, 'Ce serveur peut conserver une copie des sauvegardes des autres sites (ex. Valréas sauvegarde chez Carpentras et inversement). Les sauvegardes reçues ne sont jamais importées automatiquement.'),
          el('div', { class: 'sav-ligne' }, inter, el('span', null, 'Accepter les sauvegardes envoyées par d\'autres sites'), s.memoire ? el('span', { class: 'texte-2 texte-petit' }, '(indisponible sans stockage)') : null),
          el('div', { class: 'sav-separateur' }),
          cle,
          el('div', { class: 'sav-ligne' }, el('span', { class: 'texte-gras' }, 'Adresse à communiquer à l\'autre site :')),
          adresses,
          el('div', { class: 'aide texte-2 texte-petit', style: { marginTop: '6px' } }, 'Le serveur doit être joignable depuis l\'autre site (réseau d\'entreprise ou VPN, port autorisé dans le pare-feu Windows).'),
          empreinte,
          el('div', { class: 'sav-separateur' }),
          ligneConserver);
        return ui.carte('Recevoir les sauvegardes d\'autres sites', contenu, { actions: [ui.badge(p.accepterReception ? 'Réception active' : 'Réception désactivée', p.accepterReception ? '#16a34a' : '#6b7280')] });
      }

      async function genererCle() {
        const p = etat.parametres || {};
        if (p.cleReceptionDefinie && !(await ui.confirm({ titre: 'Nouvelle clé de réception', message: 'L\'ancienne clé ne fonctionnera plus : chaque site qui envoie ses sauvegardes ici devra saisir la nouvelle clé. Continuer ?', okLabel: 'Générer', danger: true }))) return;
        let r;
        try { r = await api.post(BASE + '/cle-reception/generer'); } catch (e) { erreur(e); return; }
        const s = etat.serveur || {};
        const adresses = s.adresses || [];
        const chiffre = s.protocole === 'https' && !!s.empreinte;
        ui.modal({
          titre: 'Clé de réception des sauvegardes', fermable: false,
          contenu: frag(
            ui.alerte(frag(el('strong', null, 'Copiez cette clé maintenant : '), 'elle ne sera plus jamais affichée (seule son empreinte est conservée sur ce serveur).'), 'alerte'),
            el('div', { class: 'sav-cle', id: 'sav-cle-generee' }, r.cle),
            el('div', { class: 'sav-ligne' }, boutonCopier(r.cle, 'Copier la clé')),
            el('div', { class: 'sav-separateur' }),
            el('div', { class: 'texte-gras', style: { marginBottom: '6px' } }, 'Sur le serveur GMAO de l\'autre site :'),
            el('div', { class: 'sav-etape' }, el('span', { class: 'sav-etape-num' }, '1'), el('div', null, 'Système & informatique › Base de données & sauvegardes › Destinations › « Ajouter une destination », type « Serveur GMAO d\'un autre site ».')),
            el('div', { class: 'sav-etape' }, el('span', { class: 'sav-etape-num' }, '2'), el('div', null, 'Adresse de ce serveur : ', adresses.length ? el('code', null, adresses[0]) : '—', adresses.length > 1 ? el('span', { class: 'texte-2 texte-petit' }, ` (ou ${adresses.slice(1).join(', ')})`) : null,
              chiffre ? el('div', { style: { marginTop: '6px' } }, 'Empreinte du certificat HTTPS de ce serveur, à confirmer sur l\'autre site : ', empreinteEl(s.empreinte)) : null)),
            el('div', { class: 'sav-etape' }, el('span', { class: 'sav-etape-num' }, '3'), el('div', null, 'Collez la clé ci-dessus, enregistrez puis cliquez sur « Tester ».')),
            p.accepterReception || s.memoire ? null : ui.alerte('Pensez à activer « Accepter les sauvegardes envoyées par d\'autres sites ».', 'info')),
          boutons: [{ label: 'J\'ai copié la clé', classe: 'btn-primaire', icone: 'check' }],
          onFermer: () => rendre(),
        });
        toast('Nouvelle clé de réception générée', 'succes');
      }

      function carteRecues() {
        const recues = etat.recues || [];
        const total = recues.reduce((t, r) => t + r.nombre, 0);
        const cont = el('div', { id: 'sav-recues' });
        const carte = ui.carte(`Sauvegardes reçues des autres sites (${total})`, cont);
        carte.id = 'sav-carte-recues';
        if (!recues.length) {
          cont.appendChild(el('p', { class: 'texte-2 texte-petit', style: { margin: '0' } }, (etat.parametres || {}).accepterReception
            ? 'Aucune sauvegarde reçue pour le moment. Communiquez l\'adresse et la clé de réception de ce serveur à l\'autre site.'
            : 'Aucune sauvegarde reçue. Activez la réception dans la carte « Recevoir les sauvegardes d\'autres sites » pour conserver ici une copie des sauvegardes d\'un autre site.'));
          return carte;
        }
        cont.appendChild(el('p', { class: 'texte-2 texte-petit', style: { margin: '0' } }, 'Copies conservées pour le compte des autres sites. En cas de sinistre sur un site, téléchargez la plus récente et restaurez-la sur son nouveau serveur (« Restaurer depuis un fichier… »).'));
        for (const r of recues) {
          const tableau = ui.table({
            compact: true, recherche: false, pagination: false, vide: 'Aucun fichier',
            colonnes: [
              { cle: 'nom', label: 'Fichier', rendu: (f) => el('span', { class: 'sav-fichier', title: f.sha256 ? 'SHA-256 : ' + f.sha256 : 'Empreinte absente' }, f.nom) },
              { cle: 'sha256', label: 'Empreinte SHA-256', rendu: (f) => (f.sha256 ? el('span', { class: 'sav-mono', title: f.sha256 }, empreinteCourte(f.sha256)) : el('span', { class: 'texte-alerte texte-petit' }, 'absente')) },
              { cle: 'date', label: 'Sauvegarde du', type: 'datetime' },
              { cle: 'taille', label: 'Taille', aligner: 'droite', rendu: (f) => formatTaille(f.taille), valeurTri: (f) => f.taille },
              { cle: 'format', label: 'Format', tri: false, rendu: badgesFormat },
            ],
            lignes: r.fichiers,
            actions: [
              { icone: 'rafraichir', titre: 'Restaurer cette sauvegarde sur ce serveur', visible: () => restaurable(), onClic: (f) => restaurer({ source: 'recue', site: r.site, fichier: f.nom, chiffre: f.chiffre, provenance: r.nom }) },
              { icone: 'export', titre: 'Télécharger', visible: () => restaurable(), onClic: (f) => api.telecharger(`${BASE}/telecharger?source=recue&site=${encodeURIComponent(r.site)}&fichier=${encodeURIComponent(f.nom)}`, f.nom).catch(erreur) },
              { icone: 'supprimer', titre: 'Supprimer cette sauvegarde reçue', classe: 'texte-danger', visible: () => restaurable(), onClic: async (f) => {
                if (!(await ui.confirm({ titre: 'Supprimer la sauvegarde reçue', message: `Supprimer définitivement « ${f.nom} » reçue de « ${r.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
                try { await api.del(`${BASE}/recues/${encodeURIComponent(r.site)}/${encodeURIComponent(f.nom)}`); toast('Sauvegarde reçue supprimée', 'succes'); rendre(); } catch (e) { erreur(e); }
              } },
            ],
          });
          cont.appendChild(el('div', { class: 'sav-site' },
            el('div', { class: 'sav-site-entete' }, icone('site'), el('span', { class: 'sav-site-nom' }, r.nom), ui.badge(`${r.nombre} fichier${r.nombre > 1 ? 's' : ''}`), el('span', { class: 'texte-2 texte-petit' }, formatTaille(r.tailleTotale)),
              el('span', { style: { flex: '1' } }), r.derniereReception ? el('span', { class: 'texte-2 texte-petit', title: dateTitre(r.derniereReception) }, `Dernière réception ${ui.relatif(r.derniereReception)}`) : null),
            el('div', { class: 'sav-site-corps' }, tableau.el)));
        }
        return carte;
      }

      // ----- Carte : destinations -----
      function carteDestinations() {
        const dests = etat.destinations || [];
        const typeLibelle = (d) => (d.type === 'serveur' ? 'Serveur GMAO d\'un autre site' : 'Dossier');
        const siteTexte = (d) => (d.secteurId == null ? 'Tous les sites' : (ui.cheminSecteur(d.secteurId) || ui.nomSecteur(d.secteurId)));
        const emplacement = (d) => (d.type === 'serveur' ? d.url : d.chemin);
        const colonnesExport = [
          { label: 'Destination', exportValeur: (d) => d.nom }, { label: 'Type', exportValeur: typeLibelle }, { label: 'Emplacement', exportValeur: emplacement },
          { label: 'Site', exportValeur: siteTexte }, { label: 'Copies conservées', exportValeur: (d) => String(d.conserver) },
          { label: 'Dernière sauvegarde', exportValeur: (d) => (d.derniere ? ui.formatDateHeure(d.derniere.date) : 'Jamais') },
          { label: 'Résultat', exportValeur: (d) => (d.derniere ? (d.derniere.ok ? 'OK' : 'Échec : ' + (d.derniere.message || '')) : '') },
          { label: 'État', exportValeur: (d) => (d.actif ? 'Active' : 'Désactivée') }, { label: 'Notes', exportValeur: (d) => d.notes || '' },
        ];
        let tableau = null;
        const exporter = el('button', { type: 'button', class: 'btn btn-sm', onclick: () => ui.exportCsv('destinations-sauvegarde.csv', colonnesExport, tableau ? tableau.filtrees() : dests) }, icone('export'), 'Exporter CSV');
        tableau = ui.table({
          lignes: dests, recherche: 'Rechercher une destination…', pagination: false, outils: [el('span', { class: 'espace' }), exporter],
          vide: 'Aucune destination : ajoutez un dossier (disque, clé USB, partage réseau) ou le serveur GMAO d\'un autre site.',
          ligneClasse: (d) => (d.actif ? '' : 'texte-2'),
          rechercheDans: (d) => [d.nom, d.notes, typeLibelle(d), siteTexte(d), emplacement(d)].join(' '),
          colonnes: [
            { cle: 'nom', label: 'Destination', rendu: (d) => el('div', { class: 'sav-nom-dest' + (d.type === 'serveur' ? ' serveur' : '') }, icone(d.type === 'serveur' ? 'serveur' : 'dossier'),
              el('div', { style: { minWidth: '0' } },
                el('div', { class: 'cellule-principale' }, el('span', null, d.nom), d.demo ? ui.badge('Exemple') : null),
                el('div', { class: 'cellule-secondaire' }, d.type === 'serveur' ? 'Autre site' : 'Dossier', ' · ', siteTexte(d)),
                d.notes ? el('div', { class: 'cellule-secondaire sav-notes', title: d.notes }, d.notes) : null)) },
            { cle: 'emplacement', label: 'Emplacement', largeur: '24%', rendu: (d) => el('div', null, renduChemin(emplacement(d)), d.type === 'serveur' ? el('div', { class: 'cellule-secondaire' }, d.cleDefinie ? 'Clé de réception enregistrée' : 'Clé manquante', /^https:/i.test(d.url || '') ? (d.empreinte ? ' · certificat confirmé' : ' · certificat à confirmer') : '') : null), valeurTri: emplacement },
            { cle: 'conserver', label: 'Copies', aligner: 'droite', rendu: (d) => String(d.conserver), valeurTri: (d) => d.conserver },
            { cle: 'derniere', label: 'Dernière sauvegarde', rendu: cellDerniere, valeurTri: (d) => (d.derniere ? d.derniere.date : '') },
            { cle: 'actif', label: 'État', rendu: (d) => frag(d.actif ? ui.badge('Active', '#16a34a') : ui.badge('Désactivée', '#6b7280'), GMAO.siteLectureSeule(d.secteurId) ? frag(' ', ui.badge('Lecture seule', '#f59e0b', { contour: true })) : null) },
          ],
          actions: [
            { icone: 'check', titre: 'Tester la destination', visible: destUtilisable, onClic: tester },
            { icone: 'sauvegarde', titre: 'Sauvegarder maintenant vers cette destination', visible: destUtilisable, onClic: (d) => executer(d) },
            { icone: 'liste', titre: 'Voir les fichiers', onClic: voirFichiers },
            { icone: 'modifier', titre: 'Modifier', visible: destGerable, onClic: (d) => formulaireDestination(d) },
            { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: destGerable, onClic: supprimer },
          ],
        });
        tableauDest = tableau;
        const aide = el('details', { class: 'sav-aide' },
          el('summary', null, 'Exemples de destinations'),
          el('ul', null,
            el('li', null, el('code', null, 'D:\\Sauvegardes\\GMAO'), ' — second disque du serveur (protège contre une erreur de manipulation, pas contre la perte du disque principal).'),
            el('li', null, el('code', null, 'E:\\GMAO'), ' — clé USB ou disque externe : branchez-le avant l\'heure de sauvegarde et rangez-le hors du local serveur.'),
            el('li', null, el('code', null, '\\\\NAS\\GMAO'), ' — partage réseau (NAS) : le compte Windows qui exécute la GMAO doit pouvoir y écrire.'),
            el('li', null, el('code', null, 'http://srv-valreas:8585'), ' — serveur GMAO d\'un autre site : saisissez son adresse et la clé de réception fournie par cet autre site (carte « Recevoir les sauvegardes d\'autres sites » de son écran). En https://, l\'empreinte de son certificat est confirmée au premier test.')),
          el('div', null, 'Règle du 3-2-1 : trois copies, sur deux supports différents, dont une hors du site.'));
        // « Sauvegarder maintenant » n'est actif que si au moins une cible existe pour cet utilisateur
        const rien = modifiable() && !ciblesExecution().length && !copieLocaleDisponible();
        const actions = modifiable() ? [
          gestion() && !siteCourantLecture() ? ui.bouton('Ajouter une destination', { icone: 'plus', classe: 'btn-sm', onClic: () => formulaireDestination(null) }) : null,
          ui.bouton('Sauvegarder maintenant vers toutes les destinations', { icone: 'sauvegarde', classe: 'btn-sm btn-primaire', disabled: rien, titre: rien ? raisonRien() : '', onClic: () => executer(null) }),
        ] : null;
        return ui.carte(`Destinations (${dests.length})`, frag(rien ? el('p', { class: 'texte-2 texte-petit sav-rien' }, icone('info'), el('span', null, raisonRien())) : null, el('div', { class: 'sav-dest-tableau' }, tableau.el), aide), { actions });
      }

      function formulaireDestination(d) {
        const edition = !!d;
        // Seuls les sites modifiables sont proposés ; « Tous les sites » est réservé aux accès à tous les sites
        const modifiables = ui.optionsSecteurs({ typeSite: true }).filter((o) => !GMAO.siteLectureSeule(o.value));
        const sitesOptions = (global() ? [{ value: '', label: 'Tous les sites (destination commune)' }] : []).concat(modifiables);
        if (edition && d.secteurId != null && !sitesOptions.some((o) => String(o.value) === String(d.secteurId))) sitesOptions.push({ value: d.secteurId, label: ui.cheminSecteur(d.secteurId) || ui.nomSecteur(d.secteurId) });
        if (!sitesOptions.length) { toast('Aucun site modifiable dans votre périmètre : impossible d\'ajouter une destination', 'alerte'); return; }
        const courant = GMAO.siteCourant();
        const siteDefaut = courant != null && modifiables.some((o) => Number(o.value) === Number(courant)) ? courant : (global() ? '' : modifiables[0].value);
        const cleConnue = edition && d.cleDefinie && d.type === 'serveur';
        const typeInitial = edition ? d.type : 'dossier';
        const estHttps = (v) => /^https:/i.test(String(v.url || '').trim());
        ui.formModal({
          titre: edition ? `Modifier la destination « ${d.nom} »` : 'Nouvelle destination de sauvegarde', taille: 'large',
          valeurs: edition ? { nom: d.nom, type: d.type, chemin: d.chemin, url: d.url, empreinte: d.empreinte || '', conserver: d.conserver, secteurId: d.secteurId == null ? '' : d.secteurId, actif: d.actif, notes: d.notes } : { type: 'dossier', conserver: 10, actif: true, secteurId: siteDefaut },
          champs: [
            { nom: 'nom', label: 'Nom', type: 'texte', requis: true, placeholder: 'Ex. NAS du service informatique', maxLength: 80 },
            { nom: 'secteurId', label: 'Site', type: 'select', options: sitesOptions, aide: 'Site où se trouve la destination (filtre multi-site)' },
            { nom: 'type', label: 'Type de destination', type: 'radio', pleineLargeur: true, options: [{ value: 'dossier', label: 'Dossier : disque, clé USB ou partage réseau' }, { value: 'serveur', label: 'Serveur GMAO d\'un autre site' }] },
            { nom: 'chemin', label: 'Chemin du dossier', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'D:\\Sauvegardes\\GMAO', suggestions: ['D:\\Sauvegardes\\GMAO', 'E:\\GMAO', '\\\\NAS\\GMAO'],
              aide: 'Exemples : D:\\Sauvegardes\\GMAO (disque), E:\\GMAO (clé USB), \\\\NAS\\GMAO (partage réseau). Le dossier est créé s\'il n\'existe pas.',
              afficherSi: (v) => v.type === 'dossier' },
            { nom: 'url', label: 'Adresse du serveur GMAO de l\'autre site', type: 'texte', requis: true, placeholder: 'http://srv-valreas:8585',
              aide: 'Adresse affichée sur l\'autre site dans « Recevoir les sauvegardes d\'autres sites »',
              afficherSi: (v) => v.type === 'serveur', onInput: (v, f) => f.rafraichirVisibilite(),
              valider: (v) => (v && !/^https?:\/\/[^\s/]+/i.test(String(v).trim()) ? 'L\'adresse doit commencer par http:// ou https://' : '') },
            { nom: 'cle', label: 'Clé de réception fournie par l\'autre site', type: 'mdp', requis: !cleConnue, placeholder: cleConnue ? '•••••••• (inchangée si vide)' : 'Collez la clé générée sur l\'autre site',
              aide: 'Générée sur le serveur de l\'autre site (bouton « Générer la clé »)', afficherSi: (v) => v.type === 'serveur',
              valider: (v) => (v && v.trim().length < 16 ? 'Clé trop courte : copiez la clé complète' : '') },
            { nom: 'empreinte', label: 'Empreinte du certificat HTTPS', type: 'texte', pleineLargeur: true, placeholder: 'AB:CD:EF:… (64 caractères hexadécimaux)',
              aide: 'Adresse https:// (poste serveur de l\'application de bureau) : empreinte SHA-256 du certificat, affichée sur l\'autre site dans « Recevoir les sauvegardes d\'autres sites ». Laissez vide pour la relever au premier test, puis confirmez-la : rien n\'est envoyé avant.',
              afficherSi: (v) => v.type === 'serveur' && estHttps(v),
              valider: (v) => (v && !/^[0-9a-f]{64}$/i.test(String(v).replace(/[^0-9a-f]/gi, '')) ? 'Empreinte invalide : 64 caractères hexadécimaux, telle qu\'affichée sur l\'autre site' : '') },
            { nom: 'conserver', label: 'Sauvegardes conservées', type: 'nombre', min: 1, max: 365, step: 1, requis: true, aide: 'Les plus anciennes sauvegardes de ce serveur sont supprimées au-delà' },
            { nom: 'actif', label: 'Destination active (utilisée par les sauvegardes automatiques)', type: 'interrupteur' },
            { nom: 'notes', label: 'Notes', type: 'texte_long', lignes: 2, placeholder: 'Ex. clé USB échangée chaque vendredi, rangée au coffre' },
          ],
          submitLabel: edition ? 'Enregistrer et tester' : 'Ajouter et tester',
          onSubmit: async (v, modal) => {
            const corps = { nom: String(v.nom || '').trim(), type: v.type || typeInitial, conserver: Number(v.conserver), actif: !!v.actif, notes: v.notes || '', secteurId: v.secteurId === '' || v.secteurId == null ? null : Number(v.secteurId) };
            if (corps.type === 'dossier') corps.chemin = String(v.chemin || '').trim();
            else {
              corps.url = String(v.url || '').trim();
              if (v.cle) corps.cle = v.cle.trim();
              corps.empreinte = estHttps(v) ? String(v.empreinte || '').trim() : '';
            }
            const res = edition ? await api.put(`${BASE}/destinations/${d.id}`, corps) : await api.post(BASE + '/destinations', corps);
            // Destination enregistrée : la fenêtre se ferme et le test s'affiche dans sa propre fenêtre d'attente
            modal.fermer();
            toast(`Destination ${edition ? 'enregistrée' : 'ajoutée'} : test en cours…`, 'succes');
            rendre();
            tester(res);
            return undefined;
          },
        });
      }

      async function tester(d) {
        const m = modaleAttente('Test de la destination', `Test de « ${d.nom} »…`);
        let r;
        try { r = await api.post(`${BASE}/destinations/${d.id}/tester`); } catch (e) { m.fermer(); erreur(e); return; }
        m.setTitre(`Test de « ${d.nom} »`);
        m.boite.classList.remove('petite');
        ui.vider(m.corps);
        m.corps.appendChild(ui.alerte(frag(el('strong', null, r.ok ? 'Destination opérationnelle. ' : 'Échec du test. '), r.message || ''), r.ok ? 'ok' : 'alerte'));
        m.corps.appendChild(ui.details([
          { label: 'Emplacement', valeur: renduChemin(d.type === 'serveur' ? d.url : d.chemin) },
          r.site ? { label: 'Site distant', valeur: r.site } : null,
          r.version ? { label: 'Version GMAO distante', valeur: r.version } : null,
          r.espaceLibre != null ? { label: 'Espace libre', valeur: formatTaille(r.espaceLibre) } : null,
          d.type === 'serveur' && d.empreinte ? { label: 'Certificat HTTPS', valeur: frag('Empreinte confirmée : ', empreinteEl(d.empreinte)) } : null,
          { label: 'Durée du test', valeur: formatDureeMs(r.dureeMs) },
        ]));
        const boutons = [{ label: 'Fermer', classe: r.code ? '' : 'btn-primaire' }];
        const majPuisRetester = async (corps, message) => {
          const maj = await api.put(`${BASE}/destinations/${d.id}`, corps);
          toast(message, 'succes');
          rendre();
          tester(maj);
        };
        // Serveur distant en HTTPS (application de bureau) : bascule d'adresse et confirmation de l'empreinte du certificat
        if (r.code === 'REDIRECTION_HTTPS' && r.adresseHttps && destGerable(d)) {
          m.corps.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Ce serveur n\'accepte que les connexions chiffrées : son certificat devra ensuite être confirmé par son empreinte.'));
          boutons.unshift({ label: 'Utiliser l\'adresse https://', classe: 'btn-primaire', icone: 'check', onClic: () => majPuisRetester({ url: r.adresseHttps }, 'Adresse de la destination mise à jour') });
        }
        if (r.code === 'EMPREINTE_NON_CONFIRMEE' && r.empreintePresentee && destGerable(d)) {
          m.corps.appendChild(el('div', { class: 'mt' },
            el('div', { class: 'texte-gras' }, 'Empreinte du certificat présenté par le serveur distant :'),
            el('div', { style: { margin: '6px 0' } }, empreinteEl(r.empreintePresentee)),
            el('p', { class: 'texte-2 texte-petit' }, 'Comparez-la avec l\'empreinte affichée sur le poste serveur de l\'autre site (carte « Recevoir les sauvegardes d\'autres sites »). Si elles sont identiques, confirmez-la : la clé de réception et les sauvegardes ne seront envoyées qu\'à ce certificat.')));
          boutons.unshift({ label: 'Confirmer cette empreinte', classe: 'btn-primaire', icone: 'check', onClic: () => majPuisRetester({ empreinte: r.empreintePresentee }, 'Empreinte du certificat confirmée') });
        }
        if (r.code === 'EMPREINTE_DIFFERENTE' && r.empreintePresentee && destGerable(d)) {
          m.corps.appendChild(el('div', { class: 'mt' },
            ui.alerte(frag(el('strong', null, 'Attention : '), 'le certificat présenté ne correspond pas à l\'empreinte confirmée ; rien n\'a été envoyé. Ne remplacez l\'empreinte que si le poste serveur de l\'autre site a réellement été réinstallé, après vérification auprès de son pôle informatique.'), 'danger'),
            el('div', { class: 'texte-gras' }, 'Empreinte confirmée :'), el('div', { style: { margin: '4px 0 8px' } }, empreinteEl(d.empreinte)),
            el('div', { class: 'texte-gras' }, 'Empreinte présentée :'), el('div', { style: { margin: '4px 0' } }, empreinteEl(r.empreintePresentee))));
          boutons.unshift({ label: 'Remplacer l\'empreinte confirmée', classe: 'btn-danger', fermer: false, onClic: async () => {
            if (!(await ui.confirm({ titre: 'Remplacer l\'empreinte', message: 'Remplacer l\'empreinte confirmée par celle du certificat présenté ? En cas d\'usurpation, la clé de réception et la base complète seraient envoyées à un serveur inconnu.', okLabel: 'Remplacer', danger: true }))) return false;
            m.fermer();
            await majPuisRetester({ empreinte: r.empreintePresentee }, 'Empreinte du certificat remplacée');
            return false;
          } });
        }
        if (!r.ok && d.type === 'dossier') m.corps.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Vérifiez que le lecteur (clé USB, disque externe) est branché, que le partage réseau est accessible et que le compte Windows qui exécute la GMAO peut y écrire.'));
        if (!r.ok && d.type === 'serveur' && !r.code) m.corps.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Vérifiez l\'adresse, que la GMAO de l\'autre site est démarrée et accessible depuis le réseau, que la réception y est activée et que la clé saisie est la dernière générée sur ce serveur.'));
        m.setBoutons(boutons);
      }

      async function executer(d) {
        const libelle = d ? `vers « ${d.nom} »` : 'vers toutes les destinations';
        if (!d) {
          const cibles = ciblesExecution();
          const noms = cibles.map((x) => `« ${x.nom} »`);
          const liste = noms.length > 4 ? `${noms.slice(0, 4).join(', ')} et ${noms.length - 4} autre${noms.length - 4 > 1 ? 's' : ''}` : noms.join(', ');
          const vers = [cibles.length ? (cibles.length > 1 ? `${cibles.length} destinations (${liste})` : liste) : null, copieLocaleDisponible() ? 'la copie locale de ce serveur' : null].filter(Boolean).join(' et ');
          const siteSel = global() && GMAO.siteCourant() != null ? ` Le sélecteur de site est positionné sur « ${ui.nomSecteur(GMAO.siteCourant())} » : seules les destinations de ce site et les destinations communes sont utilisées, et la planification automatique n'en tiendra pas compte.` : '';
          if (!(await ui.confirm({ titre: 'Sauvegarder maintenant', message: `Créer une sauvegarde de toute la base et l'envoyer vers ${vers} ?${siteSel}`, okLabel: 'Sauvegarder' }))) return;
        }
        const m = modaleAttente('Sauvegarde en cours', `Sauvegarde ${libelle}…`);
        let r;
        try { r = await api.post(BASE + '/executer', d ? { destinationId: d.id } : {}); } catch (e) { m.fermer(); erreur(e); rendre(); return; }
        m.setTitre(r.ok ? 'Sauvegarde réussie' : 'Sauvegarde incomplète');
        m.boite.classList.remove('petite');
        ui.vider(m.corps);
        m.corps.appendChild(afficherResultat(r));
        m.setBoutons([{ label: 'Fermer', classe: 'btn-primaire', onClic: () => { rendre(); } }]);
        toast(r.ok ? 'Sauvegarde réussie' : 'Sauvegarde incomplète : consultez le détail', r.ok ? 'succes' : 'alerte');
      }

      function afficherResultat(r) {
        const lignes = [];
        if (r.local) lignes.push({ ok: r.local.ok, nom: 'Copie locale', emplacement: r.local.dossier || '', message: r.local.message, dureeMs: null });
        for (const x of r.resultats || []) lignes.push({ ok: x.ok, nom: x.nom, emplacement: x.emplacement || '', message: x.message, dureeMs: x.dureeMs });
        return frag(
          ui.alerte(r.message || (r.ok ? 'Sauvegarde réussie' : 'Sauvegarde incomplète'), r.ok ? 'ok' : 'alerte'),
          r.complete === false && r.siteCourantId != null ? ui.alerte('Sauvegarde limitée au site sélectionné : non prise en compte par la planification automatique.', 'info') : null,
          r.fichier ? ui.details([
            { label: 'Fichier', valeur: el('span', { class: 'sav-emplacement' }, r.fichier) },
            { label: 'Taille', valeur: formatTaille(r.taille) },
            { label: 'Format', valeur: badgesFormat(r) },
            { label: 'Empreinte SHA-256', valeur: el('span', { class: 'sav-mono', title: r.sha256 || '' }, r.sha256 || '—') },
            { label: 'Durée totale', valeur: formatDureeMs(r.dureeMs) },
          ]) : null,
          lignes.length ? el('ul', { class: 'sav-resultats' }, lignes.map((l) => el('li', { class: l.ok ? 'ok' : 'ko' }, icone(l.ok ? 'check' : 'alerte'),
            el('div', { style: { minWidth: '0', flex: '1' } },
              el('div', { class: 'sav-ligne', style: { gap: '8px' } }, el('span', { class: 'sav-res-nom' }, l.nom), l.dureeMs != null ? el('span', { class: 'texte-2 texte-petit' }, formatDureeMs(l.dureeMs)) : null),
              l.emplacement ? el('div', { class: 'sav-mono' }, l.emplacement) : null,
              el('div', { class: 'sav-res-msg' }, l.message || ''))))) : null);
      }

      async function supprimer(d) {
        if (!(await ui.confirm({ titre: 'Supprimer la destination', message: `Supprimer la destination « ${d.nom} » ? Les fichiers déjà copiés à cet emplacement sont conservés.`, okLabel: 'Supprimer', danger: true }))) return;
        try { await api.del(`${BASE}/destinations/${d.id}`); toast('Destination supprimée', 'succes'); rendre(); } catch (e) { erreur(e); }
      }

      async function voirFichiers(d) {
        const m = ui.modal({ titre: `Fichiers — ${d.nom}`, taille: 'tres-large', contenu: ui.chargement('Lecture des fichiers…'), boutons: [{ label: 'Fermer' }] });
        let r;
        try { r = await api.get(`${BASE}/destinations/${d.id}/fichiers`); } catch (e) {
          ui.vider(m.corps); m.corps.appendChild(ui.alerte('Lecture impossible : ' + e.message, 'alerte')); return;
        }
        ui.vider(m.corps);
        m.corps.appendChild(el('p', { class: 'texte-2 texte-petit', style: { marginTop: '0' } },
          d.type === 'serveur' ? `Sauvegardes de ce serveur conservées par « ${r.site || d.url} ». Pour les restaurer, utilisez « Sauvegardes reçues » sur ce serveur distant, ou téléchargez-les depuis celui-ci.` : frag('Dossier ', el('code', null, r.emplacement), ' — les sauvegardes d\'autres sites présentes dans ce dossier sont signalées.')));
        const t = ui.table({
          lignes: r.fichiers || [], compact: true, recherche: true, pagination: true, tailleParPage: 15, triInitial: { cle: 'date', sens: 'desc' },
          vide: 'Aucune sauvegarde à cet emplacement pour le moment.',
          colonnes: [
            { cle: 'nom', label: 'Fichier', rendu: (f) => el('div', null, el('div', { class: 'sav-fichier' }, f.nom), f.ceServeur ? null : el('div', { class: 'cellule-secondaire' }, `Autre site : ${f.identifiant || '?'}`)) },
            { cle: 'date', label: 'Sauvegarde du', type: 'datetime' },
            { cle: 'taille', label: 'Taille', aligner: 'droite', rendu: (f) => formatTaille(f.taille), valeurTri: (f) => f.taille },
            { cle: 'format', label: 'Format', tri: false, rendu: badgesFormat },
            { cle: 'sha256', label: 'Empreinte SHA-256', rendu: (f) => (f.sha256 ? el('span', { class: 'sav-mono', title: f.sha256 }, empreinteCourte(f.sha256)) : el('span', { class: 'texte-alerte texte-petit' }, 'absente')) },
          ],
          actions: r.restaurable ? [
            { icone: 'rafraichir', titre: 'Restaurer cette sauvegarde', visible: () => restaurable(), onClic: (f) => { m.fermer(); restaurer({ source: 'destination', destinationId: d.id, nomDestination: d.nom, fichier: f.nom, chiffre: f.chiffre, provenance: f.ceServeur ? null : f.identifiant }); } },
            { icone: 'export', titre: 'Télécharger', visible: () => restaurable(), onClic: (f) => api.telecharger(`${BASE}/telecharger?source=destination&destinationId=${d.id}&fichier=${encodeURIComponent(f.nom)}`, f.nom).catch(erreur) },
          ] : [],
        });
        m.corps.appendChild(t.el);
      }

      // ----- Restauration -----
      /**
       * Champs de confirmation d'une restauration. Le mot de passe est obligatoire pour une sauvegarde chiffrée par un autre
       * site (sauvegarde reçue, fichier d'un autre serveur) ou quand ce serveur n'a pas de mot de passe de chiffrement.
       */
      function champsConfirmation(chiffre, avecMotDePasse, { autreServeur = false, provenance = '' } = {}) {
        const mdpLocal = !!(etat.parametres || {}).motDePasseDefini;
        const requis = chiffre === true && (autreServeur || !mdpLocal);
        let placeholder, aide;
        if (chiffre === null) { placeholder = mdpLocal ? 'Laisser vide pour utiliser celui de ce serveur' : 'Mot de passe défini sur le serveur d\'origine'; aide = 'Uniquement si le fichier est chiffré (.enc). Une sauvegarde d\'un autre site est chiffrée avec le mot de passe de cet autre site.'; }
        else if (autreServeur) { placeholder = `Mot de passe défini sur le serveur de « ${provenance || 'l\'autre site'} »`; aide = 'Cette sauvegarde a été chiffrée par l\'autre site avec son propre mot de passe de chiffrement : celui de ce serveur ne permet pas de la lire.'; }
        else { placeholder = mdpLocal ? 'Laisser vide pour utiliser celui de ce serveur' : 'Mot de passe utilisé lors de la sauvegarde'; aide = mdpLocal ? 'Sauvegarde chiffrée par ce serveur' : 'Aucun mot de passe de chiffrement n\'est défini sur ce serveur : indiquez celui utilisé lors de la sauvegarde'; }
        return [
          avecMotDePasse ? { nom: 'motDePasse', label: 'Mot de passe de chiffrement de cette sauvegarde', type: 'mdp', pleineLargeur: true, requis, placeholder, aide } : null,
          { nom: 'confirmationRestauration', label: 'Pour confirmer, saisissez RESTAURER', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'RESTAURER', valider: (v) => (String(v || '').trim().toUpperCase() !== 'RESTAURER' ? 'Saisissez RESTAURER pour confirmer' : '') },
        ];
      }
      function avertissementRestauration(provenance, etatPrecedent) {
        const nomServeur = (etat.serveur || {}).nom || 'ce serveur';
        return frag(
          ui.alerte(frag(el('strong', null, 'Attention : '), `toutes les données actuelles de ce serveur (« ${nomServeur} ») seront remplacées par le contenu de la sauvegarde. Une copie de l'état actuel est faite automatiquement juste avant (visible dans « Copies locales » avec le badge « État avant restauration »). Les paramètres de sauvegarde de ce serveur (destinations, clés, mot de passe) sont conservés.`), 'alerte'),
          etatPrecedent ? ui.alerte('Retour en arrière : la base reviendra à l\'état qu\'elle avait juste avant la restauration ou l\'import correspondant.', 'info') : null,
          provenance ? ui.alerte(`Cette sauvegarde provient de « ${provenance} » : ne la restaurez ici que pour reconstruire les données de ce site (remplacement de son serveur, sinistre).`, 'info') : null);
      }
      async function apresRestauration(r) {
        toast(r.message || 'Base restaurée', 'succes', 6000);
        if (r.sessionConservee) { try { await GMAO.refresh(true); } catch (e) { win.location.reload(); } }
        else { toast('Reconnectez-vous pour continuer', 'info'); setTimeout(() => win.location.reload(), 1500); }
      }
      /** Le bouton de validation d'une restauration est présenté comme une action dangereuse. */
      function boutonDanger(m) {
        const b = m && m.pied ? m.pied.querySelector('.btn-primaire') : null;
        if (b) { b.classList.remove('btn-primaire'); b.classList.add('btn-danger'); }
        return m;
      }
      function restaurer({ source, destinationId, nomDestination, site, fichier, chiffre, provenance, etatPrecedent }) {
        const autreServeur = source === 'recue' || !!provenance;
        let origine;
        if (source === 'recue') origine = `Sauvegarde reçue de « ${provenance || site} »`;
        else if (source === 'locale') origine = etatPrecedent ? 'Copie locale de l\'état précédent (faite avant une restauration ou un import)' : 'Copie locale de ce serveur';
        else origine = frag(`Destination « ${nomDestination || destinationId} »`, provenance ? ` — sauvegarde d'un autre site (${provenance})` : '');
        boutonDanger(ui.formModal({
          titre: etatPrecedent ? 'Revenir à l\'état précédent' : 'Restaurer une sauvegarde', taille: 'large', colonnes: 1,
          avant: frag(avertissementRestauration(provenance, etatPrecedent), ui.details([{ label: 'Fichier', valeur: el('span', { class: 'sav-emplacement' }, fichier) }, { label: 'Origine', valeur: origine }])),
          champs: champsConfirmation(chiffre, !!chiffre, { autreServeur, provenance: provenance || site }),
          submitLabel: etatPrecedent ? 'Revenir à cet état' : 'Restaurer',
          onSubmit: async (v, modal) => {
            const m = modaleAttente('Restauration en cours', 'Vérification de l\'empreinte, déchiffrement et restauration…');
            let r;
            try { r = await api.post(BASE + '/restaurer', { source, destinationId, site, fichier, motDePasse: v.motDePasse || '' }); } catch (e) { m.fermer(); erreur(e); return false; }
            m.fermer(); modal.fermer();
            await apresRestauration(r);
            return undefined;
          },
        }));
      }
      function restaurerFichier() {
        let fichier = null;
        const input = el('input', { type: 'file', accept: '.json,.gz,.enc,application/json,application/gzip,application/octet-stream' });
        const infoFichier = el('div', { class: 'texte-2 texte-petit' }, 'Aucun fichier choisi');
        input.addEventListener('change', () => {
          fichier = input.files && input.files[0] ? input.files[0] : null;
          ui.vider(infoFichier);
          infoFichier.appendChild(doc.createTextNode(fichier ? `${fichier.name} — ${formatTaille(fichier.size)}${/\.enc$/i.test(fichier.name) ? ' — chiffrée' : ''}` : 'Aucun fichier choisi'));
        });
        boutonDanger(ui.formModal({
          titre: 'Restaurer depuis un fichier', taille: 'large', colonnes: 1,
          avant: avertissementRestauration(null, false),
          champs: [
            { nom: 'fichier', type: 'html', label: 'Fichier de sauvegarde (.json, .json.gz, .json.gz.enc)', rendu: () => frag(input, infoFichier) },
            { nom: 'sha256', label: 'Empreinte SHA-256 (facultative)', type: 'texte', placeholder: 'Contenu du fichier .sha256 associé', aide: 'Si elle est indiquée, l\'intégrité du fichier est vérifiée avant restauration',
              valider: (v) => (v && !/^[a-f0-9]{64}\b/i.test(String(v).trim()) ? 'Empreinte invalide (64 caractères hexadécimaux)' : '') },
          ].concat(champsConfirmation(null, true)),
          submitLabel: 'Restaurer',
          onSubmit: async (v, modal) => {
            if (!fichier) { toast('Choisissez un fichier de sauvegarde', 'alerte'); return false; }
            if (fichier.size > 512 * 1024 * 1024) { toast('Fichier trop volumineux (512 Mo au maximum)', 'erreur'); return false; }
            const m = modaleAttente('Restauration en cours', 'Envoi du fichier et restauration…');
            const headers = { 'X-Requested-With': 'GMAO', 'Content-Type': 'application/octet-stream', 'X-GMAO-Fichier': encodeURIComponent(fichier.name), 'X-GMAO-Mot-De-Passe': encodeURIComponent(v.motDePasse || '') };
            const sha = String(v.sha256 || '').trim().slice(0, 64).toLowerCase();
            if (sha) headers['X-GMAO-Sha256'] = sha;
            let r;
            try {
              const res = await fetch(BASE + '/restaurer-fichier', { method: 'POST', credentials: 'same-origin', headers, body: fichier });
              let data = null;
              try { data = await res.json(); } catch (e) { data = null; }
              if (!res.ok) throw new Error((data && data.erreur) || `Erreur ${res.status}`);
              r = data;
            } catch (e) { m.fermer(); erreur(e); return false; }
            m.fermer(); modal.fermer();
            await apresRestauration(r);
            return undefined;
          },
        }));
      }
      function voirLocales() {
        const locales = etat.locales || [];
        const t = ui.table({
          lignes: locales, compact: true, recherche: true, pagination: true, tailleParPage: 15, vide: 'Aucune copie locale.',
          colonnes: [
            { cle: 'nom', label: 'Fichier', rendu: (f) => el('div', null, el('div', { class: 'sav-fichier' }, f.nom), f.etatPrecedent ? el('div', { class: 'cellule-secondaire' }, badgeEtatPrecedent()) : null) },
            { cle: 'date', label: 'Sauvegarde du', type: 'datetime' },
            { cle: 'taille', label: 'Taille', aligner: 'droite', rendu: (f) => formatTaille(f.taille), valeurTri: (f) => f.taille },
            { cle: 'format', label: 'Format', tri: false, rendu: badgesFormat },
            { cle: 'sha256', label: 'Empreinte', rendu: (f) => el('span', { class: 'sav-mono', title: f.sha256 || '' }, empreinteCourte(f.sha256)) },
          ],
          actions: [
            { icone: 'rafraichir', titre: 'Restaurer cette copie', visible: () => restaurable(), onClic: (f) => { m.fermer(); restaurer({ source: 'locale', fichier: f.nom, chiffre: f.chiffre, etatPrecedent: !!f.etatPrecedent }); } },
            { icone: 'export', titre: 'Télécharger', visible: () => restaurable(), onClic: (f) => api.telecharger(`${BASE}/telecharger?source=locale&fichier=${encodeURIComponent(f.nom)}`, f.nom).catch(erreur) },
          ],
        });
        const nbAvant = locales.filter((f) => f.etatPrecedent).length;
        const m = ui.modal({ titre: `Copies locales (${locales.length})`, taille: 'tres-large', contenu: frag(
          el('p', { class: 'texte-2 texte-petit', style: { marginTop: '0' } }, 'Dossier : ', el('code', null, (etat.serveur || {}).dossierLocal || '—'), nbAvant ? ` — ${nbAvant} copie${nbAvant > 1 ? 's' : ''} de l'état précédent (faite${nbAvant > 1 ? 's' : ''} avant une restauration ou un import) : la restaurer annule l'opération correspondante.` : ''), t.el), boutons: [{ label: 'Fermer' }] });
      }
      function carteRestauration() {
        const locales = etat.locales || [];
        return ui.carte('Restauration', frag(
          el('p', { class: 'texte-2 texte-petit', style: { marginTop: '0' } }, 'Restaurez une copie locale, une sauvegarde d\'une destination (bouton « Voir les fichiers »), une sauvegarde reçue d\'un autre site, ou un fichier récupéré sur une clé USB. L\'empreinte SHA-256 est vérifiée et une copie de l\'état actuel est faite avant toute restauration ; pour revenir en arrière, restaurez cette copie « État avant restauration » depuis « Copies locales » ou le détail de l\'historique.'),
          el('div', { class: 'sav-actions-carte' },
            ui.bouton(`Copies locales (${locales.length})`, { icone: 'dossier', classe: 'btn-sm', onClic: voirLocales, disabled: !(etat.serveur || {}).dossierLocal }),
            restaurable() ? ui.bouton('Restaurer depuis un fichier…', { icone: 'import', classe: 'btn-sm', onClic: restaurerFichier }) : null),
          restaurable() ? null : el('p', { class: 'texte-2 texte-petit' }, 'La restauration est réservée au pôle informatique ayant accès à tous les sites.')));
      }

      // ----- Historique -----
      function carteHistorique() {
        const histo = etat.historique || [];
        const selType = el('select', { 'aria-label': 'Type d\'opération' }, el('option', { value: '' }, 'Toutes les opérations'), Object.entries(TYPES_HISTO).map(([k, v]) => el('option', { value: k }, v.label + 's')));
        const selRes = el('select', { 'aria-label': 'Résultat' }, el('option', { value: '' }, 'Tous les résultats'), el('option', { value: 'ok' }, 'Réussies'), el('option', { value: 'ko' }, 'En échec'));
        selType.value = filtresHisto.type;
        selRes.value = filtresHisto.resultat;
        const filtrer = () => histo.filter((h) => (!filtresHisto.type || h.type === filtresHisto.type) && (!filtresHisto.resultat || (filtresHisto.resultat === 'ok' ? h.ok : !h.ok)));
        const qui = (h) => (h.type === 'reception' ? (h.source || 'Autre site') : (h.userNom || (h.declencheur === 'automatique' ? 'Planification automatique' : '—')));
        const tableau = ui.table({
          lignes: filtrer(), compact: true, recherche: 'Rechercher dans l\'historique…', pagination: true, tailleParPage: 10, exportCsv: 'historique-sauvegardes.csv',
          vide: 'Aucune opération enregistrée.', outils: [selType, selRes],
          onClic: (h) => detailHistorique(h),
          colonnes: [
            { cle: 'date', label: 'Date', type: 'datetime' },
            { cle: 'type', label: 'Opération', rendu: (h) => { const t = TYPES_HISTO[h.type] || { label: h.type || '—', couleur: '#6b7280' }; return ui.badge(t.label, t.couleur); }, exportValeur: (h) => (TYPES_HISTO[h.type] || {}).label || h.type },
            { cle: 'declencheur', label: 'Déclenchement', rendu: (h) => (h.type === 'reception' ? 'Autre site' : (h.declencheur === 'automatique' ? 'Automatique' : 'Manuel')) },
            { cle: 'qui', label: 'Par / source', rendu: qui, valeurTri: (h) => qui(h) },
            { cle: 'ok', label: 'Résultat', rendu: (h) => badgeOk(h.ok), exportValeur: (h) => (h.ok ? 'Réussie' : 'Échec') },
            { cle: 'message', label: 'Détail', rendu: (h) => el('span', { title: h.message || '' }, String(h.message || '').length > 90 ? String(h.message).slice(0, 90) + '…' : (h.message || '')), exportValeur: (h) => h.message || '' },
            { cle: 'taille', label: 'Taille', aligner: 'droite', rendu: (h) => (h.taille ? formatTaille(h.taille) : '—'), valeurTri: (h) => h.taille || 0 },
            { cle: 'dureeMs', label: 'Durée', aligner: 'droite', rendu: (h) => (h.dureeMs != null ? formatDureeMs(h.dureeMs) : '—'), valeurTri: (h) => h.dureeMs || 0 },
          ],
        });
        selType.addEventListener('change', () => { filtresHisto.type = selType.value; tableau.maj(filtrer()); });
        selRes.addEventListener('change', () => { filtresHisto.resultat = selRes.value; tableau.maj(filtrer()); });
        tableauHisto = tableau;
        return ui.carte(histo.length ? `Historique (${histo.length} dernière${histo.length > 1 ? 's' : ''} opération${histo.length > 1 ? 's' : ''})` : 'Historique', tableau.el);
      }

      function detailHistorique(h) {
        const t = TYPES_HISTO[h.type] || { label: h.type || 'Opération' };
        const infos = ui.details([
          { label: 'Date', valeur: ui.formatDateHeure(h.date) },
          { label: 'Opération', valeur: t.label },
          { label: 'Résultat', valeur: badgeOk(h.ok) },
          h.type === 'reception' ? { label: 'Site émetteur', valeur: h.source || '—' } : { label: 'Par', valeur: h.userNom || (h.declencheur === 'automatique' ? 'Planification automatique' : '—') },
          h.ip ? { label: 'Adresse IP', valeur: h.ip } : null,
          h.fichier ? { label: 'Fichier', valeur: el('span', { class: 'sav-emplacement' }, h.fichier) } : null,
          h.taille ? { label: 'Taille', valeur: formatTaille(h.taille) } : null,
          h.sha256 ? { label: 'Empreinte SHA-256', valeur: el('span', { class: 'sav-mono' }, h.sha256) } : null,
          h.dureeMs != null ? { label: 'Durée', valeur: formatDureeMs(h.dureeMs) } : null,
          h.type === 'restauration' && h.origine ? { label: 'Origine', valeur: h.origine } : null,
          h.type === 'restauration' && h.copieAvant ? { label: 'État précédent sauvegardé dans', valeur: frag(el('span', { class: 'sav-emplacement' }, h.copieAvant), ' ', badgeEtatPrecedent()) } : null,
        ]);
        const copieDisponible = h.type === 'restauration' && h.copieAvant && restaurable() && (etat.locales || []).some((f) => f.nom === h.copieAvant);
        const m = ui.modal({
          titre: `${t.label} du ${ui.formatDateHeure(h.date)}`, taille: 'large',
          contenu: frag(h.type === 'sauvegarde' ? afficherResultat(h) : ui.alerte(h.message || '', h.ok ? 'ok' : 'alerte'), h.type === 'sauvegarde' ? null : infos, h.type === 'sauvegarde' ? el('div', { class: 'mt' }, ui.details([{ label: 'Par', valeur: h.userNom || (h.declencheur === 'automatique' ? 'Planification automatique' : '—') }, { label: 'Déclenchement', valeur: h.declencheur === 'automatique' ? 'Automatique' : 'Manuel' }])) : null),
          boutons: [
            copieDisponible ? { label: 'Annuler cette restauration', classe: 'btn-danger', icone: 'rafraichir', onClic: () => { m.fermer(); restaurer({ source: 'locale', fichier: h.copieAvant, chiffre: false, etatPrecedent: true }); } } : null,
            { label: 'Fermer' },
          ],
        });
      }

      rendre();
      return { rafraichir: rendre };
    };
  }

  return { outils, installer };
});
