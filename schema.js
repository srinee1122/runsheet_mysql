// schema.js — the MySQL table definitions and column migrations, in one place.
//
// Shared by db.js (which applies them on every boot) and by scripts/export-sqlite-to-mysql.js
// (which emits them into the one-time .sql import file), so the dump a person uploads through
// GoDaddy's Import SQL can never disagree with what the running app expects.
'use strict';

// Notes on the translation from the previous SQLite schema:
//   INTEGER PRIMARY KEY AUTOINCREMENT  ->  INT AUTO_INCREMENT PRIMARY KEY
//   TEXT DEFAULT ''                    ->  VARCHAR(255) DEFAULT ''   (MySQL TEXT can't have a DEFAULT)
//   TEXT (JSON blob)                   ->  LONGTEXT
//   REAL                               ->  DOUBLE
//   INTEGER used as a flag             ->  TINYINT(1)
//   datetime('now')                    ->  CURRENT_TIMESTAMP / UTC_TIMESTAMP()
//   settings.key                       ->  kept as `key`, but it's a reserved word in
//                                          MySQL so it's backticked in every query.
// The utf8mb4 default collation is case-insensitive, which also makes the UNIQUE(name)
// constraints on products/customers case-insensitive (SQLite's were not). Checked before
// migrating: the existing data has no two names differing only by case, so nothing
// collides, and it's arguably the better behaviour going forward.
const SCHEMA = [
`CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  qty_per_ctn DOUBLE NOT NULL DEFAULT 1,
  is_round_item TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  area VARCHAR(255) DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(191) PRIMARY KEY,
  value LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS runsheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sheet_no VARCHAR(255) NOT NULL DEFAULT '',
  area VARCHAR(255) DEFAULT '',
  delivery_man VARCHAR(255) DEFAULT '',
  vehicle_no VARCHAR(255) DEFAULT '',
  run_date VARCHAR(64) DEFAULT '',
  delivery_date VARCHAR(64) DEFAULT '',
  created_by VARCHAR(255) DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// A snapshot of a runsheet's full state, taken right after an EXPLICIT save (the Save
// button, or Print, which saves first) applies. Never on auto-save. Capped at the 3 most
// recent per runsheet — see the pruning DELETE in server.js's PUT handler.
`CREATE TABLE IF NOT EXISTS runsheet_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  runsheet_id INT NOT NULL,
  version INT NOT NULL,
  sheet_no VARCHAR(255) DEFAULT '',
  area VARCHAR(255) DEFAULT '',
  delivery_man VARCHAR(255) DEFAULT '',
  vehicle_no VARCHAR(255) DEFAULT '',
  run_date VARCHAR(64) DEFAULT '',
  delivery_date VARCHAR(64) DEFAULT '',
  data LONGTEXT NOT NULL,
  saved_by VARCHAR(255) DEFAULT '',
  saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rv_runsheet (runsheet_id),
  CONSTRAINT fk_rv_runsheet FOREIGN KEY (runsheet_id) REFERENCES runsheets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// Identity comes from Firebase; permissions are entirely local to this app. The very
// first person ever to log in is auto-promoted to admin (see auth.js) so there's always
// a way in; everyone after that starts with no access until an admin grants it.
`CREATE TABLE IF NOT EXISTS users (
  uid VARCHAR(191) PRIMARY KEY,
  email VARCHAR(255) DEFAULT '',
  display_name VARCHAR(255) DEFAULT '',
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  module_builder TINYINT(1) NOT NULL DEFAULT 0,
  module_history TINYINT(1) NOT NULL DEFAULT 0,
  module_products TINYINT(1) NOT NULL DEFAULT 0,
  module_customers TINYINT(1) NOT NULL DEFAULT 0,
  module_settings TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at VARCHAR(40) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// Every invoice number on every runsheet, one row each, kept in step with the runsheet's
// data JSON on every save. Exists so the invoice-uniqueness rule can be checked with a
// simple indexed lookup instead of scanning every runsheet's JSON.
`CREATE TABLE IF NOT EXISTS runsheet_invoices (
  runsheet_id INT NOT NULL,
  invoice_no VARCHAR(64) NOT NULL,
  PRIMARY KEY (runsheet_id, invoice_no),
  INDEX idx_ri_invoice (invoice_no),
  CONSTRAINT fk_ri_runsheet FOREIGN KEY (runsheet_id) REFERENCES runsheets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// The activity log: one row per thing that happened to a runsheet -- status changes (with
// from/to), cancellations and backward moves (with their reason), remarks, and later
// prints, flags, amendments, handovers and delivery outcomes. Append-only: rows are never
// updated or deleted. Unlike runsheet_versions this is never pruned.
`CREATE TABLE IF NOT EXISTS runsheet_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  runsheet_id INT NOT NULL,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_uid VARCHAR(191) DEFAULT '',
  actor_name VARCHAR(255) DEFAULT '',
  type VARCHAR(32) NOT NULL,
  from_status VARCHAR(32) DEFAULT '',
  to_status VARCHAR(32) DEFAULT '',
  reason VARCHAR(512) DEFAULT '',
  note TEXT,
  INDEX idx_re_runsheet (runsheet_id, id),
  CONSTRAINT fk_re_runsheet FOREIGN KEY (runsheet_id) REFERENCES runsheets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// Delivery companies: who takes a runsheet out, and so who we pay. In-house teams cost
// nothing; third-party ones will carry their carton and bag rates here (delivery costing).
// Archived companies (active = 0) stop being offered but stay for history.
`CREATE TABLE IF NOT EXISTS delivery_companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  kind VARCHAR(16) NOT NULL DEFAULT 'thirdparty',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// Staff offered on the Status board's handover dropdowns, each with the roles they fill
// (a person can have several) and optionally their company -- picking a driver at handover
// fills in the runsheet's delivery company from here.
`CREATE TABLE IF NOT EXISTS staff (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  company_id INT NULL,
  is_driver TINYINT(1) NOT NULL DEFAULT 0,
  is_del_man TINYINT(1) NOT NULL DEFAULT 0,
  is_puller TINYINT(1) NOT NULL DEFAULT 0,
  is_crew TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_staff_company (company_id),
  CONSTRAINT fk_staff_company FOREIGN KEY (company_id) REFERENCES delivery_companies(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

// Throwaway table used only by the admin diagnostics endpoint's write-and-read-back check.
`CREATE TABLE IF NOT EXISTS _diag (
  k VARCHAR(64) PRIMARY KEY,
  v VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// ---- column migrations: added to tables that already exist without them ----
// Applied with ALTER TABLE ADD COLUMN, never destructive. In the export script these are
// emitted unconditionally right after each CREATE TABLE, since a freshly imported database
// has none of them yet.
const MIGRATIONS = {
  products: {
    code: "VARCHAR(255) DEFAULT ''",
    supplier: "VARCHAR(255) DEFAULT ''",
    brand: "VARCHAR(255) DEFAULT ''",
    category: "VARCHAR(255) DEFAULT ''",
    sub_category: "VARCHAR(255) DEFAULT ''",
    sub_category_2: "VARCHAR(255) DEFAULT ''",
    base_unit: "VARCHAR(64) DEFAULT ''",
    group_name: "VARCHAR(255) DEFAULT ''",
    item_type: "VARCHAR(255) DEFAULT ''",
    selling_rate: 'DOUBLE DEFAULT 0',
    // 'carton' or 'bag' — a billing classification (3rd-party delivery vendors charge
    // differently for each); never affects the carton-count math elsewhere in the app.
    packing_type: "VARCHAR(16) DEFAULT 'carton'",
    // 'CTN' or 'PCS' — how this product's round-item quantity is normally entered.
    entry_unit: "VARCHAR(8) DEFAULT 'CTN'",
  },
  customers: {
    code: "VARCHAR(255) DEFAULT ''",
    segment: "VARCHAR(255) DEFAULT ''",
    contact: "VARCHAR(255) DEFAULT ''",
    chain_store: "VARCHAR(255) DEFAULT ''",
    address: "VARCHAR(512) DEFAULT ''",
    postal_code: "VARCHAR(32) DEFAULT ''",
    mobile: "VARCHAR(64) DEFAULT ''",
    whatsapp: "VARCHAR(64) DEFAULT ''",
    roc_no: "VARCHAR(64) DEFAULT ''",
    modified_source: "VARCHAR(64) DEFAULT ''",
  },
  runsheets: {
    // optimistic-concurrency guard: incremented on every save; a PUT that doesn't match
    // the version it was loaded with means someone else saved in between.
    version: 'INT NOT NULL DEFAULT 1',
    // Lifecycle: draft | prepared | pending | out | partial | delivered | cancelled.
    // 'draft' means no sheet number yet. See STATUS in server.js for the transition rules.
    status: "VARCHAR(16) NOT NULL DEFAULT 'draft'",
    // The runsheet's DISPATCH half, kept apart from its contents (the data column): the
    // actual delivery man and vehicle (planned ones stay in delivery_man / vehicle_no),
    // driver, puller(s), loading crew, time in (vehicle arrived to load) and time out.
    // Edited from the Status board by people with the Hand over permission. Stored
    // separately so reception updating it never collides with office editing contents.
    dispatch: 'LONGTEXT NULL',
  },
  users: {
    // Above admin: the only role that can edit a runsheet's contents once it is locked
    // (Out for Delivery onwards) or grant super-user to someone else. The bootstrap admin
    // email gets it automatically on login.
    is_super: 'TINYINT(1) NOT NULL DEFAULT 0',
    // Status board page (see MODULES in db.js).
    module_status: 'TINYINT(1) NOT NULL DEFAULT 0',
    // Actions, granted per person by the super user (see ACTIONS in db.js). An admin has
    // every page and action; a super user additionally manages permissions and can edit
    // locked runsheets.
    act_prepare: 'TINYINT(1) NOT NULL DEFAULT 0',
    act_handover: 'TINYINT(1) NOT NULL DEFAULT 0',
    act_deliver: 'TINYINT(1) NOT NULL DEFAULT 0',
    act_move_back: 'TINYINT(1) NOT NULL DEFAULT 0',
    act_remarks: 'TINYINT(1) NOT NULL DEFAULT 0',
    act_view_log: 'TINYINT(1) NOT NULL DEFAULT 0',
  },
};

module.exports = { SCHEMA, MIGRATIONS };
