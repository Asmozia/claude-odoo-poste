# Modèles, champs et recettes (Odoo 19, production et qualité)

Champs vérifiés sur un Odoo 19 Enterprise réel avec fabrication, qualité et maintenance.
Certains viennent de modules que l'entreprise n'a pas forcément (dates d'expiration des
lots, maintenance, pointage par employé) : si Odoo répond « champ invalide », vérifier avec
`odoo_champs` et faire sans. En cas de doute ou sur une autre version : `odoo_champs`. Les modules propres à l'entreprise ajoutent des modèles et des champs : les
trouver avec `odoo_modeles` (mot-clé français) puis `odoo_champs`.

## Documents

| On dit | Modèle | Champs utiles |
|---|---|---|
| OF, ordre de fabrication | `mrp.production` | `name`, `product_id`, `product_qty` (à produire), `qty_produced`, `state`, `date_start`, `date_finished`, `date_deadline`, `origin`, `priority`, `user_id`, `lot_producing_ids`, `reservation_state`, `components_availability`, `bom_id` |
| OT, ordre de travail, opération | `mrp.workorder` | `name`, `production_id`, `workcenter_id`, `state`, `qty_produced`, `qty_remaining`, `duration` (min, réelle), `duration_expected` (min), `date_start`, `date_finished`, `sequence` |
| Poste de travail, machine | `mrp.workcenter` | `name`, `code` |
| Temps et arrêts au poste | `mrp.workcenter.productivity` | `workcenter_id`, `workorder_id`, `loss_id` (motif), `loss_type`, `date_start`, `date_end`, `duration` (min), `employee_id` |
| Nomenclature | `mrp.bom`, lignes `mrp.bom.line` | `product_tmpl_id`, `product_qty` ; lignes : `bom_id`, `product_id`, `product_qty`, `product_uom_id` |
| Lot, numéro de série | `stock.lot` | `name`, `product_id`, `product_qty` (en stock), `ref`, `expiration_date`, `create_date` |
| Mouvement de stock détaillé | `stock.move.line` | `date`, `reference`, `product_id`, `lot_id`, `quantity`, `location_id` (de), `location_dest_id` (vers), `picking_id`, `move_id`, `state` |
| Stock présent | `stock.quant` | `product_id`, `lot_id`, `location_id`, `quantity`, `reserved_quantity` |
| Contrôle qualité | `quality.check` | `name`, `title`, `quality_state`, `point_id`, `product_id`, `lot_ids`, `production_id`, `workorder_id`, `workcenter_id`, `picking_id`, `measure`, `measure_success`, `control_date`, `user_id`, `team_id` |
| Alerte qualité, non-conformité | `quality.alert` | `name`, `title`, `stage_id`, `product_tmpl_id`, `product_id`, `lot_ids`, `production_id`, `workorder_id`, `workcenter_id`, `reason_id` (cause), `priority`, `team_id`, `user_id`, `description`, `action_corrective`, `action_preventive`, `date_assign`, `date_close` |
| Demande de maintenance | `maintenance.request` | `name`, `equipment_id`, `workcenter_id`, `stage_id`, `maintenance_type`, `request_date`, `schedule_date`, `user_id` (technicien), `priority`, `description` |
| Article | `product.product` | `default_code` (référence), `name`, `qty_available` |

Un champ lié se traverse dans un domaine : `product_id.default_code`, `production_id.name`,
`workcenter_id.name`, `location_id.usage`.

## Statuts

| Document | Champ | Valeurs |
|---|---|---|
| OF | `state` | `draft` Brouillon, `confirmed` Confirmé, `progress` En cours, `to_close` À clôturer, `done` Fait, `cancel` Annulé |
| OF, composants | `reservation_state` | `confirmed` En attente, `assigned` Prêt, `waiting` En attente d'une autre opération |
| OT | `state` | `blocked` Bloqué, `ready` Prêt, `progress` En cours, `done` Terminé, `cancel` Annulé |
| Contrôle | `quality_state` | `none` À faire, `pass` Réussite, `fail` Échec |
| Temps au poste | `loss_type` | `productive` Productif, `availability` Disponibilité, `performance` Performances, `quality` Qualité |
| Mouvement | `state` | `done` Fait (le seul qui compte pour la traçabilité), `assigned` Disponible, `cancel` Annulé |
| Maintenance | `maintenance_type` | `corrective`, `preventive` |

Alertes qualité et demandes de maintenance n'ont pas de statut mais une étape (`stage_id`) :
« ouvertes » = `["stage_id.done", "=", false]`. Une étape se change par l'opération
`modifier` (chercher l'étape par son nom sur `quality.alert.stage` ou `maintenance.stage`),
pas par une action.

OF « en cours » au sens large = `state in [confirmed, progress, to_close]`.

## Recettes

Les dates des filtres sont en UTC : prendre l'heure et le décalage dans `odoo_connexion`,
puis convertir. Les regroupements par jour, semaine ou mois sont déjà découpés en heure
locale par Odoo.

**Où en est un OF**
1. `odoo_rechercher` `mrp.production`, `[["name", "ilike", "1234"]]`, champs `name,
   product_id, product_qty, qty_produced, state, date_start, date_deadline,
   reservation_state`.
2. Ses opérations : `mrp.workorder`, `[["production_id", "=", id]]`, champs `name,
   workcenter_id, state, qty_produced, qty_remaining, duration, duration_expected`, tri
   `sequence, id`.

**OF en retard** : `mrp.production`, `[["state", "in", ["confirmed", "progress",
"to_close"]], ["date_deadline", "<", "<maintenant en UTC>"]]`, tri `date_deadline`.

**Production par poste et par jour** : `odoo_regrouper` `mrp.workorder`, domaine
`[["state", "=", "done"], ["date_finished", ">=", "<début>"]]`, regroupements
`["workcenter_id", "date_finished:day"]`, agrégats `["qty_produced:sum", "duration:sum"]`.

**Arrêts par poste et par motif** : `odoo_regrouper` `mrp.workcenter.productivity`, domaine
`[["loss_type", "!=", "productive"], ["date_start", ">=", "<début>"]]`, regroupements
`["workcenter_id", "loss_id"]`, agrégats `["duration:sum"]`, tri `duration:sum desc`.
Durées en minutes : les donner en heures et minutes.

**Contrôles qualité à faire** : `odoo_regrouper` `quality.check`,
`[["quality_state", "=", "none"]]`, regroupement `["workcenter_id"]` ; puis la liste d'un
poste avec `odoo_rechercher`. Échecs : `quality_state = fail`.

**Traçabilité d'un lot** (toujours retrouver d'abord le lot : `stock.lot`,
`[["name", "=", "<lot>"]]`, plusieurs articles peuvent porter le même numéro)
- OF qui l'a fabriqué : `mrp.production`, `[["lot_producing_ids", "in", [id_lot]]]`.
- Composants et lots consommés par un OF : `stock.move.line`,
  `[["move_id.raw_material_production_id", "=", id_of], ["state", "=", "done"]]`, champs
  `product_id, lot_id, quantity`.
- OF qui ont consommé un lot de composant : `odoo_regrouper` `stock.move.line`,
  `[["lot_id", "=", id_lot], ["move_id.raw_material_production_id", "!=", false],
  ["state", "=", "done"]]`, regroupement `["move_id.raw_material_production_id"]`, agrégat
  `["quantity:sum"]`.
- Parcours du lot (réception, transferts, expédition) : `stock.move.line`,
  `[["lot_id", "=", id_lot], ["state", "=", "done"]]`, champs `date, reference,
  location_id, location_dest_id, quantity`, tri `date`.
- Contrôles du lot : `quality.check`, `[["lot_ids", "in", [id_lot]]]`.
- Où il se trouve : `stock.quant`, `[["lot_id", "=", id_lot],
  ["location_id.usage", "=", "internal"]]`.

Remonter ou descendre plusieurs niveaux : répéter fabriqué par / a consommé, niveau par
niveau, et dire jusqu'où on est allé.

**Stock d'un composant** : `odoo_regrouper` `stock.quant`,
`[["product_id.default_code", "=", "<réf>"], ["location_id.usage", "=", "internal"]]`,
regroupement `["location_id"]`, agrégats `["quantity:sum", "reserved_quantity:sum"]`.
Disponible = quantité moins réservé.

**Ouvrir une alerte qualité** : chercher
l'article, l'OF, le lot et l'équipe (`quality.alert.team`) par leur nom, puis
`odoo_preparer_modification` en `creer` avec `title`, `product_tmpl_id`, `product_id`,
`lot_ids` (`[[6, 0, [id_lot]]]`), `production_id`, `workcenter_id`, `team_id`,
`description`. Montrer la future fiche avec les noms, attendre le oui.

## Actions courantes (opération `action`)

| Document | Bouton | Méthode |
|---|---|---|
| OF | Confirmer | `action_confirm` |
| OF | Tout produire, clôturer | `button_mark_done` (ouvre souvent un assistant : reliquat, lots, consommations) |
| OF | Annuler | `action_cancel` |
| OF | Planifier / déplanifier | `button_plan` / `button_unplan` |
| OT | Démarrer / mettre en pause / terminer | `button_start` / `button_pending` / `button_finish` |
| Contrôle qualité | Réussite / échec | `do_pass` / `do_fail` (le statut du contrôle ne s'écrit pas à la main) |
| Transfert | Valider | `button_validate` (assistant si quantités partielles) |

Une méthode absente de cette table se cherche avec `odoo_boutons`, elle ne se devine pas.
Démarrer et terminer des opérations
se fait normalement à l'atelier, sur la tablette : ne le faire d'ici que sur demande nette.

## Pièges

- Un champ lié revient en `[id, "nom"]`, ou `false` s'il est vide.
- `mrp.production.lot_producing_ids` et `quality.check.lot_ids` sont des listes de lots :
  opérateur `in` avec une liste d'identifiants.
- Un champ calculé non stocké (`calcule_non_stocke` dans `odoo_champs`) ne se filtre pas et
  ne se regroupe pas : filtrer sur un champ stocké, ou passer par le modèle de détail
  (exemple : les lots d'un mouvement se cherchent sur `stock.move.line.lot_id`, pas sur
  `stock.move.lot_ids`).
- Les fiches archivées sont exclues par défaut : `archives: true` pour les inclure.
- Plusieurs sociétés : filtrer sur `company_id` si l'utilisateur en voit plusieurs
  (`odoo_connexion` le dit).
- Les quantités sont dans l'unité du document (`product_uom_id`) : la citer.
