// Copyright (c) 2026, Duncan Integrated Ventures LLC and contributors
// For license information, please see license.txt

/* global div_manufacturing */

frappe.provide('div_manufacturing')

frappe.ui.form.on('Stock Entry', {
	refresh(frm) {
		const show =
			!frm.is_new() && frm.doc.docstatus === 0 && frm.doc.purpose === 'Manufacture' && (frm.doc.items || []).length > 0
		if (!show) return

		frm.add_custom_button(
			__('Material Transfer for Manufacture'),
			() => div_manufacturing.pick_transit_sources(frm),
			__('Get Item Details From')
		)
	},
})

div_manufacturing.pick_transit_sources = frm => {
	const msd = new frappe.ui.form.MultiSelectDialog({
		doctype: 'Stock Entry',
		target: frm,
		date_field: 'posting_date',
		size: 'large',
		setters: {
			work_order: frm.doc.work_order || undefined,
		},
		get_query: () => ({
			filters: {
				docstatus: 1,
				purpose: 'Material Transfer for Manufacture',
				...(frm.doc.work_order ? { work_order: frm.doc.work_order } : {}),
			},
		}),
		action: selections => {
			if (!selections || !selections.length) return
			msd.dialog.hide()
			div_manufacturing.preview_allocation(frm, selections)
		},
	})

	// The dialog is created inside a frappe.model.with_doctype callback, so it
	// may not exist synchronously. Poll briefly and hide the "Make Stock Entry"
	// secondary button once the dialog is ready.
	const hide_secondary = () => {
		if (msd.dialog) {
			msd.dialog.get_secondary_btn().hide()
		} else {
			setTimeout(hide_secondary, 50)
		}
	}
	hide_secondary()
}

div_manufacturing.preview_allocation = (frm, sources) => {
	frappe
		.call({
			method: 'div_manufacturing.api.transit_mapping.get_allocation_preview',
			args: {
				target_stock_entry: frm.doc.name,
				source_stock_entry: sources,
			},
			freeze: true,
			freeze_message: __('Computing allocation…'),
		})
		.then(r => {
			const result = r.message || {}
			if (!(result.allocations || []).length) {
				frappe.msgprint({
					title: __('Nothing to map'),
					message: __('No unmapped target rows matched items on the selected transfer(s).'),
					indicator: 'orange',
				})
				return
			}
			div_manufacturing.render_allocation_dialog(frm, result)
		})
}

div_manufacturing.render_allocation_dialog = (frm, result) => {
	// Group allocations by target row. Parent rows display the target's item/needed;
	// children are the allocations, one per (target, source HU) pair, with editable qty.
	const targets = {}
	const by_id = {}
	result.allocations.forEach((a, i) => {
		a._id = String(i)
		by_id[a._id] = a
		if (!targets[a.target_row]) {
			targets[a.target_row] = {
				target_row: a.target_row,
				target_idx: a.target_idx,
				item_code: a.item_code,
				target_qty: a.target_qty,
				uom: a.uom,
				children: [],
			}
		}
		targets[a.target_row].children.push(a)
	})

	const d = new frappe.ui.Dialog({
		title: __('Confirm Allocation'),
		size: 'extra-large',
		fields: [
			{
				fieldtype: 'HTML',
				fieldname: 'unmet_html',
				options: div_manufacturing._unmet_html(result.unmet || []),
			},
			{
				fieldtype: 'HTML',
				fieldname: 'allocations_html',
				options: div_manufacturing._allocation_table_html(Object.values(targets)),
			},
		],
		primary_action_label: __('Apply'),
		primary_action: () => {
			const $inputs = d.$wrapper.find('.transit-qty')
			if (d.$wrapper.find('.transit-qty.invalid').length) {
				frappe.msgprint({
					title: __('Invalid Allocation'),
					message: __(
						'One or more rows are invalid (negative, exceed HU qty, or total exceeds the target row). Fix the highlighted rows first.'
					),
					indicator: 'red',
				})
				return
			}
			const edited = []
			$inputs.each(function () {
				const $in = $(this)
				const orig = by_id[$in.data('alloc-id')]
				edited.push({
					target_row: orig.target_row,
					qty: flt($in.val()),
					handling_unit: orig.handling_unit,
					inv_dims: orig.inv_dims || {},
				})
			})
			div_manufacturing.apply_allocation(frm, edited, d)
		},
	})
	d.show()

	// Real-time validation: any input change re-validates its target group,
	// toggling the `invalid` class on each sibling input and on the Apply button.
	d.$wrapper.on('input change', '.transit-qty', function () {
		div_manufacturing._validate_target_group(d.$wrapper, $(this).data('target-row'))
		div_manufacturing._toggle_apply(d)
	})
	Object.keys(targets).forEach(t => div_manufacturing._validate_target_group(d.$wrapper, t))
	div_manufacturing._toggle_apply(d)
}

div_manufacturing._allocation_table_html = targets => {
	const esc = frappe.utils.escape_html
	const fmt = v => frappe.format(v, { fieldtype: 'Float' })
	const body = targets
		.map(t => {
			const parent = `<tr class="transit-parent" data-target-row="${esc(t.target_row)}">
				<td class="text-right">${t.target_idx}</td>
				<td><b>${esc(t.item_code)}</b></td>
				<td class="text-right"><b>${fmt(t.target_qty)}</b></td>
				<td></td>
				<td></td>
				<td>${esc(t.uom || '')}</td>
				<td colspan="4"></td>
			</tr>`
			const children = t.children
				.map(
					a => `<tr class="transit-child">
				<td></td>
				<td class="transit-indent">└─</td>
				<td></td>
				<td class="text-right"><input
					type="number" step="any"
					class="form-control input-xs transit-qty"
					value="${a.qty}"
					data-alloc-id="${a._id}"
					data-target-row="${esc(a.target_row)}"
					data-target-idx="${a.target_idx}"
					data-target-qty="${a.target_qty}"
					data-source-qty="${a.source_qty || 0}"
				/></td>
				<td class="text-right">${fmt(a.source_qty || 0)}</td>
				<td>${esc(a.uom || '')}</td>
				<td>${esc(a.handling_unit || '')}</td>
				<td>${esc(a.feeder || '')}</td>
				<td>${esc(a.customer || '')}</td>
				<td>${esc(a.source_stock_entry || '')}</td>
			</tr>`
				)
				.join('')
			return parent + children
		})
		.join('')

	return `<style>
		.transit-mapping-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
		.transit-mapping-table th { text-align: left; font-weight: 600; color: #666; padding: 6px 8px; border-bottom: 1px solid #d1d8dd; white-space: nowrap; }
		.transit-mapping-table td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
		.transit-mapping-table .text-right { text-align: right; }
		.transit-mapping-table tr.transit-parent td { background: #f7f7f8; border-top: 1px solid #d1d8dd; }
		.transit-mapping-table .transit-indent { padding-left: 2rem; color: #999; }
		.transit-mapping-table input.transit-qty { width: 90px; text-align: right; display: inline-block; }
		.transit-mapping-table input.transit-qty.invalid { border-color: #d9534f; background: #fbeaea; }
	</style>
	<table class="transit-mapping-table">
		<thead><tr>
			<th class="text-right" style="width: 50px;">${__('Row #')}</th>
			<th>${__('Item')}</th>
			<th class="text-right" style="width: 80px;">${__('Needed')}</th>
			<th class="text-right" style="width: 110px;">${__('Allocate')}</th>
			<th class="text-right" style="width: 80px;">${__('HU Qty')}</th>
			<th style="width: 60px;">${__('UOM')}</th>
			<th>${__('Handling Unit')}</th>
			<th>${__('Feeder')}</th>
			<th>${__('Customer')}</th>
			<th>${__('Source')}</th>
		</tr></thead>
		<tbody>${body}</tbody>
	</table>`
}

div_manufacturing._validate_target_group = (wrapper, target_row) => {
	const $inputs = wrapper.find(`.transit-qty[data-target-row="${target_row}"]`)
	if (!$inputs.length) return
	let sum = 0
	const vals = []
	$inputs.each(function () {
		const v = flt($(this).val())
		vals.push(v)
		sum += v
	})
	const target_qty = flt($inputs.first().data('target-qty'))
	const over_target = sum > target_qty + 1e-9
	$inputs.each(function (i) {
		const $in = $(this)
		const v = vals[i]
		const source_qty = flt($in.data('source-qty'))
		const bad = v < 0 || v > source_qty + 1e-9 || over_target
		$in.toggleClass('invalid', bad)
	})
}

div_manufacturing._toggle_apply = d => {
	if (d.$wrapper.find('.transit-qty.invalid').length) {
		d.disable_primary_action()
	} else {
		d.enable_primary_action()
	}
}

div_manufacturing._unmet_html = unmet => {
	if (!unmet.length) return ''
	const esc = frappe.utils.escape_html
	const rows = unmet
		.map(
			u => `
		<tr>
			<td>${u.target_idx}</td>
			<td>${esc(u.item_code)}</td>
			<td style="text-align: right;">${frappe.format(u.shortfall, { fieldtype: 'Float' })}</td>
			<td>${esc(u.uom || '')}</td>
		</tr>`
		)
		.join('')
	return `<div class="alert alert-warning" style="margin-bottom: 10px;">
		<b>${__('Shortfall')}:</b> ${__('The selected transfer(s) do not fully cover these rows — they will be left unmapped.')}
		<table class="table table-condensed" style="margin-top: 6px; margin-bottom: 0;">
			<thead><tr>
				<th style="width: 60px;">${__('Row #')}</th>
				<th>${__('Item')}</th>
				<th style="text-align: right; width: 120px;">${__('Shortfall')}</th>
				<th style="width: 80px;">${__('UOM')}</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>
	</div>`
}

div_manufacturing.apply_allocation = (frm, allocations, dialog) => {
	frappe
		.call({
			method: 'div_manufacturing.api.transit_mapping.apply_allocation',
			args: {
				target_stock_entry: frm.doc.name,
				allocations,
			},
			freeze: true,
			freeze_message: __('Applying allocation…'),
		})
		.then(() => frm.reload_doc())
		.then(() => {
			dialog.hide()
			frappe.show_alert({
				message: __('Handling units mapped onto consumption rows.'),
				indicator: 'green',
			})
		})
}
