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
  // Rendu WebGL logiciel : la vue Plans 3D est couverte en 3D (sans ces options, Chromium sans interface bascule en 2D)
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|403|404/.test(m.text())) erreurs.push('[console] ' + m.text()); });
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
    await page.click('.modal .btn-primaire');
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
    await page.keyboard.press('Escape');
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

    // Thème sombre + déconnexion
    await page.click('.entete-utilisateur'); await page.click('text=Thème sombre'); await page.waitForTimeout(200);
    etape('Thème sombre appliqué', (await page.getAttribute('html', 'data-theme')) === 'sombre');
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
    await page.click('.modal-reinit >> text=Fermer');
    await page.keyboard.press('Escape');
    await page.click('.entete-utilisateur'); await page.click('text=Se déconnecter'); await page.waitForSelector('.connexion-carte');
    await page.click('text=J\'ai un code de réinitialisation');
    await page.waitForSelector('#f_codeReinit');
    await page.fill('#f_identifiant', 'jbernard');
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
    await page.click('.entete-utilisateur'); await page.click('.menu-utilisateur >> text=Se déconnecter'); await page.waitForSelector('.connexion-carte');

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
