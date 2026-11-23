#!/usr/bin/env node
'use strict';
// Serveur MCP « odoo » (stdio, JSON-RPC une ligne par message). Aucune dépendance.
//   node index.js              serveur MCP, lancé par Claude
//   node index.js --verifier   teste la connexion à Odoo et s'arrête (code 0 = OK)

const readline = require('node:readline');
const { ClientOdoo, lireConfig, cheminConfig } = require('./odoo.js');
const { creerOutils } = require('./outils.js');

const VERSION = '1.0.0';
const PROTOCOLES = ['2025-06-18', '2025-03-26', '2024-11-05'];

function demarrer() {
  let client, erreurConfig = null;
  try {
    client = new ClientOdoo(lireConfig(process.env));
  } catch (e) {
    erreurConfig = e;
    client = new ClientOdoo({ url: '', base: '', login: '', cle: '', ecriture: false, modelesEcriture: [] });
  }
  return { client, erreurConfig, ...creerOutils(client) };
}

async function verifier() {
  const { client, erreurConfig, executer } = demarrer();
  console.log(`Configuration : ${process.env.ODOO_URL ? "variables d'environnement" : cheminConfig(process.env)}`);
  try {
    if (erreurConfig) throw erreurConfig;
    const r = JSON.parse(await executer('odoo_connexion', {}));
    console.log(`Connexion OK : ${r.utilisateur} (${r.societe}), Odoo ${r.odoo.version}, base ${r.odoo.base}`);
    console.log(`Modifications : ${r.modifications}` + (Array.isArray(r.modeles_modifiables) && r.modeles_modifiables.length ? `, limitées à ${r.modeles_modifiables.join(', ')}` : ''));
    void client;
    return 0;
  } catch (e) {
    console.log(`ÉCHEC : ${e.message}`);
    return 1;
  }
}

function servir() {
  const { erreurConfig, catalogue, executer } = demarrer();
  const envoyer = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const journal = (t) => process.stderr.write(`[odoo] ${t}\n`);
  if (erreurConfig) journal(`configuration : ${erreurConfig.message}`);

  async function traiter(msg) {
    const { id, method, params } = msg;
    const repondre = (result) => envoyer({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize': {
        const demande = params && params.protocolVersion;
        return repondre({
          protocolVersion: PROTOCOLES.includes(demande) ? demande : PROTOCOLES[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'odoo', title: 'Odoo', version: VERSION },
          instructions:
            "Accès à l'Odoo de l'entreprise avec le compte de l'utilisateur. Lecture libre dans ses droits. " +
            "Toute écriture (créer, modifier, action, supprimer) passe par odoo_preparer_modification, puis l'accord explicite de l'utilisateur sur le résumé, puis odoo_appliquer_modification.",
        });
      }
      case 'ping':
        return repondre({});
      case 'tools/list':
        return repondre({ tools: catalogue });
      case 'tools/call': {
        try {
          if (erreurConfig) throw erreurConfig;
          const texte = await executer(params && params.name, params && params.arguments);
          return repondre({ content: [{ type: 'text', text: texte }] });
        } catch (e) {
          journal(`${params && params.name} : ${e.message}`);
          return repondre({ content: [{ type: 'text', text: `Erreur : ${e.message}` }], isError: true });
        }
      }
      default:
        if (id === undefined) return undefined; // notification : pas de réponse
        return envoyer({ jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${method}` } });
    }
  }

  let enCours = 0, ferme = false;
  const finir = () => { if (ferme && enCours === 0) process.exit(0); };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (ligne) => {
    if (!ligne.trim()) return;
    let msg;
    try {
      msg = JSON.parse(ligne);
    } catch (e) {
      return envoyer({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalide' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return envoyer({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Requête invalide' } });
    }
    enCours++;
    traiter(msg)
      .catch((e) => {
        journal(e.stack || e.message);
        if (msg.id !== undefined) envoyer({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
      })
      .finally(() => { enCours--; finir(); });
  });
  rl.on('close', () => { ferme = true; finir(); });
}

if (process.argv.includes('--verifier')) {
  verifier().then((code) => process.exit(code));
} else {
  servir();
}
