<!-- Copyright (c) 2026, Duncan Integrated Ventures LLC. and contributors
For license information, please see license.txt-->

# div_manufacturing

Design documents for every feature in `apps/div_manufacturing/`. Each feature is one `##` subsection
below; the structure inside each subsection is fixed (Summary, Problem, Target app, Functional
workflow, Schema, Overrides + hooks, Permissions, Out of scope, Open questions).

## Manufacture Transit Mapping

### 1. Summary
A FIFO allocator that maps Stock Entry Detail rows from one or more submitted **Material Transfer for Manufacture** Stock Entries onto the consumption rows of a draft **Manufacture** Stock Entry, preserving every active Inventory Dimension (handling unit, feeder, customer, etc.) and splitting target rows when a single BOM consumption row is satisfied by multiple source handling units.

### 2. Problem / why now
ERPNext's standard Material Transfer for Manufacture moves bulk components into WIP without per-row tagging beyond `handling_unit`. When the subsequent Manufacture Stock Entry is built from the BOM, the consumption rows are quantity-only — operators must hand-pick which transferred handling units (and which feeder / customer / other inventory dimensions) get drawn down. With multiple inventory dimensions active and BOM rows that don't line up 1:1 with transfer rows, the manual matching is error-prone and tedious. This feature lifts that into an interactive UI with a deterministic FIFO proposal and editable per-pair quantities.

### 3. Target app
App: `div_manufacturing`
Module: `DIV Manufacturing`

### 4. Functional workflow

1. **User** opens a draft Stock Entry whose `purpose = "Manufacture"`. Trigger: standard form action.
2. **User** clicks **Material Transfer for Manufacture** (custom button added by `manufacture_transit_mapping.js`). A `MultiSelectDialog` opens listing submitted `Material Transfer for Manufacture` Stock Entries, optionally pre-filtered by the draft's linked `work_order`. Trigger: button click.
3. **User** selects one or more source transfers and confirms. Trigger: dialog submit.
4. **System** — `div_manufacturing.api.transit_mapping.get_allocation_preview(target_stock_entry, source_stock_entry)` runs FIFO over the source rows for each (item, warehouse) pair in the target, returning `{allocations: [...], unmet: [...]}`. `allocations` lists each (target row, source row) pair with the proposed qty (and copies of every active inventory-dimension fieldname); `unmet` flags any target row whose qty couldn't be fully drawn from the selected sources. Trigger: in-method.
5. **System** — the dialog renders an interactive HTML table grouping each target row with its proposed allocations; quantity inputs are editable per (target, source) pair. As the user edits values the UI flags rows where the per-target sum exceeds the BOM qty or a source's available qty, and disables the **Apply** button until every row is valid. Unmet rows from step 4 are surfaced inline as a warning banner inside the dialog. Trigger: live UI validation.
6. **User** clicks **Apply**. Trigger: button click.
7. **System** — `div_manufacturing.api.transit_mapping.apply_allocation(target_stock_entry, allocations)` mutates the target Stock Entry: when a single BOM consumption row maps to N > 1 source rows, the target row is split into N child rows (the first reuses the existing row, the rest are clones via `clone_row` that drop system fields and preserve item / warehouse / UOM / rate). Each resulting row gets `qty`, `transfer_qty`, `handling_unit`, and every applicable inventory-dimension field set from the allocation. Any unallocated remainder is left as an untagged row. Trigger: whitelisted method call. Form reload follows.

### 5. Schema

#### 5.1 `Stock Entry` — Touched (no change)

No schema impact. The transit mapping mutates draft Manufacture Stock Entries via the standard child-table API; no new fields on the Stock Entry header.

#### 5.2 `Stock Entry Detail` — Touched (no change)

No schema impact. The mapping reads source rows and writes `qty`, `transfer_qty`, `handling_unit`, and the existing per-row inventory-dimension fields (whichever are active per `Inventory Dimension`). Rows are cloned/inserted via standard child-table append.

#### 5.3 `Inventory Dimension` — Touched (no change)

No schema impact. The mapping enumerates active rows at runtime via `inv_dim_fieldnames()` to discover which source-fieldnames need to be carried across; it never writes back.

### 6. Overrides, hooks, and direct file edits

**`doctype_js`** (third-party doctype):
- `Stock Entry` → `div_manufacturing/public/js/custom/manufacture_transit_mapping.js` — adds the **Material Transfer for Manufacture** button on draft Manufacture Stock Entries; opens the source-selection dialog and renders the editable allocation table.

**File-direct edits** (within div_manufacturing):
- `apps/div_manufacturing/div_manufacturing/api/transit_mapping.py` — exposes two whitelisted methods:
  - `get_allocation_preview(target_stock_entry: str, source_stock_entry: str) -> dict` — FIFO planner. Returns `{allocations: list, unmet: list}`.
  - `apply_allocation(target_stock_entry: str, allocations: list) -> None` — mutates the draft target Stock Entry per the (possibly user-edited) allocation list. Splits target rows when one BOM row maps to multiple sources.
  - Helpers: `inv_dim_fieldnames()` (enumerates active Inventory Dimension source fieldnames at runtime), `source_rows(source_stock_entry)` (fetches and annotates Stock Entry Detail rows from a submitted Material Transfer for Manufacture), `apply_alloc_to_row(row, alloc)` (mutates a Stock Entry Detail row to set qty / transfer_qty / handling_unit / inventory dimensions), `clone_row(se, template)` (creates a new child row by dropping system fields and preserving item / warehouse / UOM / rate).

### 7. Permissions

| Role | Read | Write | Create | Delete | Submit | Cancel |
|---|---|---|---|---|---|---|
| (inherits from `Stock Entry`) | ✓ | ✓ | ✓ | ✓ | | |

The whitelisted methods enforce the standard `Stock Entry` write permission of the calling user. No new permission surface.

### 8. Out of scope

- **Auto-apply on dialog open.** The FIFO proposal is always shown for review and editing; there is no "skip review" path.
- **Mapping into non-Manufacture Stock Entry purposes.** The button is gated on `purpose = "Manufacture"`. Other consumption-type entries (Material Issue, Repack) are not in scope; if needed they each get their own integration.
- **Cross-source dimension reconciliation when one BOM row spans sources with conflicting inventory-dimension values.** The split-row strategy means each resulting row carries the allocation's own dimensions; there is no warning when the operator's edits produce a target whose per-row dimensions disagree with what was originally on the transfer.
- **Persistence of the editable allocation as a doctype.** Allocations are computed on demand and applied directly to the target Stock Entry; no audit trail beyond Frappe's standard track-changes on the resulting Stock Entry Detail rows.
