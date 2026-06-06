import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Node 24 내장 SQLite(node:sqlite) 사용 — 네이티브 빌드 불필요.
const db = new DatabaseSync(path.join(DATA_DIR, 'app.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS credentials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  login_id   TEXT NOT NULL,
  pw_enc     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  region_code     TEXT,
  region_name     TEXT,
  institt_id      TEXT,
  institt_name    TEXT,
  begin_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  nights          INTEGER NOT NULL DEFAULT 1,
  people          INTEGER NOT NULL DEFAULT 2,
  house_camp      TEXT NOT NULL DEFAULT '01',
  keyword         TEXT,
  interval_min    INTEGER NOT NULL DEFAULT 5,
  enabled         INTEGER NOT NULL DEFAULT 1,
  auto_book       INTEGER NOT NULL DEFAULT 0,
  credential_id   INTEGER,
  status          TEXT NOT NULL DEFAULT 'idle',
  last_run        TEXT,
  last_found      INTEGER NOT NULL DEFAULT 0,
  last_count      INTEGER NOT NULL DEFAULT 0,
  last_message    TEXT,
  last_results    TEXT,
  notified_sig    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  level     TEXT NOT NULL DEFAULT 'info',
  found     INTEGER NOT NULL DEFAULT 0,
  count     INTEGER NOT NULL DEFAULT 0,
  message   TEXT,
  payload   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id DESC);
`);

export default db;

// ---------- credentials ----------
export const credsRepo = {
  list: () =>
    db.prepare('SELECT id, label, login_id, created_at FROM credentials ORDER BY id DESC').all(),
  get: (id) => db.prepare('SELECT * FROM credentials WHERE id = ?').get(id),
  create: ({ label, login_id, pw_enc }) =>
    Number(
      db
        .prepare('INSERT INTO credentials (label, login_id, pw_enc) VALUES (?, ?, ?)')
        .run(label, login_id, pw_enc).lastInsertRowid,
    ),
  remove: (id) => db.prepare('DELETE FROM credentials WHERE id = ?').run(id),
};

// ---------- jobs ----------
const JOB_FIELDS = [
  'name', 'region_code', 'region_name', 'institt_id', 'institt_name',
  'begin_date', 'end_date', 'nights', 'people', 'house_camp', 'keyword',
  'interval_min', 'enabled', 'auto_book', 'credential_id',
];

export const jobsRepo = {
  list: () => db.prepare('SELECT * FROM jobs ORDER BY id DESC').all(),
  get: (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
  create: (data) => {
    const cols = JOB_FIELDS.join(', ');
    const placeholders = JOB_FIELDS.map(() => '?').join(', ');
    const values = JOB_FIELDS.map((f) => normalize(data[f]));
    return Number(
      db.prepare(`INSERT INTO jobs (${cols}) VALUES (${placeholders})`).run(...values)
        .lastInsertRowid,
    );
  },
  update: (id, data) => {
    const fields = JOB_FIELDS.filter((f) => f in data);
    if (!fields.length) return;
    const set = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => normalize(data[f]));
    db.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(...values, id);
  },
  setRuntime: (id, r) => {
    db.prepare(
      `UPDATE jobs SET
         status       = COALESCE(?, status),
         last_run     = datetime('now'),
         last_found   = COALESCE(?, last_found),
         last_count   = COALESCE(?, last_count),
         last_message = COALESCE(?, last_message),
         last_results = COALESCE(?, last_results),
         notified_sig = COALESCE(?, notified_sig)
       WHERE id = ?`,
    ).run(
      r.status ?? null,
      r.last_found ?? null,
      r.last_count ?? null,
      r.last_message ?? null,
      r.last_results ?? null,
      r.notified_sig ?? null,
      id,
    );
  },
  setEnabled: (id, enabled) =>
    db.prepare('UPDATE jobs SET enabled = ?, status = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      enabled ? 'idle' : 'stopped',
      id,
    ),
  remove: (id) => db.prepare('DELETE FROM jobs WHERE id = ?').run(id),
};

// ---------- events ----------
export const eventsRepo = {
  add: ({ job_id, level = 'info', found = 0, count = 0, message = '', payload = null }) =>
    Number(
      db
        .prepare(
          'INSERT INTO events (job_id, level, found, count, message, payload) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(job_id, level, found ? 1 : 0, count, message, payload ? JSON.stringify(payload) : null)
        .lastInsertRowid,
    ),
  listByJob: (job_id, limit = 50) =>
    db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(job_id, limit),
  recent: (limit = 100) => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit),
  prune: (keepPerJob = 200) => {
    db.exec(`
      DELETE FROM events WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) rn FROM events
        ) WHERE rn > ${keepPerJob}
      )`);
  },
};

// node:sqlite 는 boolean/undefined 를 직접 바인딩하지 못하므로 정규화
function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
