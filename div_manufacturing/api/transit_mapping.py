# Copyright (c) 2026, Duncan Integrated Ventures LLC and contributors
# For license information, please see license.txt

"""Map handling units (and other inventory dimensions) from a submitted Material
Transfer for Manufacture onto the consumption rows of a draft Manufacture Stock
Entry. Preserves BOM-driven consumed quantities; splits target rows when a single
BOM row is covered by multiple source handling units (FIFO)."""

from collections import defaultdict

import frappe
from frappe.utils import flt


def inv_dim_fieldnames() -> list[str]:
	"""Source-side fieldnames (e.g. `feeder`, `customer`, `handling_unit`) for every
	Inventory Dimension. The paired target field on Stock Entry Detail is
	`to_{fieldname}` (beam's convention): the source row's `to_*` holds where the
	stock moved to, which is what the target Manufacture row consumes from."""
	return [
		d.source_fieldname
		for d in frappe.get_all(
			"Inventory Dimension",
			fields=["source_fieldname"],
		)
		if d.source_fieldname
	]


def source_rows(source_stock_entry: str) -> list[dict]:
	"""Rows from the source Material Transfer for Manufacture, ordered by idx.
	Each row's `to_*` values are what the WIP stock is currently tagged with."""
	dims = inv_dim_fieldnames()
	fields = [
		"name",
		"idx",
		"item_code",
		"item_name",
		"qty",
		"uom",
		"stock_uom",
		"conversion_factor",
		"t_warehouse",
	]
	fields += [f"to_{d}" for d in dims]
	rows = frappe.get_all(
		"Stock Entry Detail",
		filters={"parent": source_stock_entry},
		fields=fields,
		order_by="idx",
	)
	for r in rows:
		r["source_stock_entry"] = source_stock_entry
	return rows


@frappe.whitelist()
def get_allocation_preview(target_stock_entry: str, source_stock_entry: str) -> dict:
	"""Propose an HU→row mapping for the Manufacture Stock Entry.

	FIFO: walk source rows in idx order; fill each target row (matching item_code,
	missing handling_unit) from available source qty until the row is covered.
	Does not mutate either document."""
	target = frappe.get_doc("Stock Entry", target_stock_entry)
	dims = inv_dim_fieldnames()
	sources: list[dict] = []
	for src_name in as_list(source_stock_entry):
		sources.extend(source_rows(src_name))

	# Group sources by item_code; track remaining qty per source row. Skip rows
	# that carry no inventory dimensions at all — there's nothing to copy onto
	# the target, so they shouldn't clutter the allocation list.
	src_by_item: dict[str, list[dict]] = defaultdict(list)
	for s in sources:
		if flt(s.qty) <= 0:
			continue
		if not any(s.get(f"to_{d}") for d in dims):
			continue
		src_by_item[s.item_code].append({**s, "remaining": flt(s.qty)})

	allocations: list[dict] = []
	unmet: list[dict] = []

	for tgt in target.items:
		if tgt.handling_unit:
			continue  # already mapped — leave alone
		needed = flt(tgt.qty)
		if needed <= 0:
			continue
		if tgt.item_code not in src_by_item:
			# No dim-carrying source rows for this item — skip silently.
			# (Items without HU tracking land here if they also lack other dims.)
			continue
		queue = src_by_item[tgt.item_code]
		while needed > 0 and queue:
			src = queue[0]
			if src["remaining"] <= 0:
				queue.pop(0)
				continue
			take = min(needed, src["remaining"])
			inv_dims = {d: src.get(f"to_{d}") for d in dims if src.get(f"to_{d}")}
			handling_unit = inv_dims.pop("handling_unit", None)
			allocations.append(
				{
					"target_row": tgt.name,
					"target_idx": tgt.idx,
					"item_code": tgt.item_code,
					"item_name": tgt.item_name,
					"target_qty": flt(tgt.qty),
					"qty": take,
					"uom": tgt.uom,
					"source_row": src["name"],
					"source_idx": src["idx"],
					"source_qty": flt(src["qty"]),
					"source_stock_entry": src["source_stock_entry"],
					"handling_unit": handling_unit,
					"inv_dims": inv_dims,
					"feeder": inv_dims.get("feeder"),
					"customer": inv_dims.get("customer"),
					"splits_target": take < flt(tgt.qty),
				}
			)
			src["remaining"] -= take
			needed -= take
		if needed > 0:
			unmet.append(
				{
					"target_row": tgt.name,
					"target_idx": tgt.idx,
					"item_code": tgt.item_code,
					"item_name": tgt.item_name,
					"shortfall": needed,
					"uom": tgt.uom,
				}
			)

	return {
		"allocations": allocations,
		"unmet": unmet,
	}


def as_list(v) -> list[str]:
	if isinstance(v, str):
		try:
			parsed = frappe.parse_json(v)
			if isinstance(parsed, list):
				return parsed
		except Exception:
			pass
		return [v]
	return list(v or [])


@frappe.whitelist()
def apply_allocation(target_stock_entry: str, allocations: list | str) -> dict:
	"""Apply a (possibly edited) allocation to the Manufacture Stock Entry.

	For each target row, the total allocated qty is consumed from its qty. If
	total == row.qty, the last allocation updates the row in place. If total <
	row.qty, the row's qty is reduced by total (the remainder stays unallocated
	for manual handling). Each allocation that doesn't fill its target in place
	produces a new row cloned from the target with qty + inventory dimensions set."""
	if isinstance(allocations, str):
		allocations = frappe.parse_json(allocations)
	allocations = allocations or []

	se = frappe.get_doc("Stock Entry", target_stock_entry)

	by_target: dict[str, list[dict]] = defaultdict(list)
	for a in allocations:
		if flt(a.get("qty")) <= 0:
			continue
		by_target[a["target_row"]].append(a)

	for target_name, allocs in by_target.items():
		target_row = next((r for r in se.items if r.name == target_name), None)
		if not target_row:
			continue
		if target_row.serial_and_batch_bundle:
			frappe.throw(
				f"Row {target_row.idx} ({target_row.item_code}) already has a serial/batch "
				"bundle — splitting is not supported. Clear the bundle first or map manually."
			)

		original_qty = flt(target_row.qty)
		for a in allocs:
			if flt(a["qty"]) < 0:
				frappe.throw(
					f"Row {target_row.idx} ({target_row.item_code}): allocated qty "
					"cannot be negative."
				)
		total_alloc = sum(flt(a["qty"]) for a in allocs)
		leftover = original_qty - total_alloc
		if leftover < 0:
			frappe.throw(
				f"Row {target_row.idx} ({target_row.item_code}): allocations "
				f"({total_alloc}) exceed the row qty ({original_qty})."
			)

		# Update the original row in place with the first allocation's values.
		# Remaining allocations become new rows cloned from target_row (cheap to
		# copy via as_dict before we mutate the original).
		template = target_row.as_dict()
		apply_alloc_to_row(target_row, allocs[0])
		if leftover > 0:
			# Remainder: keep an un-tagged row carrying the leftover qty.
			leftover_row = clone_row(se, template)
			leftover_row.qty = leftover
			leftover_row.transfer_qty = leftover * flt(leftover_row.conversion_factor or 1)
			leftover_row.handling_unit = None
			for f in inv_dim_fieldnames():
				leftover_row.set(f, None)

		for a in allocs[1:]:
			new_row = clone_row(se, template)
			apply_alloc_to_row(new_row, a)

	se.save()
	return {"ok": True, "name": se.name}


def apply_alloc_to_row(row, alloc: dict) -> None:
	qty = flt(alloc["qty"])
	row.qty = qty
	row.transfer_qty = qty * flt(row.conversion_factor or 1)
	row.handling_unit = alloc.get("handling_unit")
	inv_dims = alloc.get("inv_dims") or {}
	for field, value in inv_dims.items():
		row.set(field, value)


def clone_row(se, template: dict):
	# Drop fields that must be regenerated for a new row; keep item_code,
	# warehouses, uom, conversion_factor, basic_rate, etc.
	for k in (
		"name",
		"idx",
		"creation",
		"modified",
		"modified_by",
		"owner",
		"docstatus",
		"parent",
		"parenttype",
		"parentfield",
		"serial_no",
		"batch_no",
		"serial_and_batch_bundle",
	):
		template.pop(k, None)
	return se.append("items", template)
