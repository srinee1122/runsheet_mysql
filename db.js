// db.js — MySQL storage via mysql2, replacing the earlier SQLite-in-a-file approach.
//
// Why the switch: GoDaddy Node.js Hosting runs the app in a container whose filesystem
// does NOT reliably persist writes — a runsheet saved successfully could vanish minutes
// later once the container was recycled, and the file GoDaddy's File Manager showed was
// byte-for-byte the copy deployed from git, untouched by any save since. That isn't
// something a code fix on the SQLite side can address; the platform simply doesn't keep
// files written at runtime. What it does provide is a managed MySQL database attached to
// every published app, with DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD injected
// automatically into the environment (shared between Preview and Published). This module
// talks to that.
//
// Every query helper here is async. The old node:sqlite API was synchronous, so every
// route handler in server.js and the user lookup in auth.js became async as part of this
// change — that's the bulk of the diff, and it's mechanical.
'use strict';
const mysql = require('mysql2/promise');

const REQUIRED = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  // Fail loudly at startup rather than letting the first request produce a confusing
  // connection error. On GoDaddy these are set automatically once a hosted database is
  // attached to the app; locally, put them in start-server.bat (see DEPLOYMENT.md).
  console.error(`[db] Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('[db] On GoDaddy: attach the hosted MySQL database to the app (Settings > Hosted Database).');
  console.error('[db] Locally: run a MySQL server and set these in start-server.bat before npm start.');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  // DATETIME columns come back as plain 'YYYY-MM-DD HH:MM:SS' strings rather than JS Date
  // objects. That is exactly the format the old SQLite datetime('now') produced and exactly
  // what the frontend's formatDate.js already parses as UTC — so no frontend change was
  // needed for timestamps. All timestamps are written with UTC_TIMESTAMP() for the same
  // reason: the stored value is always UTC regardless of the database server's own zone.
  dateStrings: true,
  charset: 'utf8mb4',
});

// ---- tiny helpers so route code reads cleanly ----
// q(): all rows.  one(): first row or undefined.  run(): the result object, of which
// insertId and affectedRows are the parts route code actually uses.
async function q(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; }
async function one(sql, params = []) { const rows = await q(sql, params); return rows[0]; }
async function run(sql, params = []) { const [result] = await pool.query(sql, params); return result; }

// mysql2 surfaces a UNIQUE violation as error code ER_DUP_ENTRY (errno 1062). The old
// SQLite code matched on the string 'UNIQUE' in the message; route handlers use this now.
function isDuplicate(e) { return e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062); }

// ---- schema ----
// Table definitions and column migrations live in schema.js, shared with the SQLite->MySQL
// export script so the one-time import file and the running app can never disagree.
const { SCHEMA, MIGRATIONS } = require('./schema');

// ---- migrations: add columns to tables that already exist without them ----
// Same idea as before — ALTER TABLE ADD COLUMN, never destructive — but MySQL has no
// PRAGMA table_info, so existing columns are read from INFORMATION_SCHEMA instead.
async function ensureColumns(table, columns) {
  const rows = await q(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  const existing = new Set(rows.map(r => r.COLUMN_NAME));
  for (const [name, def] of Object.entries(columns)) {
    if (!existing.has(name)) await run(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${def}`);
  }
}

async function migrate() {
  for (const [table, columns] of Object.entries(MIGRATIONS)) await ensureColumns(table, columns);
  await backfillStatusAndInvoices();
  await defaultActionPermissions();
  await staffFromOldNameList();
}

// One-time: the old flat staff-name list (settings key 'clerks') becomes rows in the staff
// table, each with every role ticked so they keep appearing in every dropdown until someone
// sets their real roles in Settings. The old list itself is left untouched.
const STAFF_FLAG = 'migration_staff_v1';
async function staffFromOldNameList() {
  const done = await one('SELECT value FROM settings WHERE `key` = ?', [STAFF_FLAG]);
  if (done) return;
  const names = await getSetting('clerks', []);
  let n = 0;
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim().slice(0, 120);
    if (!name) continue;
    const r = await run('INSERT IGNORE INTO staff (name, is_driver, is_del_man, is_puller, is_crew) VALUES (?, 1, 1, 1, 1)', [name]);
    n += r.affectedRows;
  }
  await run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [STAFF_FLAG, JSON.stringify({ at: new Date().toISOString(), moved: n })]);
  console.log(`[db] Moved ${n} name(s) from the old staff list into Staff (one-time)`);
}

// One-time: when action permissions are introduced, people who could already use the
// Builder keep being able to prepare their runsheets and add remarks -- the same things
// they could do before actions existed. Everything else is left for the super user to
// grant. Runs once, recorded by a settings flag, so later changes are never overridden.
const PERMS_FLAG = 'migration_perms_v1';
async function defaultActionPermissions() {
  const done = await one('SELECT value FROM settings WHERE `key` = ?', [PERMS_FLAG]);
  if (done) return;
  const r = await run('UPDATE users SET act_prepare = 1, act_remarks = 1 WHERE module_builder = 1');
  await run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [PERMS_FLAG, JSON.stringify({ at: new Date().toISOString(), users: r.affectedRows })]);
  console.log(`[db] Gave Prepare + Remarks to ${r.affectedRows} existing Builder user(s) (one-time)`);
}

// One-time backfill when the status column is first introduced: runsheets that already
// have a sheet number become 'prepared', those without become 'draft' (the draft rule),
// and the invoice index is built from each runsheet's data JSON.
//
// Runs exactly ONCE, recorded by a flag in the settings table. An earlier version decided
// what still needed backfilling by looking for runsheets missing from the invoice index --
// so a runsheet created later with a sheet number but no invoice numbers yet was quietly
// promoted to Prepared on the next server restart, skipping the promotion checks. After
// this has run once, statuses change only through the status endpoint and the index only
// through saves.
const BACKFILL_FLAG = 'migration_status_v1';
async function backfillStatusAndInvoices() {
  const done = await one('SELECT value FROM settings WHERE `key` = ?', [BACKFILL_FLAG]);
  if (done) return;
  const rows = await q('SELECT id, sheet_no, data FROM runsheets');
  for (const r of rows) {
    let stops = [];
    try { stops = (JSON.parse(r.data || '{}').stops) || []; } catch { stops = []; }
    const invoices = [...new Set(stops.map(s => String(s.invoice_no || '').trim()).filter(Boolean))];
    for (const inv of invoices) await run('INSERT IGNORE INTO runsheet_invoices (runsheet_id, invoice_no) VALUES (?, ?)', [r.id, inv]);
    if (String(r.sheet_no || '').trim()) await run("UPDATE runsheets SET status = 'prepared' WHERE id = ? AND status = 'draft'", [r.id]);
  }
  await run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [BACKFILL_FLAG, JSON.stringify({ at: new Date().toISOString(), runsheets: rows.length })]);
  console.log(`[db] Backfilled status/invoice index for ${rows.length} runsheet(s) (one-time)`);
}

// ---- settings helpers ----
async function getSetting(key, fallback) {
  const row = await one('SELECT value FROM settings WHERE `key` = ?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

async function setSetting(key, value) {
  const json = JSON.stringify(value);
  await run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, json]);
}

// ---- startup ----
// server.js awaits this before listening, so no request can arrive before the schema
// exists. Safe to run on every boot: CREATE TABLE IF NOT EXISTS and the column checks
// are all no-ops once they've been applied.
async function init() {
  for (const ddl of SCHEMA) await run(ddl);
  await migrate();
  const { n } = await one('SELECT COUNT(*) AS n FROM settings');
  if (Number(n) === 0) await setSetting('frequent_columns', []);
  const v = await one('SELECT VERSION() AS v');
  console.log(`[db] Connected to MySQL ${v.v} at ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
}

// The five sidebar pages that can be individually granted — kept in one place so the
// server's user-permission validation and the bootstrap logic can't drift from what the
// frontend actually gates.
const MODULES = ['builder', 'history', 'status', 'products', 'customers', 'settings'];

// Actions a person can be allowed to take, each its own column act_<name> on users:
//   prepare    Draft -> Prepared -> Pending Delivery
//   handover   record handover details (time in/out, puller, crew, driver...) and mark Out
//   deliver    record the delivery outcome: Out -> Partial / Full Delivery
//   move_back  move a runsheet back to an earlier status, or cancel it (reason required)
//   remarks    add remarks to a runsheet
//   view_log   read a runsheet's activity log
const ACTIONS = ['prepare', 'handover', 'deliver', 'move_back', 'remarks', 'view_log'];

module.exports = { pool, q, one, run, isDuplicate, getSetting, setSetting, init, MODULES, ACTIONS };
