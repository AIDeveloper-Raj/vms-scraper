// ─────────────────────────────────────────────────────────────────────────────
// db/database.ts — SQLite persistence
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

const DB_DIR = path.resolve(process.env['OUTPUT_DIR'] ?? './output');
const DB_PATH = path.join(DB_DIR, 'scraper.db');

fs.mkdirSync(DB_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  logger.debug(`[DB] Connected: ${DB_PATH}`);
  return _db;
}

// ── Schema ────────────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account      TEXT    NOT NULL,
      vms_type     TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'running',
      started_at   TEXT    NOT NULL,
      finished_at  TEXT,
      total        INTEGER DEFAULT 0,
      passed       INTEGER DEFAULT 0,
      failed       INTEGER DEFAULT 0,
      duration_ms  INTEGER,
      error        TEXT
    );

    CREATE TABLE IF NOT EXISTS records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      account      TEXT    NOT NULL DEFAULT '',
      ts_id        TEXT    NOT NULL,
      employee     TEXT,
      period_start TEXT,
      period_end   TEXT,
      status       TEXT,
      client       TEXT,
      total_hours  REAL,
      reg_hours    REAL,
      ot_hours     REAL,
      dt_hours     REAL,
      confidence   REAL,
      fallback     TEXT,
      flag         TEXT    DEFAULT 'new',
      scraped_at   TEXT,
      json_path    TEXT,
      screenshot_path TEXT
    );

    CREATE TABLE IF NOT EXISTS fingerprints (
      ts_id        TEXT    NOT NULL,
      account      TEXT    NOT NULL,
      status       TEXT,
      st_hours     REAL,
      ot_hours     REAL,
      dt_hours     REAL,
      last_seen    TEXT    NOT NULL,
      last_scraped TEXT,
      removed      INTEGER DEFAULT 0,
      PRIMARY KEY (ts_id, account)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_account    ON runs(account);
    CREATE INDEX IF NOT EXISTS idx_runs_started    ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_records_run     ON records(run_id);
    CREATE INDEX IF NOT EXISTS idx_records_ts      ON records(ts_id);
    CREATE INDEX IF NOT EXISTS idx_records_flag    ON records(flag);
    CREATE INDEX IF NOT EXISTS idx_records_account ON records(account);
    CREATE INDEX IF NOT EXISTS idx_fp_account      ON fingerprints(account);
  `);

  // ── Add new columns to existing tables (safe — ignored if already exist) ──
  const addCol = (sql: string) => { try { db.exec(sql); } catch { /* column exists */ } };
  addCol(`ALTER TABLE records ADD COLUMN account          TEXT DEFAULT ''`);
  addCol(`ALTER TABLE records ADD COLUMN flag             TEXT DEFAULT 'new'`);
  addCol(`ALTER TABLE records ADD COLUMN json_path        TEXT`);
  addCol(`ALTER TABLE records ADD COLUMN screenshot_path  TEXT`);
}

// ── Run CRUD ──────────────────────────────────────────────────────────────────

export interface RunRow {
  id: number; account: string; vms_type: string; status: string;
  started_at: string; finished_at: string | null;
  total: number; passed: number; failed: number;
  duration_ms: number | null; error: string | null;
}

export function createRun(account: string, vmsType: string): number {
  const db = getDb();
  const r = db.prepare(`INSERT INTO runs (account, vms_type, status, started_at) VALUES (?, ?, 'running', ?)`).run(account, vmsType, new Date().toISOString());
  return r.lastInsertRowid as number;
}

export function updateRun(runId: number, status: 'completed' | 'failed', counts: { total: number; passed: number; failed: number }, error?: string): void {
  const db = getDb();
  const run = db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  const dur = run ? Date.now() - new Date(run.started_at).getTime() : null;
  db.prepare(`UPDATE runs SET status=?,finished_at=?,total=?,passed=?,failed=?,duration_ms=?,error=? WHERE id=?`)
    .run(status, new Date().toISOString(), counts.total, counts.passed, counts.failed, dur, error ?? null, runId);
}

export function getRuns(account?: string, limit = 100): RunRow[] {
  const db = getDb();
  if (account) return db.prepare('SELECT * FROM runs WHERE account=? ORDER BY started_at DESC LIMIT ?').all(account, limit) as RunRow[];
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export function getLastRun(account: string): RunRow | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE account=? AND status!='running' ORDER BY started_at DESC LIMIT 1`).get(account) as RunRow | undefined;
}

export function getRunningRun(account: string): RunRow | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE account=? AND status='running' ORDER BY started_at DESC LIMIT 1`).get(account) as RunRow | undefined;
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface RecordRow {
  ts_id: string; employee: string; period_start: string; period_end: string;
  status: string; client: string; total_hours: number; reg_hours: number;
  ot_hours: number; dt_hours: number; confidence: number; fallback: string;
  flag?: string; scraped_at: string; json_path?: string; screenshot_path?: string;
}

export function insertRecord(runId: number, account: string, data: RecordRow): void {
  getDb().prepare(`
    INSERT INTO records
      (run_id, account, ts_id, employee, period_start, period_end, status, client,
       total_hours, reg_hours, ot_hours, dt_hours, confidence, fallback, flag,
       scraped_at, json_path, screenshot_path)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(runId, account, data.ts_id, data.employee, data.period_start, data.period_end,
    data.status, data.client, data.total_hours, data.reg_hours, data.ot_hours,
    data.dt_hours, data.confidence, data.fallback, data.flag ?? 'new',
    data.scraped_at, data.json_path ?? null, data.screenshot_path ?? null);
}

export interface RecordFilter {
  account?: string; flag?: string; status?: string;
  search?: string; limit?: number; offset?: number;
}

export function getRecords(filter: RecordFilter = {}): { rows: RecordRow[]; total: number } {
  const db = getDb();
  const wheres: string[] = [];
  const params: unknown[] = [];

  if (filter.account) { wheres.push('r.account = ?'); params.push(filter.account); }
  if (filter.flag) { wheres.push('r.flag = ?'); params.push(filter.flag); }
  if (filter.status) { wheres.push('r.status = ?'); params.push(filter.status); }
  if (filter.search) {
    wheres.push('(r.employee LIKE ? OR r.ts_id LIKE ? OR r.client LIKE ?)');
    const s = `%${filter.search}%`;
    params.push(s, s, s);
  }

  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  // Latest record per ts_id
  const base = `
    FROM records r
    INNER JOIN (
      SELECT ts_id, account, MAX(scraped_at) AS max_scraped
      FROM records GROUP BY ts_id, account
    ) latest ON r.ts_id = latest.ts_id AND r.account = latest.account
           AND r.scraped_at = latest.max_scraped
    ${where}
  `;

  const total = (db.prepare(`SELECT COUNT(*) as c ${base}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT r.* ${base} ORDER BY r.scraped_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as RecordRow[];

  return { rows, total };
}

export function getRecordByTsId(tsId: string, account: string): RecordRow | undefined {
  return getDb().prepare(`
    SELECT * FROM records WHERE ts_id=? AND account=?
    ORDER BY scraped_at DESC LIMIT 1
  `).get(tsId, account) as RecordRow | undefined;
}

// ── Fingerprints ──────────────────────────────────────────────────────────────

export interface Fingerprint {
  ts_id: string; account: string; status: string;
  st_hours: number; ot_hours: number; dt_hours: number;
  last_seen: string; last_scraped: string | null; removed: number;
}

export type ChangeFlag = 'new' | 'changed' | 'unchanged' | 'removed';

export interface ChangeResult {
  tsId: string;
  flag: ChangeFlag;
  reason?: string;
}

export function getFingerprints(account: string): Map<string, Fingerprint> {
  const rows = getDb().prepare('SELECT * FROM fingerprints WHERE account=?').all(account) as Fingerprint[];
  return new Map(rows.map((r) => [r.ts_id, r]));
}

export function upsertFingerprint(fp: Omit<Fingerprint, 'removed'>): void {
  getDb().prepare(`
    INSERT INTO fingerprints (ts_id, account, status, st_hours, ot_hours, dt_hours, last_seen, last_scraped, removed)
    VALUES (?,?,?,?,?,?,?,?,0)
    ON CONFLICT(ts_id, account) DO UPDATE SET
      status=excluded.status, st_hours=excluded.st_hours,
      ot_hours=excluded.ot_hours, dt_hours=excluded.dt_hours,
      last_seen=excluded.last_seen, last_scraped=excluded.last_scraped,
      removed=0
  `).run(fp.ts_id, fp.account, fp.status, fp.st_hours, fp.ot_hours, fp.dt_hours, fp.last_seen, fp.last_scraped ?? null);
}

export function markFingerprintsRemoved(account: string, currentIds: Set<string>): string[] {
  const db = getDb();
  const all = db.prepare('SELECT ts_id FROM fingerprints WHERE account=? AND removed=0').all(account) as { ts_id: string }[];
  const gone = all.filter((r) => !currentIds.has(r.ts_id)).map((r) => r.ts_id);

  if (gone.length) {
    const placeholders = gone.map(() => '?').join(',');
    db.prepare(`UPDATE fingerprints SET removed=1, last_seen=? WHERE account=? AND ts_id IN (${placeholders})`)
      .run(new Date().toISOString(), account, ...gone);
    logger.info(`[DB] Marked ${gone.length} fingerprints as removed for ${account}`);
  }

  return gone;
}

export function markFingerprintScraped(tsId: string, account: string): void {
  getDb().prepare('UPDATE fingerprints SET last_scraped=? WHERE ts_id=? AND account=?')
    .run(new Date().toISOString(), tsId, account);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface AccountStats {
  account: string; total_runs: number; total_records: number;
  last_run_at: string | null; last_status: string | null; avg_duration: number | null;
}

export function getAccountStats(): AccountStats[] {
  return getDb().prepare(`
    SELECT r.account,
      COUNT(DISTINCT r.id) AS total_runs,
      COUNT(rc.id)         AS total_records,
      MAX(r.started_at)    AS last_run_at,
      (SELECT status FROM runs r2 WHERE r2.account=r.account ORDER BY started_at DESC LIMIT 1) AS last_status,
      AVG(r.duration_ms)   AS avg_duration
    FROM runs r LEFT JOIN records rc ON rc.run_id=r.id
    GROUP BY r.account ORDER BY r.account
  `).all() as AccountStats[];
}

export function getTodayStats(): { total: number; passed: number; failed: number } {
  const today = new Date().toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(passed),0) AS passed, COALESCE(SUM(failed),0) AS failed
    FROM runs WHERE started_at LIKE ?
  `).get(`${today}%`) as { total: number; passed: number; failed: number };
}

export function getFlagStats(account?: string): Record<string, number> {
  const db = getDb();
  const where = account ? 'WHERE account=?' : '';
  const params = account ? [account] : [];
  const rows = db.prepare(`
    SELECT flag, COUNT(*) as cnt FROM records ${where} GROUP BY flag
  `).all(...params) as { flag: string; cnt: number }[];
  return Object.fromEntries(rows.map((r) => [r.flag, r.cnt]));
}
