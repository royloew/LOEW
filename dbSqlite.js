import sqlite3 from "sqlite3";

sqlite3.verbose();

const DB_FILE = process.env.LOEW_DB_FILE || "/tmp/loew.db";

console.log("[DB] Trying to open SQLite file at:", DB_FILE);

const db = new sqlite3.Database(
  DB_FILE,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("[DB] Failed to open DB:", err);
    } else {
      console.log("[DB] SQLite DB opened OK.");
    }
  }
);

// ---------- Promise helpers ----------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// ================================================================
// 📌 פונקציה גנרית לניקוי ספייקים (robust outliers)
// ================================================================
function filterOutliersRobust(values, options = {}) {
  const {
    minValue = null,
    maxValue = null,
    maxZ = 3.5,
    minCountForStats = 8,
  } = options;

  let arr = values
    .filter((v) => Number.isFinite(v))
    .map((v) => Number(v));

  if (minValue != null) arr = arr.filter((v) => v >= minValue);
  if (maxValue != null) arr = arr.filter((v) => v <= maxValue);

  if (arr.length === 0) return [];

  if (arr.length < minCountForStats) {
    return arr;
  }

  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const midDev = Math.floor(absDevs.length / 2);
  const mad =
    absDevs.length % 2 === 0
      ? (absDevs[midDev - 1] + absDevs[midDev]) / 2
      : absDevs[midDev];

  if (mad === 0) return arr;

  const filtered = arr.filter((v) => {
    const z = (0.6745 * Math.abs(v - median)) / mad;
    return z <= maxZ;
  });

  return filtered;
}

// ================================================================
// DB init & schema
// ================================================================
async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY,
      json       TEXT,
      created_at INTEGER
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS training_params (
      user_id          TEXT PRIMARY KEY,
      ftp              INTEGER,
      ftp20            INTEGER,
      ftp_from_3min    INTEGER,
      ftp_from_cp      INTEGER,
      ftp_recommended  INTEGER,
      hr_max           INTEGER,
      hr_threshold     INTEGER,
      created_at       INTEGER,
      updated_at       INTEGER
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id    TEXT PRIMARY KEY,
      stage      TEXT,
      data_json  TEXT,
      updated_at INTEGER
    );
  `);

  try { await run(`ALTER TABLE training_params ADD COLUMN ftp20 INTEGER;`);} catch(_){}
  try { await run(`ALTER TABLE training_params ADD COLUMN ftp_from_3min INTEGER;`);} catch(_){}
  try { await run(`ALTER TABLE training_params ADD COLUMN ftp_from_cp INTEGER;`);} catch(_){}
  try { await run(`ALTER TABLE training_params ADD COLUMN ftp_recommended INTEGER;`);} catch(_){}

  await run(`
    CREATE TABLE IF NOT EXISTS strava_tokens (
      user_id       TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS strava_athlete (
      user_id    TEXT PRIMARY KEY,
      weight_kg  REAL,
      updated_at INTEGER
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS strava_activities (
      id                     INTEGER PRIMARY KEY,
      user_id                TEXT,
      start_date             INTEGER,
      moving_time            INTEGER,
      elapsed_time           INTEGER,
      distance               REAL,
      total_elevation_gain   REAL,
      avg_power              REAL,
      max_power              REAL,
      avg_hr                 REAL,
      max_hr                 REAL,
      has_power              INTEGER,
      type                   TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      user_id     TEXT,
      activity_id INTEGER,
      stream_type TEXT,
      data        TEXT,
      PRIMARY KEY (user_id, activity_id, stream_type)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS power_curves (
      user_id    TEXT,
      window_sec INTEGER,
      best_power REAL,
      updated_at INTEGER,
      PRIMARY KEY (user_id, window_sec)
    );
  `);
}

// ================================================================
// JSON helper
// ================================================================
function parseJsonArray(text) {
  if (!text) return null;
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

// ================================================================
// Main DB API
// =========================================
