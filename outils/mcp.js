#!/usr/bin/env node
'use strict';
// Inscrit le serveur MCP « odoo » (portée utilisateur) dans le .claude.json de Claude Code,
// ou vérifie qu'il y est. Marche aussi sans la commande « claude » (application de bureau).
// Usage : node mcp.js --fichier <.claude.json> --index <index.js> [--verifier]
// Idempotent. Sauvegarde le fichier une fois avant la première modification.
// Code de sortie : 0 conforme (ou appliqué), 2 à faire (--verifier), 1 erreur.

const fs = require('node:fs');

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const fichier = val('--fichier');
const index = val('--index');
if (args.includes('--help') || !fichier || !index) {
  console.log('Usage : node mcp.js --fichier <.claude.json> --index <index.js> [--verifier]');
  process.exit(args.includes('--help') ? 0 : 1);
}

let conf = {};
if (fs.existsSync(fichier)) {
  try {
    conf = JSON.parse(fs.readFileSync(fichier, 'utf8').replace(/^﻿/, '') || '{}');
  } catch (e) {
    console.log(`erreur : ${fichier} n'est pas un JSON valide (${e.message}). Rien n'est modifié.`);
    process.exit(1);
  }
}
const actuel = conf.mcpServers && conf.mcpServers.odoo;
if (actuel && Array.isArray(actuel.args) && actuel.args.includes(index)) {
  console.log('conforme');
  process.exit(0);
}
if (args.includes('--verifier')) {
  console.log(actuel ? 'enregistré vers un autre chemin' : 'odoo non enregistré');
  process.exit(2);
}
if (fs.existsSync(fichier) && !fs.existsSync(fichier + '.avant-claude-odoo')) {
  fs.copyFileSync(fichier, fichier + '.avant-claude-odoo');
}
conf.mcpServers = conf.mcpServers || {};
// Chemin complet de node : le PATH de Claude peut dater d'avant l'installation de Node.js.
conf.mcpServers.odoo = { type: 'stdio', command: process.execPath, args: [index], env: {} };
fs.writeFileSync(fichier, JSON.stringify(conf, null, 2) + '\n', 'utf8');
console.log('appliqué');
