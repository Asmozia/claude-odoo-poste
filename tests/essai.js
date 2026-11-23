'use strict';
// Essai du connecteur contre un faux Odoo local : node --test tests/essai.js
// Lance le vrai serveur MCP en sous-processus et lui parle en JSON-RPC, comme Claude.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVEUR = path.join(__dirname, '..', 'connecteur', 'server', 'index.js');

function fauxOdoo() {
  const alertes = new Map([[7, { id: 7, display_name: 'QA00007', name: 'QA00007', title: 'Bavure', priority: '0', state: 'x' }]]);
  const ecritures = [];
  const champs = {
    name: { string: 'Référence', type: 'char', readonly: true },
    title: { string: 'Titre', type: 'char' },
    priority: { string: 'Priorité', type: 'selection', selection: [['0', 'Normale'], ['1', 'Haute']] },
    state: { string: 'Statut', type: 'selection' },
    team_id: { string: 'Équipe', type: 'many2one', relation: 'quality.alert.team' },
    line_ids: { string: 'Lignes', type: 'one2many', relation: 'quality.alert' },
    user_ids: { string: 'Utilisateurs', type: 'many2many', relation: 'res.users' },
  };
  const serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (d) => (corps += d));
    req.on('end', () => {
      const { id, params: { service, method, args } } = JSON.parse(corps);
      const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (service === 'common' && method === 'authenticate') return ok(args[2] === 'bonne-cle' ? 5 : false);
      if (service === 'common' && method === 'version') return ok({ server_version: '19.0' });
      const [, , , modele, methode, a, kw] = args;
      if (methode === 'context_get') return ok({ lang: 'fr_FR', tz: 'Europe/Paris' });
      if (methode === 'get_available_models') return ok([{ model: 'quality.alert', display_name: 'Alerte qualité' }, { model: 'mrp.production', display_name: 'Ordre de fabrication' }]);
      if (methode === 'get_views') return ok({ views: { form: { arch: '<form><header><button name="action_fermer" type="object" string="Cl&#39;oturer"/><button name="web_save" type="object" string="X"/><button name="123" type="action" string="Y"/></header></form>' } } });
      if (modele === 'res.users') return ok([{ id: 5, name: 'Camille Essai', login: 'camille@example.com', company_id: [1, 'Fabrique Essai'], company_ids: [1], tz: 'Europe/Paris' }]);
      if (methode === 'fields_get') return ok(champs);
      if (methode === 'search_count') return ok(a[0].length ? a[0][0][2].filter((i) => alertes.has(i)).length : alertes.size);
      if (methode === 'search_read') return ok([...alertes.values()].map((l) => Object.fromEntries(['id', ...kw.fields].map((f) => [f, l[f]]))));
      if (methode === 'read') return ok(a[0].filter((i) => alertes.has(i)).map((i) => Object.fromEntries(['id', ...kw.fields].map((f) => [f, alertes.get(i)[f]]))));
      if (methode === 'write') { ecritures.push(a); for (const i of a[0]) Object.assign(alertes.get(i), a[1]); return ok(true); }
      if (methode === 'create') { const n = { id: 8, display_name: 'QA00008', ...a[0] }; alertes.set(8, n); ecritures.push(a); return ok(8); }
      if (methode === 'unlink') { ecritures.push(a); for (const i of a[0]) alertes.delete(i); return ok(true); }
      if (methode === 'action_fermer') { ecritures.push(a); for (const i of a[0]) alertes.get(i).state = 'done'; return ok(null); }
      if (methode === 'action_assistant') return ok({ type: 'ir.actions.act_window', target: 'new', name: 'Confirmer la clôture' });
      if (methode === 'formatted_read_group') return ok([{ __count: alertes.size }]);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'Odoo Server Error', data: { name: 'odoo.exceptions.AccessError', message: 'Accès refusé' } } }));
    });
  });
  return new Promise((r) => serveur.listen(0, '127.0.0.1', () => r({ serveur, alertes, ecritures, url: `http://127.0.0.1:${serveur.address().port}` })));
}

function lancer(env) {
  const p = spawn(process.execPath, [SERVEUR], { env: { ...process.env, CLAUDE_ODOO_CONFIG: path.join(__dirname, 'absent.json'), ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let tampon = '', n = 0;
  const attente = new Map();
  p.stdout.on('data', (d) => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const m = JSON.parse(tampon.slice(0, i));
      tampon = tampon.slice(i + 1);
      if (attente.has(m.id)) { attente.get(m.id)(m); attente.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; attente.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  // Comme Claude : appliquer répète l'opération, le modèle et le nombre de fiches de la préparation.
  const appliquer = (prep, plus = {}) => outil('odoo_appliquer_modification', {
    jeton: prep.jeton, operation: prep.demande.operation, modele: prep.demande.modele,
    nombre: prep.demande.ids ? prep.demande.ids.length : 1, resume: 'essai', ...plus });
  const outil = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const t = m.result.content[0].text;
    if (m.result.isError) return { erreur: t };
    const r = JSON.parse(t);
    if (name === 'odoo_preparer_modification') r.demande = args;
    return r;
  };
  return { rpc, outil, appliquer, fin: () => p.kill() };
}

const envOk = (url, plus = {}) => ({ ODOO_URL: url, ODOO_BASE: 'essai', ODOO_LOGIN: 'camille@example.com', ODOO_CLE: 'bonne-cle', ODOO_ECRITURE: 'true', ODOO_MODELES_ECRITURE: 'quality.alert', ...plus });

test('protocole MCP : initialize, tools/list, méthode inconnue', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url));
  const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const liste = await c.rpc('tools/list', {});
  assert.equal(liste.result.tools.length, 9);
  assert.ok(liste.result.tools.every((t) => t.inputSchema && !('run' in t)));
  assert.equal(liste.result.tools.find((t) => t.name === 'odoo_appliquer_modification').annotations.destructiveHint, true);
  assert.equal((await c.rpc('nimporte', {})).error.code, -32601);
  assert.ok(liste.result.tools.find((t) => t.name === 'odoo_appliquer_modification').inputSchema.required.includes('resume'));
  c.fin(); o.serveur.close();
});

test('lecture : connexion, recherche, regroupement', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url));
  const qui = await c.outil('odoo_connexion', {});
  assert.equal(qui.utilisateur, 'Camille Essai');
  assert.deepEqual(qui.modeles_modifiables, ['quality.alert']);
  const r = await c.outil('odoo_rechercher', { modele: 'quality.alert', champs: ['name', 'title'], domaine: '[]' });
  assert.equal(r.total, 1);
  assert.equal(r.lignes[0].title, 'Bavure');
  assert.equal((await c.outil('odoo_regrouper', { modele: 'quality.alert' })).groupes[0].__count, 1);
  assert.match(qui.maintenant_utc, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(qui.decalage, /UTC\+[12] h/);
  assert.deepEqual((await c.outil('odoo_modeles', { recherche: 'qualite' })).modeles, [{ modele: 'quality.alert', libelle: 'Alerte qualité' }]);
  assert.deepEqual((await c.outil('odoo_boutons', { modele: 'quality.alert' })).boutons, [{ libelle: "Cl'oturer", methode: 'action_fermer' }]);
  c.fin(); o.serveur.close();
});

test('écriture en deux temps, jeton à usage unique', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url));
  const prep = await c.outil('odoo_preparer_modification', { operation: 'modifier', modele: 'quality.alert', ids: [7], valeurs: { priority: '1' } });
  assert.equal(prep.rien_n_est_ecrit, true);
  assert.equal(prep.resume.enregistrements[0].avant.priority, '0');
  assert.equal(o.ecritures.length, 0, 'préparer ne doit rien écrire');
  const faux = await c.appliquer(prep, { modele: 'mrp.production' });
  assert.match(faux.erreur, /alors que la préparation porte sur/);
  assert.equal(o.ecritures.length, 0, 'un appel incohérent ne doit rien écrire');
  const prep2 = await c.outil('odoo_preparer_modification', { operation: 'modifier', modele: 'quality.alert', ids: [7], valeurs: { priority: '1' } });
  const fait = await c.appliquer(prep2);
  assert.equal(fait.fait, true);
  assert.equal(o.alertes.get(7).priority, '1');
  assert.match((await c.appliquer(prep2)).erreur, /Jeton inconnu/);
  assert.match((await c.appliquer(prep)).erreur, /Jeton inconnu/, 'le jeton de l\'appel incohérent est brûlé');
  assert.equal(o.ecritures.length, 1);
  const cree = await c.outil('odoo_preparer_modification', { operation: 'creer', modele: 'quality.alert', valeurs: { title: 'Rayure' } });
  assert.equal((await c.appliquer(cree)).id, 8);
  c.fin(); o.serveur.close();
});

test('refus : fiche changée entre-temps, statut, lecture seule, modèle hors liste, modèle technique', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url, { ODOO_MODELES_ECRITURE: 'quality.alert, ir.rule' }));
  const prep = await c.outil('odoo_preparer_modification', { operation: 'modifier', modele: 'quality.alert', ids: [7], valeurs: { title: 'Bavure carter' } });
  o.alertes.get(7).title = 'Modifié par un collègue';
  assert.match((await c.appliquer(prep)).erreur, /ont changé dans Odoo/);
  assert.equal(o.alertes.get(7).title, 'Modifié par un collègue');
  const p = (modele, valeurs) => c.outil('odoo_preparer_modification', { operation: 'modifier', modele, ids: [7], valeurs });
  assert.match((await p('quality.alert', { state: 'done' })).erreur, /statut change par une action/);
  assert.match((await p('quality.alert', { name: 'X' })).erreur, /lecture seule/);
  assert.match((await p('quality.alert', { inconnu: 1 })).erreur, /n'existe pas/);
  assert.match((await c.outil('odoo_preparer_modification', { operation: 'supprimer', modele: 'quality.alert', ids: [null] })).erreur, /identifiants entiers/);
  assert.match((await p('mrp.production', { title: 'x' })).erreur, /n'est pas dans la liste/);
  assert.match((await p('ir.rule', { title: 'x' })).erreur, /modèle technique/);
  assert.equal(o.ecritures.length, 0);
  c.fin(); o.serveur.close();
});

test('poste en lecture seule, mauvaise clé, config absente', async () => {
  const o = await fauxOdoo();
  let c = lancer(envOk(o.url, { ODOO_ECRITURE: 'false' }));
  assert.match((await c.outil('odoo_preparer_modification', { operation: 'creer', modele: 'quality.alert', valeurs: { title: 'x' } })).erreur, /lecture seule/);
  c.fin();
  c = lancer(envOk(o.url, { ODOO_CLE: 'mauvaise' }));
  assert.match((await c.outil('odoo_connexion', {})).erreur, /Connexion refusée/);
  c.fin();
  c = lancer({ ODOO_URL: '' });
  assert.match((await c.outil('odoo_connexion', {})).erreur, /non configuré/);
  c.fin(); o.serveur.close();
});

test('liste vide = tous les modèles ; action métier, assistant, suppression', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url, { ODOO_MODELES_ECRITURE: '' }));
  assert.equal((await c.outil('odoo_connexion', {})).modeles_modifiables, 'tous ceux que le compte Odoo autorise');
  const p = (args) => c.outil('odoo_preparer_modification', { modele: 'un.modele.quelconque', ids: [7], ...args });
  const act = await p({ operation: 'action', methode: 'action_fermer' });
  assert.equal(act.resume.enregistrements[0].state, 'x');
  assert.equal(o.ecritures.length, 0);
  const fait = await c.appliquer(act);
  assert.equal(fait.fait, true);
  assert.equal(fait.fiches_relues[0].state, 'done');
  const ass = await p({ operation: 'action', methode: 'action_assistant' });
  assert.equal((await c.appliquer(ass)).fait, 'à terminer');
  for (const m of ['_prive', 'unlink', 'write', 'web_save', 'message_post', 'export_data', 'toggle_active']) {
    assert.match((await p({ operation: 'action', methode: m })).erreur, /n'est pas un bouton/, m);
  }
  assert.match((await c.outil('odoo_preparer_modification', { operation: 'supprimer', modele: 'res.users', ids: [7] })).erreur, /modèle technique/);
  const sup = await p({ operation: 'supprimer' });
  assert.equal(sup.resume.operation, 'SUPPRESSION DÉFINITIVE');
  assert.ok(o.alertes.has(7));
  const supFait = await c.appliquer(sup);
  assert.equal(supFait.fait, true);
  assert.ok(!o.alertes.has(7));
  c.fin(); o.serveur.close();
});

test('lignes imbriquées et fiches liées : mêmes garde-fous que le document', async () => {
  const o = await fauxOdoo();
  const c = lancer(envOk(o.url, { ODOO_MODELES_ECRITURE: '' }));
  const p = (valeurs) => c.outil('odoo_preparer_modification', { operation: 'modifier', modele: 'quality.alert', ids: [7], valeurs });
  assert.match((await p({ line_ids: [[1, 7, { state: 'done' }]] })).erreur, /statut change par une action/);
  assert.match((await p({ line_ids: [[0, 0, { inconnu: 1 }]] })).erreur, /n'existe pas/);
  assert.match((await p({ user_ids: [[0, 0, { title: 'x' }]] })).erreur, /modèle technique/);
  assert.match((await p({ user_ids: [[2, 5]] })).erreur, /modèle technique/);
  assert.match((await p({ line_ids: [7] })).erreur, /liste de commandes/);
  assert.equal((await p({ user_ids: [[6, 0, [5]]] })).rien_n_est_ecrit, true, 'lier des fiches existantes reste permis');
  assert.equal((await p({ line_ids: [[0, 0, { title: 'ligne' }]] })).rien_n_est_ecrit, true);
  assert.match((await p({ team_id: 'Équipe A' })).erreur, /attend l'identifiant/);
  assert.match((await p({ team_id: 99 })).erreur, /introuvable/);
  assert.equal((await p({ team_id: 7 })).resume.fiches_liees.team_id, 'QA00007');
  assert.equal(o.ecritures.length, 0);
  c.fin(); o.serveur.close();
});
