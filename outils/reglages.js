#!/usr/bin/env node
'use strict';
// Pose dans les réglages Claude Code de l'utilisateur les permissions du connecteur Odoo :
//   lecture autorisée sans question, application d'une modification toujours demandée,
//   lecture du fichier de configuration (clé API) refusée.
// Usage : node reglages.js --fichier <settings.json> [--verifier]
// Idempotent. Sauvegarde le fichier une fois avant la première modification.
// Code de sortie : 0 conforme (ou appliqué), 2 à faire (--verifier), 1 erreur.

const fs = require('node:fs');
const path = require('node:path');

const REGLES = {
  allow: ['connexion', 'modeles', 'champs', 'boutons', 'rechercher', 'lire', 'regrouper', 'preparer_modification']
    .map((o) => `mcp__odoo__odoo_${o}`),
  ask: ['mcp__odoo__odoo_appliquer_modification'],
  deny: ['Read(~/.config/claude-odoo/**)'],
};

const args = process.argv.slice(2);
if (args.includes('--help') || !args.includes('--fichier')) {
  console.log('Usage : node reglages.js --fichier <settings.json> [--verifier]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const fichier = args[args.indexOf('--fichier') + 1];
const verifier = args.includes('--verifier');

let reglages = {};
if (fs.existsSync(fichier)) {
  try {
    reglages = JSON.parse(fs.readFileSync(fichier, 'utf8').replace(/^﻿/, '') || '{}');
  } catch (e) {
    console.log(`erreur : ${fichier} n'est pas un JSON valide (${e.message}). Rien n'est modifié.`);
    process.exit(1);
  }
}

const perms = reglages.permissions && typeof reglages.permissions === 'object' ? reglages.permissions : {};
const manquantes = [];
for (const [liste, regles] of Object.entries(REGLES)) {
  const actuelles = Array.isArray(perms[liste]) ? perms[liste] : [];
  for (const r of regles) if (!actuelles.includes(r)) manquantes.push([liste, r]);
}
// Une règle « allow » sur l'application d'une modification annulerait la demande d'accord.
const allowActuel = Array.isArray(perms.allow) ? perms.allow : [];
const tropLarges = allowActuel.filter((r) => r === 'mcp__odoo' || r === 'mcp__odoo__*' || r === REGLES.ask[0]);

if (!manquantes.length && !tropLarges.length) {
  console.log('conforme');
  process.exit(0);
}
if (verifier) {
  for (const [l, r] of manquantes) console.log(`manque ${l} : ${r}`);
  for (const r of tropLarges) console.log(`à retirer de allow : ${r}`);
  process.exit(2);
}

if (fs.existsSync(fichier)) {
  const sauvegarde = fichier + '.avant-claude-odoo';
  if (!fs.existsSync(sauvegarde)) fs.copyFileSync(fichier, sauvegarde);
} else {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
}
for (const [l, r] of manquantes) {
  if (!Array.isArray(perms[l])) perms[l] = [];
  perms[l].push(r);
}
if (tropLarges.length) perms.allow = perms.allow.filter((r) => !tropLarges.includes(r));
reglages.permissions = perms;
fs.writeFileSync(fichier, JSON.stringify(reglages, null, 2) + '\n', 'utf8');
console.log(`appliqué : ${manquantes.length} règle(s) ajoutée(s)` + (tropLarges.length ? `, ${tropLarges.length} retirée(s)` : ''));
