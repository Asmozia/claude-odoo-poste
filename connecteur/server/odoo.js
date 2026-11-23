'use strict';
// Client Odoo minimal (JSON-RPC, clé API). Aucune dépendance : fetch est fourni par Node 18+.

class ErreurOdoo extends Error {}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function cheminConfig(env) {
  return env.CLAUDE_ODOO_CONFIG || path.join(os.homedir(), '.config', 'claude-odoo', 'config.json');
}

// Config du poste : fichier hors dépôt (cas normal, Claude Code), ou variables
// d'environnement ODOO_* (tests, autre lanceur). Les variables priment.
function lireConfig(env) {
  const propre = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    // Un champ facultatif laissé vide peut arriver non substitué : "${user_config.x}".
    return s.startsWith('${') ? '' : s;
  };
  if (!propre(env.ODOO_URL)) {
    const f = cheminConfig(env);
    if (fs.existsSync(f)) {
      let c;
      try {
        c = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        throw new ErreurOdoo(`Le fichier de configuration ${f} n'est pas un JSON valide : ${e.message}`);
      }
      const m = c.modeles_modifiables;
      env = {
        ODOO_URL: c.adresse, ODOO_BASE: c.base, ODOO_LOGIN: c.identifiant, ODOO_CLE: c.cle_api,
        ODOO_ECRITURE: c.modifications === true ? 'true' : 'false',
        ODOO_MODELES_ECRITURE: Array.isArray(m) ? m.join(',') : m,
      };
    }
  }
  let url = propre(env.ODOO_URL);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  // Une adresse collée depuis le navigateur porte souvent un chemin : on ne garde que le site.
  if (url) {
    try { url = new URL(url).origin; } catch (e) { throw new ErreurOdoo(`Adresse Odoo invalide : ${url}`); }
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
  if (url && !/^https:\/\//i.test(url) && !local) {
    throw new ErreurOdoo("L'adresse Odoo doit commencer par https://");
  }
  const liste = propre(env.ODOO_MODELES_ECRITURE)
    .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return {
    url,
    base: propre(env.ODOO_BASE),
    login: propre(env.ODOO_LOGIN),
    cle: propre(env.ODOO_CLE),
    ecriture: /^(true|1|oui|yes)$/i.test(propre(env.ODOO_ECRITURE)),
    modelesEcriture: liste,
  };
}

class ClientOdoo {
  constructor(config) {
    this.config = config;
    this._uid = null;
    this._n = 0;
    this._champs = new Map();
    this._contexte = { lang: 'fr_FR' };
  }

  manquants() {
    const noms = { url: "l'adresse Odoo", base: 'le nom de la base', login: "l'identifiant", cle: 'la clé API' };
    return Object.keys(noms).filter((k) => !this.config[k]).map((k) => noms[k]);
  }

  async rpc(service, method, args) {
    const manque = this.manquants();
    if (manque.length) {
      throw new ErreurOdoo(
        'Connecteur non configuré : il manque ' + manque.join(', ') +
        `. Compléter le fichier ${cheminConfig(process.env)} puis redémarrer Claude.`);
    }
    let rep;
    try {
      rep = await fetch(this.config.url + '/jsonrpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++this._n, params: { service, method, args } }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      throw new ErreurOdoo(
        `Odoo injoignable (${this.config.url}) : ${e.name === 'TimeoutError' ? 'pas de réponse en 90 s' : e.message}. ` +
        "Vérifier la connexion du poste et l'adresse dans la configuration.");
    }
    if (!rep.ok) throw new ErreurOdoo(`Odoo a répondu ${rep.status} sur ${this.config.url}/jsonrpc.`);
    let corps;
    try {
      corps = await rep.json();
    } catch (e) {
      throw new ErreurOdoo("La réponse n'est pas celle d'un Odoo : vérifier l'adresse dans la configuration.");
    }
    if (corps.error) {
      const d = corps.error.data || {};
      const msg = d.message || corps.error.message || 'Erreur Odoo';
      throw new ErreurOdoo(d.name && !/UserError|AccessError|ValidationError|MissingError/.test(d.name) ? `${msg} (${d.name})` : msg);
    }
    return corps.result;
  }

  async uid() {
    if (this._uid) return this._uid;
    const uid = await this.rpc('common', 'authenticate', [this.config.base, this.config.login, this.config.cle, {}]);
    if (!uid) {
      throw new ErreurOdoo(
        'Connexion refusée par Odoo : identifiant, clé API ou nom de base incorrect, ou clé API expirée ' +
        "(Odoo limite la durée d'une clé). Refaire une clé : Mon profil > Sécurité du compte > Nouvelle clé API, " +
        'puis la saisir avec setup.ps1 -SaisirCle.');
    }
    this._uid = uid;
    // Langue et fuseau de l'utilisateur : libellés dans sa langue, périodes découpées dans son fuseau.
    try {
      const c = await this.rpc('object', 'execute_kw', [this.config.base, uid, this.config.cle, 'res.users', 'context_get', [], {}]);
      this._contexte = { lang: c.lang || 'fr_FR', ...(c.tz ? { tz: c.tz } : {}) };
    } catch (e) {
      this._contexte = { lang: 'fr_FR' };
    }
    return uid;
  }

  async appeler(modele, methode, args = [], kwargs = {}) {
    const uid = await this.uid();
    const kw = { ...kwargs, context: { ...this._contexte, ...(kwargs.context || {}) } };
    return this.rpc('object', 'execute_kw', [this.config.base, uid, this.config.cle, modele, methode, args, kw]);
  }

  async version() {
    const v = await this.rpc('common', 'version', []);
    return v && v.server_version;
  }

  async champs(modele) {
    if (!this._champs.has(modele)) {
      const f = await this.appeler(modele, 'fields_get', [], {
        attributes: ['string', 'type', 'relation', 'required', 'readonly', 'selection', 'store'],
      });
      this._champs.set(modele, f);
    }
    return this._champs.get(modele);
  }
}

module.exports = { ClientOdoo, ErreurOdoo, lireConfig, cheminConfig };
