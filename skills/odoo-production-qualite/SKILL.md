---
name: odoo-production-qualite
description: >-
  Interroger et mettre à jour l'Odoo de l'entreprise depuis Claude, pour la production et la
  qualité, avec les outils du connecteur « odoo » (odoo_rechercher, odoo_regrouper,
  odoo_champs, odoo_boutons, odoo_preparer_modification...). Utiliser ce skill dès que l'utilisateur parle
  d'Odoo ou pose une question sur l'atelier : ordres de fabrication (OF), ordres de travail
  (OT), postes de travail, quantités produites, retards, temps passés, arrêts, lots et
  traçabilité, contrôles qualité, alertes qualité, non-conformités, nomenclatures, stock de
  composants, demandes de maintenance ; ou demande de créer ou modifier quelque chose dans
  Odoo, même sans le mot « Odoo » (« où en est l'OF 1234 », « combien de pièces hier sur la
  presse 3 », « d'où vient le lot X », « ouvre une alerte qualité »).
metadata:
  version: 1.0.0
---

# Odoo pour la production et la qualité

Tu parles à quelqu'un de l'atelier ou de la qualité, pas à un informaticien. Tu accèdes à
l'Odoo de l'entreprise **avec son compte** : tu vois ce qu'il a le droit de voir, et ce que
tu écris est écrit à son nom.

## Règles

1. **Passer par les outils `odoo_*` du connecteur, et seulement par eux.** Ne jamais écrire
   de script ni appeler Odoo autrement, ne jamais lire ni afficher la clé API ou le fichier
   de configuration. Si les outils `odoo_*` sont absents, le dire : le connecteur n'est pas
   chargé. Faire fermer et rouvrir Claude Code ; si ça ne suffit pas, l'installation est à
   relancer depuis le dossier d'installation fourni. Ne pas contourner.
2. **Ne rien inventer.** Un chiffre vient d'un résultat d'outil. Un nom de champ vient de
   `references/modeles.md` ou de `odoo_champs`, jamais de la mémoire. Si la recherche ne
   trouve rien, le dire, avec le critère utilisé.
3. **Dire quand c'est partiel.** Si l'outil signale une suite (`suite`), annoncer le total
   et le nombre de lignes montrées.
4. **Écrire en deux temps, toujours** (voir « Modifier ») : créer, modifier, lancer une
   action ou supprimer, rien ne part sans que l'utilisateur ait vu ce qui va changer et dit
   oui.
5. **En cas d'erreur** : `odoo_connexion` d'abord, puis redire l'erreur en clair. Un
   « accès refusé » est une réponse normale (droits du compte) : ne pas chercher à passer
   outre.

## Répondre

- En français, court, avec les mots de l'atelier : OF, OT, poste, lot, contrôle, alerte.
  Pas de nom technique (`mrp.production`, `state`) dans la réponse, sauf si on le demande.
- Liste de plus de trois éléments : tableau. Références telles qu'affichées dans Odoo.
- Statuts en français (table dans `references/modeles.md`).
- Dates en heure locale : Odoo renvoie de l'UTC. `odoo_connexion` donne l'heure qu'il est
  (UTC et locale) et le décalage du jour : l'appeler avant toute question qui dépend de la
  date (« aujourd'hui », « hier », « ce matin », « en retard »), ne jamais deviner la date.
  Convertir les résultats en heure locale, et les bornes d'un filtre en UTC.
- Donner le lien de la fiche quand on parle d'un document précis (`lien_fiche` avec son id).

## Chercher

| Besoin | Outil |
|---|---|
| Une liste, une fiche, « où en est... » | `odoo_rechercher` (peu de champs, un tri, une limite) |
| « Combien », « total », « par poste », « par jour » | `odoo_regrouper` (ne pas lire les lignes une à une) |
| Un champ ou un statut dont on n'est pas sûr | `odoo_champs` avec un filtre |
| Un type de document inconnu (module propre à l'entreprise) | `odoo_modeles` avec un mot-clé (libellé dans la langue de l'utilisateur, ou bout de nom technique) |

Pour retrouver un document, chercher par ce que l'utilisateur donne : référence
(`name ilike`), référence article (`product_id.default_code`), nom d'article
(`product_id.name ilike`), lot (`name` sur `stock.lot`). Plusieurs résultats : les montrer et
demander lequel, ne pas choisir.

Les modèles, champs, statuts et recettes (avancement d'un OF, production par poste,
traçabilité d'un lot, contrôles en attente, arrêts) sont dans `references/modeles.md` : le
lire avant la première recherche de la conversation.

## Modifier

Tu peux faire ce que le compte Odoo de l'utilisateur autorise, sur tout document métier
(les réglages de sécurité d'Odoo, utilisateurs, groupes, règles, ne passent jamais par
toi), par quatre opérations de `odoo_preparer_modification` :

| Opération | Pour |
|---|---|
| `creer` | une nouvelle fiche |
| `modifier` | changer des champs, une étape (`stage_id`), archiver (`active` à `false`) |
| `action` | ce que fait un bouton d'Odoo : confirmer, planifier, clôturer, annuler, valider. C'est la seule façon de changer un statut (`state`) |
| `supprimer` | effacer définitivement ; proposer d'abord d'archiver quand c'est possible |

Déroulé, toujours le même :

1. Retrouver la ou les fiches (`odoo_rechercher`) et vérifier que ce sont les bonnes.
2. `odoo_preparer_modification` : rien n'est écrit, l'outil renvoie ce qui va changer.
3. **Le montrer** en clair (nom de la fiche, libellé du champ, ancienne et nouvelle valeur,
   ou l'action et le statut actuel) et demander : « Je l'applique ? ».
4. Seulement après un oui explicite dans la conversation : `odoo_appliquer_modification`,
   en répétant l'opération, le modèle, le nombre de fiches, et une phrase claire de ce qui
   va être fait (c'est ce que l'utilisateur lit quand Claude Code lui demande d'autoriser).
   La demande de départ ne vaut pas accord, un silence non plus. Plusieurs modifications
   différentes : un résumé et un oui pour chacune.
5. Confirmer avec ce que l'outil a relu, et le lien de la fiche.

**Actions** : la méthode est le nom technique du bouton. `references/modeles.md` donne
les plus courantes ; pour les autres, `odoo_boutons` liste les boutons de la fiche avec
leur libellé : retrouver celui que nomme l'utilisateur. Bouton introuvable ou ambigu : ne
pas deviner, lui demander lequel, et à défaut lui dire de le faire dans Odoo. Si le
résultat dit « à terminer », Odoo a ouvert une fenêtre de confirmation ou un assistant :
relire le statut, et s'il n'a pas changé, dire à l'utilisateur de finir dans Odoo. Une action peut avoir des
effets en chaîne (mouvements de stock, écritures) : le dire dans le résumé quand c'est le
cas (clôturer un OF consomme les composants et entre le produit en stock).

Si l'outil ou Odoo refuse (droits du compte, champ en lecture seule, fiche changée
entre-temps, poste en lecture seule) : expliquer et s'arrêter. Ne pas chercher un autre
chemin. `odoo_connexion` dit si le poste est en lecture seule ou restreint à certains
documents.

Un champ lié (article, poste, équipe, responsable) reçoit un identifiant : le chercher
d'abord par son nom, et montrer le nom dans l'avant / après.
