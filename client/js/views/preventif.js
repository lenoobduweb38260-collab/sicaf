/**
 * Vue Maintenance préventive : indicateurs, liste des plans (filtres, recherche, export CSV),
 * génération des OT à échéance, échéancier sur 12 mois regroupé par mois, fiche détaillée
 * #/preventif/:id (détails, gamme, pièces, historique des OT générés) et formulaire modal avec
 * éditeur de gamme (ajout, suppression, réordonnancement par glisser-déposer ou flèches).
 * Support de #/preventif?nouveau=1&equipementId=ID (création depuis une fiche équipement),
 * #/preventif?equipementId=ID et #/preventif?etat=en_retard (filtres).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'preventif';
  const can = (a) => GMAO.can(MODULE, a);
  const ETATS = {
    en_retard: { label: 'En retard', couleur: '#dc2626', rang: 1 },
    proche: { label: 'Échéance proche', couleur: '#f59e0b', rang: 2 },
    a_jour: { label: 'À jour', couleur: '#16a34a', rang: 3 },
    inactif: { label: 'Inactif', couleur: '#6b7280', rang: 4 },
  };
  const TYPES_PERIODICITE = [
    { value: 'jours', label: 'Jours' }, { value: 'semaines', label: 'Semaines' },
    { value: 'mois', label: 'Mois' }, { value: 'compteur', label: 'Compteur de l\'équipement (heures, cycles, km…)' },
  ];
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const FEMININ = ['heures', 'heure', 'h', 'pièces', 'pieces', 'tonnes', 'manoeuvres', 'manœuvres'];

  /** Icône dimensionnée explicitement (hors boutons). */
  function ico(nom, px = 14) { const svg = icone(nom); Object.assign(svg.style, { width: px + 'px', height: px + 'px', flexShrink: '0' }); return svg; }
  const nf = (n) => ui.formatNombre(n);
  /** Libellé d'unité d'article accordé à la quantité (« 2 unités », « 5 litres »). */
  function uniteArticle(code, quantite) {
    if (!code) return '';
    const l = String(ui.libelle('unites', code) || code).toLowerCase();
    return ' ' + (Number(quantite) > 1 && !/[sx]$/.test(l) ? l + 's' : l);
  }
  function uniteAbregee(u) { const s = String(u || 'heures').toLowerCase(); return ['heures', 'heure', 'h'].includes(s) ? 'h' : (u || 'h'); }

  // ----- Dates calendaires (mêmes règles que le serveur) ----------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  function versChaine(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
  function ajouterPeriode(s, p) {
    if (!s || !p) return '';
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    const v = Number(p.valeur) || 0;
    if (p.type === 'jours') return versChaine(y, m, d + v);
    if (p.type === 'semaines') return versChaine(y, m, d + 7 * v);
    if (p.type === 'mois') {
      const total = y * 12 + (m - 1) + v; const ny = Math.floor(total / 12); const nm = total - ny * 12 + 1;
      return versChaine(ny, nm, Math.min(d, new Date(Date.UTC(ny, nm, 0)).getUTCDate()));
    }
    return s;
  }

  // ----- Présentation ------------------------------------------------------------------------
  function badgeEtat(etat, opts) { const e = ETATS[etat] || ETATS.a_jour; return ui.badge(e.label, e.couleur, opts); }
  /** « tous les 3 mois », « toutes les semaines », « toutes les 500 h ». */
  function periodiciteLisible(p, unite) {
    if (!p || !p.type) return '—';
    const v = Number(p.valeur);
    if (!(v > 0)) return '—';
    if (p.type === 'jours') return v === 1 ? 'tous les jours' : `tous les ${nf(v)} jours`;
    if (p.type === 'semaines') return v === 1 ? 'toutes les semaines' : `toutes les ${nf(v)} semaines`;
    if (p.type === 'mois') { if (v % 12 === 0) return v === 12 ? 'tous les ans' : `tous les ${nf(v / 12)} ans`; return v === 1 ? 'tous les mois' : `tous les ${nf(v)} mois`; }
    const u = String(unite || 'heures');
    return `${FEMININ.includes(u.toLowerCase()) ? 'toutes' : 'tous'} les ${nf(v)} ${uniteAbregee(u)}`;
  }
  function valeurEcheance(p, v, unite) {
    if (v == null || v === '') return '—';
    if (p && p.type === 'compteur') return `${nf(v)} ${uniteAbregee(unite)}`;
    return ui.formatDate(v);
  }
  function texteRestant(p) {
    if (p.etat === 'inactif') return 'plan inactif';
    if ((p.periodicite || {}).type === 'compteur') {
      if (p.resteCompteur == null) return 'compteur de l\'équipement inconnu';
      const u = uniteAbregee(p.uniteCompteur);
      if (p.resteCompteur <= 0) return `dépassée de ${nf(-p.resteCompteur)} ${u}`;
      return `reste ${nf(p.resteCompteur)} ${u}${p.echeanceEstimee && p.echeanceDate ? ` · ≈ ${ui.formatDate(p.echeanceDate)}` : ''}`;
    }
    const j = p.joursRestants;
    if (j == null) return '';
    if (j < 0) return `en retard de ${-j} jour${-j > 1 ? 's' : ''}`;
    if (j === 0) return 'aujourd\'hui';
    if (j === 1) return 'demain';
    return `dans ${j} jours`;
  }
  function lienVue(href, label, titre) { return el('a', { href, title: titre, onclick: (ev) => ev.stopPropagation() }, label); }
  function lienOt(id, numero, statut) {
    if (id == null) return el('span', { class: 'texte-2' }, '—');
    const lib = numero || ('OT #' + id);
    return el('div', { style: { whiteSpace: 'nowrap' } }, GMAO.can('ot', 'voir') ? lienVue('#/ot/' + id, lib, 'Ouvrir l\'ordre de travail') : el('span', null, lib), statut ? el('div', null, ui.badgeListe('statutsOT', statut)) : null);
  }
  function lienEquipement(p) {
    if (!p.equipementId) return el('span', { class: 'texte-2' }, p.secteurChemin ? 'Plan général · ' + p.secteurChemin : 'Plan général');
    const nom = p.equipementNom || ('Équipement #' + p.equipementId);
    return el('div', { style: { minWidth: '130px', maxWidth: '200px' }, title: p.secteurChemin ? 'Secteur : ' + p.secteurChemin : null },
      GMAO.can('equipements', 'voir') ? lienVue('#/equipements/' + p.equipementId, nom, 'Ouvrir la fiche équipement') : el('span', null, nom),
      el('div', { class: 'cellule-secondaire' }, [p.equipementNumero, p.secteurNom].filter(Boolean).join(' · ')));
  }
  function celluleEcheance(p) {
    const type = (p.periodicite || {}).type;
    const coul = (ETATS[p.etat] || ETATS.a_jour).couleur;
    return el('div', { style: { minWidth: '120px' } },
      el('div', { class: 'inline', style: { flexWrap: 'wrap', gap: '4px 6px' } }, el('span', { class: 'texte-gras', style: p.etat === 'en_retard' ? { color: coul } : null }, valeurEcheance(p.periodicite, p.echeance, p.uniteCompteur)), badgeEtat(p.etat)),
      el('div', { class: 'cellule-secondaire' }, texteRestant(p), type === 'compteur' && p.echeanceEstimee ? el('span', { title: 'Date estimée d\'après le rythme d\'utilisation de l\'équipement' }, ' (estimée)') : null));
  }

  // ----- Références (cache court) --------------------------------------------------------------
  const cache = {};
  async function charger(cle, fn, ttl = 30000) {
    if (cache[cle] && Date.now() - cache[cle].t < ttl) return cache[cle].v;
    const v = await fn();
    cache[cle] = { v, t: Date.now() };
    return v;
  }
  const invalider = () => { Object.keys(cache).forEach((k) => delete cache[k]); };
  const chargerReferences = () => charger('refs', () => api.get('/api/preventif-references'));
  /** Articles : API du module Stock si disponible, sinon liste fournie par le module préventif. */
  async function chargerArticles(refs) {
    if (GMAO.can('stock', 'voir')) {
      try {
        const r = await charger('articles', () => api.get('/api/articles', { actif: '1' }));
        const liste = Array.isArray(r) ? r : (r && (r.articles || r.lignes)) || [];
        if (liste.length) return liste.filter((a) => a.actif !== false).map((a) => ({ id: a.id, code: a.code || '', designation: a.designation || '', quantite: Number(a.quantite) || 0, uniteCode: a.uniteCode || null, equipementIds: (a.equipementIds || []).map(Number) }));
      } catch (e) { /* repli ci-dessous */ }
    }
    return (refs && refs.articles) || [];
  }

  // ----- Badge de navigation (plans en retard) ---------------------------------------------------
  let derniereMajBadge = 0;
  async function majBadge(compteurs) {
    try {
      derniereMajBadge = Date.now();
      const c = compteurs || await api.get('/api/preventif-compteurs', null, { silent401: true });
      GMAO.setNavBadge(MODULE, c.enRetard || 0);
      return c;
    } catch (e) { return null; }
  }

  // ----- Éditeur de gamme ------------------------------------------------------------------------
  function editeurGamme(initiale) {
    const items = (initiale || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map((t) => ({ libelle: t.libelle || '', duree: t.duree == null ? '' : String(t.duree) }));
    const corps = el('div', { class: 'liste-editable' });
    const total = el('span', { class: 'texte-2 texte-petit' });
    const grille = '22px 30px minmax(0, 1fr) 96px 96px';
    let source = null;
    const focusSur = (i) => { const inp = corps.querySelectorAll('input[type=text]')[i]; if (inp) inp.focus(); };
    function majTotal() {
      const n = items.filter((t) => t.libelle.trim()).length;
      const h = items.reduce((s, t) => s + (Number(t.duree) || 0), 0);
      total.textContent = n ? `${n} tâche${n > 1 ? 's' : ''} · durée totale ${h ? ui.formatDuree(h) : 'non renseignée'}` : 'Aucune tâche';
    }
    function deplacer(de, vers) {
      if (vers < 0 || vers >= items.length || de === vers) return;
      const [it] = items.splice(de, 1); items.splice(vers, 0, it); rendre();
    }
    function ajouter(position) {
      const i = position == null ? items.length : position;
      items.splice(i, 0, { libelle: '', duree: '' }); rendre(); focusSur(i);
    }
    function rendre() {
      ui.vider(corps);
      corps.appendChild(el('div', { class: 'ligne texte-2 texte-petit texte-gras', style: { gridTemplateColumns: grille } }, el('span'), el('span', null, 'N°'), el('span', null, 'Tâche / opération'), el('span', null, 'Durée (h)'), el('span')));
      if (!items.length) corps.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '4px 0 8px' } }, 'Aucune tâche : ajoutez les opérations à réaliser, dans l\'ordre d\'exécution. Elles seront copiées dans chaque ordre de travail généré.'));
      items.forEach((it, i) => {
        const lib = el('input', { type: 'text', value: it.libelle, placeholder: 'ex. Graisser les paliers du carrousel', maxlength: '300', 'aria-label': `Libellé de la tâche ${i + 1}` });
        lib.addEventListener('input', () => { it.libelle = lib.value; majTotal(); });
        lib.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ajouter(i + 1); } });
        const dur = el('input', { type: 'number', value: it.duree, min: '0', step: '0.25', placeholder: '—', 'aria-label': `Durée de la tâche ${i + 1} en heures` });
        dur.addEventListener('input', () => { it.duree = dur.value; majTotal(); });
        const poignee = el('span', { class: 'poignee', title: 'Glisser pour réordonner' }, ico('glisser', 16));
        const ligne = el('div', { class: 'ligne', style: { gridTemplateColumns: grille }, dataset: { index: i } },
          poignee, el('span', { class: 'texte-2 texte-gras' }, String(i + 1)), lib, dur,
          el('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Monter', disabled: i === 0, onclick: () => deplacer(i, i - 1) }, icone('haut')),
            el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Descendre', disabled: i === items.length - 1, onclick: () => deplacer(i, i + 1) }, icone('bas')),
            el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer la tâche', onclick: () => { items.splice(i, 1); rendre(); } }, icone('supprimer'))));
        // Glisser-déposer : activé uniquement depuis la poignée (la saisie dans les champs reste possible)
        poignee.addEventListener('mousedown', () => { ligne.draggable = true; });
        ligne.addEventListener('dragstart', (ev) => { source = i; ligne.style.opacity = '0.5'; try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)); } catch (e) { /* ignore */ } });
        ligne.addEventListener('dragend', () => { ligne.draggable = false; ligne.style.opacity = ''; source = null; corps.querySelectorAll('.ligne').forEach((l) => { l.style.boxShadow = ''; }); });
        ligne.addEventListener('dragover', (ev) => { if (source == null) return; ev.preventDefault(); ligne.style.boxShadow = 'inset 0 2px 0 var(--primaire)'; });
        ligne.addEventListener('dragleave', () => { ligne.style.boxShadow = ''; });
        ligne.addEventListener('drop', (ev) => { ev.preventDefault(); if (source != null) deplacer(source, i); });
        corps.appendChild(ligne);
      });
      majTotal();
    }
    rendre();
    const racine = el('div', null, corps, el('div', { class: 'barre-outils', style: { marginTop: '6px', marginBottom: '0' } },
      ui.bouton('Ajouter une tâche', { icone: 'plus', classe: 'btn-sm', onClic: () => ajouter() }), el('span', { class: 'espace' }), total));
    return {
      el: racine,
      valeurs: () => items.filter((t) => t.libelle.trim() || String(t.duree).trim()).map((t, i) => ({ ordre: i + 1, libelle: t.libelle.trim(), duree: String(t.duree).trim() === '' ? null : Number(t.duree) })),
      valider() {
        const v = items.filter((t) => t.libelle.trim() || String(t.duree).trim());
        const i = v.findIndex((t) => !t.libelle.trim());
        if (i >= 0) return `Gamme : la tâche n°${i + 1} n'a pas de libellé`;
        const j = v.findIndex((t) => String(t.duree).trim() !== '' && !(Number(t.duree) >= 0));
        if (j >= 0) return `Gamme : la durée de la tâche n°${j + 1} est invalide`;
        return '';
      },
      total: () => items.reduce((s, t) => s + (Number(t.duree) || 0), 0),
    };
  }

  // ----- Éditeur des pièces nécessaires --------------------------------------------------------
  function editeurPieces(initiales, articles) {
    const items = (initiales || []).map((p) => ({ articleId: p.articleId, quantite: p.quantite == null ? '1' : String(p.quantite), designation: p.designation || '' }));
    const parId = new Map(articles.map((a) => [a.id, a]));
    let equipementId = null;
    const corps = el('div', { class: 'liste-editable' });
    const grille = 'minmax(0, 1fr) 110px 36px';
    const libelleArticle = (a) => `${a.code ? a.code + ' — ' : ''}${a.designation} (stock : ${nf(a.quantite)}${uniteArticle(a.uniteCode, a.quantite)})`;
    function select(it) {
      const sel = el('select', { 'aria-label': 'Article' });
      sel.appendChild(el('option', { value: '' }, '— Choisir un article —'));
      const compatibles = articles.filter((a) => equipementId != null && a.equipementIds.includes(Number(equipementId)));
      const autres = articles.filter((a) => !compatibles.includes(a));
      if (compatibles.length) sel.appendChild(el('optgroup', { label: 'Compatibles avec l\'équipement' }, compatibles.map((a) => el('option', { value: String(a.id) }, libelleArticle(a)))));
      if (autres.length) sel.appendChild(el('optgroup', { label: compatibles.length ? 'Autres articles' : 'Articles en stock' }, autres.map((a) => el('option', { value: String(a.id) }, libelleArticle(a)))));
      if (it.articleId != null && !parId.has(Number(it.articleId))) sel.appendChild(el('option', { value: String(it.articleId) }, it.designation || `Article #${it.articleId}`));
      sel.value = it.articleId == null ? '' : String(it.articleId);
      sel.addEventListener('change', () => { it.articleId = sel.value ? Number(sel.value) : null; });
      return sel;
    }
    function rendre() {
      ui.vider(corps);
      if (!articles.length && !items.length) {
        corps.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '4px 0' } }, 'Aucun article disponible : le module Stock est absent ou ne contient aucun article actif.'));
        return;
      }
      if (items.length) corps.appendChild(el('div', { class: 'ligne texte-2 texte-petit texte-gras', style: { gridTemplateColumns: grille } }, el('span', null, 'Article'), el('span', null, 'Quantité'), el('span')));
      items.forEach((it, i) => {
        const q = el('input', { type: 'number', value: it.quantite, min: '0', step: 'any', 'aria-label': 'Quantité' });
        q.addEventListener('input', () => { it.quantite = q.value; });
        corps.appendChild(el('div', { class: 'ligne', style: { gridTemplateColumns: grille } }, select(it), q,
          el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Retirer la pièce', onclick: () => { items.splice(i, 1); rendre(); } }, icone('supprimer'))));
      });
      if (articles.length) corps.appendChild(el('div', { style: { marginTop: '4px' } }, ui.bouton('Ajouter une pièce', { icone: 'plus', classe: 'btn-sm', onClic: () => { items.push({ articleId: null, quantite: '1' }); rendre(); } })));
    }
    rendre();
    return {
      el: el('div', null, corps, el('div', { class: 'texte-2 texte-petit', style: { marginTop: '4px' } }, 'Pièces à préparer pour chaque intervention (reprises comme « pièces prévues » dans les OT générés ; la sortie de stock se fait sur l\'OT).')),
      setEquipement(id) { const n = id === '' || id == null ? null : Number(id); if (n === equipementId) return; equipementId = n; rendre(); },
      valeurs: () => items.filter((it) => it.articleId != null).map((it) => ({ articleId: Number(it.articleId), quantite: Number(it.quantite) })),
      valider() {
        const i = items.findIndex((it) => it.articleId == null);
        if (i >= 0) return `Pièces : choisissez l'article de la ligne ${i + 1} (ou retirez-la)`;
        const j = items.findIndex((it) => it.articleId != null && !(Number(it.quantite) > 0));
        if (j >= 0) return `Pièces : la quantité de la ligne ${j + 1} doit être strictement positive`;
        return '';
      },
    };
  }

  // ----- Formulaire (création / modification) ---------------------------------------------------
  function codeParDefaut(liste, voulu) { const l = GMAO.liste(liste); return l.some((x) => x.code === voulu) ? voulu : (l[0] ? l[0].code : ''); }
  function optionsEquipements(equipements) {
    const out = [{ value: '', label: '— Aucun équipement (plan général de secteur) —' }];
    const groupes = new Map();
    for (const e of equipements) { const k = e.secteurId == null ? 0 : Number(e.secteurId); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(e); }
    const ordre = (id) => { const s = ui.secteur(id); return s ? (s.ordre || 0) : 999; };
    Array.from(groupes.keys()).sort((a, b) => ordre(a) - ordre(b) || ui.cheminSecteur(a).localeCompare(ui.cheminSecteur(b))).forEach((k) => {
      out.push({ value: '__secteur_' + k, label: `── ${k ? (ui.cheminSecteur(k) || 'Secteur #' + k) : 'Sans secteur'} ──`, disabled: true });
      groupes.get(k).sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr')).forEach((e) => out.push({ value: e.id, label: `${e.nom}${e.numero ? ' (' + e.numero + ')' : ''}${e.parentNom ? ' — ' + e.parentNom : ''}` }));
    });
    return out;
  }

  async function ouvrirFormulaire(existant, opts = {}, apres) {
    let refs;
    try { refs = await chargerReferences(); } catch (e) { return erreur(e); }
    const articles = await chargerArticles(refs);
    const creation = !existant;
    const equipements = (refs.equipements || []).slice();
    if (existant && existant.equipementId != null && !equipements.some((e) => e.id === existant.equipementId)) {
      equipements.push({ id: existant.equipementId, nom: existant.equipementNom || ('Équipement #' + existant.equipementId), numero: existant.equipementNumero || '', secteurId: existant.secteurId, compteur: existant.equipement ? existant.equipement.compteur : null });
    }
    const eqParId = new Map(equipements.map((e) => [e.id, e]));
    const techniciens = (refs.techniciens || []).map((t) => ({ value: t.id, label: `${t.nomComplet}${t.fonction ? ' — ' + t.fonction : ''} · ${t.charge} OT ouvert${t.charge > 1 ? 's' : ''}` }));
    if (existant && existant.technicienId != null && !techniciens.some((t) => t.value === existant.technicienId)) techniciens.push({ value: existant.technicienId, label: existant.technicienNom || ui.nomUser(existant.technicienId) });
    const gamme = editeurGamme(existant ? existant.gamme : (opts.gamme || []));
    const pieces = editeurPieces(existant ? existant.pieces : [], articles);
    const apercu = el('div', { class: 'alerte alerte-info', style: { margin: '0' } });
    const p0 = existant ? existant.periodicite || { type: 'mois', valeur: 1 } : { type: 'mois', valeur: 1 };
    const compteur0 = p0.type === 'compteur';
    const equipementInitial = existant ? (existant.equipementId == null ? '' : existant.equipementId) : (opts.equipementId && eqParId.has(Number(opts.equipementId)) ? Number(opts.equipementId) : '');
    const estCompteur = (v) => v.periodiciteType === 'compteur';
    // Durée « automatique » (= somme de la gamme) : champ laissé vide pour suivre les modifications de la gamme
    const sommeInitiale = existant ? (existant.gamme || []).reduce((t, x) => t + (Number(x.duree) || 0), 0) : 0;
    const dureeAuto = !!existant && (existant.dureeEstimee == null || Math.abs(Number(existant.dureeEstimee) - sommeInitiale) < 1e-6);
    let m = null;

    function majApercu(f) {
      if (!f) return;
      const v = f.valeurs();
      const p = { type: v.periodiciteType, valeur: Number(v.periodiciteValeur) };
      const eq = v.equipementId !== '' ? eqParId.get(Number(v.equipementId)) : null;
      const cpt = eq && eq.compteur ? eq.compteur : null;
      pieces.setEquipement(v.equipementId);
      ui.vider(apercu);
      const lignes = [];
      if (!(p.valeur > 0)) lignes.push('Saisissez la valeur de la périodicité.');
      else if (p.type === 'compteur') {
        if (!eq) lignes.push(el('span', { class: 'texte-danger' }, 'Une périodicité sur compteur nécessite un équipement.'));
        else {
          const base = v.derniereCompteur != null ? Number(v.derniereCompteur) : (cpt ? Number(cpt.valeur) || 0 : 0);
          lignes.push(frag(el('strong', null, 'Périodicité : '), periodiciteLisible(p, cpt && cpt.unite)));
          lignes.push(`Compteur actuel de l'équipement : ${cpt ? nf(cpt.valeur) + ' ' + (cpt.unite || '') : 'non renseigné'}.`);
          lignes.push(v.echeanceCompteur != null ? `Prochaine échéance saisie : ${nf(v.echeanceCompteur)} ${uniteAbregee(cpt && cpt.unite)}.` : `Prochaine échéance calculée : ${nf(base + p.valeur)} ${uniteAbregee(cpt && cpt.unite)} (${v.derniereCompteur != null ? 'dernière réalisation' : 'compteur actuel'} + période).`);
        }
      } else {
        lignes.push(frag(el('strong', null, 'Périodicité : '), periodiciteLisible(p)));
        const inchangee = existant && (existant.periodicite || {}).type === p.type && Number((existant.periodicite || {}).valeur) === p.valeur;
        if (v.echeanceDate && (creation || inchangee || v.echeanceDate !== (existant && existant.prochaineEcheance))) lignes.push(`Prochaine échéance : ${ui.formatDate(v.echeanceDate)}.`);
        else {
          const base = v.derniereDate || (creation ? (v.dateDebut || ui.aujourdhui()) : (existant.dateDebut || ui.aujourdhui()));
          lignes.push(`Prochaine échéance calculée : ${ui.formatDate(ajouterPeriode(base, p))} (${v.derniereDate ? 'dernière réalisation' : 'date de départ'} + période).`);
        }
      }
      const horizon = v.genererJoursAvant != null ? v.genererJoursAvant : refs.horizonJours;
      lignes.push(`L'ordre de travail est généré ${horizon} jour${horizon > 1 ? 's' : ''} avant l'échéance${refs.genererAuto ? ' (génération automatique active)' : ' (génération automatique désactivée : utilisez « Générer les OT à échéance »)'}.`);
      lignes.forEach((l) => apercu.appendChild(el('div', null, l)));
    }
    const maj = (v, f) => majApercu(f);
    const champs = [
      { type: 'separateur', label: 'Identification' },
      { nom: 'nom', label: 'Nom du plan', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'ex. Graissage mensuel de la remplisseuse', valider: (v) => (String(v || '').trim().length < 3 ? 'Au moins 3 caractères' : '') },
      { nom: 'equipementId', label: 'Équipement', type: 'select', options: optionsEquipements(equipements), onChange: maj, aide: 'Le secteur du plan est repris de l\'équipement' },
      { nom: 'secteurId', label: 'Secteur (plan sans équipement)', type: 'select', options: ui.optionsSecteurs({ vide: '— Aucun secteur —' }), afficherSi: (v) => v.equipementId === '' },
      { nom: 'typeCode', label: 'Type d\'intervention', type: 'select', requis: true, options: ui.optionsListe('typesIntervention', { vide: false }) },
      { nom: 'prioriteCode', label: 'Priorité des OT générés', type: 'select', requis: true, options: ui.optionsListe('priorites', { vide: false }) },
      { nom: 'description', label: 'Description / consignes de sécurité', type: 'texte_long', lignes: 2, placeholder: 'Objet du plan, consignes, références constructeur…' },
      { type: 'separateur', label: 'Périodicité et échéances' },
      { nom: 'periodiciteType', label: 'Périodicité en', type: 'select', requis: true, options: TYPES_PERIODICITE, onChange: maj, valider: (v, vals) => (v === 'compteur' && vals.equipementId === '' ? 'Choisissez un équipement : son compteur sert de référence' : '') },
      { nom: 'periodiciteValeur', label: 'Tous les…', type: 'nombre', requis: true, min: 0, step: 'any', onChange: maj, onInput: () => majApercu(m && m.form), valider: (v, vals) => (!(Number(v) > 0) ? 'Valeur strictement positive attendue' : (vals.periodiciteType !== 'compteur' && !Number.isInteger(Number(v)) ? 'Nombre entier de jours, semaines ou mois' : '')) },
      creation ? { nom: 'dateDebut', label: 'Date de départ', type: 'date', onChange: maj, afficherSi: (v) => !estCompteur(v), aide: 'Première échéance = date de départ + période (si elle n\'est pas saisie)' } : null,
      { nom: 'derniereDate', label: 'Dernière réalisation (facultatif)', type: 'date', onChange: maj, afficherSi: (v) => !estCompteur(v), max: ui.aujourdhui() },
      { nom: 'derniereCompteur', label: 'Compteur à la dernière réalisation (facultatif)', type: 'nombre', min: 0, onChange: maj, afficherSi: estCompteur },
      { nom: 'echeanceDate', label: 'Prochaine échéance', type: 'date', onChange: maj, afficherSi: (v) => !estCompteur(v), aide: creation ? 'Vide = calculée automatiquement' : 'Recalculée si la périodicité change (sauf nouvelle date saisie)' },
      { nom: 'echeanceCompteur', label: 'Prochaine échéance (valeur du compteur)', type: 'nombre', min: 0, onChange: maj, afficherSi: estCompteur, aide: 'Vide = compteur (ou dernière réalisation) + période' },
      { nom: 'genererJoursAvant', label: 'Générer l\'OT … jours avant l\'échéance', type: 'nombre', min: 0, max: 365, step: 1, onChange: maj, placeholder: `${refs.horizonJours} (paramètre général)`, valider: (v) => (v != null && !Number.isInteger(Number(v)) ? 'Nombre entier de jours' : '') },
      { nom: 'actif', label: 'Plan actif (génère des ordres de travail)', type: 'booleen' },
      { type: 'html', rendu: () => apercu },
      { type: 'separateur', label: 'Affectation' },
      { nom: 'technicienId', label: 'Technicien responsable', type: 'select', options: [{ value: '', label: '— Non affecté —' }].concat(techniciens), aide: 'Affecté automatiquement aux OT générés' },
      { nom: 'dureeEstimee', label: 'Durée estimée (heures)', type: 'nombre', min: 0, step: 0.25, placeholder: 'somme des durées de la gamme', aide: 'Vide = somme des durées des tâches de la gamme' },
      { type: 'separateur', label: 'Gamme opératoire' },
      { type: 'html', rendu: () => gamme.el },
      { type: 'separateur', label: 'Pièces nécessaires' },
      { type: 'html', rendu: () => pieces.el },
      ...ui.champsPersoDefs('plansPreventifs'),
    ];
    const valeurs = existant ? Object.assign({
      nom: existant.nom, description: existant.description || '', typeCode: existant.typeCode, prioriteCode: existant.prioriteCode,
      equipementId: equipementInitial, secteurId: existant.equipementId == null && existant.secteurId != null ? existant.secteurId : '',
      periodiciteType: p0.type, periodiciteValeur: p0.valeur,
      derniereDate: !compteur0 && existant.derniereExecution ? existant.derniereExecution : '', derniereCompteur: compteur0 ? existant.derniereExecution : null,
      echeanceDate: !compteur0 && existant.prochaineEcheance ? existant.prochaineEcheance : '', echeanceCompteur: compteur0 ? existant.prochaineEcheance : null,
      genererJoursAvant: existant.genererJoursAvant == null ? null : existant.genererJoursAvant, actif: existant.actif !== false,
      technicienId: existant.technicienId == null ? '' : existant.technicienId, dureeEstimee: dureeAuto || existant.dureeEstimee == null ? null : existant.dureeEstimee,
    }, ui.champsPersoInitiaux(existant)) : {
      nom: opts.nom || '', typeCode: codeParDefaut('typesIntervention', 'preventif'), prioriteCode: codeParDefaut('priorites', 'normale'),
      equipementId: equipementInitial, secteurId: '', periodiciteType: 'mois', periodiciteValeur: 1, dateDebut: ui.aujourdhui(), actif: true, technicienId: '',
    };
    m = ui.formModal({
      titre: creation ? 'Nouveau plan de maintenance préventive' : `Modifier le plan ${existant.numero}`, taille: 'tres-large', champs, valeurs,
      submitLabel: creation ? 'Créer le plan' : 'Enregistrer',
      onSubmit: async (v) => {
        const msg = gamme.valider() || pieces.valider();
        if (msg) { toast(msg, 'erreur'); return false; }
        const compteur = v.periodiciteType === 'compteur';
        const body = {
          nom: v.nom, description: v.description, typeCode: v.typeCode, prioriteCode: v.prioriteCode,
          equipementId: v.equipementId === '' ? null : v.equipementId,
          periodicite: { type: v.periodiciteType, valeur: v.periodiciteValeur },
          prochaineEcheance: compteur ? v.echeanceCompteur : (v.echeanceDate || null),
          derniereExecution: compteur ? v.derniereCompteur : (v.derniereDate || null),
          technicienId: v.technicienId === '' ? null : v.technicienId,
          dureeEstimee: v.dureeEstimee, genererJoursAvant: v.genererJoursAvant, actif: !!v.actif,
          gamme: gamme.valeurs(), pieces: pieces.valeurs(), champs: ui.champsPersoValeurs(v),
        };
        if (body.equipementId == null) body.secteurId = v.secteurId === '' ? null : v.secteurId;
        if (creation) body.dateDebut = compteur ? null : (v.dateDebut || null);
        const res = creation ? await api.post('/api/preventif', body) : await api.put('/api/preventif/' + existant.id, body);
        toast(creation ? `Plan ${res.numero} créé` : `Plan ${res.numero} enregistré`, 'succes');
        invalider(); majBadge();
        if (apres) apres(res);
      },
    });
    majApercu(m.form);
  }

  // ----- Actions ----------------------------------------------------------------------------------
  async function genererMaintenant(p, apres) {
    const st = (p.periodicite || {}).type === 'compteur';
    ui.formModal({
      titre: `Générer un OT maintenant — ${p.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Générer l\'OT',
      avant: el('p', { class: 'texte-2' }, `Un ordre de travail va être créé immédiatement pour « ${p.nom} », avec la gamme (${p.nbTaches || 0} tâche${(p.nbTaches || 0) > 1 ? 's' : ''}) et le technicien du plan. ${st ? 'À sa clôture, le relevé de compteur saisi recalculera la prochaine échéance.' : 'À sa clôture, la prochaine échéance sera recalculée depuis la date de réalisation.'}`),
      champs: [{ nom: 'datePrevue', label: 'Date prévue de l\'intervention', type: 'date', requis: true }],
      valeurs: { datePrevue: ui.aujourdhui() },
      onSubmit: async (v) => {
        const r = await api.post(`/api/preventif/${p.id}/generer`, { datePrevue: v.datePrevue });
        toast(`Ordre de travail ${r.ot.numero} généré`, 'succes');
        majBadge();
        if (apres) apres(r.plan, r.ot);
      },
    });
  }
  async function basculerActif(p, apres) {
    const desactiver = p.actif !== false;
    if (desactiver && !(await ui.confirm({ titre: 'Désactiver le plan', message: `Désactiver le plan ${p.numero} ? Plus aucun ordre de travail ne sera généré tant qu'il restera inactif.`, okLabel: 'Désactiver' }))) return;
    try {
      const r = await api.put('/api/preventif/' + p.id, { actif: !desactiver });
      toast(desactiver ? `Plan ${p.numero} désactivé` : `Plan ${p.numero} réactivé`, 'succes');
      majBadge();
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  async function dupliquer(p, apres) {
    const nomCopie = await ui.prompt({ titre: `Dupliquer le plan ${p.numero}`, message: 'La copie reprend la périodicité, la gamme, les pièces et le technicien ; sa première échéance est calculée à partir d\'aujourd\'hui.', label: 'Nom du nouveau plan', valeur: `${p.nom} (copie)`.slice(0, 200), okLabel: 'Dupliquer' });
    if (nomCopie === null) return;
    try {
      const r = await api.post(`/api/preventif/${p.id}/dupliquer`, { nom: nomCopie });
      toast(`Plan ${r.numero} créé par duplication`, 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  async function supprimer(p, apres) {
    const ref = p.nbOt || (p.stats && p.stats.nbOt) || 0;
    const message = ref ? `Le plan ${p.numero} est référencé par ${ref} ordre(s) de travail : il sera désactivé (historique conservé) au lieu d'être supprimé.` : `Supprimer définitivement le plan ${p.numero} « ${p.nom} » ?`;
    if (!(await ui.confirm({ titre: ref ? 'Désactiver le plan' : 'Supprimer le plan', message, okLabel: ref ? 'Désactiver' : 'Supprimer', danger: true }))) return;
    try {
      const r = await api.del('/api/preventif/' + p.id);
      toast(r && r.desactive ? `Plan ${p.numero} désactivé (référencé par des OT)` : `Plan ${p.numero} supprimé`, 'succes');
      majBadge();
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  /** Génération des OT à échéance (tous les plans visibles). */
  function genererEcheances(apres) {
    const horizon = ((GMAO.config || {}).preventif || {}).horizonJours;
    ui.formModal({
      titre: 'Générer les OT à échéance', taille: 'petite', colonnes: 1, submitLabel: 'Générer',
      avant: el('div', null,
        el('p', null, 'Un ordre de travail est créé pour chaque plan actif dont l\'échéance tombe dans son délai de génération (ou est dépassée) et qui n\'a pas déjà un OT ouvert.'),
        el('p', { class: 'texte-2 texte-petit' }, `Délai de génération : celui de chaque plan, à défaut le paramètre général (${horizon != null ? horizon : 30} jours).`)),
      champs: [{ nom: 'horizonJours', label: 'Forcer un horizon pour cette génération (jours)', type: 'nombre', min: 0, max: 365, step: 1, placeholder: 'délai propre à chaque plan', valider: (v) => (v != null && !Number.isInteger(Number(v)) ? 'Nombre entier de jours' : '') }],
      onSubmit: async (v) => {
        const r = await api.post('/api/preventif/generer', v.horizonJours != null ? { horizonJours: v.horizonJours } : {});
        afficherRapport(r);
        majBadge();
        if (apres) apres(r);
      },
    });
  }
  function afficherRapport(r) {
    if (!r.nb && !r.erreurs.length) toast(r.ignores.length ? `Aucun OT généré (${r.ignores.length} plan(s) à échéance déjà couverts ou ignorés)` : 'Aucun plan n\'est arrivé à échéance', 'info');
    else toast(`${r.nb} ordre${r.nb > 1 ? 's' : ''} de travail généré${r.nb > 1 ? 's' : ''}`, r.erreurs.length ? 'alerte' : 'succes');
    if (!r.nb && !r.erreurs.length && !r.ignores.length) return;
    const lienPlan = (x) => el('a', { href: '#/preventif/' + x.planId, onclick: () => ui.fermerModales() }, `${x.planNumero} — ${x.planNom}`);
    const contenu = el('div');
    if (r.generes.length) contenu.appendChild(ui.carte(`Ordres de travail générés (${r.generes.length})`, el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' },
      el('thead', null, el('tr', null, el('th', null, 'OT'), el('th', null, 'Plan'), el('th', null, 'Date prévue'))),
      el('tbody', null, r.generes.map((g) => el('tr', null, el('td', null, GMAO.can('ot', 'voir') ? el('a', { href: '#/ot/' + g.otId, onclick: () => ui.fermerModales() }, g.otNumero) : g.otNumero), el('td', null, lienPlan(g)), el('td', null, ui.formatDate(g.datePrevue)))))))));
    if (r.ignores.length) contenu.appendChild(ui.carte(`Plans à échéance ignorés (${r.ignores.length})`, el('ul', { style: { margin: '0', paddingLeft: '18px' } }, r.ignores.map((x) => el('li', null, lienPlan(x), el('span', { class: 'texte-2' }, ' — ' + x.motif))))));
    if (r.erreurs.length) contenu.appendChild(ui.alerte(frag(el('strong', null, 'Erreurs : '), r.erreurs.map((x) => `${x.planNumero} : ${x.message}`).join(' ; ')), 'alerte'));
    ui.modal({ titre: 'Résultat de la génération', taille: 'large', contenu, boutons: [{ label: 'Fermer', classe: 'btn-primaire' }] });
  }
  function exporter(filtres) {
    const q = new URLSearchParams();
    for (const k of ['etat', 'secteurId', 'equipementId', 'technicienId', 'typeCode', 'recherche']) if (filtres[k]) q.set(k, filtres[k]);
    api.telecharger('/api/preventif-export' + (q.toString() ? '?' + q.toString() : ''), `plans-preventifs-${ui.aujourdhui()}.csv`).then(() => toast('Export CSV généré', 'succes')).catch(erreur);
  }
  function imprimerGamme(p) {
    const esc = ui.esc;
    const unite = p.uniteCompteur;
    let html = `<h1>${esc(p.numero)} — ${esc(p.nom)}</h1><dl>`;
    const ligne = (l, v) => { html += `<dt>${esc(l)}</dt><dd>${esc(v == null || v === '' ? '—' : v)}</dd>`; };
    ligne('Équipement', p.equipementNom ? `${p.equipementNom}${p.equipementNumero ? ' (' + p.equipementNumero + ')' : ''}` : 'Plan général');
    ligne('Secteur', p.secteurChemin);
    ligne('Type', ui.libelle('typesIntervention', p.typeCode));
    ligne('Périodicité', periodiciteLisible(p.periodicite, unite));
    ligne('Dernière exécution', valeurEcheance(p.periodicite, p.derniereExecution, unite));
    ligne('Prochaine échéance', valeurEcheance(p.periodicite, p.echeance, unite));
    ligne('Technicien', p.technicienNom || 'Non affecté');
    ligne('Durée estimée', p.dureeEstimee != null ? ui.formatDuree(p.dureeEstimee) : '');
    html += '</dl>';
    if (p.description) html += `<h2>Description</h2><p>${esc(p.description)}</p>`;
    html += '<h2>Gamme opératoire</h2><table><thead><tr><th style="width:36px">N°</th><th>Opération</th><th style="width:80px">Durée</th><th style="width:60px">Fait</th><th style="width:160px">Observations</th></tr></thead><tbody>';
    html += (p.gamme || []).map((t) => `<tr><td>${t.ordre}</td><td>${esc(t.libelle)}</td><td>${esc(t.duree != null ? ui.formatDuree(t.duree) : '')}</td><td>☐</td><td></td></tr>`).join('') || '<tr><td colspan="5">Aucune tâche</td></tr>';
    html += '</tbody></table>';
    if ((p.pieces || []).length) html += '<h2>Pièces nécessaires</h2><table><thead><tr><th>Code</th><th>Désignation</th><th>Quantité</th></tr></thead><tbody>' + p.pieces.map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.designation)}</td><td>${esc(nf(x.quantite))}</td></tr>`).join('') + '</tbody></table>';
    html += '<div class="signature"><div>Intervenant — date / visa</div><div>Responsable maintenance — visa</div></div>';
    ui.imprimer(`Gamme ${p.numero}`, html);
  }

  // ----- Fiche ----------------------------------------------------------------------------------
  async function rendreFiche(container, id) {
    let p;
    try { p = await api.get('/api/preventif/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: 'Plan préventif introuvable', icone: 'preventif', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/preventif' }, { label: '#' + id }] }));
      container.appendChild(ui.vide(e.message || 'Ce plan n\'existe pas ou n\'est pas dans votre périmètre.', 'alerte'));
      return;
    }
    afficherFiche(container, p);
  }

  function afficherFiche(container, p) {
    const a = p.actions || {};
    const unite = p.uniteCompteur;
    const compteur = (p.periodicite || {}).type === 'compteur';
    const maj = (n) => {
      if (!container.isConnected || !n) return;
      const y = window.scrollY;
      ui.vider(container);
      afficherFiche(container, n);
      window.scrollTo(0, y);
    };
    const recharger = async () => { try { maj(await api.get('/api/preventif/' + p.id)); } catch (e) { erreur(e); } };
    const actions = [
      a.generer ? ui.bouton('Générer un OT maintenant', { icone: 'ot', classe: 'btn-primaire', onClic: () => genererMaintenant(p, (plan) => maj(plan)) }) : null,
      p.otOuvertId && GMAO.can('ot', 'voir') ? ui.bouton(`OT en cours : ${p.otOuvertNumero}`, { icone: 'voir', onClic: () => GMAO.navigate('#/ot/' + p.otOuvertId) }) : null,
      a.modifier ? ui.bouton('Modifier', { icone: 'modifier', onClic: () => ouvrirFormulaire(p, {}, maj) }) : null,
      a.dupliquer ? ui.bouton('Dupliquer', { icone: 'copier', onClic: () => dupliquer(p, (r) => GMAO.navigate('#/preventif/' + r.id)) }) : null,
      a.modifier ? ui.bouton(p.actif === false ? 'Réactiver' : 'Désactiver', { icone: p.actif === false ? 'lecture' : 'pause', onClic: () => basculerActif(p, maj) }) : null,
      ui.bouton('Imprimer la gamme', { icone: 'imprimer', onClic: () => imprimerGamme(p) }),
      a.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'texte-danger', onClic: () => supprimer(p, (r) => { if (r && r.desactive) recharger(); else GMAO.navigate('#/preventif'); }) }) : null,
    ];
    container.appendChild(ui.pageEntete({
      titre: `${p.numero} — ${p.nom}`, icone: 'preventif', actions,
      filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/preventif' }, { label: p.numero }],
      sousTitre: el('span', { class: 'inline', style: { flexWrap: 'wrap' } }, badgeEtat(p.etat), ui.badgeListe('typesIntervention', p.typeCode), ui.badgeListe('priorites', p.prioriteCode),
        el('span', null, ico('horloge', 13), ' ', periodiciteLisible(p.periodicite, unite)),
        p.equipementId ? el('span', null, ico('equipements', 13), ' ', GMAO.can('equipements', 'voir') ? el('a', { href: '#/equipements/' + p.equipementId }, p.equipementNom) : p.equipementNom) : el('span', { class: 'texte-2' }, 'Plan général'),
        el('span', { class: 'texte-2' }, `Créé par ${p.createdByNom || '—'} le ${ui.formatDate(p.createdAt)}`)),
    }));

    // Alertes contextuelles
    if (p.actif === false) container.appendChild(ui.alerte(frag(el('strong', null, 'Plan inactif : '), 'aucun ordre de travail n\'est généré.', a.modifier ? ' Utilisez « Réactiver » pour le remettre en service.' : ''), 'info'));
    else if (p.equipement && p.equipement.actif === false) container.appendChild(ui.alerte(`L'équipement « ${p.equipementNom} » est inactif : aucun ordre de travail ne sera généré pour ce plan.`, 'alerte'));
    if (p.actif !== false && p.etat === 'en_retard') {
      container.appendChild(ui.alerte(frag(el('strong', null, 'Échéance dépassée'), compteur ? ` : compteur à ${nf(p.compteurActuel)} ${uniteAbregee(unite)} pour une échéance à ${nf(p.echeance)} ${uniteAbregee(unite)}.` : ` depuis le ${ui.formatDate(p.echeance)} (${texteRestant(p)}).`,
        p.otOuvertId ? frag(' Intervention en cours : ', GMAO.can('ot', 'voir') ? el('a', { href: '#/ot/' + p.otOuvertId }, p.otOuvertNumero) : p.otOuvertNumero, ` (${p.otOuvertStatutLibelle || ''}).`) : (a.generer ? ' Aucun ordre de travail n\'est ouvert : générez-le maintenant.' : ' Aucun ordre de travail n\'est ouvert.')), 'alerte'));
    } else if (p.actif !== false && p.etat === 'proche' && !p.otOuvertId) {
      container.appendChild(ui.alerte(`Échéance proche (${texteRestant(p)}) : l'ordre de travail sera généré automatiquement ${GMAO.config.preventif && GMAO.config.preventif.genererAuto === false ? 'via « Générer les OT à échéance »' : 'dans l\'heure'}.`, 'info'));
    }
    if (p.otAnnule) container.appendChild(ui.alerte(frag(`L'OT `, GMAO.can('ot', 'voir') ? el('a', { href: '#/ot/' + p.otAnnule.id }, p.otAnnule.numero) : p.otAnnule.numero, ' généré pour cette échéance a été annulé : il ne sera pas régénéré automatiquement. Générez un nouvel OT ou reportez l\'échéance (Modifier).'), 'alerte'));

    // Indicateurs
    const s = p.stats || {};
    const coulEtat = (ETATS[p.etat] || ETATS.a_jour).couleur;
    container.appendChild(el('div', { class: 'grille grille-4 mb' },
      ui.kpi({ label: 'Prochaine échéance', valeur: valeurEcheance(p.periodicite, p.echeance, unite), icone: 'planning', couleur: coulEtat, detail: texteRestant(p) + (compteur && p.compteurActuel != null ? ` · compteur ${nf(p.compteurActuel)} ${uniteAbregee(unite)}` : '') }),
      ui.kpi({ label: 'Dernière exécution', valeur: valeurEcheance(p.periodicite, p.derniereExecution, unite), icone: 'check', couleur: '#2563eb', detail: compteur && p.derniereExecutionDate ? `le ${ui.formatDate(p.derniereExecutionDate)}` : (p.derniereExecution ? (() => { const j = ui.joursEntre(p.derniereExecution, ui.aujourdhui()); return j > 1 ? `il y a ${j} jours` : (j === 1 ? 'hier' : 'aujourd\'hui'); })() : 'jamais réalisé') }),
      ui.kpi({ label: 'Réalisations', valeur: s.nbTermines || 0, icone: 'ot', couleur: '#8b5cf6', detail: s.tauxRespect != null ? `${s.tauxRespect} % dans les délais` + (s.nbAnnules ? ` · ${s.nbAnnules} annulé(s)` : '') : (s.nbOuverts ? `${s.nbOuverts} OT en cours` : 'aucun OT réalisé') }),
      ui.kpi({ label: 'Durée estimée', valeur: p.dureeEstimee != null ? ui.formatDuree(p.dureeEstimee) : '—', icone: 'horloge', couleur: '#f59e0b', detail: `${p.nbTaches ? `${p.nbTaches} tâche${p.nbTaches > 1 ? 's' : ''}` : 'aucune tâche'}${s.tempsMoyen ? ' · réalisé en ' + ui.formatDuree(s.tempsMoyen) + ' en moyenne' : ''}` })));

    container.appendChild(ui.onglets([
      { cle: 'details', label: 'Détails', icone: 'info', rendu: () => rendreDetails(p) },
      { cle: 'gamme', label: 'Gamme', icone: 'liste', badge: p.nbTaches || null, rendu: () => rendreGamme(p) },
      { cle: 'pieces', label: 'Pièces', icone: 'piece', badge: (p.pieces || []).length || null, rendu: () => rendrePieces(p) },
      { cle: 'historique', label: 'Historique des OT', icone: 'ot', badge: s.nbOt || null, rendu: () => rendreHistorique(p) },
    ], { hash: true }).el);
  }

  function rendreDetails(p) {
    const unite = p.uniteCompteur;
    const compteur = (p.periodicite || {}).type === 'compteur';
    const horizonGeneral = ((GMAO.config || {}).preventif || {}).horizonJours;
    const cont = el('div', { class: 'grille grille-2' });
    cont.appendChild(ui.carte('Informations', ui.details([
      { label: 'Numéro', valeur: p.numero }, { label: 'Nom', valeur: p.nom },
      { label: 'Équipement', valeur: p.equipementId ? frag(GMAO.can('equipements', 'voir') ? el('a', { href: '#/equipements/' + p.equipementId }, p.equipementNom) : p.equipementNom, p.equipementNumero ? el('span', { class: 'texte-2' }, ` (${p.equipementNumero})`) : null) : 'Plan général (sans équipement)' },
      { label: 'Secteur', valeur: p.secteurChemin || '—' },
      { label: 'Localisation', valeur: p.equipement ? p.equipement.localisation : '' },
      { label: 'Type d\'intervention', valeur: ui.badgeListe('typesIntervention', p.typeCode) },
      { label: 'Priorité des OT', valeur: ui.badgeListe('priorites', p.prioriteCode) },
      { label: 'Technicien responsable', valeur: p.technicienId ? ui.nomUser(p.technicienId) : el('span', { class: 'texte-2' }, 'Non affecté') },
      { label: 'Statut', valeur: p.actif === false ? ui.badge('Inactif', '#6b7280') : ui.badge('Actif', '#16a34a') },
      ...ui.champsPersoAffichage('plansPreventifs', p),
    ])));
    cont.appendChild(ui.carte('Périodicité et échéances', ui.details([
      { label: 'Périodicité', valeur: periodiciteLisible(p.periodicite, unite) },
      compteur ? { label: 'Compteur actuel', valeur: p.compteurActuel != null ? `${nf(p.compteurActuel)} ${p.uniteCompteur || ''}` : 'non renseigné' } : { label: 'Date de départ', valeur: p.dateDebut ? ui.formatDate(p.dateDebut) : '' },
      compteur && p.rythmeJour ? { label: 'Rythme d\'utilisation', valeur: `≈ ${nf(p.rythmeJour)} ${uniteAbregee(unite)} / jour` } : null,
      { label: 'Dernière exécution', valeur: valeurEcheance(p.periodicite, p.derniereExecution, unite) + (compteur && p.derniereExecutionDate ? ` (le ${ui.formatDate(p.derniereExecutionDate)})` : '') },
      { label: 'Prochaine échéance', valeur: frag(valeurEcheance(p.periodicite, p.echeance, unite), ' ', badgeEtat(p.etat)) },
      compteur ? { label: 'Date estimée', valeur: p.echeanceEstimee && p.echeanceDate ? ui.formatDate(p.echeanceDate) : 'non estimable (relevés de compteur insuffisants)' } : null,
      { label: 'Génération de l\'OT', valeur: p.genererJoursAvant != null ? `${p.genererJoursAvant} jour(s) avant l'échéance` : `${horizonGeneral != null ? horizonGeneral : p.horizonJours} jours avant l'échéance (paramètre général)` },
      { label: 'Dernière génération', valeur: p.derniereGeneration ? ui.formatDateHeure(p.derniereGeneration) : 'jamais' },
      { label: 'OT en cours', valeur: p.otOuvertId ? lienOt(p.otOuvertId, p.otOuvertNumero, p.otOuvertStatut) : '—' },
    ].filter(Boolean))));
    const bloc = el('div', null, cont);
    if (p.description) bloc.appendChild(ui.carte('Description / consignes', el('p', { style: { margin: '0', whiteSpace: 'pre-wrap' } }, p.description)));
    const prochaines = p.prochainesEcheances || [];
    bloc.appendChild(ui.carte('Prochaines échéances', prochaines.length ? el('ul', { class: 'chronologie' }, prochaines.map((x, i) => el('li', null,
      el('div', { class: 'inline', style: { flexWrap: 'wrap' } }, el('strong', null, x.date ? ui.formatDate(x.date) : 'Date non estimable'), compteur && x.valeurCompteur != null ? el('span', null, `à ${nf(x.valeurCompteur)} ${uniteAbregee(unite)}`) : null, i === 0 ? badgeEtat(x.etat) : null),
      el('div', { class: 'chrono-date' }, x.estimee ? 'date estimée d\'après le rythme d\'utilisation' : (i === 0 ? 'prochaine échéance' : `échéance n°${i + 1} (projection)`)))))
      : el('p', { class: 'texte-2', style: { margin: '0' } }, p.actif === false ? 'Plan inactif.' : 'Aucune échéance prévue dans les deux prochaines années.')));
    return bloc;
  }

  function rendreGamme(p) {
    const gamme = p.gamme || [];
    if (!gamme.length) return ui.carte('Gamme opératoire', el('div', null, ui.vide('Aucune tâche définie pour ce plan.', 'liste'), p.actions && p.actions.modifier ? el('div', { class: 'texte-centre' }, ui.bouton('Définir la gamme', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(p, {}, () => GMAO.rendre()) })) : null));
    const total = gamme.reduce((s, t) => s + (Number(t.duree) || 0), 0);
    return ui.carte(`Gamme opératoire (${gamme.length} tâche${gamme.length > 1 ? 's' : ''})`, frag(
      ui.table({
        lignes: gamme, recherche: false, pagination: false, compact: true,
        colonnes: [
          { cle: 'ordre', label: 'N°', largeur: '50px', aligner: 'centre' },
          { cle: 'libelle', label: 'Opération' },
          { cle: 'duree', label: 'Durée', aligner: 'droite', largeur: '110px', rendu: (t) => (t.duree != null ? ui.formatDuree(t.duree) : el('span', { class: 'texte-2' }, '—')) },
        ],
      }).el,
      el('p', { class: 'texte-2 texte-petit', style: { marginBottom: '0' } }, `Durée totale de la gamme : ${total ? ui.formatDuree(total) : 'non renseignée'}${p.dureeEstimee != null && Number(p.dureeEstimee) !== total ? ` · durée estimée du plan : ${ui.formatDuree(p.dureeEstimee)}` : ''}. La gamme est copiée dans chaque ordre de travail généré.`)),
      { actions: ui.bouton('Imprimer', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerGamme(p) }) });
  }

  function rendrePieces(p) {
    const pieces = p.pieces || [];
    if (!pieces.length) return ui.carte('Pièces nécessaires', ui.vide('Aucune pièce prévue pour ce plan.', 'piece'));
    return ui.carte(`Pièces nécessaires (${pieces.length})`, ui.table({
      lignes: pieces, recherche: false, pagination: false, compact: true, cleId: 'articleId',
      colonnes: [
        { cle: 'code', label: 'Code', largeur: '120px', rendu: (x) => x.code || '—' },
        { cle: 'designation', label: 'Désignation', rendu: (x) => (x.introuvable ? el('span', { class: 'texte-danger' }, x.designation) : x.designation) },
        { cle: 'quantite', label: 'Quantité', aligner: 'droite', rendu: (x) => `${nf(x.quantite)}${uniteArticle(x.uniteCode, x.quantite)}` },
        { cle: 'disponible', label: 'En stock', aligner: 'droite', rendu: (x) => (x.disponible == null ? '—' : el('span', { class: x.disponible < x.quantite ? 'texte-danger texte-gras' : 'texte-ok' }, nf(x.disponible), x.disponible < x.quantite ? ' (insuffisant)' : '')) },
      ],
    }).el);
  }

  function rendreHistorique(p) {
    if (!p.historiqueVisible) return ui.carte('Historique des ordres de travail', el('p', { class: 'texte-2', style: { margin: '0' } }, 'Vous n\'avez pas accès au module Ordres de travail.'));
    const s = p.stats || {};
    const ots = p.historique || [];
    const resumeStats = el('div', { class: 'inline texte-2 texte-petit mb', style: { flexWrap: 'wrap', gap: '14px' } },
      el('span', null, `${s.nbOt || 0} OT générés`), el('span', null, `${s.nbTermines || 0} réalisé(s)`), el('span', null, `${s.nbOuverts || 0} en cours`), s.nbAnnules ? el('span', null, `${s.nbAnnules} annulé(s)`) : null,
      s.tauxRespect != null ? el('span', null, `Respect des délais : ${s.tauxRespect} %`) : null,
      s.ecartMoyenJours != null ? el('span', null, `Écart moyen : ${s.ecartMoyenJours > 0 ? '+' : ''}${nf(s.ecartMoyenJours)} j`) : null);
    if (!ots.length) return ui.carte('Historique des ordres de travail', el('div', null, ui.vide('Aucun ordre de travail n\'a encore été généré pour ce plan.', 'ot')));
    return ui.carte('Historique des ordres de travail', frag(resumeStats, ui.table({
      lignes: ots, recherche: false, compact: true, triInitial: { cle: 'datePrevue', sens: 'desc' },
      onClic: GMAO.can('ot', 'voir') ? (o) => GMAO.navigate('#/ot/' + o.id) : null,
      ligneClasse: (o) => (o.annule ? 'inactif' : ''),
      colonnes: [
        { cle: 'numero', label: 'OT', largeur: '120px', rendu: (o) => el('span', { class: 'cellule-principale' }, o.numero) },
        { cle: 'titre', label: 'Intitulé', rendu: (o) => el('div', null, o.titre, o.nbTaches ? el('div', { class: 'cellule-secondaire' }, `${o.nbTachesFaites}/${o.nbTaches} tâches`) : null) },
        { cle: 'statut', label: 'Statut', liste: 'statutsOT', aligner: 'centre' },
        { cle: 'datePrevue', label: 'Prévu le', rendu: (o) => el('span', { class: o.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(o.datePrevue) || '—'), valeurTri: (o) => o.datePrevue || '' },
        { cle: 'dateFin', label: 'Réalisé le', rendu: (o) => (o.final && !o.annule ? ui.formatDate(o.dateFin) : '—'), valeurTri: (o) => o.dateFin || '' },
        { cle: 'ecartJours', label: 'Écart', aligner: 'centre', rendu: (o) => (o.ecartJours == null ? '—' : el('span', { class: o.ecartJours > 0 ? 'texte-danger' : 'texte-ok', title: 'Écart entre la date prévue et la date de réalisation' }, o.ecartJours > 0 ? `+${o.ecartJours} j` : (o.ecartJours === 0 ? 'à date' : `${o.ecartJours} j`))) },
        { cle: 'technicienId', label: 'Technicien', rendu: (o) => o.technicienNom || el('span', { class: 'texte-2' }, 'Non affecté') },
        { cle: 'tempsTotal', label: 'Temps passé', aligner: 'droite', rendu: (o) => (o.tempsTotal ? ui.formatDuree(o.tempsTotal) : '—') },
        p.periodicite && p.periodicite.type === 'compteur' ? { cle: 'compteurReleve', label: 'Relevé', aligner: 'droite', rendu: (o) => (o.compteurReleve != null ? `${nf(o.compteurReleve)} ${uniteAbregee(p.uniteCompteur)}` : '—') } : null,
      ].filter(Boolean),
    }).el));
  }

  // ----- Échéancier (12 mois) --------------------------------------------------------------------
  function libelleMois(cle) { const [y, m] = cle.split('-').map(Number); const n = MOIS[m - 1] || ''; return `${n.charAt(0).toUpperCase()}${n.slice(1)} ${y}`; }
  function rendreEcheancier(cont, planVisible) {
    cont.appendChild(ui.chargement('Calcul de l\'échéancier…'));
    api.get('/api/preventif-echeances', { jours: 365, nonDatees: '1' }).then((occ) => {
      if (!cont.isConnected) return;
      ui.vider(cont);
      const lignes = occ.filter((o) => planVisible(o.planId));
      const aujourdhui = ui.aujourdhui();
      const groupeDe = (o) => (o.enRetard || (o.date && o.date < aujourdhui) ? '0000-retard' : (o.date ? o.date.slice(0, 7) : '9999-compteur'));
      const parMois = new Map();
      for (const o of lignes) { const g = groupeDe(o); if (!parMois.has(g)) parMois.set(g, []); parMois.get(g).push(o); }
      // Charge prévisionnelle (heures) sur les 12 mois glissants
      const d0 = new Date();
      const mois = Array.from({ length: 12 }, (_, i) => { const d = new Date(d0.getFullYear(), d0.getMonth() + i, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
      const charge = mois.map((k) => ({ cle: k, rows: (parMois.get(k) || []).concat(k === mois[0] ? parMois.get('0000-retard') || [] : []) }));
      const totalHeures = lignes.reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0);
      cont.appendChild(el('div', { class: 'grille grille-4 mb' },
        ui.kpi({ label: 'Échéances sur 12 mois', valeur: lignes.filter((o) => o.date).length, icone: 'planning', couleur: '#2563eb', detail: `${new Set(lignes.map((o) => o.planId)).size} plan(s) concerné(s)` }),
        ui.kpi({ label: 'En retard', valeur: (parMois.get('0000-retard') || []).length, icone: 'alerte', couleur: (parMois.get('0000-retard') || []).length ? '#dc2626' : '#16a34a', detail: 'échéances dépassées' }),
        ui.kpi({ label: 'Charge prévisionnelle', valeur: ui.formatDuree(totalHeures) || '0 h', icone: 'horloge', couleur: '#8b5cf6', detail: 'somme des durées estimées' }),
        ui.kpi({ label: 'Sur compteur non datées', valeur: (parMois.get('9999-compteur') || []).length, icone: 'rafraichir', couleur: '#6b7280', detail: 'relevés insuffisants pour estimer' })));
      cont.appendChild(ui.carte('Charge prévisionnelle par mois (heures estimées)', ui.graphiqueBarres(charge.map((c) => ({
        label: `${(MOIS[Number(c.cle.slice(5)) - 1] || '').slice(0, 4)}. ${c.cle.slice(2, 4)}`,
        valeur: Math.round(c.rows.reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0) * 10) / 10,
        couleur: c.rows.some((o) => o.enRetard) ? '#dc2626' : undefined,
      }))), { actions: ui.bouton('Imprimer l\'échéancier', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerEcheancier(lignes, groupeDe) }) }));
      const table = ui.table({
        lignes, recherche: 'Rechercher une échéance…', pagination: false, compact: true,
        onClic: (o) => GMAO.navigate('#/preventif/' + o.planId),
        groupe: {
          cle: groupeDe,
          label: (g, rows) => {
            const h = rows.reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0);
            const titre = g === '0000-retard' ? 'En retard' : (g === '9999-compteur' ? 'Sur compteur — date non estimable' : libelleMois(g));
            return frag(g === '0000-retard' ? ui.pastille('#dc2626') : null, el('span', null, titre), el('span', { class: 'texte-2' }, ` · ${rows.length} échéance${rows.length > 1 ? 's' : ''}${h ? ' · ' + ui.formatDuree(h) + ' prévues' : ''}`));
          },
        },
        vide: 'Aucune échéance sur les 12 prochains mois',
        colonnes: [
          { cle: 'date', label: 'Date', largeur: '120px', rendu: (o) => el('div', null, el('span', { class: 'texte-gras' }, o.date ? ui.formatDate(o.date) : '—'), o.estimee ? el('div', { class: 'cellule-secondaire' }, 'estimée') : null), valeurTri: (o) => o.date || '9999' },
          { cle: 'numero', label: 'Plan', rendu: (o) => el('div', null, el('div', { class: 'cellule-principale' }, o.nom), el('div', { class: 'cellule-secondaire' }, `${o.numero} · ${o.periodiciteLibelle}`)) },
          { cle: 'equipementNom', label: 'Équipement', rendu: (o) => o.equipementNom || el('span', { class: 'texte-2' }, 'Plan général') },
          { cle: 'valeurCompteur', label: 'Compteur', aligner: 'droite', rendu: (o) => (o.valeurCompteur != null ? `${nf(o.valeurCompteur)} ${uniteAbregee(o.uniteCompteur)}` : '—') },
          { cle: 'technicienNom', label: 'Technicien', rendu: (o) => o.technicienNom || el('span', { class: 'texte-2' }, 'Non affecté') },
          { cle: 'dureeEstimee', label: 'Durée', aligner: 'droite', rendu: (o) => (o.dureeEstimee != null ? ui.formatDuree(o.dureeEstimee) : '—') },
          { cle: 'etat', label: 'État', aligner: 'centre', rendu: (o) => (o.occurrence === 0 ? badgeEtat(o.etat) : el('span', { class: 'texte-2 texte-petit' }, 'prévisionnelle')) },
          { cle: 'otOuvertId', label: 'OT', rendu: (o) => (o.otOuvertId ? lienOt(o.otOuvertId, o.otOuvertNumero, null) : el('span', { class: 'texte-2' }, '—')) },
        ],
      });
      cont.appendChild(table.el);
    }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'alerte')); });
  }
  function imprimerEcheancier(lignes, groupeDe) {
    const esc = ui.esc;
    const groupes = new Map();
    for (const o of lignes) { const g = groupeDe(o); if (!groupes.has(g)) groupes.set(g, []); groupes.get(g).push(o); }
    let html = '<h1>Échéancier de maintenance préventive (12 mois)</h1>';
    for (const g of Array.from(groupes.keys()).sort()) {
      html += `<h2>${esc(g === '0000-retard' ? 'En retard' : g === '9999-compteur' ? 'Sur compteur — date non estimable' : libelleMois(g))}</h2><table><thead><tr><th>Date</th><th>Plan</th><th>Équipement</th><th>Technicien</th><th>Durée</th></tr></thead><tbody>`;
      html += groupes.get(g).map((o) => `<tr><td>${esc(o.date ? ui.formatDate(o.date) : '—')}${o.estimee ? ' (est.)' : ''}</td><td>${esc(o.numero)} — ${esc(o.nom)}</td><td>${esc(o.equipementNom || '—')}</td><td>${esc(o.technicienNom || '—')}</td><td>${esc(o.dureeEstimee != null ? ui.formatDuree(o.dureeEstimee) : '')}</td></tr>`).join('');
      html += '</tbody></table>';
    }
    ui.imprimer('Échéancier préventif', html);
  }

  // ----- Liste ----------------------------------------------------------------------------------
  async function rendreListe(container, query) {
    let plans = [];
    let compteurs = null;
    const nouveau = query.nouveau === '1' || query.nouveau === 'true';
    const filtres = {
      recherche: '', etat: ETATS[query.etat] ? query.etat : '', secteurId: query.secteurId || '',
      equipementId: !nouveau && query.equipementId ? String(query.equipementId) : '', technicienId: '', typeCode: '',
    };
    let ongletsListe = null;

    const tableau = ui.table({
      lignes: [], recherche: false, exportCsv: false, compact: true,
      triInitial: { cle: 'echeance', sens: 'asc' },
      onClic: (p) => GMAO.navigate('#/preventif/' + p.id),
      ligneClasse: (p) => (p.actif === false ? 'inactif' : ''),
      vide: 'Aucun plan de maintenance préventive',
      colonnes: [
        { cle: 'numero', label: 'Numéro', rendu: (p) => el('span', { class: 'cellule-principale', style: { whiteSpace: 'nowrap' } }, p.numero), valeurTri: (p) => p.numero },
        { cle: 'nom', label: 'Plan', rendu: (p) => el('div', { style: { minWidth: '180px' } }, el('div', { class: 'cellule-principale' }, p.nom), el('div', { class: 'cellule-secondaire' }, [ui.libelle('typesIntervention', p.typeCode), p.nbTaches ? `${p.nbTaches} tâche${p.nbTaches > 1 ? 's' : ''}` : 'sans gamme', p.dureeEstimee != null ? ui.formatDuree(p.dureeEstimee) : '', (p.pieces || []).length ? `${p.pieces.length} pièce${p.pieces.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '))), valeurTri: (p) => String(p.nom || '').toLowerCase() },
        { cle: 'equipementNom', label: 'Équipement', rendu: lienEquipement, valeurTri: (p) => String(p.equipementNom || 'zzz').toLowerCase() },
        { cle: 'periodicite', label: 'Périodicité', rendu: (p) => el('div', { style: { whiteSpace: 'nowrap' } }, el('div', null, periodiciteLisible(p.periodicite, p.uniteCompteur)),
          el('div', { class: 'cellule-secondaire', title: 'Dernière exécution' }, p.derniereExecution == null || p.derniereExecution === '' ? 'jamais réalisé' : ((p.periodicite || {}).type === 'compteur' ? `fait à ${valeurEcheance(p.periodicite, p.derniereExecution, p.uniteCompteur)}` : `fait le ${ui.formatDate(p.derniereExecution)}`))),
          valeurTri: (p) => { const q = p.periodicite || {}; return q.type === 'compteur' ? 1e9 + Number(q.valeur) : Number(q.valeur) * ({ jours: 1, semaines: 7, mois: 30 }[q.type] || 1); } },
        { cle: 'echeance', label: 'Prochaine échéance', rendu: celluleEcheance, valeurTri: (p) => `${(ETATS[p.etat] || ETATS.a_jour).rang}-${p.echeanceDate || '9999-12-31'}` },
        { cle: 'technicienNom', label: 'Technicien', rendu: (p) => p.technicienNom || el('span', { class: 'texte-2' }, 'Non affecté'), valeurTri: (p) => String(p.technicienNom || 'zzz').toLowerCase() },
        { cle: 'otOuvertId', label: 'OT en cours', rendu: (p) => lienOt(p.otOuvertId, p.otOuvertNumero, p.otOuvertStatut), valeurTri: (p) => p.otOuvertNumero || 'zzz' },
      ],
      actions: [
        { icone: 'ot', titre: 'Générer un OT maintenant', visible: (p) => can('modifier') && p.actif !== false && !p.otOuvertId && !(p.equipement && p.equipement.actif === false), onClic: (p) => genererMaintenant(p, () => rafraichir()) },
        { icone: 'modifier', titre: 'Modifier', visible: () => can('modifier'), onClic: async (p) => { try { ouvrirFormulaire(await api.get('/api/preventif/' + p.id), {}, rafraichir); } catch (e) { erreur(e); } } },
      ],
    });

    function correspond(p, sansEtat) {
      if (!sansEtat && filtres.etat && p.etat !== filtres.etat) return false;
      if (filtres.secteurId) {
        const ids = new Set([Number(filtres.secteurId)]);
        let ajout = true;
        while (ajout) { ajout = false; for (const s of GMAO.refs.secteurs || []) if (s.parentId != null && ids.has(Number(s.parentId)) && !ids.has(s.id)) { ids.add(s.id); ajout = true; } }
        if (p.secteurId == null || !ids.has(Number(p.secteurId))) return false;
      }
      if (filtres.equipementId && String(p.equipementId) !== filtres.equipementId) return false;
      if (filtres.technicienId === 'aucun' && p.technicienId != null) return false;
      if (filtres.technicienId && filtres.technicienId !== 'aucun' && String(p.technicienId) !== filtres.technicienId) return false;
      if (filtres.typeCode && p.typeCode !== filtres.typeCode) return false;
      if (filtres.recherche) {
        const s = filtres.recherche.toLowerCase();
        if (![p.numero, p.nom, p.description, p.equipementNom, p.equipementNumero, p.technicienNom, p.secteurChemin, periodiciteLisible(p.periodicite, p.uniteCompteur), (p.gamme || []).map((t) => t.libelle).join(' ')].some((v) => String(v || '').toLowerCase().includes(s))) return false;
      }
      return true;
    }
    const compteurTexte = el('span', { class: 'texte-2 texte-petit' });
    let zoneEcheancier = null;
    function appliquer() {
      const rows = plans.filter((p) => correspond(p, false));
      tableau.maj(rows);
      compteurTexte.textContent = `${rows.length} plan${rows.length > 1 ? 's' : ''}`;
      if (zoneEcheancier && zoneEcheancier.isConnected && ongletsListe && ongletsListe.actif === 'echeancier') { ui.vider(zoneEcheancier); rendreEcheancier(zoneEcheancier, planVisible); }
    }
    const planVisible = (id) => { const p = plans.find((x) => x.id === id); return !!p && correspond(p, true); };

    // Indicateurs
    const kpis = el('div', { class: 'grille grille-4 mb' });
    function rendreKpis() {
      ui.vider(kpis);
      if (!compteurs) return;
      const filtrerEtat = (e) => () => { filtres.etat = e; selEtat.value = e; if (ongletsListe) ongletsListe.activer('plans'); appliquer(); };
      kpis.appendChild(ui.kpi({ label: 'Plans actifs', valeur: compteurs.actifs, icone: 'preventif', couleur: '#2563eb', detail: `${compteurs.inactifs} inactif${compteurs.inactifs > 1 ? 's' : ''} · ${compteurs.otOuverts} OT préventif${compteurs.otOuverts > 1 ? 's' : ''} en cours`, onClic: filtrerEtat('') }));
      kpis.appendChild(ui.kpi({ label: 'En retard', valeur: compteurs.enRetard, icone: 'alerte', couleur: compteurs.enRetard ? '#dc2626' : '#16a34a', detail: compteurs.enRetard ? (compteurs.sansOtEnRetard ? `${compteurs.sansOtEnRetard} sans OT ouvert` : 'tous ont un OT ouvert') : 'aucune échéance dépassée', onClic: filtrerEtat('en_retard') }));
      kpis.appendChild(ui.kpi({ label: 'À venir sous 30 jours', valeur: compteurs.aVenir30, icone: 'planning', couleur: '#f59e0b', detail: compteurs.chargeHeures30 ? `${ui.formatDuree(compteurs.chargeHeures30)} de travail prévues` : 'aucune charge prévue', onClic: filtrerEtat('proche') }));
      kpis.appendChild(ui.kpi({ label: 'À jour', valeur: compteurs.aJour, icone: 'check', couleur: '#16a34a', detail: compteurs.genererAuto ? `génération auto. ${compteurs.horizonJours} j avant l'échéance` : 'génération automatique désactivée', onClic: filtrerEtat('a_jour') }));
    }
    async function rafraichir() {
      try {
        [plans, compteurs] = await Promise.all([api.get('/api/preventif'), api.get('/api/preventif-compteurs')]);
        majBadge(compteurs);
        majEquipements();
        rendreKpis();
        appliquer();
      } catch (e) { erreur(e); }
    }

    // Filtres
    const opt = (o) => el('option', { value: o.value }, o.label);
    const selEtat = el('select', { title: 'État', onchange: () => { filtres.etat = selEtat.value; appliquer(); } }, [{ value: '', label: 'Tous les états' }].concat(Object.entries(ETATS).map(([k, v]) => ({ value: k, label: v.label }))).map(opt));
    const selSecteur = el('select', { title: 'Secteur', onchange: () => { filtres.secteurId = selSecteur.value; appliquer(); } }, ui.optionsSecteurs({ vide: 'Tous les secteurs' }).map(opt));
    const selEquipement = el('select', { title: 'Équipement', style: { maxWidth: '240px' }, onchange: () => { filtres.equipementId = selEquipement.value; appliquer(); } }, opt({ value: '', label: 'Tous les équipements' }));
    const selTech = el('select', { title: 'Technicien', onchange: () => { filtres.technicienId = selTech.value; appliquer(); } }, opt({ value: '', label: 'Tous les techniciens' }));
    const selType = el('select', { title: 'Type d\'intervention', onchange: () => { filtres.typeCode = selType.value; appliquer(); } }, ui.optionsListe('typesIntervention', { vide: 'Tous les types' }).map(opt));
    function majEquipements() {
      const eqs = new Map(); const techs = new Map();
      for (const p of plans) { if (p.equipementId != null) eqs.set(String(p.equipementId), p.equipementNom || ('#' + p.equipementId)); if (p.technicienId != null) techs.set(String(p.technicienId), p.technicienNom || ui.nomUser(p.technicienId)); }
      if (filtres.equipementId && !eqs.has(filtres.equipementId)) eqs.set(filtres.equipementId, 'Équipement #' + filtres.equipementId);
      ui.vider(selEquipement); selEquipement.appendChild(opt({ value: '', label: 'Tous les équipements' }));
      Array.from(eqs).sort((a, b) => a[1].localeCompare(b[1], 'fr')).forEach(([v, l]) => selEquipement.appendChild(opt({ value: v, label: l })));
      selEquipement.value = filtres.equipementId;
      ui.vider(selTech); [{ value: '', label: 'Tous les techniciens' }, { value: 'aucun', label: 'Non affectés' }].forEach((o) => selTech.appendChild(opt(o)));
      Array.from(techs).sort((a, b) => a[1].localeCompare(b[1], 'fr')).forEach(([v, l]) => selTech.appendChild(opt({ value: v, label: l })));
      selTech.value = filtres.technicienId;
    }
    const inRecherche = el('input', { type: 'search', placeholder: 'Rechercher (numéro, plan, équipement, tâche)…', style: { maxWidth: '280px' } });
    inRecherche.addEventListener('input', ui.debounce(() => { filtres.recherche = inRecherche.value.trim(); appliquer(); }, 200));
    selEtat.value = filtres.etat; selSecteur.value = filtres.secteurId;
    const btnReinit = el('button', { type: 'button', class: 'btn btn-sm', title: 'Réinitialiser les filtres', onclick: () => {
      [selEtat, selSecteur, selEquipement, selTech, selType, inRecherche].forEach((x) => { x.value = ''; });
      Object.keys(filtres).forEach((k) => { filtres[k] = ''; });
      if (location.hash.includes('equipementId')) history.replaceState(null, '', '#/preventif');
      appliquer();
    } }, ico('filtre'), 'Réinitialiser');
    const barreFiltres = el('div', { class: 'barre-outils' }, inRecherche, selEtat, selSecteur, selEquipement, selTech, selType, btnReinit,
      el('span', { class: 'espace' }), compteurTexte,
      el('button', { type: 'button', class: 'btn btn-sm btn-icone', title: 'Actualiser', onclick: rafraichir }, icone('rafraichir')));

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'preventif', sousTitre: 'Plans de maintenance périodiques (calendrier ou compteur), gammes et échéancier',
      actions: [
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter(filtres) }) : null,
        can('modifier') ? ui.bouton('Générer les OT à échéance', { icone: 'ot', onClic: () => genererEcheances(rafraichir) }) : null,
        can('creer') ? ui.bouton('Nouveau plan', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, {}, (res) => GMAO.navigate('#/preventif/' + res.id)) }) : null,
      ],
    }));
    container.appendChild(kpis);
    container.appendChild(barreFiltres);
    ongletsListe = ui.onglets([
      { cle: 'plans', label: 'Plans', icone: 'liste', contenu: tableau.el },
      { cle: 'echeancier', label: 'Échéancier (12 mois)', icone: 'planning', rendu: (c) => { zoneEcheancier = el('div'); c.appendChild(zoneEcheancier); rendreEcheancier(zoneEcheancier, planVisible); } },
    ], { hash: true, actif: query.onglet === 'echeancier' ? 'echeancier' : undefined });
    container.appendChild(ongletsListe.el);
    await rafraichir();

    if (nouveau && can('creer')) {
      history.replaceState(null, '', '#/preventif');
      ouvrirFormulaire(null, { equipementId: query.equipementId ? Number(query.equipementId) : null }, (res) => GMAO.navigate('#/preventif/' + res.id));
    }
  }

  GMAO.registerView(MODULE, {
    titre: 'Maintenance préventive', icone: 'preventif',
    async rendu(container, { params, query }) {
      if (params[0]) await rendreFiche(container, params[0]);
      else await rendreListe(container, query || {});
    },
  });

  // Badge « plans en retard » dans la navigation, mis à jour hors de la vue (au plus une fois par minute)
  function majBadgeSiNecessaire() {
    if (!GMAO.user || !GMAO.perms || !GMAO.can(MODULE, 'voir')) return;
    if (Date.now() - derniereMajBadge < 60000) return;
    majBadge();
  }
  window.addEventListener('hashchange', majBadgeSiNecessaire);
  setTimeout(majBadgeSiNecessaire, 1500);
  setInterval(majBadgeSiNecessaire, 300000);
})();
