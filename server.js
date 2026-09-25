'use strict';
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { q, one, run, isDuplicate, getSetting, setSetting, init: initDb } = require('./db');
const { EXTRACTION_SYSTEM_PROMPT } = require('./extraction-prompt');
const { requireAuth, requireModule, requireAnyModule, requireAdmin, getUser, userPermissions, MODULES } = require('./auth');

const app = express();
const PORT = process.env.PORT || 4500;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// One-time diagnostic covering every secret this app reads from the environment — prints
// once at startup so a single deploy shows whether a platform's secrets feature is
// reaching the process at all, or only failing for one specific value (auth.js logs its
// own more detailed line for FIREBASE_SERVICE_ACCOUNT_JSON specifically; this is the
// short version covering all three side by side).
console.log('[env check] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `present (${process.env.ANTHROPIC_API_KEY.length} chars)` : 'NOT SET');
console.log('[env check] BOOTSTRAP_ADMIN_EMAIL:', process.env.BOOTSTRAP_ADMIN_EMAIL ? `present: ${process.env.BOOTSTRAP_ADMIN_EMAIL}` : 'NOT SET');
console.log('[env check] FIREBASE_SERVICE_ACCOUNT_JSON:', process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? `present (${process.env.FIREBASE_SERVICE_ACCOUNT_JSON.length} chars)` : 'NOT SET');

app.use(express.json({ limit: '5mb' }));
// Everything under public/ is intentionally served to anyone with no authentication —
// the login page has to be reachable before anyone can sign in. Data lives in MySQL now
// (see db.js), so there is no longer a database file under public/ needing protection.
// Cache-Control: no-cache on code and page files. Without it, browsers keep ES modules in
// cache across deploys and GoDaddy's Cloudflare-backed CDN caches .js at the edge — which
// produced a print page running a NEW print.js against an OLD runsheet-data.js, and the
// word "undefined" on a printed sign-off line. no-cache means "always revalidate": the
// server answers 304 when the file is unchanged (still fast, ETags are on by default), and
// sends the new file the moment a deploy changes it. Both browsers and Cloudflare honour
// it. Images and fonts are left cacheable; they don't change with deploys.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(js|mjs|css|html)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

// Every /api/* route requires a valid Firebase ID token from here on — the login page
// and the rest of the static frontend stay reachable without one, since you need to be
// able to load the page to sign in at all. Per-route module checks are added below.
app.use('/api', requireAuth);

// ---- current-user profile & admin user management ----
app.get('/api/me', (req, res) => {
  res.json({ uid: req.user.uid, email: req.user.email, displayName: req.user.display_name, ...req.permissions });
});

app.get('/api/users', requireAdmin, async (req, res) => {
  const rows = await q('SELECT * FROM users ORDER BY email');
  res.json(rows.map(r => ({
    uid: r.uid, email: r.email, displayName: r.display_name, isAdmin: !!r.is_admin,
    modules: Object.fromEntries(MODULES.map(m => [m, !!r[`module_${m}`]])),
    lastLoginAt: r.last_login_at,
  })));
});

// ---- diagnostics (admin only) ----
// Originally added to investigate runsheets vanishing on the live host with no deployment
// in between. That investigation found the cause: the container's filesystem did not keep
// files written at runtime, so a SQLite database file could never persist there — which
// is why data now lives in the platform's managed MySQL instead. Kept because it remains
// a useful one-click health check: it confirms the app can reach the database, that a
// write actually lands and reads back, and (via instanceId / hostname / pid) whether the
// process is being restarted or duplicated. Purely read-only apart from one harmless
// write-and-read-back into the throwaway _diag table, which never touches runsheet data.
const INSTANCE_ID = crypto.randomUUID();
const PROCESS_STARTED_AT = new Date().toISOString();
app.get('/api/diag', requireAdmin, async (req, res) => {
  let dbVersion = null, dbError = null, runsheetCount = null, recent = [], writeReadBack = null;
  try {
    dbVersion = (await one('SELECT VERSION() AS v')).v;
    runsheetCount = Number((await one('SELECT COUNT(*) AS n FROM runsheets')).n);
    recent = await q('SELECT id, sheet_no, created_at FROM runsheets ORDER BY id DESC LIMIT 8');
    const marker = new Date().toISOString();
    await run('INSERT INTO _diag (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['last_check', marker]);
    const back = await one('SELECT v FROM _diag WHERE k = ?', ['last_check']);
    writeReadBack = back && back.v === marker ? 'ok' : 'MISMATCH';
  } catch (e) { dbError = e.message; }
  res.json({
    instanceId: INSTANCE_ID,
    hostname: os.hostname(),
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    now: new Date().toISOString(),
    database: { host: process.env.DB_HOST, port: process.env.DB_PORT, name: process.env.DB_NAME, user: process.env.DB_USER },
    dbVersion,
    dbError,
    runsheetCount,
    recentRunsheets: recent,
    writeReadBack,
  });
});

app.put('/api/users/:uid', requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const target = await getUser(uid);
  if (!target) return res.status(404).json({ error: 'No such user.' });
  const isAdmin = !!req.body.isAdmin;
  // Guard against locking everyone out: never let the last remaining admin be demoted.
  if (target.is_admin && !isAdmin) {
    const { n: otherAdmins } = await one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND uid != ?', [uid]);
    if (Number(otherAdmins) === 0) return res.status(400).json({ error: "Can't remove the last admin." });
  }
  const modules = req.body.modules || {};
  const setCols = ['is_admin=?', ...MODULES.map(m => `module_${m}=?`)];
  const vals = [isAdmin ? 1 : 0, ...MODULES.map(m => (modules[m] ? 1 : 0))];
  await run(`UPDATE users SET ${setCols.join(',')} WHERE uid=?`, [...vals, uid]);
  res.json({ ok: true });
});


// ---------------------------------------------------------------------------
// tiny CSV parser (handles quoted fields with commas) — no dependency needed
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// header normalization shared by both CSV-paste and rows-array import paths.
// Lets an import accept either the exact ItemsMaster/CustomersMaster column
// names (e.g. "Sub-category 2", "Qty/Ctn") or our own canonical field names.
// ---------------------------------------------------------------------------
function normKey(k) { return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
// Coerces any value to a clean string before it touches a TEXT column. Needed because Excel
// exports things like postal codes as actual numbers — binding a raw JS number into a TEXT
// column lets SQLite apply its own float-to-text conversion, turning 609957 into "609957.0".
function txt(v) { return (v === undefined || v === null || v === '') ? '' : String(v).trim(); }

function csvToObjects(text) {
  const parsed = parseCsv(text.trim());
  if (!parsed.length) return [];
  const header = parsed[0];
  const out = [];
  for (let i = 1; i < parsed.length; i++) {
    const row = parsed[i];
    if (!row.some(c => c && String(c).trim())) continue; // skip blank rows
    const obj = {};
    header.forEach((h, idx) => { obj[h] = row[idx]; });
    out.push(obj);
  }
  return out;
}

const PRODUCT_FIELD_MAP = {
  name: 'name', code: 'code', supplier: 'supplier', brand: 'brand', category: 'category',
  subcategory: 'sub_category', subcategory2: 'sub_category_2', baseunit: 'base_unit',
  group: 'group_name', itemtype: 'item_type', qtyctn: 'qty_per_ctn', qtypctn: 'qty_per_ctn',
  pack: 'qty_per_ctn', sellingrate: 'selling_rate', isrounditem: 'is_round_item',
  rounditem: 'is_round_item', round: 'is_round_item',
  packingtype: 'packing_type', packing: 'packing_type', cartonbag: 'packing_type',
  entryunit: 'entry_unit', unit: 'entry_unit',
};
const PRODUCT_FIELDS = ['name', 'code', 'supplier', 'brand', 'category', 'sub_category', 'sub_category_2',
  'base_unit', 'group_name', 'item_type', 'qty_per_ctn', 'selling_rate', 'is_round_item', 'packing_type', 'entry_unit'];

function normalizeProductRecord(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = PRODUCT_FIELD_MAP[normKey(k)];
    if (field && out[field] === undefined) out[field] = v;
  }
  for (const f of PRODUCT_FIELDS) if (raw[f] !== undefined && out[f] === undefined) out[f] = raw[f];
  return out;
}

const CUSTOMER_FIELD_MAP = {
  name: 'name', code: 'code', segment: 'segment', area: 'area', contact: 'contact',
  chainstore: 'chain_store', address: 'address', postalcode: 'postal_code', mobile: 'mobile',
  whatsapp: 'whatsapp', rocno: 'roc_no', modified: 'modified_source',
};
const CUSTOMER_FIELDS = ['name', 'code', 'segment', 'area', 'contact', 'chain_store', 'address',
  'postal_code', 'mobile', 'whatsapp', 'roc_no', 'modified_source'];

function normalizeCustomerRecord(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = CUSTOMER_FIELD_MAP[normKey(k)];
    if (field && out[field] === undefined) out[field] = v;
  }
  for (const f of CUSTOMER_FIELDS) if (raw[f] !== undefined && out[f] === undefined) out[f] = raw[f];
  return out;
}

function truthy(v) { return v === true || /^(1|y|yes|true)$/i.test(String(v ?? '').trim()); }
// packing_type is purely a billing classification (3rd-party delivery vendors charge
// cartons and bags differently) — never affects the carton-count math elsewhere.
// Three packing types: 'carton', 'bag', and 'pcs' -- loose pieces (frozen items and the
// like) that travel as individual pieces, neither cartoned nor bagged. Loose pieces are
// counted in pieces and kept out of every carton/bag figure and out of TOTAL PACKAGES.
function normPacking(v) {
  const s = String(v ?? '').trim();
  if (/^bag/i.test(s)) return 'bag';
  if (/^(pcs?|pieces?|loose)/i.test(s)) return 'pcs';
  return 'carton';
}
// how this product's round-item quantity is normally counted — cartons or pieces; only
// affects what unit entry fields default to/display, never how anything is stored.
function normEntryUnit(v) { return /^p/i.test(String(v ?? '').trim()) ? 'PCS' : 'CTN'; }

// =====================================================================
// PRODUCTS — mirrors the Item Master columns (Name, Code, Supplier, Brand,
// Category, Sub-category, Sub-category 2, Base unit, Group, Item type,
// Qty/Ctn, Selling rate), plus the app's own is_round_item flag.
// =====================================================================
app.get('/api/products', requireAnyModule('builder', 'products'), async (req, res) => {
  const rows = await q('SELECT * FROM products ORDER BY name');
  res.json(rows.map(r => ({ ...r, is_round_item: !!r.is_round_item })));
});

function productParams(body) {
  return [
    (body.name || '').trim(), Number(body.qty_per_ctn) || 1, body.is_round_item ? 1 : 0,
    txt(body.code), txt(body.supplier), txt(body.brand), txt(body.category),
    txt(body.sub_category), txt(body.sub_category_2), txt(body.base_unit),
    txt(body.group_name), txt(body.item_type), Number(body.selling_rate) || 0,
    normPacking(body.packing_type), normEntryUnit(body.entry_unit),
  ];
}

app.post('/api/products', requireModule('products'), async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const info = await run(`
      INSERT INTO products (name, qty_per_ctn, is_round_item, code, supplier, brand, category, sub_category, sub_category_2, base_unit, group_name, item_type, selling_rate, packing_type, entry_unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, productParams(req.body));
    res.json({ id: Number(info.insertId) });
  } catch (e) {
    res.status(400).json({ error: isDuplicate(e) ? 'A product with this name already exists' : e.message });
  }
});

app.put('/api/products/:id', requireModule('products'), async (req, res) => {
  try {
    await run(`
      UPDATE products SET name=?, qty_per_ctn=?, is_round_item=?, code=?, supplier=?, brand=?, category=?,
        sub_category=?, sub_category_2=?, base_unit=?, group_name=?, item_type=?, selling_rate=?, packing_type=?, entry_unit=? WHERE id=?
    `, [...productParams(req.body), req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: isDuplicate(e) ? 'A product with this name already exists' : e.message });
  }
});

app.delete('/api/products/:id', requireModule('products'), async (req, res) => {
  await run('DELETE FROM products WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Import from CSV paste or a rows array (the browser parses .xlsx client-side and posts rows).
// Re-importing a name that already exists updates its reference data but deliberately leaves
// is_round_item, packing_type, and entry_unit untouched, so re-running an Item Master import
// never wipes flags or classifications assigned inside this app.
app.post('/api/products/import', requireModule('products'), async (req, res) => {
  const { csv, rows } = req.body;
  let rawRecords;
  if (Array.isArray(rows)) rawRecords = rows;
  else if (typeof csv === 'string') rawRecords = csvToObjects(csv);
  else return res.status(400).json({ error: 'provide csv text or rows array' });

  // MySQL's spelling of SQLite's ON CONFLICT ... DO UPDATE SET x=excluded.x.
  const UPSERT = `
    INSERT INTO products (name, qty_per_ctn, is_round_item, code, supplier, brand, category, sub_category, sub_category_2, base_unit, group_name, item_type, selling_rate, packing_type, entry_unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      qty_per_ctn=VALUES(qty_per_ctn), code=VALUES(code), supplier=VALUES(supplier), brand=VALUES(brand),
      category=VALUES(category), sub_category=VALUES(sub_category), sub_category_2=VALUES(sub_category_2),
      base_unit=VALUES(base_unit), group_name=VALUES(group_name), item_type=VALUES(item_type),
      selling_rate=VALUES(selling_rate)
  `;
  let count = 0;
  for (const raw of rawRecords) {
    const r = normalizeProductRecord(raw);
    if (!r.name || !String(r.name).trim()) continue;
    await run(UPSERT, [
      String(r.name).trim(), Number(r.qty_per_ctn) || 1, r.is_round_item !== undefined ? (truthy(r.is_round_item) ? 1 : 0) : 0,
      txt(r.code), txt(r.supplier), txt(r.brand), txt(r.category), txt(r.sub_category),
      txt(r.sub_category_2), txt(r.base_unit), txt(r.group_name), txt(r.item_type), Number(r.selling_rate) || 0,
      normPacking(r.packing_type), normEntryUnit(r.entry_unit),
    ]);
    count++;
  }
  res.json({ imported: count });
});

// =====================================================================
// CUSTOMERS — mirrors the Customer Master columns (Name, Code, Segment,
// Area, Contact, Chain store, Address, Postal code, Mobile, WhatsApp, ROC no).
// =====================================================================
app.get('/api/customers', requireAnyModule('builder', 'customers'), async (req, res) => {
  res.json(await q('SELECT * FROM customers ORDER BY name'));
});

function customerParams(body) {
  return [
    (body.name || '').trim(), txt(body.area), txt(body.code), txt(body.segment), txt(body.contact),
    txt(body.chain_store), txt(body.address), txt(body.postal_code), txt(body.mobile),
    txt(body.whatsapp), txt(body.roc_no), txt(body.modified_source),
  ];
}

app.post('/api/customers', requireModule('customers'), async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const info = await run(`
      INSERT INTO customers (name, area, code, segment, contact, chain_store, address, postal_code, mobile, whatsapp, roc_no, modified_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, customerParams(req.body));
    res.json({ id: Number(info.insertId) });
  } catch (e) {
    res.status(400).json({ error: isDuplicate(e) ? 'A customer with this name already exists' : e.message });
  }
});

app.put('/api/customers/:id', requireModule('customers'), async (req, res) => {
  try {
    await run(`
      UPDATE customers SET name=?, area=?, code=?, segment=?, contact=?, chain_store=?, address=?,
        postal_code=?, mobile=?, whatsapp=?, roc_no=?, modified_source=? WHERE id=?
    `, [...customerParams(req.body), req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: isDuplicate(e) ? 'A customer with this name already exists' : e.message });
  }
});

app.delete('/api/customers/:id', requireModule('customers'), async (req, res) => {
  await run('DELETE FROM customers WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/customers/import', requireModule('customers'), async (req, res) => {
  const { csv, rows } = req.body;
  let rawRecords;
  if (Array.isArray(rows)) rawRecords = rows;
  else if (typeof csv === 'string') rawRecords = csvToObjects(csv);
  else return res.status(400).json({ error: 'provide csv text or rows array' });

  const UPSERT = `
    INSERT INTO customers (name, area, code, segment, contact, chain_store, address, postal_code, mobile, whatsapp, roc_no, modified_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      area=VALUES(area), code=VALUES(code), segment=VALUES(segment), contact=VALUES(contact),
      chain_store=VALUES(chain_store), address=VALUES(address), postal_code=VALUES(postal_code),
      mobile=VALUES(mobile), whatsapp=VALUES(whatsapp), roc_no=VALUES(roc_no), modified_source=VALUES(modified_source)
  `;
  let count = 0;
  for (const raw of rawRecords) {
    const r = normalizeCustomerRecord(raw);
    if (!r.name || !String(r.name).trim()) continue;
    await run(UPSERT, [
      String(r.name).trim(), txt(r.area), txt(r.code), txt(r.segment), txt(r.contact),
      txt(r.chain_store), txt(r.address), txt(r.postal_code), txt(r.mobile), txt(r.whatsapp),
      txt(r.roc_no), txt(r.modified_source),
    ]);
    count++;
  }
  res.json({ imported: count });
});

// =====================================================================
// SETTINGS — frequent round-item columns (max 15), clerk name list
// =====================================================================
app.get('/api/settings/frequent-columns', requireAnyModule('builder', 'settings'), async (req, res) => {
  res.json(await getSetting('frequent_columns', []));
});

app.put('/api/settings/frequent-columns', requireModule('settings'), async (req, res) => {
  const cols = Array.isArray(req.body.columns) ? req.body.columns : [];
  if (cols.length > 15) return res.status(400).json({ error: 'max 15 frequent columns' });
  await setSetting('frequent_columns', cols);
  res.json({ ok: true });
});

app.get('/api/settings/clerks', requireAnyModule('builder', 'settings'), async (req, res) => {
  res.json(await getSetting('clerks', []));
});

app.put('/api/settings/clerks', requireModule('settings'), async (req, res) => {
  const names = Array.isArray(req.body.names) ? [...new Set(req.body.names.map(n => String(n).trim()).filter(Boolean))] : [];
  await setSetting('clerks', names);
  res.json({ ok: true });
});

// =====================================================================
// RUNSHEETS (history + save/reopen)
// =====================================================================
app.get('/api/runsheets', requireAnyModule('builder', 'history'), async (req, res) => {
  const rows = await q(
    'SELECT id, sheet_no, area, delivery_man, vehicle_no, run_date, delivery_date, created_by, created_at, updated_at FROM runsheets ORDER BY id DESC'
  );
  res.json(rows);
});

app.get('/api/runsheets/:id', requireAnyModule('builder', 'history'), async (req, res) => {
  const row = await one('SELECT * FROM runsheets WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

function validateRunsheetPayload(body) {
  const stops = body.data && Array.isArray(body.data.stops) ? body.data.stops : [];
  if (stops.length > 25) return 'A runsheet can hold at most 25 invoices (one-page rule).';
  return null;
}

app.post('/api/runsheets', requireModule('builder'), async (req, res) => {
  const b = req.body;
  const err = validateRunsheetPayload(b);
  if (err) return res.status(400).json({ error: err });
  // created_by comes from the verified token, not whatever the client sends — a person
  // can't misattribute a sheet to someone else this way.
  const createdBy = req.user.display_name || req.user.email || '';
  const info = await run(`
    INSERT INTO runsheets (sheet_no, area, delivery_man, vehicle_no, run_date, delivery_date, created_by, data, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [txt(b.sheet_no), txt(b.area), txt(b.delivery_man), txt(b.vehicle_no), txt(b.run_date), txt(b.delivery_date), createdBy, JSON.stringify(b.data || {})]);
  res.json({ id: Number(info.insertId), version: 1 });
});

// Optimistic concurrency: the client sends the version it loaded. If the row's current
// version has since moved on (someone else saved in between), reject with 409 rather than
// silently overwriting their save — no lock to go stale, just a conflict caught at save time.
//
// `explicit: true` in the payload (set by the Save button and by Print, which saves first;
// never set by auto-save) snapshots into runsheet_versions AFTER applying the new save —
// so the snapshot is exactly what was just saved, not the state it replaced. Snapshotting
// the pre-save state instead (the previous behavior here) meant the content you just saved
// was never itself visible in version history until a later save pushed it there, always
// one step behind. See the table's own comment in db.js for why auto-save doesn't trigger
// a snapshot at all.
//
// Only the 3 most recent explicit saves are kept per runsheet — older ones are pruned right
// after each new snapshot is inserted, so this table can never grow without bound the way it
// used to. This only ever prunes past explicit saves; auto-save never adds a row here in the
// first place, so leaving a page open for hours has no effect on how many of these accumulate.
const VERSIONS_TO_KEEP = 3;
app.put('/api/runsheets/:id', requireModule('builder'), async (req, res) => {
  const b = req.body;
  const err = validateRunsheetPayload(b);
  if (err) return res.status(400).json({ error: err });
  const current = await one('SELECT * FROM runsheets WHERE id=?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'not found' });
  const expected = Number(b.version);
  if (!Number.isFinite(expected) || expected !== current.version) {
    return res.status(409).json({
      error: 'This runsheet was changed by someone else since you opened it. Reload to see the latest version before saving again.',
      current_version: current.version,
    });
  }
  const nextVersion = current.version + 1;
  await run(`
    UPDATE runsheets SET sheet_no=?, area=?, delivery_man=?, vehicle_no=?, run_date=?, delivery_date=?, data=?, version=?, updated_at=UTC_TIMESTAMP()
    WHERE id=?
  `, [txt(b.sheet_no), txt(b.area), txt(b.delivery_man), txt(b.vehicle_no), txt(b.run_date), txt(b.delivery_date), JSON.stringify(b.data || {}), nextVersion, req.params.id]);
  if (b.explicit) {
    const savedBy = req.user.display_name || req.user.email || '';
    await run(`
      INSERT INTO runsheet_versions (runsheet_id, version, sheet_no, area, delivery_man, vehicle_no, run_date, delivery_date, data, saved_by, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
    `, [req.params.id, nextVersion, txt(b.sheet_no), txt(b.area), txt(b.delivery_man), txt(b.vehicle_no), txt(b.run_date), txt(b.delivery_date), JSON.stringify(b.data || {}), savedBy]);
    // MySQL rejects LIMIT inside an IN (...) subquery outright, so the "ids to keep" query
    // is wrapped in a derived table, which it does allow. Same effect as the SQLite form.
    await run(`
      DELETE FROM runsheet_versions WHERE runsheet_id = ? AND id NOT IN (
        SELECT id FROM (SELECT id FROM runsheet_versions WHERE runsheet_id = ? ORDER BY id DESC LIMIT ?) keep
      )
    `, [req.params.id, req.params.id, VERSIONS_TO_KEEP]);
  }
  res.json({ ok: true, version: nextVersion });
});

// Lightweight list — no `data` (could be large) — newest first. displayNumber is a clean
// 1/2/3 label independent of the real `version` column, which is shared with the runsheet's
// own optimistic-concurrency counter and increments on every save including silent auto-
// saves — that makes it skip numbers whenever an auto-save happened between two explicit
// saves, which reads as broken even though it isn't. displayNumber instead just counts
// position among whatever's currently kept (oldest of the 3 = 1, newest = 3), recomputed
// fresh each time this list is fetched rather than stored anywhere.
app.get('/api/runsheets/:id/versions', requireAnyModule('builder', 'history'), async (req, res) => {
  const rows = await q(
    'SELECT id, version, saved_by, saved_at FROM runsheet_versions WHERE runsheet_id=? ORDER BY id DESC', [req.params.id]
  );
  const withDisplayNumber = rows.map((r, i) => ({ ...r, displayNumber: rows.length - i }));
  res.json(withDisplayNumber);
});

// Full content of one specific past snapshot — for viewing, or loading back into the
// Builder as a starting point to restore (restoring is just loading this into the editor
// and saving normally; there's no separate destructive "restore" action on the server).
app.get('/api/runsheets/:id/versions/:versionId', requireAnyModule('builder', 'history'), async (req, res) => {
  const row = await one('SELECT * FROM runsheet_versions WHERE id=? AND runsheet_id=?', [req.params.versionId, req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

// =====================================================================
// PHOTO EXTRACTION — calls the Anthropic API with the tuned system prompt (verbatim)
// =====================================================================
app.post('/api/extract-photo', requireModule('builder'), upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });

    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        // Pages with many line items need one serial_scan entry per row plus a
        // round_items array — raised from 2000 so long pages don't get cut off mid-JSON.
        max_tokens: 8000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: 'Extract this sales order per the rules.' },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Anthropic API error: ${response.status} ${errText}` });
    }
    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No text content in API response' });

    if (data.stop_reason === 'max_tokens') {
      console.error('[extract-photo] response truncated at max_tokens for a page with many line items. Raw text:\n', textBlock.text);
      return res.status(502).json({ error: 'The model\'s response was cut off before it finished (this page likely has an unusually large number of line items). Try again — if it keeps happening, this needs a higher max_tokens on the server.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
    } catch (e1) {
      // salvage attempt: the model may have added stray text around the JSON object
      const match = textBlock.text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (e2) { /* fall through to error below */ }
      }
      if (!parsed) {
        console.error('[extract-photo] could not parse model output as JSON. Raw text:\n', textBlock.text);
        return res.status(502).json({ error: 'Model did not return valid JSON', raw: textBlock.text });
      }
    }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The schema (CREATE TABLE IF NOT EXISTS + column migrations) is applied before the server
// starts accepting requests, so a request can never race the tables into existence. If the
// database can't be reached at all, exit with a clear message rather than serving 500s.
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Sri Ambikas Runsheet Tool running at http://localhost:${PORT}`);
    console.log(`Other machines on the same network: http://<this-PC's-LAN-IP>:${PORT}`);
  });
}).catch(e => {
  console.error('[db] Could not initialise the database:', e.message);
  process.exit(1);
});
