#!/usr/bin/env node
'use strict';
/**
 * Test de bout en bout de l'interface (Playwright + Chromium).
 *   node tests/e2e/run.js            → exécute le parcours et écrit les captures dans tests/e2e/captures
 *   node tests/e2e/run.js --rapide   → sans captures d'écran
 * Le serveur est démarré en mémoire sur un port aléatoire.
 */
const path = require('path');
const fs = require('fs');
const { createApp } = require('../../server/server');
const { seedDemo } = require('../../server/modules');
const totp = require('../../server/totp');

const CAPTURES = path.join(__dirname, 'captures');
const rapide = process.argv.includes('--rapide');

async function main() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('Playwright indisponible, test E2E ignoré.'); return; }
  if (!rapide) fs.mkdirSync(CAPTURES, { recursive: true });
  const app = createApp({ inMemory: true, log: () => {} });
  seedDemo(app.ctx);
  const addr = await app.start(0);
  const base = `http://127.0.0.1:${addr.port}`;
  // Horloge de la double authentification décalable : un nouveau code par pas de 30 s (anti-rejeu)
  let decalage2fa = 0;
  app.ctx.deuxFacteurs.maintenant = () => Date.now() + decalage2fa;
  const code2fa = (secret) => { decalage2fa += 31000; return totp.totp(secret, { instant: app.ctx.deuxFacteurs.maintenant() }); };
  // Rendu WebGL logiciel : la vue Plans 3D est couverte en 3D (sans ces options, Chromium sans interface bascule en 2D)
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const erreurs = [];
  // Refus du serveur provoqués par le parcours (code incorrect…) : réponses 400 attendues, non comptées comme erreurs
  let refusAttendus = 0;
  page.on('pageerror', (e) => erreurs.push('[pageerror] ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /401|403|404/.test(m.text())) return;
    if (refusAttendus > 0 && /status of 400/.test(m.text())) { refusAttendus--; return; }
    erreurs.push('[console] ' + m.text());
  });
  /** Textes d'une zone dont le contraste (WCAG) est inférieur à 4,5:1 (3:1 pour les grands textes), fonds translucides composés. */
  const contrastesInsuffisants = (sel) => page.evaluate((s) => {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const mix = (h, b) => ({ r: h.r * h.a + b.r * (1 - h.a), g: h.g * h.a + b.g * (1 - h.a), b: h.b * h.a + b.b * (1 - h.a), a: 1 });
    const fond = (e) => {
      const couches = [];
      for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c.a > 0) { couches.push(c); if (c.a >= 1) break; } }
      return couches.reverse().reduce((acc, c) => mix(c, acc), { r: 255, g: 255, b: 255, a: 1 });
    };
    const out = [];
    for (const racine of document.querySelectorAll(s)) {
      const w = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const e = n.parentElement; const t = n.textContent.trim();
        if (!t || !e || !e.getClientRects().length) continue;
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden') continue;
        const fg = parse(cs.color); if (!fg) continue;
        const bg = fond(e); const c = fg.a < 1 ? mix(fg, bg) : fg;
        const l1 = lum(c), l2 = lum(bg); const r = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const grand = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
        if (r < (grand ? 3 : 4.5)) out.push(`${r.toFixed(2)} « ${t.slice(0, 30)} »`);
      }
    }
    return out;
  }, sel);
  const capture = async (nom) => { if (!rapide) await page.screenshot({ path: path.join(CAPTURES, nom + '.png'), fullPage: true }); };
  const etapes = [];
  const etape = (nom, ok, detail) => { etapes.push({ nom, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${nom}${detail ? ' — ' + detail : ''}`); };

  try {
    await page.goto(base + '/');
    await page.waitForSelector('.connexion-carte', { timeout: 10000 });
    etape('Page de connexion affichée', true);
    await page.fill('#f_login', 'admin'); await page.fill('#f_password', 'mauvais'); await page.click('button[type=submit]');
    await page.waitForSelector('.connexion-erreur:not(.masque)');
    etape('Mot de passe incorrect refusé', true);
    await page.fill('#f_password', 'admin'); await page.click('button[type=submit]');
    await page.waitForSelector('.modal #f_nouveau', { timeout: 10000 });
    etape('Changement de mot de passe forcé à la première connexion', true);
    // Règles du mot de passe cochées pendant la saisie, robustesse, bouton afficher / masquer
    await page.fill('#f_nouveau', 'admin');
    etape('Règles non respectées signalées en direct', (await page.$$('.modal .regles-mdp .regle.ko')).length >= 2);
    await page.click('.modal .champ-mdp .mdp-voir');
    etape('Bouton afficher le mot de passe', (await page.getAttribute('#f_nouveau', 'type')) === 'text');
    await page.fill('#f_nouveau', 'Gmao-Essai#2026'); await page.fill('#f_confirmation', 'Gmao-Essai#2026');
    etape('Règles respectées et robustesse affichée', (await page.$$('.modal .regles-mdp .regle.ko')).length === 0 && (await page.textContent('.modal .robustesse-mdp')).includes('excellente'));
    await capture('changement-mdp-regles');
    // Fenêtre imposée : la tabulation ne quitte pas la fenêtre (menu et en-tête derrière le fond)
    await page.focus('.modal .modal-pied .btn-primaire');
    let horsFenetre = 0;
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => document.querySelector('.modal').contains(document.activeElement)))) horsFenetre++; }
    etape('Fenêtre imposée : tabulation confinée à la fenêtre', horsFenetre === 0);
    // Entrée dans la confirmation (deux champs, aucun bouton d'envoi dans le formulaire) : le changement est envoyé
    await page.focus('#f_confirmation'); await page.keyboard.press('Enter');
    const envoiParEntree = await page.waitForFunction(() => !document.querySelector('.modal-mdp'), null, { timeout: 5000 }).then(() => true, () => false);
    etape('Entrée dans la confirmation du nouveau mot de passe enregistre le changement', envoiParEntree);
    if (!envoiParEntree) await page.click('.modal .btn-primaire'); // suite du parcours malgré l'échec
    await page.waitForSelector('.sidebar-nav .nav-item');
    const nav = await page.$$eval('.sidebar-nav .nav-item', (a) => a.map((x) => x.dataset.module));
    etape('Navigation construite', nav.length >= 4, nav.join(', '));

    // Parcours de toutes les vues visibles
    for (const module of nav) {
      await page.goto(base + '/#/' + module);
      await page.waitForFunction((m) => document.querySelector(`.vue[data-module="${m}"]`) && !document.querySelector('.vue > .chargement'), module, { timeout: 15000 });
      await page.waitForTimeout(300);
      const alerte = await page.$('.vue .alerte-danger');
      etape(`Vue ${module}`, !alerte, alerte ? await alerte.textContent() : '');
      await capture('vue-' + module);
    }

    // Utilisateurs : création + fiche + droits effectifs
    await page.goto(base + '/#/utilisateurs'); await page.waitForSelector('table.tableau');
    await page.click('text=Nouvel utilisateur'); await page.waitForSelector('.modal #f_login');
    await page.fill('#f_login', 'e2e'); await page.fill('#f_nom', 'Test E2E'); await page.selectOption('#f_profilId', { label: 'Technicien (niveau 4)' });
    await page.waitForTimeout(300);
    const boutonsSurcharge = await page.$$('.modal .matrice button');
    etape('Matrice de surcharges affichée dans le formulaire utilisateur', boutonsSurcharge.length > 10, boutonsSurcharge.length + ' cases');
    await boutonsSurcharge[0].click(); // dashboard › voir : bascule
    await page.click('.modal-pied .btn-primaire');
    await page.waitForSelector('.toast.succes');
    // Mot de passe initial généré : affiché une seule fois dans une fenêtre
    await page.waitForSelector('.modal code');
    etape('Mot de passe initial aléatoire affiché une seule fois', /^.{14}$/.test(await page.textContent('.modal code')));
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    etape('Mot de passe initial : Échap ne ferme pas la fenêtre (affiché une seule fois)', !!(await page.$('.modal code')));
    await page.click('.modal .modal-pied button:has-text("Fermer")');
    etape('Utilisateur créé depuis l\'interface', true);
    await page.click('text=Test E2E'); await page.waitForSelector('.modal .onglets');
    await page.click('.modal .onglets button:nth-child(2)');
    await page.waitForSelector('.modal .matrice');
    etape('Fiche utilisateur avec droits effectifs', true);
    await capture('fiche-utilisateur'); await page.keyboard.press('Escape');

    // Profils : tri par secteur / regroupement
    await page.goto(base + '/#/profils'); await page.waitForSelector('table.tableau');
    await page.check('.barre-outils input[type=checkbox]');
    await page.waitForTimeout(200);
    const groupes = await page.$$eval('tr.groupe-ligne', (t) => t.map((x) => x.textContent));
    etape('Profils regroupés par secteur', groupes.length >= 1, groupes.join(' | '));
    await capture('profils-groupes');
    await page.click('text=Nouveau profil'); await page.waitForSelector('.modal #f_nom');
    await page.fill('#f_nom', 'Profil E2E'); await page.fill('#f_niveau', '7');
    await page.click('.modal .matrice tbody tr:first-child input[type=checkbox]');
    await page.click('.modal-pied .btn-primaire'); await page.waitForSelector('.toast.succes');
    etape('Profil créé avec matrice', true);

    // Configuration : option « trier les profils par secteur »
    await page.goto(base + '/#/configuration?onglet=affichage'); await page.waitForSelector('#f_profils\\.triParSecteur');
    await page.uncheck('#f_profils\\.triParSecteur'); await page.click('.vue .btn-primaire'); await page.waitForSelector('.toast.succes');
    etape('Option de tri des profils par secteur enregistrée', true);
    await page.goto(base + '/#/configuration?onglet=listes'); await page.waitForSelector('.liste-editable');
    await page.click('text=Ajouter une valeur'); const inputs = await page.$$('.liste-editable .ligne:last-child input[type=text]');
    await inputs[0].fill('test_e2e'); await inputs[1].fill('Statut E2E'); await page.click('text=Enregistrer cette liste'); await page.waitForSelector('.toast.succes');
    etape('Liste de valeurs modifiée', true);
    await page.goto(base + '/#/configuration?onglet=secteurs'); await page.waitForSelector('text=Nouveau site / secteur');
    await page.click('text=Nouveau site / secteur'); await page.fill('#f_nom', 'Secteur E2E'); await page.click('.modal-pied .btn-primaire'); await page.waitForSelector('.toast.succes');
    etape('Secteur créé', true);

    // Pièce dédiée : création depuis l'interface, puis choix des pièces sur l'OT d'une autre machine et de la bonne machine
    await page.goto(base + '/#/stock'); await page.waitForSelector('.vue[data-module="stock"] table.tableau');
    await page.click('text=Nouvel article'); await page.waitForSelector('.modal #f_designation');
    await page.fill('#f_designation', 'Vérin de serrage E2E'); await page.fill('#f_quantite', '4');
    await page.check('#f_reservee');
    etape('Formulaire article : « Équipements autorisés » quand la case « Pièce dédiée » est cochée', (await page.$eval('.modal label[for="f_equipementIds"]', (l) => l.firstChild.textContent)) === 'Équipements autorisés');
    // Sans équipement : erreur propre aux pièces dédiées, effacée quand la case est décochée
    const erreurEq = () => page.$eval('.modal label[for="f_equipementIds"]', (l) => l.closest('.champ').querySelector('.erreur-champ').textContent);
    await page.click('.modal-pied .btn-primaire'); await page.waitForTimeout(200);
    const erreurDediee = await erreurEq();
    await page.uncheck('#f_reservee'); await page.waitForTimeout(100);
    etape('Formulaire article : erreur « au moins un équipement autorisé » effacée au décochage', /au moins un équipement autorisé/.test(erreurDediee) && (await erreurEq()) === '');
    await page.check('#f_reservee');
    await page.click('.modal .cases-liste label:has-text("Presse hydraulique 250 t") input');
    await page.click('.modal-pied .btn-primaire'); await page.waitForSelector('.toast.succes');
    await page.waitForSelector('.page-entete .badge:text-is("Dédiée")');
    const idDediee = Number((await page.evaluate(() => location.hash)).match(/stock\/(\d+)/)[1]);
    etape('Pièce dédiée créée depuis l\'interface (badge « Dédiée »)', idDediee > 0);
    await capture('stock-piece-dediee');
    const ots = await page.evaluate(() => api.get('/api/ot'));
    const otAutre = ots.find((o) => /groupe froid/i.test(o.titre) && !/termine|annule/.test(o.statut));
    const otBonne = ots.find((o) => /joint de tige/i.test(o.titre) && !/termine|annule/.test(o.statut));
    const optionPiece = async (otId) => {
      await page.goto(base + '/#/ot/' + otId); await page.waitForSelector('.vue[data-module="ot"] .onglets');
      await page.click('.onglets button:has-text("Réalisation")');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.vue select')).some((s) => /Choisir un article/.test(s.textContent) && !s.disabled));
      return page.evaluate((id) => {
        const s = Array.from(document.querySelectorAll('.vue select')).find((x) => /Choisir un article/.test(x.textContent));
        const o = s.querySelector(`option[value="${id}"]`);
        return o ? { desactivee: o.disabled, groupe: o.parentElement.label, raison: o.title } : null;
      }, idDediee);
    };
    const surAutre = await optionPiece(otAutre.id);
    etape('OT d\'une autre machine : pièce dédiée désactivée avec la raison', !!surAutre && surAutre.desactivee && /ne peut pas être utilisée sur Groupe froid/.test(surAutre.raison), surAutre && surAutre.raison);
    // Aide sur les pièces grisées conservée quand l'article choisi change
    const aidePieces = () => page.evaluate(() => { const s = Array.from(document.querySelectorAll('.vue select')).find((x) => /Choisir un article/.test(x.textContent)); return Array.from(s.closest('.carte').querySelectorAll('.aide')).map((a) => a.textContent).join(' '); });
    await page.evaluate(() => { const s = Array.from(document.querySelectorAll('.vue select')).find((x) => /Choisir un article/.test(x.textContent)); const o = Array.from(s.options).find((x) => x.value && !x.disabled); s.value = o.value; s.dispatchEvent(new Event('change')); s.value = ''; s.dispatchEvent(new Event('change')); });
    etape('OT : aide sur les pièces dédiées grisées conservée après le choix d\'un article', /grisée/.test(await aidePieces()));
    // OT sans équipement : groupe et raison invitant à renseigner l'équipement de l'OT
    const prod = await page.evaluate(() => GMAO.refs.secteurs.find((x) => x.code === 'PROD').id);
    const otSansEq = await page.evaluate((sid) => api.post('/api/ot', { titre: 'Contrôle sans équipement', typeCode: 'correctif', prioriteCode: 'normale', secteurId: sid }), prod);
    const surSansEq = await optionPiece(otSansEq.id);
    etape('OT sans équipement : pièce dédiée grisée « renseignez d\'abord l\'équipement de l\'OT »', !!surSansEq && surSansEq.desactivee && /renseignez d'abord l'équipement/.test(surSansEq.groupe) && /renseignez d'abord l'équipement de l'ordre de travail/.test(surSansEq.raison), surSansEq && surSansEq.groupe);
    // Nouveau mouvement : un OT choisi avant une pièce dédiée qu'il n'autorise pas est désélectionné
    await page.goto(base + '/#/stock'); await page.waitForSelector('.vue[data-module="stock"] table.tableau');
    await page.click('.page-entete button:has-text("Nouveau mouvement")'); await page.waitForSelector('.modal #f_articleId');
    await page.check('.modal input[type=radio][value="sortie"]');
    await page.selectOption('.modal #f_otId', String(otAutre.id));
    await page.selectOption('.modal #f_articleId', String(idDediee));
    await page.waitForTimeout(200);
    const mvt = await page.evaluate(() => ({ ot: document.querySelector('#f_otId').value, erreur: document.querySelector('#f_otId').closest('.champ').querySelector('.erreur-champ').textContent }));
    etape('Nouveau mouvement : OT non autorisé désélectionné et signalé', mvt.ot === '' && /OT non autorisé/.test(mvt.erreur), mvt.erreur);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    { const abandon = await page.$('.modal .btn-danger'); if (abandon) await abandon.click(); }
    await page.waitForFunction(() => !document.querySelector('.modal #f_articleId'));
    const surBonne = await optionPiece(otBonne.id);
    etape('OT de la bonne machine : pièce dédiée en tête et utilisable', !!surBonne && !surBonne.desactivee && surBonne.groupe === 'Pièces dédiées à cet équipement');
    await page.evaluate((id) => { const s = Array.from(document.querySelectorAll('.vue select')).find((x) => /Choisir un article/.test(x.textContent)); s.value = String(id); s.dispatchEvent(new Event('change')); }, idDediee);
    await page.click('.vue button:has-text("Sortir du stock")'); await page.waitForSelector('.toast.succes >> text=Sortie de stock enregistrée');
    etape('Pièce dédiée sortie du stock sur l\'OT de la bonne machine', (await page.textContent('.vue')).includes('Vérin de serrage E2E'));
    await capture('ot-piece-dediee');

    // Thème sombre + déconnexion
    await page.click('.entete-utilisateur'); await page.click('text=Thème sombre'); await page.waitForTimeout(200);
    etape('Thème sombre appliqué', (await page.getAttribute('html', 'data-theme')) === 'sombre');
    await page.goto(base + '/#/demandes'); await page.waitForSelector('.vue[data-module="demandes"] table.tableau'); await page.waitForTimeout(300);
    const contrastesSombre = await contrastesInsuffisants('.vue .badge, .vue .texte-danger, .vue .texte-ok, .vue .texte-alerte, .sidebar-nav .nav-badge');
    etape('Thème sombre : badges et textes d\'état lisibles (demandes)', !contrastesSombre.length, contrastesSombre.slice(0, 5).join(' | '));
    await capture('theme-sombre');
    await page.click('.entete-utilisateur'); await page.click('text=Se déconnecter'); await page.waitForSelector('.connexion-carte');
    etape('Déconnexion', true);

    // Mot de passe oublié : demande depuis l'écran de connexion, code remis par l'administrateur, nouveau mot de passe
    await page.fill('#f_login', 'jbernard');
    await page.click('text=Mot de passe oublié ?');
    await page.waitForSelector('#f_identifiant');
    etape('Demande de réinitialisation : identifiant prérempli', (await page.inputValue('#f_identifiant')) === 'jbernard');
    await page.fill('#f_message', 'Atelier 2, joignable au 2145');
    await page.click('.connexion button[type=submit]');
    await page.waitForSelector('text=Demande envoyée');
    etape('Demande de réinitialisation envoyée (confirmation générique)', (await page.textContent('.connexion-carte')).includes('Si cet identifiant correspond à un compte actif'));
    await capture('mdp-oublie-demande');
    await page.click('text=Retour à la connexion');
    await page.fill('#f_login', 'admin'); await page.fill('#f_password', 'Gmao-Essai#2026'); await page.click('button[type=submit]');
    await page.waitForSelector('.sidebar-nav .nav-item');
    await page.waitForSelector('.notif-compteur');
    await page.waitForSelector('.nav-item[data-module="utilisateurs"] .nav-badge', { timeout: 5000 }).catch(() => {});
    etape('Compteur « Utilisateurs » (demande en attente) dans le menu dès la connexion', (await page.$eval('.nav-item[data-module="utilisateurs"]', (a) => (a.querySelector('.nav-badge') || {}).textContent || '')) === '1');
    await page.click('.btn-notifs');
    await page.click('.notif-item:has-text("Demande de réinitialisation de mot de passe")');
    await page.waitForSelector('.modal-demandes-mdp table.tableau');
    etape('Notification → fenêtre des demandes de réinitialisation', (await page.textContent('.modal-demandes-mdp')).includes('Atelier 2, joignable au 2145'));
    await page.click('.modal-demandes-mdp >> text=Réinitialiser…');
    await page.waitForSelector('.modal-reinit #f_mode_code');
    await page.click('.modal-reinit .btn-primaire');
    await page.waitForSelector('.modal-reinit .secret-unique');
    const codeReinit = (await page.textContent('.modal-reinit .secret-unique')).trim();
    etape('Code de réinitialisation affiché une seule fois', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(codeReinit), codeReinit);
    await capture('mdp-oublie-code');
    const [fiche] = await Promise.all([page.waitForEvent('popup'), page.click('.modal-reinit >> text=Imprimer la fiche')]);
    fiche.on('pageerror', (e) => erreurs.push('[pageerror fiche] ' + e.message));
    await fiche.waitForLoadState();
    const texteFiche = await fiche.textContent('body');
    etape('Fiche imprimable du code', texteFiche.includes(codeReinit) && texteFiche.includes('jbernard') && texteFiche.includes('Mode d\'emploi'));
    await fiche.close();
    await page.keyboard.press('Escape'); await page.mouse.click(10, 10); await page.waitForTimeout(200);
    etape('Code affiché une seule fois : ni Échap ni clic sur le fond ne ferment la fenêtre', !!(await page.$('.modal-reinit .secret-unique')) && !(await page.$('.modal-reinit .modal-entete .btn-icone')));
    await page.click('.modal-reinit >> text=Fermer');
    await page.keyboard.press('Escape');
    await page.click('.entete-utilisateur'); await page.click('text=Se déconnecter'); await page.waitForSelector('.connexion-carte');
    await page.click('text=J\'ai un code de réinitialisation');
    await page.waitForSelector('#f_codeReinit');
    await page.fill('#f_identifiant', 'jbernard');
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.fill('#f_codeReinit', 'ABCD-EF23'); await page.fill('#f_nouveauMdp', 'Bernard-Atelier#26'); await page.fill('#f_confirmationMdp', 'Bernard-Atelier#26');
    refusAttendus++;
    await page.click('.connexion button[type=submit]');
    await page.waitForSelector('.connexion-erreur:not(.masque)');
    const geoErreur = await page.evaluate(() => { const r = document.querySelector('.connexion-erreur').getBoundingClientRect(); return { haut: Math.round(r.top), bas: Math.round(r.bottom), fenetre: window.innerHeight, defilement: Math.round(window.scrollY) }; });
    etape('« J\'ai un code » : erreur du serveur ramenée dans la zone visible (fenêtre de 650 px)', geoErreur.haut >= 0 && geoErreur.bas <= geoErreur.fenetre, JSON.stringify(geoErreur));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.fill('#f_codeReinit', '');
    await page.type('#f_codeReinit', codeReinit.replace('-', '').toLowerCase());
    etape('Saisie tolérante du code', (await page.inputValue('#f_codeReinit')) === codeReinit);
    await page.fill('#f_nouveauMdp', 'jbernard-2026');
    etape('Règles vérifiées en direct sur l\'écran de connexion', (await page.$$('.connexion .regles-mdp .regle.ko')).length >= 1);
    await page.fill('#f_nouveauMdp', 'Bernard-Atelier#26'); await page.fill('#f_confirmationMdp', 'Bernard-Atelier#26');
    await capture('mdp-oublie-nouveau');
    await page.click('.connexion button[type=submit]');
    await page.waitForSelector('.sidebar-nav .nav-item');
    etape('Nouveau mot de passe enregistré et connexion automatique', (await page.textContent('.entete-utilisateur')).includes('Bernard'));
    // Changement depuis le menu du compte, avec les règles cochées en direct
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Changer mon mot de passe');
    await page.waitForSelector('.modal #f_ancien');
    await page.fill('#f_ancien', 'Bernard-Atelier#26'); await page.fill('#f_nouveau', 'Bernard-Second#27'); await page.fill('#f_confirmation', 'Bernard-Second');
    etape('Saisies différentes signalées', await page.$eval('.modal .regles-mdp', (u) => Array.from(u.querySelectorAll('.regle.ko')).some((li) => li.textContent.includes('identiques'))));
    await page.fill('#f_confirmation', 'Bernard-Second#27');
    await page.click('.modal .btn-primaire');
    await page.waitForSelector('.toast.succes >> text=Mot de passe modifié');
    etape('Mot de passe changé depuis le menu du compte', true);
    // Contrastes de la fenêtre et du menu du compte (badges, textes d'état)
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Mon compte'); await page.waitForSelector('.modal .details');
    const contrastesCompte = await contrastesInsuffisants('.modal');
    etape('Fenêtre « Mon compte » lisible (contrastes)', !contrastesCompte.length, contrastesCompte.join(' | '));
    await page.keyboard.press('Escape');

    // Double authentification facultative : enrôlement, codes de secours protégés, désactivation au clavier
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Double authentification');
    await page.waitForSelector('.modal #f_motDePasse'); await page.waitForTimeout(100);
    await page.fill('#f_motDePasse', 'Bernard-Second#27');
    const [prepa] = await Promise.all([page.waitForResponse((r) => /\/api\/auth\/2fa\/preparer$/.test(r.url())), page.keyboard.press('Enter')]);
    const secret2fa = (await prepa.json()).secret;
    await page.waitForSelector('#f_code_activation');
    await page.type('#f_code_activation', code2fa(secret2fa));
    await page.waitForSelector('.codes-secours');
    await page.keyboard.press('Escape'); await page.mouse.click(10, 10); await page.waitForTimeout(200);
    etape('Codes de secours : la fenêtre reste ouverte sans la case « J\'ai conservé mes codes »', !!(await page.$('.codes-secours')) && !(await page.$('.modal .modal-entete .btn-icone')));
    await page.check('#f_codes_conserves'); await page.click('.modal .modal-pied .btn-primaire');
    await page.waitForSelector('.toast.succes >> text=Double authentification activée');
    await page.waitForFunction(() => !document.querySelector('.modal-fond'));
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Double authentification');
    await page.click('.modal .modal-pied button:has-text("Désactiver")'); await page.waitForSelector('.modal #f_code'); await page.waitForTimeout(150);
    etape('« Désactiver la double authentification » : mise au point sur le mot de passe', await page.evaluate(() => document.activeElement && document.activeElement.id === 'f_motDePasse'));
    await page.keyboard.type('Bernard-Second#27'); await page.fill('#f_code', '000000');
    refusAttendus++;
    await page.focus('#f_code'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#f_code').closest('.champ').classList.contains('invalide'));
    etape('Code refusé : message sous le champ du code, qui garde le focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'f_code'));
    await page.fill('#f_code', code2fa(secret2fa)); await page.keyboard.press('Enter');
    await page.waitForSelector('.toast.succes >> text=Double authentification désactivée');
    etape('Entrée dans le champ du code envoie la désactivation', !(app.db.findOne('users', (u) => u.login === 'jbernard').deuxFacteurs || {}).actif);
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Se déconnecter'); await page.waitForSelector('.connexion-carte');
    etape('Déconnexion : aucune notification de la session sur l\'écran de connexion', (await page.$$('#toasts .toast')).length === 0);

    // Connexion avec un profil restreint (données de démo : demandeur)
    await page.fill('#f_login', 'spetit'); await page.fill('#f_password', 'demo'); await page.click('button[type=submit]');
    await page.waitForSelector('.sidebar-nav .nav-item');
    const navRestreinte = await page.$$eval('.sidebar-nav .nav-item', (a) => a.map((x) => x.dataset.module));
    const attendus = ['dashboard', 'demandes', 'equipements'];
    const interdits = ['ot', 'preventif', 'planning', 'stock', 'fournisseurs', 'rapports', 'utilisateurs', 'profils', 'configuration', 'audit'];
    etape('Menu restreint pour un demandeur', attendus.every((m) => navRestreinte.includes(m)) && !interdits.some((m) => navRestreinte.includes(m)), navRestreinte.join(', '));
    await page.goto(base + '/#/configuration'); await page.waitForTimeout(400);
    etape('Accès refusé à la configuration pour un demandeur', (await page.textContent('.vue')).includes('pas accès'));
    await page.goto(base + '/#/ot'); await page.waitForTimeout(400);
    etape('Accès refusé aux ordres de travail pour un demandeur', (await page.textContent('.vue')).includes('pas accès'));
    await page.goto(base + '/#/demandes'); await page.waitForSelector('.vue[data-module="demandes"] table.tableau');
    etape('Le demandeur peut signaler une panne', !!(await page.$('.vue .page-actions .btn-primaire')));
    await page.goto(base + '/#/dashboard'); await page.waitForFunction(() => document.querySelector('.vue[data-module="dashboard"]') && !document.querySelector('.vue > .chargement'));
    await page.waitForTimeout(300);
    etape('Tableau de bord du demandeur sans erreur', !(await page.$('.vue .alerte-danger')));
    await capture('demandeur');
  } catch (e) {
    etape('Exception', false, e.message);
    await capture('erreur');
  }

  await browser.close();
  await app.stop();
  const echecs = etapes.filter((e) => !e.ok);
  if (erreurs.length) { console.log('\nErreurs navigateur :'); erreurs.forEach((e) => console.log('  ' + e)); }
  console.log(`\n${etapes.length - echecs.length}/${etapes.length} étapes réussies`);
  if (echecs.length || erreurs.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
