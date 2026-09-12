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
  },
};

module.exports = { SCHEMA, MIGRATIONS };
