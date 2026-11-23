'use strict';
// Les outils exposés à Claude. Lecture libre (dans les droits du compte Odoo),
// écriture en deux temps : préparer (rien n'est écrit) puis appliquer (jeton à usage unique).
// Quatre écritures : créer, modifier, action (bouton d'Odoo), supprimer.

const crypto = require('node:crypto');
const { ErreurOdoo } = require('./odoo.js');

const LIMITE_DEFAUT = 40;
const LIMITE_MAX = 200;
const LOT_MAX = 200;                // enregistrements modifiables en une fois
const DUREE_JETON_MS = 10 * 60 * 1000;
const TAILLE_MAX = 60000;           // caractères renvoyés à Claude

// Sécurité et technique d'Odoo : jamais modifiables par ce connecteur, même pour un administrateur.
const MODELES_INTERDITS = [/^ir\./, /^base\./, /^res\.users/, /^res\.groups/, /^res\.config/];
// Un statut change par une action (le bouton d'Odoo, qui déclenche le métier), pas par une écriture.
const CHAMPS_INTERDITS = new Set(['state', 'quality_state', 'id', 'create_uid', 'create_date', 'write_uid', 'write_date']);
// Une action est un bouton : ces préfixes couvrent les boutons d'Odoo et écartent les
// méthodes génériques qui écriraient sans contrôle (web_save, message_post, export_data...).
const PREFIXES_ACTION = /^(action|button|do)_[a-z0-9_]+$/;

const NOTE_DATES = 'Dates-heures en UTC : convertir avec le décalage donné par odoo_connexion.';

function liste(v, nom, defaut) {
  if (v == null || v === '') {
    if (defaut !== undefined) return defaut;
    throw new ErreurOdoo(`Paramètre « ${nom} » manquant.`);
  }
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { throw new ErreurOdoo(`« ${nom} » doit être une liste JSON.`); }
  }
  if (!Array.isArray(v)) throw new ErreurOdoo(`« ${nom} » doit être une liste.`);
  return v;
}

function identifiants(v) {
  const ids = [...new Set(liste(v, 'ids'))];
  if (!ids.length) throw new ErreurOdoo('Aucun enregistrement désigné.');
  if (!ids.every((i) => Number.isInteger(i) && i > 0)) throw new ErreurOdoo('« ids » : identifiants entiers attendus (les chercher avec odoo_rechercher).');
  return ids;
}

function objet(v, nom) {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { throw new ErreurOdoo(`« ${nom} » doit être un objet JSON.`); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ErreurOdoo(`« ${nom} » doit être un objet { champ: valeur }.`);
  return v;
}

function texte(v, nom) {
  if (typeof v !== 'string' || !v.trim()) throw new ErreurOdoo(`Paramètre « ${nom} » manquant.`);
  return v.trim();
}

function entier(v, defaut, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(max, Math.max(min, n));
}

// Valeur comparable : un many2one lu ([id, nom]) vaut son id.
function comparable(v) {
  if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && typeof v[1] === 'string') return v[0];
  return v === undefined ? false : v;
}
const pareil = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

function horloge(fuseau) {
  const d = new Date();
  const r = { maintenant_utc: d.toISOString().slice(0, 19).replace('T', ' ') };
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
      timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    const local = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    const h = Math.round((Date.parse(local.replace(' ', 'T') + 'Z') - d.getTime()) / 3600000);
    r.maintenant_local = `${p.weekday} ${local}`;
    r.decalage = `heure locale = UTC${h >= 0 ? '+' : ''}${h} h aujourd'hui`;
  } catch (e) {
    r.decalage = "fuseau de l'utilisateur inconnu : lui demander son heure locale";
  }
  return r;
}

function creerOutils(client) {
  const cfg = client.config;
  const jetons = new Map();

  const lien = (modele, id) => `${cfg.url}/web#id=${id}&model=${modele}&view_type=form`;

  function verifierEcriture(modele) {
    if (!cfg.ecriture) {
      throw new ErreurOdoo('Ce poste est en lecture seule : les modifications sont désactivées dans la configuration du poste.');
    }
    if (MODELES_INTERDITS.some((r) => r.test(modele))) {
      throw new ErreurOdoo(`« ${modele} » est un modèle technique : jamais modifiable par Claude. À faire dans Odoo.`);
    }
    // Liste vide = tout ce que le compte Odoo autorise. Une liste restreint le poste.
    if (cfg.modelesEcriture.length && !cfg.modelesEcriture.includes(modele)) {
      throw new ErreurOdoo(
        `« ${modele} » n'est pas dans la liste des modèles modifiables de ce poste ` +
        `(${cfg.modelesEcriture.join(', ')}). À faire dans Odoo, ou demander à l'administrateur d'ajouter ce modèle dans la configuration du poste.`);
    }
  }

  // Contrôle les valeurs d'un create / write, lignes imbriquées comprises (one2many, many2many) :
  // les mêmes règles s'appliquent au modèle des lignes, sinon elles serviraient de contournement.
  async function verifierValeurs(modele, valeurs, profondeur = 0) {
    if (profondeur > 3) throw new ErreurOdoo('Lignes imbriquées sur plus de 3 niveaux : à faire dans Odoo.');
    const champs = await client.champs(modele);
    const noms = Object.keys(valeurs);
    if (!noms.length) throw new ErreurOdoo('Aucune valeur à écrire.');
    for (const nom of noms) {
      const c = champs[nom];
      if (!c) throw new ErreurOdoo(`Le champ « ${nom} » n'existe pas sur ${modele}. Utiliser odoo_champs.`);
      if (CHAMPS_INTERDITS.has(nom)) {
        throw new ErreurOdoo(`Le champ « ${nom} » (${c.string}) ne s'écrit pas directement : un statut change par une action (operation « action » avec la méthode du bouton, voir odoo_boutons).`);
      }
      if (c.readonly) throw new ErreurOdoo(`Le champ « ${nom} » (${c.string}) est en lecture seule dans Odoo.`);
      if (c.type === 'one2many' || c.type === 'many2many') {
        const commandes = valeurs[nom];
        if (!Array.isArray(commandes) || !commandes.every((k) => Array.isArray(k) && Number.isInteger(k[0]))) {
          throw new ErreurOdoo(`« ${nom} » attend une liste de commandes Odoo, par exemple [[6, 0, [ids]]] (remplacer), [[4, id]] (ajouter), [[0, 0, {valeurs}]] (nouvelle ligne).`);
        }
        for (const k of commandes) {
          if (![0, 1, 2, 3, 4, 5, 6].includes(k[0])) throw new ErreurOdoo(`Commande ${k[0]} inconnue sur « ${nom} ».`);
          if (k[0] <= 2) verifierEcriture(c.relation);          // créer, modifier, supprimer une ligne
          if (k[0] <= 1) await verifierValeurs(c.relation, objet(k[2], `${nom} (ligne)`), profondeur + 1);
        }
      }
    }
    return champs;
  }

  // Nom affiché des fiches liées (many2one) qu'on s'apprête à écrire : l'utilisateur valide
  // un nom relu dans Odoo, pas un identifiant ni ce que Claude croit qu'il désigne.
  async function nomsLies(champs, valeurs) {
    const r = {};
    for (const [nom, v] of Object.entries(valeurs)) {
      const c = champs[nom];
      if (c.type !== 'many2one' || v === false || v == null) continue;
      if (!Number.isInteger(v) || v <= 0) throw new ErreurOdoo(`« ${nom} » (${c.string}) attend l'identifiant d'une fiche ${c.relation} : la chercher d'abord par son nom.`);
      const [f] = await client.appeler(c.relation, 'read', [[v]], { fields: ['display_name'] });
      if (!f) throw new ErreurOdoo(`« ${nom} » : la fiche ${c.relation} n°${v} est introuvable.`);
      r[nom] = f.display_name;
    }
    return r;
  }

  const libelles = (champs, noms) => Object.fromEntries(noms.map((n) => [n, champs[n].string]));

  const outils = [
    {
      name: 'odoo_connexion',
      title: 'Odoo : état de la connexion',
      description:
        "Vérifie la connexion à Odoo et dit qui est connecté : utilisateur, société, version, si les modifications sont autorisées sur ce poste, et l'heure qu'il est (UTC et locale). À appeler en premier en cas de doute ou d'erreur, et avant toute question qui dépend de la date ou de l'heure (« aujourd'hui », « hier », « en retard ») : ne jamais deviner la date.",
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async run() {
        const uid = await client.uid();
        const [u] = await client.appeler('res.users', 'read', [[uid]], { fields: ['name', 'login', 'company_id', 'company_ids', 'tz'] });
        return {
          connecte: true,
          utilisateur: u.name,
          identifiant: u.login,
          societe: u.company_id && u.company_id[1],
          nombre_societes: (u.company_ids || []).length,
          fuseau: u.tz || 'non renseigné',
          ...horloge(u.tz || 'Europe/Paris'),
          odoo: { adresse: cfg.url, base: cfg.base, version: await client.version() },
          modifications: cfg.ecriture ? 'autorisées après confirmation' : 'désactivées (lecture seule)',
          modeles_modifiables: !cfg.ecriture ? [] : (cfg.modelesEcriture.length ? cfg.modelesEcriture : 'tous ceux que le compte Odoo autorise'),
        };
      },
    },
    {
      name: 'odoo_modeles',
      title: 'Odoo : trouver un modèle',
      description:
        "Cherche les modèles Odoo (types de documents) accessibles à l'utilisateur, par mot-clé sur le nom technique ou le libellé. Exemple : « qualité » trouve quality.check, quality.alert. À utiliser quand on ne connaît pas le nom technique d'un document.",
      inputSchema: {
        type: 'object',
        properties: { recherche: { type: 'string', description: 'Mot-clé, par exemple « fabrication », « lot », « quality ».' } },
        required: ['recherche'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const plat = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const q = plat(texte(a.recherche, 'recherche'));
        // get_available_models : accessible à un compte standard, contrairement à la lecture de ir.model.
        const tous = await client.appeler('ir.model', 'get_available_models', []);
        const trouves = tous.filter((m) => plat(m.model).includes(q) || plat(m.display_name).includes(q));
        trouves.sort((x, y) => x.model.localeCompare(y.model));
        return { nombre: trouves.length, modeles: trouves.slice(0, 80).map((m) => ({ modele: m.model, libelle: m.display_name })) };
      },
    },
    {
      name: 'odoo_champs',
      title: "Odoo : champs d'un modèle",
      description:
        "Liste les champs d'un modèle Odoo : nom technique, libellé, type, modèle lié, valeurs possibles d'une liste de choix. À appeler avant une recherche sur un modèle dont on n'est pas sûr des champs : ne jamais deviner un nom de champ. Filtrer avec « recherche » sur les gros modèles.",
      inputSchema: {
        type: 'object',
        properties: {
          modele: { type: 'string', description: 'Nom technique, par exemple mrp.production.' },
          recherche: { type: 'string', description: 'Filtre facultatif sur le nom ou le libellé du champ.' },
        },
        required: ['modele'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const champs = await client.champs(texte(a.modele, 'modele'));
        const q = (a.recherche || '').toLowerCase().trim();
        const sortie = [];
        for (const [nom, c] of Object.entries(champs)) {
          if (q && !nom.toLowerCase().includes(q) && !(c.string || '').toLowerCase().includes(q)) continue;
          const l = { champ: nom, libelle: c.string, type: c.type };
          if (c.relation) l.modele_lie = c.relation;
          if (c.selection) l.choix = Object.fromEntries(c.selection);
          if (c.required) l.obligatoire = true;
          if (c.readonly) l.lecture_seule = true;
          if (c.store === false) l.calcule_non_stocke = true;
          sortie.push(l);
        }
        sortie.sort((x, y) => x.champ.localeCompare(y.champ));
        return { modele: a.modele, nombre: sortie.length, champs: sortie };
      },
    },
    {
      name: 'odoo_boutons',
      title: "Odoo : boutons d'un document",
      description:
        "Liste les boutons de la fiche d'un modèle Odoo : libellé affiché à l'écran et méthode technique correspondante. À appeler avant une opération « action » dont on ne connaît pas la méthode : retrouver le bouton par le libellé que donne l'utilisateur (« Confirmer », « Marquer comme fait »), ne jamais deviner une méthode.",
      inputSchema: {
        type: 'object',
        properties: { modele: { type: 'string', description: 'Nom technique, par exemple mrp.production.' } },
        required: ['modele'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const modele = texte(a.modele, 'modele');
        const r = await client.appeler(modele, 'get_views', [], { views: [[false, 'form']] });
        const arch = (r && r.views && r.views.form && r.views.form.arch) || '';
        const vus = new Map();
        for (const balise of arch.match(/<button\b[^>]*>/g) || []) {
          const attr = (n) => { const m = balise.match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? m[1] : ''; };
          const methode = attr('name');
          if (attr('type') !== 'object' || !PREFIXES_ACTION.test(methode) || vus.has(methode)) continue;
          const libelle = (attr('string') || attr('title') || attr('aria-label')).replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
          vus.set(methode, { libelle: libelle || '(sans libellé)', methode });
        }
        return {
          modele,
          boutons: [...vus.values()],
          note: "Tous les boutons de la fiche, quel que soit le statut : Odoo n'en affiche qu'une partie selon l'état du document, et refusera une action hors de propos.",
        };
      },
    },
    {
      name: 'odoo_rechercher',
      title: 'Odoo : rechercher des enregistrements',
      description:
        "Recherche des enregistrements Odoo et renvoie les champs demandés, avec le nombre total de résultats. Le domaine est au format Odoo : liste de conditions [champ, opérateur, valeur], par exemple [[\"state\", \"in\", [\"confirmed\", \"progress\"]], [\"product_id.default_code\", \"=\", \"REF123\"]]. Opérateurs : =, !=, >, >=, <, <=, in, not in, ilike (contient), =ilike. « | » devant deux conditions = OU. " +
        NOTE_DATES + ' Toujours demander peu de champs. Pour compter ou totaliser, préférer odoo_regrouper.',
      inputSchema: {
        type: 'object',
        properties: {
          modele: { type: 'string', description: 'Nom technique, par exemple mrp.production.' },
          domaine: { type: 'array', items: {}, description: 'Conditions Odoo. Liste vide = tout.' },
          champs: { type: 'array', items: { type: 'string' }, description: 'Champs à renvoyer (noms techniques).' },
          limite: { type: 'integer', description: `Nombre de lignes, ${LIMITE_DEFAUT} par défaut, ${LIMITE_MAX} au plus.` },
          decalage: { type: 'integer', description: 'Lignes à sauter (page suivante).' },
          tri: { type: 'string', description: 'Par exemple « date_start desc, id desc ».' },
          archives: { type: 'boolean', description: 'Inclure les enregistrements archivés.' },
        },
        required: ['modele', 'champs'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const modele = texte(a.modele, 'modele');
        const domaine = liste(a.domaine, 'domaine', []);
        const champs = liste(a.champs, 'champs');
        const limite = entier(a.limite, LIMITE_DEFAUT, 1, LIMITE_MAX);
        const decalage = entier(a.decalage, 0, 0, 1e9);
        const kw = { fields: champs, limit: limite, offset: decalage };
        if (a.tri) kw.order = String(a.tri);
        const ctx = a.archives ? { context: { active_test: false } } : {};
        const [total, lignes] = await Promise.all([
          client.appeler(modele, 'search_count', [domaine], ctx),
          client.appeler(modele, 'search_read', [domaine], { ...kw, ...ctx }),
        ]);
        const r = { modele, total, renvoyes: lignes.length, lignes, lien_fiche: lien(modele, '<id>') };
        if (total > decalage + lignes.length) {
          r.suite = `Résultat partiel : ${total - decalage - lignes.length} lignes restantes. Dire à l'utilisateur que la liste est partielle, ou relancer avec decalage=${decalage + lignes.length}.`;
        }
        return r;
      },
    },
    {
      name: 'odoo_lire',
      title: 'Odoo : lire des fiches',
      description: 'Lit des enregistrements Odoo dont on connaît les identifiants. ' + NOTE_DATES,
      inputSchema: {
        type: 'object',
        properties: {
          modele: { type: 'string' },
          ids: { type: 'array', items: { type: 'integer' }, description: `${LIMITE_MAX} identifiants au plus.` },
          champs: { type: 'array', items: { type: 'string' } },
        },
        required: ['modele', 'ids', 'champs'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const modele = texte(a.modele, 'modele');
        const ids = identifiants(a.ids);
        if (ids.length > LIMITE_MAX) throw new ErreurOdoo(`${ids.length} identifiants : ${LIMITE_MAX} au plus par lecture.`);
        const lignes = await client.appeler(modele, 'read', [ids], { fields: liste(a.champs, 'champs') });
        return { modele, lignes, lien_fiche: lien(modele, '<id>') };
      },
    },
    {
      name: 'odoo_regrouper',
      title: 'Odoo : compter et totaliser',
      description:
        "Compte et totalise des enregistrements Odoo par groupe, sans les lire un par un : c'est l'outil des questions « combien », « quel total », « par poste », « par mois ». regroupements : champs de regroupement, avec une période pour les dates (date_start:day, :week, :month, :quarter, :year ; les périodes sont découpées dans le fuseau de l'utilisateur). agregats : « __count » (nombre de lignes) ou champ:fonction (product_qty:sum, duration:avg, date_start:min, :max). Exemple : OF terminés par mois = regroupements [\"date_finished:month\"], agregats [\"__count\", \"product_qty:sum\"].",
      inputSchema: {
        type: 'object',
        properties: {
          modele: { type: 'string' },
          domaine: { type: 'array', items: {}, description: 'Conditions Odoo. Liste vide = tout.' },
          regroupements: { type: 'array', items: { type: 'string' }, description: 'Liste vide = un seul total.' },
          agregats: { type: 'array', items: { type: 'string' }, description: '« __count » par défaut.' },
          tri: { type: 'string', description: 'Par exemple « __count desc ».' },
          limite: { type: 'integer', description: `Nombre de groupes, ${LIMITE_MAX} au plus.` },
        },
        required: ['modele'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const modele = texte(a.modele, 'modele');
        const limite = entier(a.limite, LIMITE_MAX, 1, LIMITE_MAX);
        const kw = {
          domain: liste(a.domaine, 'domaine', []),
          groupby: liste(a.regroupements, 'regroupements', []),
          aggregates: liste(a.agregats, 'agregats', ['__count']),
          limit: limite,
        };
        if (a.tri) kw.order = String(a.tri);
        const groupes = await client.appeler(modele, 'formatted_read_group', [], kw);
        for (const g of groupes) delete g.__extra_domain;
        const r = { modele, nombre_groupes: groupes.length, groupes };
        if (kw.groupby.length && groupes.length >= limite) {
          r.suite = `Liste de groupes sans doute incomplète (limite de ${limite} atteinte) : ne pas additionner ces groupes pour annoncer un total. Refaire un appel sans regroupement pour le total, ou restreindre le domaine.`;
        }
        return r;
      },
    },
    {
      name: 'odoo_preparer_modification',
      title: 'Odoo : préparer une modification',
      description:
        "Première étape, obligatoire, de toute écriture dans Odoo. N'ÉCRIT RIEN : contrôle la demande et renvoie ce qui va changer, avec un jeton valable 10 minutes. Quatre opérations : « creer » (valeurs), « modifier » (ids + valeurs ; une étape stage_id se change ainsi), « action » (ids + methode : le bouton d'Odoo, par exemple action_confirm, button_mark_done, action_cancel ; c'est ainsi qu'un statut change ; méthode inconnue = odoo_boutons), « supprimer » (ids ; préférer archiver avec modifier { active: false } quand le modèle a un champ active). Présenter ensuite à l'utilisateur ce qui va changer, en clair, et attendre son accord explicite (« oui », « vas-y ») avant d'appeler odoo_appliquer_modification. Sa demande de départ ne vaut pas accord : il doit voir le résumé. Les droits sont ceux de son compte Odoo.",
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['creer', 'modifier', 'action', 'supprimer'] },
          modele: { type: 'string' },
          ids: { type: 'array', items: { type: 'integer' }, description: `Enregistrements concernés (${LOT_MAX} au plus). Inutile pour une création.` },
          valeurs: { type: 'object', description: 'creer, modifier : champs à écrire, { champ: valeur }. Un champ lié (many2one) reçoit un identifiant. Lignes (one2many, many2many) : commandes Odoo, [[0, 0, {valeurs}]] nouvelle ligne, [[4, id]] ajouter, [[6, 0, [ids]]] remplacer.' },
          methode: { type: 'string', description: 'action : méthode du bouton (action_..., button_..., do_...). La trouver avec odoo_boutons.' },
        },
        required: ['operation', 'modele'],
      },
      annotations: { readOnlyHint: true },
      async run(a) {
        const modele = texte(a.modele, 'modele');
        const operation = a.operation;
        if (!['creer', 'modifier', 'action', 'supprimer'].includes(operation)) {
          throw new ErreurOdoo('operation : « creer », « modifier », « action » ou « supprimer ».');
        }
        verifierEcriture(modele);
        const plan = { operation, modele, cree: Date.now() };
        const resume = { operation: { creer: 'création', modifier: 'modification', action: 'action', supprimer: 'SUPPRESSION DÉFINITIVE' }[operation], modele };

        let ids = [];
        if (operation !== 'creer') {
          ids = identifiants(a.ids);
          if (ids.length > LOT_MAX) throw new ErreurOdoo(`${ids.length} enregistrements : ${LOT_MAX} au plus à la fois. Découper en plusieurs lots.`);
          plan.ids = ids;
        }

        if (operation === 'creer' || operation === 'modifier') {
          const valeurs = objet(a.valeurs, 'valeurs');
          const champs = await verifierValeurs(modele, valeurs);
          const noms = Object.keys(valeurs);
          const lies = await nomsLies(champs, valeurs);
          plan.valeurs = valeurs;
          resume.champs = libelles(champs, noms);
          if (Object.keys(lies).length) resume.fiches_liees = lies;
          if (operation === 'creer') {
            resume.nouvelle_fiche = valeurs;
          } else {
            const avant = await client.appeler(modele, 'read', [ids], { fields: ['display_name', ...noms] });
            if (avant.length !== ids.length) throw new ErreurOdoo('Certains enregistrements sont introuvables ou inaccessibles.');
            plan.avant = Object.fromEntries(avant.map((l) => [l.id, Object.fromEntries(noms.map((n) => [n, comparable(l[n])]))]));
            resume.apres = valeurs;
            resume.enregistrements = avant.map((l) => ({
              id: l.id,
              nom: l.display_name,
              avant: Object.fromEntries(noms.map((n) => [n, l[n]])),
              inchange: noms.every((n) => pareil(l[n], valeurs[n])) || undefined,
            }));
          }
        } else {
          // action, supprimer : on montre les fiches visées et leur statut du moment.
          const champs = await client.champs(modele);
          const suivis = ['state', 'quality_state', 'stage_id'].filter((n) => champs[n]);
          if (operation === 'action') {
            const methode = texte(a.methode, 'methode');
            if (!PREFIXES_ACTION.test(methode)) {
              throw new ErreurOdoo(`« ${methode} » n'est pas un bouton (méthodes action_..., button_..., do_...). Chercher le bon avec odoo_boutons ; sinon, à faire dans Odoo.`);
            }
            plan.methode = methode;
            resume.methode = methode;
          }
          const avant = await client.appeler(modele, 'read', [ids], { fields: ['display_name', ...suivis] });
          if (avant.length !== ids.length) throw new ErreurOdoo('Certains enregistrements sont introuvables ou inaccessibles.');
          plan.suivis = suivis;
          plan.avant = Object.fromEntries(avant.map((l) => [l.id, Object.fromEntries(suivis.map((n) => [n, comparable(l[n])]))]));
          resume.enregistrements = avant.map((l) => ({ id: l.id, nom: l.display_name, ...Object.fromEntries(suivis.map((n) => [n, l[n]])) }));
          if (operation === 'supprimer') {
            resume.attention = 'Irréversible.' + (champs.active ? ' Ce modèle peut être archivé à la place : le proposer.' : '');
          }
        }

        const sortie = {
          rien_n_est_ecrit: true,
          jeton: crypto.randomBytes(9).toString('hex'),
          validite: '10 minutes, usage unique',
          resume,
          consigne: "Montrer ce résumé à l'utilisateur (noms et libellés, pas les identifiants seuls) et attendre son accord explicite avant odoo_appliquer_modification.",
        };
        // Un résumé trop gros serait tronqué à l'affichage : l'utilisateur validerait sans tout voir.
        if (JSON.stringify(sortie).length > TAILLE_MAX - 2000) {
          throw new ErreurOdoo('Modification trop volumineuse pour être présentée en entier : la découper en plusieurs lots plus petits.');
        }
        for (const [j, p] of jetons) if (Date.now() - p.cree > DUREE_JETON_MS) jetons.delete(j);
        jetons.set(sortie.jeton, plan);
        return sortie;
      },
    },
    {
      name: 'odoo_appliquer_modification',
      title: 'Odoo : appliquer une modification confirmée',
      description:
        "Deuxième étape : exécute dans Odoo ce qui a été préparé par odoo_preparer_modification. À n'appeler qu'après que l'utilisateur a vu le résumé et a donné son accord explicite dans la conversation. Répéter l'opération, le modèle et le nombre de fiches du résumé : ils sont vérifiés. Refuse si les fiches ont changé depuis la préparation. C'est fait au nom de l'utilisateur connecté et reste visible dans l'historique Odoo.",
      inputSchema: {
        type: 'object',
        properties: {
          jeton: { type: 'string', description: 'Jeton renvoyé par odoo_preparer_modification.' },
          operation: { type: 'string', enum: ['creer', 'modifier', 'action', 'supprimer'], description: 'La même que dans la préparation.' },
          modele: { type: 'string', description: 'Le même que dans la préparation.' },
          nombre: { type: 'integer', description: 'Nombre de fiches concernées (1 pour une création).' },
          resume: { type: 'string', description: "Ce qui va être fait, en une phrase claire pour l'utilisateur : c'est ce qu'il lit au moment d'autoriser." },
        },
        required: ['jeton', 'operation', 'modele', 'nombre', 'resume'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      async run(a) {
        const jeton = texte(a.jeton, 'jeton');
        const plan = jetons.get(jeton);
        jetons.delete(jeton);
        if (!plan || Date.now() - plan.cree > DUREE_JETON_MS) {
          throw new ErreurOdoo("Jeton inconnu, déjà utilisé ou expiré : refaire odoo_preparer_modification et redemander son accord à l'utilisateur.");
        }
        const attendu = plan.ids ? plan.ids.length : 1;
        if (a.operation !== plan.operation || a.modele !== plan.modele || Number(a.nombre) !== attendu) {
          throw new ErreurOdoo(
            `Rien n'a été fait : l'appel annonce « ${a.operation} » sur ${a.modele} (${a.nombre} fiche(s)) alors que la préparation porte sur ` +
            `« ${plan.operation} » sur ${plan.modele} (${attendu} fiche(s)). Refaire odoo_preparer_modification.`);
        }
        verifierEcriture(plan.modele);
        const { modele, operation } = plan;

        if (operation === 'creer') {
          const noms = Object.keys(plan.valeurs);
          const id = await client.appeler(modele, 'create', [plan.valeurs]);
          const nid = Array.isArray(id) ? id[0] : id;
          const [relu] = await client.appeler(modele, 'read', [[nid]], { fields: ['display_name', ...noms] });
          return { fait: true, operation: 'création', modele, id: nid, fiche: relu, lien: lien(modele, nid) };
        }

        // Rien n'est fait si une fiche a bougé depuis que l'utilisateur a vu le résumé.
        const noms = operation === 'modifier' ? Object.keys(plan.valeurs) : plan.suivis;
        const actuel = await client.appeler(modele, 'read', [plan.ids], { fields: noms });
        const change = actuel.filter((l) => noms.some((n) => !pareil(l[n], plan.avant[l.id][n])));
        if (change.length || actuel.length !== plan.ids.length) {
          throw new ErreurOdoo(
            `Rien n'a été fait : ${change.length || 'des'} fiche(s) ont changé dans Odoo depuis la préparation ` +
            `(ids ${change.map((l) => l.id).join(', ') || 'introuvables'}). Refaire odoo_preparer_modification et remontrer le résumé.`);
        }
        const liens = plan.ids.slice(0, 10).map((id) => lien(modele, id));

        if (operation === 'modifier') {
          await client.appeler(modele, 'write', [plan.ids, plan.valeurs]);
          const relu = await client.appeler(modele, 'read', [plan.ids], { fields: ['display_name', ...noms] });
          return { fait: true, operation: 'modification', modele, nombre: relu.length, fiches_relues: relu, liens };
        }
        if (operation === 'supprimer') {
          await client.appeler(modele, 'unlink', [plan.ids]);
          const reste = await client.appeler(modele, 'search_count', [[['id', 'in', plan.ids]]], { context: { active_test: false } });
          return { fait: reste === 0, operation: 'suppression', modele, nombre: plan.ids.length - reste };
        }
        const retour = await client.appeler(modele, plan.methode, [plan.ids]);
        const relu = await client.appeler(modele, 'read', [plan.ids], { fields: ['display_name', ...plan.suivis] });
        const r = { fait: true, operation: 'action', methode: plan.methode, modele, fiches_relues: relu, liens };
        const ouvre = retour && typeof retour === 'object' && !Array.isArray(retour) && retour.type === 'ir.actions.act_window' && retour.target === 'new';
        if (ouvre) {
          r.fait = 'à terminer';
          r.suite_dans_odoo =
            `Odoo a ouvert une fenêtre (${retour.name || retour.res_model}) : confirmation ou assistant à remplir. ` +
            "L'action n'est sans doute pas terminée : comparer le statut relu avec celui d'avant et dire à l'utilisateur de finir dans Odoo.";
        }
        return r;
      },
    },
  ];

  async function executer(nom, args) {
    const outil = outils.find((o) => o.name === nom);
    if (!outil) throw new ErreurOdoo(`Outil inconnu : ${nom}`);
    const resultat = await outil.run(args || {});
    let sortie = JSON.stringify(resultat, null, 1);
    if (sortie.length > TAILLE_MAX) {
      sortie = JSON.stringify({
        trop_volumineux: true,
        taille: sortie.length,
        conseil: 'Réponse trop volumineuse : restreindre la demande (filtre « recherche », moins de champs, limite plus basse) ou utiliser odoo_regrouper pour totaliser.',
        debut: sortie.slice(0, 4000),
      }, null, 1);
    }
    return sortie;
  }

  const catalogue = outils.map(({ run, ...decl }) => decl);
  return { catalogue, executer };
}

module.exports = { creerOutils, MODELES_INTERDITS, LOT_MAX };
