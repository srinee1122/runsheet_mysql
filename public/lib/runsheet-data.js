// public/lib/runsheet-data.js — turns a saved runsheet + the current product list into the
// DATA shape both the print view and the Excel export need: the main per-invoice table
// (preset columns, CTNS, RI, totals), the "All Round Items" distribution matrix, and the
// packing-type breakdown used for the Load Summary. Extracted out of print.js so both
// exports build on the exact same logic rather than two copies that could quietly drift
// apart from each other over time — every comment here is carried over unchanged from
// there, since the reasoning behind each piece hasn't changed, only where it lives.
// created_by is the creator's display name where Firebase has one, otherwise their email.
// Accounts made in Firebase Console with just an email have no display name, so this
// would otherwise print "nikarthika@sriambikas.com" on the sign-off line. Show only the
// part before the @, with a capital first letter.
function preparedByLabel(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const name = s.includes('@') ? s.slice(0, s.indexOf('@')) : s;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Splits a product name into its pack-size / SKU part and the rest, so the pack size can
// be shown FIRST. It normally sits at the end of the name ("... RICE - 25KG X 1") and is
// usually what tells two similar products apart -- so in a narrow column it was the first
// thing cut off. Display-only; the stored name is never changed. Tested against every real
// product name: ~94% get a pack size (last " - " segment, else the last size token onward,
// handling "5KGX4", "500MLX 12", "5kg*6" and stray brackets), else a trailing bare pack
// count like "1X60"; the rest are mostly non-products (fees, equipment), correctly blank.
export function splitSku(name) {
  const s = String(name || '').trim();
  if (!s) return { sku: '', rest: '' };
  const clean = (t) => t.replace(/[\s\-–(]+$/, '').trim();
  const dash = s.lastIndexOf(' - ');
  if (dash > 0 && /\d/.test(s.slice(dash + 3))) return { sku: s.slice(dash + 3).trim(), rest: clean(s.slice(0, dash)) };
  const UNIT = '(?:kgs?|gms?|gr|g|mls?|ltrs?|l|litres?|pcs?|nos?|pkts?|pk|rolls?|bags?|tins?|cans?|btls?|bottles?|packs?|sachets?|inch|in)';
  const token = new RegExp('\\d[\\d.,]*\\s*' + UNIT + '(?=\\s|[x*]\\s*\\d|$|[)\\],])', 'gi');
  let last = null, m; while ((m = token.exec(s))) last = m.index;
  if (last == null) {
    const pk = s.match(/\d+\s*[xX*]\s*\d+\)?\s*$/);
    return pk ? { sku: pk[0].replace(/\)/g, '').trim(), rest: clean(s.slice(0, pk.index)) } : { sku: '', rest: s };
  }
  let depth = 0, out = '';
  for (const ch of s.slice(last)) { if (ch === '(') depth++; if (ch === ')') { if (depth === 0) continue; depth--; } out += ch; }
  return { sku: out.replace(/\s+/g, ' ').trim(), rest: clean(s.slice(0, last)) };
}

// "25KG X 1 · OOTY PREMIUM PARBOILED PONNI RICE" -- pack size first, on one line. Falls
// back to the plain name when no pack size can be found.
export function skuFirstLabel(name) {
  const { sku, rest } = splitSku(name);
  return sku && rest ? `${sku} · ${rest}` : (sku || rest || String(name || ''));
}

export function buildRunsheetData(rs, products) {
  const productById = new Map(products.map(p => [p.id, p]));
  const stops = (rs.data && rs.data.stops) || [];
  const frequentColumns = ((rs.data && rs.data.frequentColumns) || []).filter(c => c.product_id).slice(0, 15);

  const cols = frequentColumns.map(c => {
    const p = productById.get(c.product_id);
    // The unit this specific product is meant to be entered/shown in — mixed units
    // across columns on the same sheet are expected, matching whatever each product's
    // own Settings say, same as the Builder already shows while building.
    const unit = (p && p.entry_unit === 'PCS') ? 'PCS' : 'CTN';
    return { code: c.code || (p ? p.name : ''), pack: p ? `${p.qty_per_ctn}/ctn` : '', qty: (p && p.qty_per_ctn) || 1, unit, _pid: c.product_id };
  });
  const columnProductIds = new Set(cols.map(c => c._pid));

  // pieces for one product on one stop, from our stored round_items (qty in cartons).
  // Kept as the exact decimal, not rounded — that's what makes the cartons figure
  // downstream (pieces ÷ qty/ctn) come out mathematically identical to the Builder's
  // own raw qty_ctn sum, rather than drifting from a round-trip through a rounded
  // intermediate value.
  function piecesFor(stop, productId, qtyPerCtn) {
    let pcs = 0;
    for (const ri of stop.round_items || []) {
      if (ri.product_id === productId) pcs += (Number(ri.qty_ctn) || 0) * (qtyPerCtn || 1);
    }
    return pcs;
  }

  // manual box-total CTNS, split by packing type; falls back to the pre-split `ctns`
  // field (as all-carton) for runsheets saved before this existed.
  function stopCtns(s) {
    if (s.ctns_carton != null || s.ctns_bag != null) {
      return { carton: Number(s.ctns_carton) || 0, bag: Number(s.ctns_bag) || 0 };
    }
    return { carton: Number(s.ctns) || 0, bag: 0 };
  }

  const rows = stops.map(s => {
    const c = stopCtns(s);
    return {
      inv: s.invoice_no || '', so: s.so_no || '', cust: s.customer || '', by: s.taken_by || '',
      cash: '', chq: '', ctn: c.carton + c.bag,
      pcs: cols.map(col => piecesFor(s, col._pid, col.qty)),
    };
  });

  // products that appear as round items on some stop but aren't one of the up-to-15 preset columns
  const matrixIds = new Set();
  for (const s of stops) for (const ri of s.round_items || []) if (!columnProductIds.has(ri.product_id)) matrixIds.add(ri.product_id);
  const matrixProducts = [...matrixIds].map(pid => productById.get(pid)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  // The Builder's per-row packing toggle applies to every existing AND new quantity in
  // that row at once, so every stop's saved entry for a given product should already
  // agree — this just reads back whichever one is actually stored, rather than assuming.
  function packingTypeFor(productId) {
    for (const s of stops) {
      const ri = (s.round_items || []).find(r => r.product_id === productId);
      if (ri) return ri.packing_type === 'bag' ? 'bag' : (ri.packing_type === 'pcs' ? 'pcs' : 'carton');
    }
    return 'carton';
  }

  // Same idea for the entry-unit toggle — the Builder now saves whichever unit was
  // actually active when each quantity was entered/last toggled, so this reads that
  // back rather than falling back to the product's current Settings default, which
  // could easily have changed since (or just never matched what was toggled for this
  // specific runsheet).
  function entryUnitFor(productId, product) {
    for (const s of stops) {
      const ri = (s.round_items || []).find(r => r.product_id === productId);
      if (ri && ri.entry_unit) return ri.entry_unit === 'PCS' ? 'PCS' : 'CTN';
    }
    return (product && product.entry_unit === 'PCS') ? 'PCS' : 'CTN';
  }

  const all_round = matrixProducts.map(p => {
    const packing = packingTypeFor(p.id);
    return {
    name: p.name, label: skuFirstLabel(p.name), qty: p.qty_per_ctn || 1,
    // loose pieces are always shown in pieces, whatever unit the row was last toggled to
    unit: packing === 'pcs' ? 'PCS' : entryUnitFor(p.id, p),
    packing,
    loose: packing === 'pcs',
    byInv: stops.map(s => piecesFor(s, p.id, p.qty_per_ctn)),
  }; });

  const notes = stops.filter(s => s.note && s.note.trim()).map(s => `${s.so_no || ''}: ${s.note}`).join(' · ');

  // packing-type breakdown for delivery cost (3rd-party vendors bill cartons and bags
  // differently) — computed straight from the stored round items, not re-derived through
  // the pieces/ceiling conversion used elsewhere, so it stays exact. Manual CTNS gets the
  // same breakdown, since that's billed the same way.
  // Loose pieces are counted separately, in pieces, and never added to cartons or bags.
  let cartonUnits = 0, bagUnits = 0, ctnsCartonUnits = 0, ctnsBagUnits = 0, loosePieces = 0;
  for (const s of stops) {
    for (const ri of s.round_items || []) {
      const qty = Number(ri.qty_ctn) || 0;
      if (ri.packing_type === 'pcs') {
        const pr = productById.get(ri.product_id);
        loosePieces += qty * ((pr && pr.qty_per_ctn) || 1);
      } else if (ri.packing_type === 'bag') bagUnits += qty; else cartonUnits += qty;
    }
    const c = stopCtns(s);
    ctnsCartonUnits += c.carton;
    ctnsBagUnits += c.bag;
  }

  return {
    meta: {
      sheet_no: rs.sheet_no || '', run_date: rs.run_date || '', area: rs.area || '',
      // the ACTUAL delivery man / vehicle confirmed at handover win over the planned ones
      del_date: (rs.dispatch && rs.dispatch.delivery_date) || rs.delivery_date || '',
      del_man: (rs.dispatch && rs.dispatch.del_man) || rs.delivery_man || '',
      veh_no: (rs.dispatch && rs.dispatch.vehicle_no) || rs.vehicle_no || '',
      driver: (rs.dispatch && rs.dispatch.driver) || '',
      driver_company: (rs.dispatch && rs.dispatch.company_name) || '',
      time_in: (rs.dispatch && rs.dispatch.time_in) || '',
      time_out: (rs.dispatch && rs.dispatch.time_out) || '',
      notes,
      // Who created the runsheet — set by the server from the verified login when the sheet
      // was first saved, never from anything the browser sends. Pre-fills the "Prepared By"
      // sign-off line on the printout and in the Excel export.
      created_by: preparedByLabel(rs.created_by),
    },
    cols, rows, all_round,
    packing: {
      cartons: Math.round(cartonUnits * 100) / 100, bags: Math.round(bagUnits * 100) / 100,
      ctnsCartons: Math.round(ctnsCartonUnits * 100) / 100, ctnsBags: Math.round(ctnsBagUnits * 100) / 100,
      pieces: Math.round(loosePieces * 100) / 100,
    },
  };
}

// ctnOf and cell() live here too — both print.js's render() and the Excel export need the
// same pieces-to-cartons conversion and zero-as-dot display convention to stay consistent
// with each other and with the Builder.
// No ceiling — matches the Matrix Builder exactly, which shows the raw decimal on
// purpose (a fractional cartons figure is usually a sign of a wrong entry, and
// rounding it away here would hide that on the one document a driver actually acts
// on, which is worse than hiding it during entry).
export const ctnOf = (pcs, qty) => qty <= 1 ? pcs : pcs / qty;
