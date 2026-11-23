# Harnais Claude + Odoo : consignes pour Claude

Ce dossier est un **paquet d'installation**. Il met sur ce poste Windows un connecteur MCP
`odoo`, le skill `odoo-production-qualite` et la configuration du poste, pour que
l'utilisateur interroge et mette à jour l'Odoo de son entreprise depuis Claude Code, avec
son propre compte. Détail : `README.md`.

## « Installe », « configure Odoo », ou l'utilisateur ne sait pas par où commencer

Tu fais toute l'installation toi-même, dans l'ordre ci-dessous, sans lui demander de taper
de commande. L'utilisateur n'est pas informaticien : phrases courtes, pas de jargon. Il n'a
que trois choses à faire, que tu lui annonces au bon moment : donner son identifiant Odoo,
coller sa clé dans une fenêtre, redémarrer Claude Code.

**Si tu n'as que l'adresse du dépôt** (on t'a dit « installe le harnais Odoo » avec un lien) :
récupère-le toi-même dans `%USERPROFILE%\claude-odoo-poste` (`git clone`, ou `git pull` s'il
y est déjà), puis continue ici. Si le poste n'a ni git ni accès au dépôt, dis-le tel quel et
arrête-toi : ne demande pas à l'utilisateur de copier des fichiers.

Lance toutes les commandes avec le chemin complet du script, où que tu sois :
`powershell -NoProfile -ExecutionPolicy Bypass -File "<dossier>\setup.ps1" <options>`.

1. **Diagnostic** : `setup.ps1 -Verifier`. Il ne modifie rien. S'il dit « Tout est en
   place », passe directement à l'étape 6.
2. **Ce qu'il te faut** :
   - l'adresse de l'Odoo et le nom de la base : ils sont dans la demande qu'on t'a faite, ou
     dans `entreprise.json` s'il existe. Sinon demande-les. Tu les passes en paramètres :
     aucun fichier à créer ni à copier à la main ;
   - l'identifiant Odoo de l'utilisateur (en général son adresse e-mail) : demande-le.
   Ne demande jamais de mot de passe ni de clé API, et refuse-les s'il les propose dans la
   conversation.
3. **Installation** : `setup.ps1 -Oui -Adresse "<...>" -Base "<...>" -Identifiant "<identifiant>"`
   (`-Adresse` et `-Base` sont inutiles s'il y a un `entreprise.json`). Si Node.js manque,
   il est installé par winget : préviens que Windows peut afficher une demande
   d'autorisation, et prévois un délai de 10 minutes pour la commande.
4. **Clé API** : dis à l'utilisateur, avant de lancer la commande : « Deux fenêtres vont
   s'ouvrir : Odoo sur votre profil, et une petite fenêtre Clé API Odoo. Dans Odoo, onglet
   Sécurité du compte, cliquez sur Nouvelle clé API, donnez-lui un nom, copiez la clé, puis
   collez-la dans la petite fenêtre et cliquez sur Enregistrer. » Puis lance
   `setup.ps1 -Oui -SaisirCle` **avec un délai de 10 minutes** : la commande attend la
   saisie. Tu ne vois jamais la clé, et tu ne lis pas le fichier de configuration.
5. **Contrôle** : la fin de la sortie de l'étape 4 contient « Connexion à Odoo ».
   - « Connexion OK : <nom> » : c'est bon, dis-lui sous quel nom il est connecté.
   - « Connexion refusée » : identifiant ou clé incorrects. Vérifie l'identifiant avec lui,
     puis relance l'étape 4.
   - « Odoo injoignable » : problème de réseau ou d'adresse, le dire tel quel.
   - saisie annulée : propose de relancer l'étape 4.
6. **Fin** : relance `setup.ps1 -Verifier`. Quand il dit « Tout est en place », demande à
   l'utilisateur de **fermer puis rouvrir Claude Code** (le connecteur ne se charge qu'au
   démarrage), puis de dire « vérifie ma connexion Odoo ». Donne-lui deux ou trois exemples
   de questions : « où en est l'OF 1234 », « quels contrôles qualité sont à faire »,
   « d'où vient le lot X ».

En cas d'erreur que tu ne sais pas résoudre : montre le message exact, ne bricole pas
autour (pas de script maison, pas de modification à la main des fichiers de Claude), et dis
à l'utilisateur de le transmettre à la personne qui lui a fourni ce dossier.

`setup.ps1` est relançable : il ne refait que ce qui manque, n'écrase jamais la
configuration du poste et sauvegarde un skill modifié avant de le remplacer.

## Après l'installation

On ne travaille pas dans ce dossier. Les outils `odoo_*` et le skill sont disponibles dans
toute session Claude Code du poste.

- Changer de clé (expirée, renouvelée) : `setup.ps1 -Oui -SaisirCle`.
- Passer un poste en lecture seule ou le restreindre : voir « Régler un poste » du README.

## Modifier le harnais

- Connecteur : `connecteur/server/`. Après toute modification : `node --test tests/essai.js`.
- Essai de l'installateur : toujours `-Racine <dossier temporaire non vide>`, jamais sur le
  vrai profil.
- Toute écriture dans Odoo reste en deux temps (préparer, accord, appliquer) ; ne pas
  ajouter d'outil qui écrit directement.
- Rien de propre à une entreprise ni à une personne dans ce dossier, sauf `entreprise.json`
  (adresse et base, fourni à part) : identifiant et clé vivent dans la configuration du
  poste.
