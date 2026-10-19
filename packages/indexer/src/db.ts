import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  base_symbol TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  base_decimals INTEGER NOT NULL,
  quote_decimals INTEGER NOT NULL,
  listed_block INTEGER NOT NULL,
  listed_ts INTEGER NOT NULL,
  UNIQUE (base, quote)
);

CREATE TABLE IF NOT EXISTS vaults (
  address TEXT PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  owner TEXT NOT NULL,
  quoter TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  created_ts INTEGER NOT NULL,
  listed INTEGER NOT NULL DEFAULT 1
);

-- Periodic snapshots of every listed vault's quote and real inventory.
CREATE TABLE IF NOT EXISTS quotes_sampled (
  ts INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  bid_px TEXT NOT NULL,
  ask_px TEXT NOT NULL,
  bid_size TEXT NOT NULL,
  ask_size TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  live INTEGER NOT NULL,
  free_base TEXT NOT NULL,
  free_quote TEXT NOT NULL,
  PRIMARY KEY (vault, ts)
);
CREATE INDEX IF NOT EXISTS quotes_sampled_market_ts ON quotes_sampled (market_id, ts);

-- setQuote counts per vault per hour (the raw QuoteSet stream is too hot to keep row by row).
CREATE TABLE IF NOT EXISTS quote_updates (
  vault TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (vault, hour)
);

CREATE TABLE IF NOT EXISTS probes (
  campaign_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  prober TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  checked INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  fee TEXT NOT NULL,
  ref_px TEXT NOT NULL,
  gas_used INTEGER,
  gas_price TEXT,
  PRIMARY KEY (campaign_id, nonce)
);
CREATE INDEX IF NOT EXISTS probes_ts ON probes (ts);

CREATE TABLE IF NOT EXISTS probe_results (
  campaign_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  vault TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  fail_mask INTEGER NOT NULL,
  spread_bps INTEGER NOT NULL,
  bid_px TEXT NOT NULL,
  ask_px TEXT NOT NULL,
  bid_size TEXT NOT NULL,
  ask_size TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, nonce, vault)
);
CREATE INDEX IF NOT EXISTS probe_results_vault_ts ON probe_results (vault, ts);

CREATE TABLE IF NOT EXISTS fills (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  taker TEXT NOT NULL,
  recipient TEXT NOT NULL,
  buying_base INTEGER NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  px TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fills_market_ts ON fills (market_id, ts);

CREATE TABLE IF NOT EXISTS failed_fills (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  taker TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  status INTEGER NOT NULL,
  selector TEXT NOT NULL,
  penalized INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL,
  creator TEXT NOT NULL,
  reward_token TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  num_epochs INTEGER NOT NULL,
  epoch_length INTEGER NOT NULL,
  reward_per_epoch TEXT NOT NULL,
  max_spread_bps INTEGER NOT NULL,
  min_depth_base TEXT NOT NULL,
  min_depth_quote TEXT NOT NULL,
  min_probe_interval INTEGER NOT NULL,
  probe_fee_bps INTEGER NOT NULL,
  maker_bond TEXT NOT NULL,
  reference_price TEXT NOT NULL,
  opened_block INTEGER NOT NULL,
  opened_ts INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  settled_epochs INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS epochs (
  campaign_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  probes INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  maker_pot TEXT,
  refunded TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  settled_tx TEXT,
  settled_ts INTEGER,
  PRIMARY KEY (campaign_id, epoch)
);

CREATE TABLE IF NOT EXISTS maker_scores (
  campaign_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  vault TEXT NOT NULL,
  maker TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  reward TEXT,
  PRIMARY KEY (campaign_id, epoch, vault)
);

CREATE TABLE IF NOT EXISTS registrations (
  campaign_id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  maker TEXT NOT NULL,
  bond TEXT NOT NULL,
  status TEXT NOT NULL,
  registered_ts INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, vault)
);

CREATE TABLE IF NOT EXISTS penalties (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  reporter TEXT NOT NULL,
  slashed TEXT NOT NULL,
  to_reporter TEXT NOT NULL,
  to_makers TEXT NOT NULL,
  forfeited INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- Sampled receipts for gas accounting of non-probe transactions (e.g. setQuote).
CREATE TABLE IF NOT EXISTS gas_samples (
  tx_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  gas_used INTEGER NOT NULL,
  gas_price TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string | number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value),
  );
}

/** Add two decimal-string integers. */
export function addStr(a: string | null | undefined, b: bigint | string): string {
  return (BigInt(a ?? "0") + BigInt(b)).toString();
}
