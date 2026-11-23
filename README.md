# Claude + Odoo sur un poste

Installe sur un poste Windows de quoi poser ses questions à l'Odoo de l'entreprise depuis
Claude Code, en français, avec le compte Odoo de la personne : « où en est l'OF 1234 »,
« combien de pièces hier sur la presse 3 », « d'où vient ce lot », « ouvre une alerte
qualité ». Première cible : la production et la qualité.

## Ce qui est installé

| Élément | Rôle | Emplacement sur le poste |
|---|---|---|
| Connecteur `odoo` | Serveur MCP local : 9 outils pour chercher, lire, totaliser, et écrire en deux temps (créer, modifier, action, supprimer) | `%USERPROFILE%\.claude-odoo\connecteur` |
| Skill `odoo-production-qualite` | La méthode : vocabulaire atelier, modèles et champs, recettes (avancement, traçabilité, contrôles, arrêts), règle de confirmation | `%USERPROFILE%\.claude\skills` |
| Configuration du poste | Adresse, base, identifiant, clé API, droits de modification | `%USERPROFILE%\.config\claude-odoo\config.json` |
| Permissions Claude Code | Lecture sans question, modification toujours demandée, fichier de clé illisible | `%USERPROFILE%\.claude\settings.json` |

## Installer un poste

Prérequis : Claude Code installé et connecté sur le poste, avec le compte Odoo de la
personne déjà créé. Node.js LTS est installé par winget s'il manque : sur un poste sans
droits d'administrateur, l'installer avant.

**La voie normale : laisser faire Claude.** Dans Claude Code, sur le poste, coller :

> Installe le harnais Odoo sur ce poste : récupère `<adresse de ce dépôt>` dans mon dossier
> utilisateur, lis son CLAUDE.md et suis-le. Adresse Odoo : `<https://...>`, base :
> `<nom de la base>`.

Claude récupère le dossier, installe tout et vérifie. La personne n'a que trois gestes :
donner son identifiant Odoo, coller sa clé API dans la petite fenêtre qui s'ouvre (Odoo est
ouvert à côté sur la page où la créer), fermer et rouvrir Claude Code. La clé ne passe
jamais par la conversation. Le poste doit pouvoir lire le dépôt (git, et un accès au dépôt
s'il est privé) ; à défaut, lui fournir le dossier et dire « installe ».

Facultatif : un fichier `entreprise.json` (modèle : `entreprise.exemple.json`) placé dans le
dossier fixe l'adresse, la base, et au besoin `modifications` et `modeles_modifiables`
(voir « Régler un poste ») pour tous les postes, sans les redonner à chaque fois.

À la main, dans PowerShell depuis le dossier :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
```

Diagnostic à tout moment, sans rien modifier :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Verifier
```

## Renouveler la clé API

Odoo limite la durée d'une clé (trois mois au plus pour un compte non administrateur).
Quand Claude répond « Connexion refusée », refaire une clé dans Odoo (Mon profil > Sécurité
du compte > Nouvelle clé API) et la saisir :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Oui -SaisirCle
```

## Régler un poste

Dans `%USERPROFILE%\.config\claude-odoo\config.json`, puis redémarrer Claude Code :

- `"modifications": false` : poste en lecture seule.
- `"modeles_modifiables"` : liste vide (par défaut) = tout ce que le compte Odoo de la
  personne autorise. Pour restreindre un poste, lister les seuls documents modifiables, par
  exemple `["quality.alert", "maintenance.request"]`.

## Ce que Claude peut faire, et ses limites

- **Lire** tout ce que le compte Odoo de la personne a le droit de voir.
- **Écrire** tout ce que ce compte a le droit de faire : créer, modifier, lancer une action
  (les boutons d'Odoo : confirmer, clôturer, annuler...), supprimer, lignes comprises. Toujours en deux
  temps : Claude prépare, montre ce qui va changer, attend un oui, puis applique. Claude
  Code redemande en plus la permission à chaque application.
- Refusé par le connecteur, quels que soient les droits : écrire un statut à la main (il
  passe par l'action), les champs en lecture seule, les modèles de sécurité et techniques
  (utilisateurs, groupes, règles, paramètres), toute méthode qui n'est pas un bouton, plus
  de 200 fiches à la fois, une fiche modifiée par quelqu'un d'autre entre la préparation et
  l'application.
- Une action qui ouvre un assistant dans Odoo (reliquat, quantités partielles) se termine
  dans Odoo : Claude le dit.
- Ce qui est écrit l'est **au nom de la personne** et reste dans l'historique Odoo.

À savoir : Claude Code dispose d'un terminal sur le poste. Les garde-fous du connecteur et
la règle qui lui interdit de lire le fichier de clé sont des freins, pas un mur. La vraie
limite, ce sont **les droits du compte Odoo** : ne donner ce harnais qu'à un compte dont
les droits sont déjà les bons. Clé API : lui donner une durée limitée, et la supprimer dans
Odoo si le poste est perdu ou si la personne part.

## Mettre à jour ou retirer

- Mettre à jour : remplacer ce dossier par la nouvelle version et relancer `setup.ps1`. La
  configuration du poste est conservée.
- Retirer : `claude mcp remove odoo --scope user` (ou retirer `odoo` de `mcpServers` dans
  `%USERPROFILE%\.claude.json`), supprimer `%USERPROFILE%\.claude-odoo`,
  `%USERPROFILE%\.claude\skills\odoo-production-qualite` et
  `%USERPROFILE%\.config\claude-odoo`, retirer de `%USERPROFILE%\.claude\settings.json` les
  règles `mcp__odoo__...` et `Read(~/.config/claude-odoo/**)` (l'état d'avant est dans
  `settings.json.avant-claude-odoo`), puis supprimer la clé API dans Odoo.

## Structure

```
setup.ps1            installation et diagnostic (-Verifier, -Oui, -SaisirCle, -Racine pour un essai à blanc)
CLAUDE.md            la marche à suivre de Claude pour installer seul
entreprise.exemple.json  adresse et base communes à tous les postes (à copier en entreprise.json)
config.exemple.json  modèle de la configuration du poste
connecteur/server/   serveur MCP « odoo » (Node.js, aucune dépendance)
skills/              le skill odoo-production-qualite
outils/reglages.js   pose les permissions Claude Code (idempotent, sauvegarde)
outils/mcp.js        inscrit le connecteur dans Claude Code (idempotent, sauvegarde)
tests/essai.js       essai du connecteur contre un faux Odoo : node --test tests/essai.js
```
