<!-- Copyright (c) 2026, Duncan Integrated Ventures LLC. and contributors
For license information, please see license.txt-->

### DIV Manufacturing

Customizations for the ERPNext Manufacturing module.

### Functionality

#### Map handling units onto a Manufacture Stock Entry

Adds a **Get Item Details From → Material Transfer for Manufacture** action to
draft `Stock Entry` documents with purpose `Manufacture`. It copies handling
units and other inventory dimensions from one or more submitted Material
Transfer for Manufacture entries onto the consumption rows of the Manufacture
entry, without disturbing BOM-driven quantities.

Flow:

1. On a draft Manufacture Stock Entry, click **Get Item Details From →
   Material Transfer for Manufacture**. A multi-select dialog lists submitted
   transfers (pre-filtered to the current Work Order when set).
2. The server computes a preview (`get_allocation_preview`): for each unmapped
   target row it walks matching source rows FIFO by `idx`, pulling qty from
   each source HU until the row is covered. Source rows with no inventory
   dimensions are skipped; shortfalls are surfaced as **Unmet** warnings.
3. The preview dialog renders a parent/child table grouped by target row, with
   editable per-HU qty inputs. Live validation flags negative values, values
   above an HU's available qty, or a group that exceeds the target row's
   needed qty.
4. On **Apply** (`apply_allocation`): for each target row, the first
   allocation updates the row in place; additional allocations clone the row
   with their own qty and inventory dimensions; any leftover (allocated qty
   less than the original row qty) is kept as an un-tagged remainder row for
   manual handling. Rows that already carry a `serial_and_batch_bundle` are
   rejected — clear the bundle or map manually.

Inventory dimensions are discovered dynamically from the `Inventory Dimension`
doctype (e.g. `handling_unit`, `feeder`, `customer`), so any dimension using
beam's `source_fieldname` / `to_{fieldname}` convention is carried across.

Server endpoints live in `div_manufacturing/api/transit_mapping.py`; the
client button and preview dialog live in
`public/js/custom/manufacture_transit_mapping.js` (wired via `doctype_js` in
`hooks.py`).

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app div_manufacturing
```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/div_manufacturing
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
