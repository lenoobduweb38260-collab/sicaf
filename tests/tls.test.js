'use strict';
/**
 * Chiffrement des échanges entre les postes : certificat auto-signé généré sans dépendance,
 * renouvellement automatique, serveur HTTPS réel (createApp({ tls })), écoute mixte HTTP/HTTPS
 * et sonde d'un serveur GMAO avec épinglage de l'empreinte.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const tlsGmao = require('../server/tls');
const { createApp } = require('../server/server');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ANS = 365.25 * 24 * 3600 * 1000;

/**
 * Requête HTTPS acceptant le certificat auto-signé UNIQUEMENT si son empreinte est celle attendue
 * (la requête n'est envoyée qu'après vérification de l'empreinte).
 */
function requeteHttps(port, { method = 'GET', chemin = '/', corps, cookie, empreinte, entetes = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'x-requested-with': 'GMAO' }, entetes);
    if (cookie) h.cookie = cookie;
    let donnees = null;
    if (corps !== undefined) { donnees = Buffer.from(JSON.stringify(corps)); h['content-type'] = 'application/json'; h['content-length'] = donnees.length; }
    const req = https.request({
      host: '127.0.0.1', port, method, path: chemin, headers: h, agent: false, rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const texte = Buffer.concat(morceaux).toString('utf8');
        let json = null;
        try { json = JSON.parse(texte); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, texte, json });
      });
    });
    req.on('socket', (s) => s.once('secureConnect', () => {
      const fp = s.getPeerCertificate().fingerprint256;
      if (empreinte && fp !== empreinte) { req.destroy(new Error(`Empreinte inattendue : ${fp}`)); return; }
      if (donnees) req.write(donnees);
      req.end();
    }));
    req.on('error', reject);
  });
}

function requeteHttp(port, { method = 'GET', chemin = '/', hote } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: chemin, agent: false, headers: hote ? { host: hote } : {} }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texte: Buffer.concat(morceaux).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Certificat auto-signé', () => {
  test('certificat ECDSA valide : signature, nom du poste, adresses, dates, usages', () => {
    const avant = Date.now();
    const g = tlsGmao.genererCertificat({ nomPoste: 'SRV-GMAO', adresses: ['192.168.1.20', { adresse: '10.0.0.5' }, 'pas-une-ip', '::1'] });
    assert.match(g.cle, /^-----BEGIN PRIVATE KEY-----/);
    assert.match(g.certificat, /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/);
    const x = new crypto.X509Certificate(g.certificat);
    assert.equal(x.verify(x.publicKey), true, 'auto-signé : signature vérifiée par sa propre clé');
    assert.equal(x.checkPrivateKey(crypto.createPrivateKey(g.cle)), true);
    assert.equal(x.subject, 'CN=GMAO SICAF srv-gmao');
    assert.equal(x.issuer, x.subject);
    assert.equal(x.checkHost('srv-gmao'), 'srv-gmao');
    assert.equal(x.checkHost('SRV-GMAO') !== undefined, true, 'nom insensible à la casse');
    assert.equal(x.checkHost('localhost'), 'localhost');
    assert.equal(x.checkHost('autre-poste'), undefined);
    assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(x.checkIP('192.168.1.20'), '192.168.1.20');
    assert.equal(x.checkIP('10.0.0.5'), '10.0.0.5');
    assert.equal(x.checkIP('10.0.0.6'), undefined);
    assert.equal(x.ca, false, 'basicConstraints CA:FALSE');
    assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'extendedKeyUsage serverAuth');
    assert.equal(x.publicKey.asymmetricKeyType, 'ec');
    assert.equal(x.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
    // Validité : 10 ans, début légèrement antérieur (tolérance d'horloge entre postes)
    const debut = new Date(x.validFrom).getTime();
    const fin = new Date(x.validTo).getTime();
    assert.ok(debut <= avant && debut > avant - 2 * 3600 * 1000);
    assert.ok(Math.abs(fin - avant - 10 * ANS) < 3 * 24 * 3600 * 1000, 'validité de 10 ans');
    // Numéro de série aléatoire de 16 octets, positif
    assert.match(x.serialNumber, /^[0-7][0-9A-F]{31}$/);
    assert.notEqual(tlsGmao.genererCertificat({ nomPoste: 'SRV-GMAO' }).certificat, g.certificat);
    // Empreintes
    assert.equal(g.empreinte, x.fingerprint256);
    assert.equal(tlsGmao.empreinte(g.certificat), g.empreinte);
    assert.match(g.empreinte, tlsGmao.FORMAT_EMPREINTE);
    const spki = x.publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(g.empreinteCle, crypto.createHash('sha256').update(spki).digest('hex').toUpperCase().match(/../g).join(':'));
    assert.equal(tlsGmao.empreinteCle(g.certificat), g.empreinteCle);
    assert.equal(tlsGmao.empreinteCle(crypto.createPrivateKey(g.cle)), g.empreinteCle);
  });

  test('variante RSA 2048 et conservation de la clé', () => {
    const g = tlsGmao.genererCertificat({ nomPoste: 'poste-rsa', type: 'rsa' });
    const x = new crypto.X509Certificate(g.certificat);
    assert.equal(x.publicKey.asymmetricKeyType, 'rsa');
    assert.equal(x.verify(x.publicKey), true);
    assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
    const r = tlsGmao.genererCertificat({ nomPoste: 'poste-rsa', cle: g.cle });
    assert.equal(r.empreinteCle, g.empreinteCle, 'même clé publique');
    assert.notEqual(r.empreinte, g.empreinte, 'nouveau certificat');
    assert.throws(() => tlsGmao.genererCertificat({ cle: crypto.generateKeyPairSync('ed25519').privateKey }), /non pris en charge/);
  });

  test('validité au-delà de 2049 (GeneralizedTime)', () => {
    const g = tlsGmao.genererCertificat({ nomPoste: 'poste', maintenant: new Date('2045-06-01T00:00:00Z') });
    const x = new crypto.X509Certificate(g.certificat);
    assert.equal(new Date(x.validTo).getUTCFullYear(), 2055);
    assert.equal(x.verify(x.publicKey), true);
  });

  test('empreintes : forme canonique et comparaison', () => {
    const fp = tlsGmao.genererCertificat({ nomPoste: 'p' }).empreinte;
    assert.equal(tlsGmao.normaliserEmpreinte(fp.toLowerCase()), fp);
    assert.equal(tlsGmao.normaliserEmpreinte(fp.replace(/:/g, '')), fp);
    assert.equal(tlsGmao.normaliserEmpreinte(fp.replace(/:/g, ' ')), fp);
    assert.equal(tlsGmao.normaliserEmpreinte('AB:CD'), '');
    assert.equal(tlsGmao.normaliserEmpreinte(null), '');
    assert.equal(tlsGmao.normaliserEmpreinte('ZZ'.repeat(32)), '');
    assert.equal(tlsGmao.empreintesEgales(fp, fp.toLowerCase()), true);
    assert.equal(tlsGmao.empreintesEgales(fp, ''), false);
    assert.equal(tlsGmao.empreintesEgales('', ''), false, 'deux empreintes absentes ne sont jamais égales');
    assert.equal(tlsGmao.empreintesEgales(fp, fp.slice(0, -2) + (fp.endsWith('00') ? '01' : '00')), false);
  });

  test('épinglage : certificat identique, renouvelé avec la même clé, ou différent', () => {
    const g = tlsGmao.genererCertificat({ nomPoste: 'srv' });
    const renouvele = tlsGmao.genererCertificat({ nomPoste: 'srv', cle: g.cle, adresses: ['10.1.1.1'] });
    const autre = tlsGmao.genererCertificat({ nomPoste: 'srv' });
    const pin = { empreinte: g.empreinte, empreinteCle: g.empreinteCle };
    assert.deepEqual(tlsGmao.verifierEpinglage(g.certificat, pin), { ok: true, parCle: false, empreinte: g.empreinte, empreinteCle: g.empreinteCle });
    const r = tlsGmao.verifierEpinglage(renouvele.certificat, pin);
    assert.equal(r.ok, true);
    assert.equal(r.parCle, true);
    assert.equal(tlsGmao.verifierEpinglage(renouvele.certificat, { empreinte: g.empreinte }).ok, false, 'sans empreinte de clé, seul le certificat identique est accepté');
    assert.equal(tlsGmao.verifierEpinglage(autre.certificat, pin).ok, false);
    assert.equal(tlsGmao.verifierEpinglage('pas un certificat', pin).ok, false);
    assert.equal(tlsGmao.verifierEpinglage(g.certificat, {}).ok, false);
  });
});

describe('Certificat du poste serveur (chargement et renouvellement)', () => {
  const opts = { nomPoste: 'srv-gmao', adresses: ['192.168.1.20'] };

  test('création, droits restreints et empreinte stable entre deux chargements', () => {
    const d = tmp('gmao-tls-');
    const journal = [];
    const a = tlsGmao.chargerOuCreer(d, Object.assign({ log: (m) => journal.push(m) }, opts));
    assert.equal(a.regenere, true);
    assert.equal(a.raison, 'première génération');
    assert.ok(fs.existsSync(path.join(d, 'tls', 'cle.pem')));
    assert.ok(fs.existsSync(path.join(d, 'tls', 'certificat.pem')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(d, 'tls', 'cle.pem')).mode & 0o777, 0o600, 'clé privée lisible par le seul compte du serveur');
      assert.equal(fs.statSync(path.join(d, 'tls')).mode & 0o077, 0, 'dossier tls privé');
    }
    assert.equal(journal.length, 1);
    assert.ok(!journal[0].includes('PRIVATE KEY'), 'la clé n\'apparaît jamais dans le journal');
    const b = tlsGmao.chargerOuCreer(d, opts);
    assert.equal(b.regenere, false);
    assert.equal(b.empreinte, a.empreinte, 'empreinte stable');
    assert.equal(b.empreinteCle, a.empreinteCle);
    assert.equal(b.certificat, a.certificat);
    assert.equal(tlsGmao.empreinte(fs.readFileSync(path.join(d, 'tls', 'certificat.pem'))), a.empreinte);
    assert.equal(fs.readdirSync(path.join(d, 'tls')).sort().join(','), 'certificat.pem,cle.pem', 'aucun fichier temporaire');
  });

  test('régénération si expiré (clé conservée), proche de l\'échéance ou daté dans le futur', () => {
    const d = tmp('gmao-tls-');
    const a = tlsGmao.chargerOuCreer(d, opts);
    const expire = tlsGmao.chargerOuCreer(d, Object.assign({ maintenant: new Date(Date.now() + 11 * ANS) }, opts));
    assert.equal(expire.regenere, true);
    assert.match(expire.raison, /expiré/);
    assert.notEqual(expire.empreinte, a.empreinte);
    assert.equal(expire.empreinteCle, a.empreinteCle, 'clé conservée : les postes appairés restent valides');
    const x = new crypto.X509Certificate(expire.certificat);
    assert.ok(new Date(x.validTo).getTime() > Date.now() + 20 * ANS);
    // 20 jours avant l'échéance : renouvellement anticipé
    const d2 = tmp('gmao-tls-');
    const c = tlsGmao.chargerOuCreer(d2, opts);
    const fin = new Date(new crypto.X509Certificate(c.certificat).validTo).getTime();
    assert.equal(tlsGmao.chargerOuCreer(d2, Object.assign({ maintenant: new Date(fin - 20 * 24 * 3600 * 1000) }, opts)).regenere, true);
    // Horloge du poste remise en arrière : certificat « pas encore valide »
    const d3 = tmp('gmao-tls-');
    tlsGmao.chargerOuCreer(d3, opts);
    assert.match(tlsGmao.chargerOuCreer(d3, Object.assign({ maintenant: new Date(Date.now() - 2 * 24 * 3600 * 1000) }, opts)).raison, /futur/);
  });

  test('régénération si une adresse ou le nom du poste change', () => {
    const d = tmp('gmao-tls-');
    const a = tlsGmao.chargerOuCreer(d, opts);
    assert.equal(tlsGmao.chargerOuCreer(d, { nomPoste: 'srv-gmao', adresses: [] }).regenere, false, 'une adresse disparue ne force pas de renouvellement');
    const b = tlsGmao.chargerOuCreer(d, { nomPoste: 'srv-gmao', adresses: ['192.168.1.20', '192.168.5.7'] });
    assert.equal(b.regenere, true);
    assert.match(b.raison, /192\.168\.5\.7/);
    assert.equal(b.empreinteCle, a.empreinteCle);
    const x = new crypto.X509Certificate(b.certificat);
    assert.equal(x.checkIP('192.168.5.7'), '192.168.5.7');
    assert.equal(x.checkIP('192.168.1.20'), '192.168.1.20');
    const c = tlsGmao.chargerOuCreer(d, { nomPoste: 'nouveau-nom', adresses: ['192.168.1.20'] });
    assert.equal(c.regenere, true);
    assert.match(c.raison, /nom du poste/);
    assert.equal(new crypto.X509Certificate(c.certificat).checkHost('nouveau-nom'), 'nouveau-nom');
  });

  test('fichiers corrompus ou incohérents', () => {
    const d = tmp('gmao-tls-');
    const a = tlsGmao.chargerOuCreer(d, opts);
    fs.writeFileSync(path.join(d, 'tls', 'certificat.pem'), 'corrompu');
    const b = tlsGmao.chargerOuCreer(d, opts);
    assert.equal(b.regenere, true);
    assert.equal(b.empreinteCle, a.empreinteCle, 'certificat illisible : recréé avec la même clé');
    // Certificat d'une autre clé : remplacé
    fs.writeFileSync(path.join(d, 'tls', 'certificat.pem'), tlsGmao.genererCertificat(opts).certificat);
    const c = tlsGmao.chargerOuCreer(d, opts);
    assert.match(c.raison, /ne correspond pas/);
    assert.equal(c.empreinteCle, a.empreinteCle);
    // Clé illisible : nouvelle clé (une nouvelle confirmation sera demandée aux postes)
    fs.writeFileSync(path.join(d, 'tls', 'cle.pem'), 'corrompu');
    const e = tlsGmao.chargerOuCreer(d, opts);
    assert.equal(e.regenere, true);
    assert.notEqual(e.empreinteCle, a.empreinteCle);
    assert.equal(new crypto.X509Certificate(e.certificat).checkPrivateKey(crypto.createPrivateKey(e.cle)), true);
    assert.throws(() => tlsGmao.chargerOuCreer(''), /Dossier/);
  });
});

describe('Serveur GMAO en HTTPS', () => {
  let app;
  let port;
  let cert;

  before(async () => {
    cert = tlsGmao.genererCertificat({ nomPoste: 'srv-test' });
    app = createApp({ inMemory: true, log: () => {}, tls: { key: cert.cle, cert: cert.certificat } });
    port = (await app.start(0)).port;
  });
  after(() => app.stop());

  test('connexion réelle : empreinte vérifiée, HSTS, cookie de session Secure', async () => {
    const infos = await requeteHttps(port, { chemin: '/api/auth/infos', empreinte: cert.empreinte });
    assert.equal(infos.status, 200);
    assert.equal(typeof infos.json.version, 'string');
    assert.match(infos.headers['strict-transport-security'] || '', /max-age=\d+/);
    const login = await requeteHttps(port, { method: 'POST', chemin: '/api/auth/login', corps: { login: 'admin', password: 'admin' }, empreinte: cert.empreinte });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie'] || '');
    assert.match(cookie, /gmao_session=[a-f0-9]{64}/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const moi = await requeteHttps(port, { chemin: '/api/auth/me', cookie: cookie.split(';')[0], empreinte: cert.empreinte });
    assert.equal(moi.status, 200);
    assert.equal(moi.json.user.login, 'admin');
    assert.equal(moi.json.user.passwordHash, undefined);
  });

  test('un certificat différent est refusé par le client', async () => {
    const autre = tlsGmao.genererCertificat({ nomPoste: 'srv-test' }).empreinte;
    await assert.rejects(() => requeteHttps(port, { chemin: '/api/auth/infos', empreinte: autre }), /Empreinte inattendue/);
  });

  test('TLS 1.2 minimum', async () => {
    await assert.rejects(() => new Promise((resolve, reject) => {
      const s = require('tls').connect({ host: '127.0.0.1', port, rejectUnauthorized: false, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, () => { s.destroy(); resolve(); });
      s.on('error', reject);
    }));
  });
});

describe('Écoute mixte (HTTPS + redirection HTTP sur le même port)', () => {
  let app;
  let ecoute;
  let port;
  let cert;

  before(async () => {
    cert = tlsGmao.genererCertificat({ nomPoste: 'srv-mixte' });
    app = createApp({ inMemory: true, log: () => {}, tls: { key: cert.cle, cert: cert.certificat } });
    app.server.headersTimeout = 400;          // délais courts pour vérifier la protection contre les connexions lentes
    app.server.requestTimeout = 800;
    app.server.connectionsCheckingInterval = 100;
    ecoute = await tlsGmao.ecouterMixte(app.server, 0, '127.0.0.1');
    port = ecoute.adresse.port;
  });
  after(async () => { await ecoute.fermer(); await app.stop(); });

  test('HTTPS sur le port partagé, adresse du poste correctement transmise', async () => {
    const r = await requeteHttps(port, { method: 'POST', chemin: '/api/auth/login', corps: { login: 'admin', password: 'admin' }, empreinte: cert.empreinte });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['set-cookie']), /; Secure/);
    assert.match(r.headers['strict-transport-security'] || '', /max-age/);
    const connexion = app.db.list('audit', (a) => a.action === 'connexion').pop();
    assert.match(connexion.ip, /127\.0\.0\.1/, 'adresse IP du poste conservée (journal, anti-force-brute)');
  });

  test('HTTP en clair : redirection vers https://, aucune donnée servie', async () => {
    const r = await requeteHttp(port, { chemin: '/api/auth/infos?x=1' });
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, `https://127.0.0.1:${port}/api/auth/infos?x=1`);
    assert.ok(!r.texte.includes('"version"'));
    assert.equal(r.headers['cache-control'], 'no-store');
    const p = await requeteHttp(port, { chemin: '/', hote: 'srv-mixte:8585' });
    assert.equal(p.headers.location, `https://srv-mixte:${port}/`);
    const post = await requeteHttp(port, { method: 'POST', chemin: '/api/auth/login' });
    assert.equal(post.status, 403);
    assert.match(JSON.parse(post.texte).erreur, /Connexion chiffrée obligatoire/);
    const mauvaisHote = await requeteHttp(port, { chemin: '/', hote: 'a b"<x>' });
    assert.equal(mauvaisHote.status, 400, 'en-tête Host invalide : pas de redirection');
    const relatif = await requeteHttp(port, { chemin: '//pirate.example/x' });
    assert.equal(relatif.headers.location, `https://127.0.0.1:${port}/`, 'aucune redirection vers un autre site');
  });

  test('connexion inconnue ou trop lente : fermée', async () => {
    const ferme = (envoi) => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { if (envoi) s.write(envoi); });
      const t0 = Date.now();
      s.on('data', () => {});
      s.on('error', () => {});
      s.on('close', () => resolve(Date.now() - t0));
    });
    assert.ok(await ferme(Buffer.from([0x00, 0x01, 0x02])) < 2000, 'octets inconnus : connexion coupée');
    // En-têtes HTTPS jamais terminés : coupure par headersTimeout (suivi des connexions actif)
    const duree = await new Promise((resolve) => {
      const s = require('tls').connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
      const t0 = Date.now();
      const echeance = setTimeout(() => { resolve(Infinity); s.destroy(); }, 4000);
      s.on('data', () => {});
      s.on('error', () => {});
      s.on('close', () => { clearTimeout(echeance); resolve(Date.now() - t0); });
    });
    assert.ok(duree < 3000, `connexion lente coupée (${duree} ms)`);
  });
});

describe('Sonde d\'un serveur GMAO', () => {
  let app;
  let ecoute;
  let port;
  let cert;
  let appHttp;
  let portHttp;

  before(async () => {
    cert = tlsGmao.genererCertificat({ nomPoste: 'srv-sonde' });
    app = createApp({ inMemory: true, log: () => {}, tls: { key: cert.cle, cert: cert.certificat } });
    ecoute = await tlsGmao.ecouterMixte(app.server, 0, '127.0.0.1');
    port = ecoute.adresse.port;
    appHttp = createApp({ inMemory: true, log: () => {} });
    portHttp = (await appHttp.start(0)).port;
  });
  after(async () => { await ecoute.fermer(); await app.stop(); await appHttp.stop(); });

  test('HTTPS sans empreinte connue : empreinte présentée renvoyée', async () => {
    const r = await tlsGmao.sonder(`https://127.0.0.1:${port}/`);
    assert.equal(r.ok, true);
    assert.equal(r.protocole, 'https');
    assert.equal(r.empreinte, cert.empreinte);
    assert.equal(r.empreinteCle, cert.empreinteCle);
    assert.equal(r.correspond, null);
    assert.equal(typeof r.infos.version, 'string');
  });

  test('HTTPS avec empreinte confirmée : accepté ; empreinte différente : coupé avant toute requête', async () => {
    const ok = await tlsGmao.sonder(`https://127.0.0.1:${port}/`, { empreinte: cert.empreinte });
    assert.equal(ok.ok, true);
    assert.equal(ok.correspond, true);
    // Serveur HTTPS espion : aucune requête ne doit lui parvenir
    const espion = tlsGmao.genererCertificat({ nomPoste: 'pirate' });
    let requetes = 0;
    const faux = https.createServer({ key: espion.cle, cert: espion.certificat }, (req, res) => { requetes += 1; res.end('{}'); });
    await new Promise((r) => faux.listen(0, '127.0.0.1', r));
    try {
      const ko = await tlsGmao.sonder(`https://127.0.0.1:${faux.address().port}/`, { empreinte: cert.empreinte, empreinteCle: cert.empreinteCle });
      assert.equal(ko.ok, false);
      assert.equal(ko.erreur, 'empreinte');
      assert.equal(ko.empreinte, espion.empreinte);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(requetes, 0, 'aucune requête envoyée à un serveur non reconnu');
    } finally { faux.close(); }
  });

  test('certificat renouvelé avec la même clé : reconnu par l\'empreinte de clé', async () => {
    const renouvele = tlsGmao.genererCertificat({ nomPoste: 'srv-sonde', cle: cert.cle });
    const app2 = createApp({ inMemory: true, log: () => {}, tls: { key: renouvele.cle, cert: renouvele.certificat } });
    const p2 = (await app2.start(0)).port;
    try {
      const r = await tlsGmao.sonder(`https://127.0.0.1:${p2}/`, { empreinte: cert.empreinte, empreinteCle: cert.empreinteCle });
      assert.equal(r.ok, true);
      assert.equal(r.parCle, true);
      assert.equal(r.empreinte, renouvele.empreinte);
    } finally { await app2.stop(); }
  });

  test('HTTP : serveur ancien (en clair) ou redirection vers HTTPS signalée', async () => {
    const clair = await tlsGmao.sonder(`http://127.0.0.1:${portHttp}/`);
    assert.equal(clair.ok, true);
    assert.equal(clair.protocole, 'http');
    assert.equal(clair.empreinte, undefined);
    const red = await tlsGmao.sonder(`http://127.0.0.1:${port}/`);
    assert.equal(red.ok, false);
    assert.equal(red.erreur, 'redirection-https');
    assert.equal(red.redirectionHttps, `https://127.0.0.1:${port}/`);
    const versClair = await tlsGmao.sonder(`https://127.0.0.1:${portHttp}/`);
    assert.equal(versClair.ok, false);
    assert.equal(versClair.erreur, 'protocole', 'HTTPS demandé vers un serveur en clair : pas de déclassement automatique');
  });

  test('erreurs : port fermé, serveur qui n\'est pas une GMAO, redirection externe, délai', async () => {
    const libre = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    assert.equal((await tlsGmao.sonder(`http://127.0.0.1:${libre}/`)).erreur, 'refus');
    const autre = http.createServer((req, res) => {
      if (req.url.includes('infos')) { res.writeHead(302, { location: 'https://pirate.example/' }); return res.end(); }
      res.end('ok');
    });
    await new Promise((r) => autre.listen(0, '127.0.0.1', r));
    const muet = net.createServer(() => {});
    await new Promise((r) => muet.listen(0, '127.0.0.1', r));
    const page = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    try {
      assert.equal((await tlsGmao.sonder(`http://127.0.0.1:${autre.address().port}/`)).erreur, 'redirection');
      assert.equal((await tlsGmao.sonder(`http://127.0.0.1:${page.address().port}/`)).erreur, 'pas-gmao');
      assert.equal((await tlsGmao.sonder(`http://127.0.0.1:${muet.address().port}/`, { delaiMs: 300 })).erreur, 'delai');
      assert.equal((await tlsGmao.sonder('ftp://x/')).erreur, 'adresse');
    } finally { autre.close(); muet.close(); page.close(); }
  });
});
