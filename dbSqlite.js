import sqlite3 from "sqlite3";

sqlite3.verbose();

// ברירת מחדל: /tmp/loew.db (מתאים ל-Render)
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

// עטיפות Promise נוחות
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

// ---------- Schema ----------

async function init() {
  // טבלת users בסיסית
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY,
      json       TEXT,
      created_at INTEGER
    );
  `);

  // טבלת פרמטרים לאימון
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

  // טבלת מצב אונבורדינג
  await run(`
    CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id    TEXT PRIMARY KEY,
      stage      TEXT,
      data_json  TEXT,
      updated_at INTEGER
    );
  `);

  // הרחבות אם חסר (למקרה של DB ישן יותר)
  try {
    await run(`ALTER TABLE training_params ADD COLUMN ftp20 INTEGER;`);
  } catch (_) {}
  try {
    await run(`ALTER TABLE training_params ADD COLUMN ftp_from_3min INTEGER;`);
  } catch (_) {}
  try {
    await run(`ALTER TABLE training_params ADD COLUMN ftp_from_cp INTEGER;`);
  } catch (_) {}
  try {
    await run(
      `ALTER TABLE training_params ADD COLUMN ftp_recommended INTEGER;`
    );
  } catch (_) {}

  await run(`
    CREATE TABLE IF NOT EXISTS strava_tokens (
      user_id       TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER
    );
  `);

  // טבלה לפרופיל רוכב מסטרבה (כרגע משקל בלבד)
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
      start_date             INTEGER, -- epoch seconds
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

// ---------- עזרי JSON פשוטים ----------

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

// ---------- לוגיקת DB ראשית ----------

export async function createDbImpl() {
  await init();

  // ===== USERS =====

  async function ensureUser(userId) {
    const emptyJson = {
      profile: {},
      onboarding: { stage: "intro" },
    };

    await run(
      `INSERT INTO users (user_id, json, created_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO NOTHING`,
      [userId, JSON.stringify(emptyJson)]
    );
  }

  // ===== ONBOARDING STATE =====

  async function getOnboardingState(userId) {
    await ensureUser(userId);
    const row = await get(
      `SELECT stage, data_json FROM onboarding_states WHERE user_id = ?`,
      [userId]
    );
    if (!row) return { stage: null, data: {} };

    let data = {};
    if (row.data_json) {
      try {
        data = JSON.parse(row.data_json);
      } catch (e) {
        console.error("Failed parsing onboarding data_json:", e);
        data = {};
      }
    }
    return { stage: row.stage || null, data };
  }

  async function saveOnboardingState(userId, state) {
    const now = Math.floor(Date.now() / 1000);
    const dataJson = JSON.stringify(state.data || {});
    const existing = await get(
      `SELECT user_id FROM onboarding_states WHERE user_id = ?`,
      [userId]
    );

    if (!existing) {
      await run(
        `INSERT INTO onboarding_states (user_id, stage, data_json, updated_at)
         VALUES (?, ?, ?, ?)`,
        [userId, state.stage || null, dataJson, now]
      );
    } else {
      await run(
        `UPDATE onboarding_states
         SET stage = ?, data_json = ?, updated_at = ?
         WHERE user_id = ?`,
        [state.stage || null, dataJson, now, userId]
      );
    }
  }

  // ===== TRAINING PARAMS =====

  async function getTrainingParams(userId) {
    const row = await get(
      `SELECT ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
              hr_max, hr_threshold
       FROM training_params
       WHERE user_id = ?`,
      [userId]
    );
    if (!row) return null;
    return {
      ftp: row.ftp ?? null,
      ftp20: row.ftp20 ?? null,
      ftpFrom3min: row.ftp_from_3min ?? null,
      ftpFromCP: row.ftp_from_cp ?? null,
      ftpRecommended: row.ftp_recommended ?? null,
      hrMax: row.hr_max ?? null,
      hrThreshold: row.hr_threshold ?? null,
    };
  }

  async function saveTrainingParams(userId, params) {
    const now = Math.floor(Date.now() / 1000);
    const existing = await get(
      `SELECT user_id FROM training_params WHERE user_id = ?`,
      [userId]
    );

    const values = [
      params.ftp ?? null,
      params.ftp20 ?? null,
      params.ftpFrom3min ?? null,
      params.ftpFromCP ?? null,
      params.ftpRecommended ?? null,
      params.hrMax ?? null,
      params.hrThreshold ?? null,
      now,
      userId,
    ];

    if (!existing) {
      await run(
        `INSERT INTO training_params
         (ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
          hr_max, hr_threshold, created_at, updated_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.ftp ?? null,
          params.ftp20 ?? null,
          params.ftpFrom3min ?? null,
          params.ftpFromCP ?? null,
          params.ftpRecommended ?? null,
          params.hrMax ?? null,
          params.hrThreshold ?? null,
          now,
          now,
          userId,
        ]
      );
    } else {
      await run(
        `UPDATE training_params
         SET ftp = ?, ftp20 = ?, ftp_from_3min = ?, ftp_from_cp = ?,
             ftp_recommended = ?, hr_max = ?, hr_threshold = ?, updated_at = ?
         WHERE user_id = ?`,
        values
      );
    }
  }

  // ===== STRAVA TOKENS =====

  async function getStravaTokens(userId) {
    const row = await get(
      `SELECT access_token, refresh_token, expires_at
       FROM strava_tokens WHERE user_id = ?`,
      [userId]
    );
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    };
  }

  async function saveStravaTokens(userId, tokens) {
    const existing = await get(
      `SELECT user_id FROM strava_tokens WHERE user_id = ?`,
      [userId]
    );
    const values = [
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt || 0,
      userId,
    ];

    if (!existing) {
      await run(
        `INSERT INTO strava_tokens (access_token, refresh_token, expires_at, user_id)
         VALUES (?, ?, ?, ?)`,
        values
      );
    } else {
      await run(
        `UPDATE strava_tokens
         SET access_token = ?, refresh_token = ?, expires_at = ?
         WHERE user_id = ?`,
        values
      );
    }
  }

  async function clearStravaData(userId) {
    await run(`DELETE FROM strava_activities WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM strava_streams WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM power_curves WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM strava_athlete WHERE user_id = ?`, [userId]);
  }

  // ===== חישוב נפח ו-SUMMARY מתוך ה-DB =====

  async function computeVolumeAndSummaryFromDb(userId) {
    const DAYS_BACK = 90;
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - DAYS_BACK * 24 * 3600;

    const RIDE_TYPES = [
      "Ride",
      "VirtualRide",
      "GravelRide",
      "MountainBikeRide",
      "EBikeRide",
    ];

    const placeholders = RIDE_TYPES.map(() => "?").join(",");

    const rows = await all(
      `
      SELECT
        start_date,
        moving_time,
        distance,
        total_elevation_gain,
        type
      FROM strava_activities
      WHERE user_id = ?
        AND start_date >= ?
        AND type IN (${placeholders})
      ORDER BY start_date ASC
      `,
      [userId, sinceSec, ...RIDE_TYPES]
    );

    if (!rows.length) {
      return {
        trainingSummary: null,
        volume: null,
      };
    }

    let totalMovingTimeSec = 0;
    let totalDistanceM = 0;
    let totalElevationGainM = 0;
    let minDurationSec = Number.POSITIVE_INFINITY;
    let maxDurationSec = 0;
    let offroadCount = 0;

    const weeks = new Map(); // key: YYYY-WW, value: { timeSec, rides }

    for (const r of rows) {
      const mt = Number(r.moving_time || 0);
      const dist = Number(r.distance || 0);
      const elev = Number(r.total_elevation_gain || 0);

      totalMovingTimeSec += mt;
      totalDistanceM += dist;
      totalElevationGainM += elev;

      if (mt > 0) {
        if (mt < minDurationSec) minDurationSec = mt;
        if (mt > maxDurationSec) maxDurationSec = mt;
      }

      const t = r.type || "";
      if (
        t.includes("Gravel") ||
        t.includes("Mountain") ||
        t.includes("EBike")
      ) {
        offroadCount += 1;
      }

      const startDateSec = Number(r.start_date || 0);
      const d = new Date(startDateSec * 1000);
      const year = d.getUTCFullYear();
      const firstJan = new Date(Date.UTC(year, 0, 1));
      const dayOfYear = Math.floor((d - firstJan) / (24 * 3600 * 1000)) + 1;
      const week = Math.ceil(dayOfYear / 7);
      const weekKey = `${year}-${week}`;

      if (!weeks.has(weekKey)) {
        weeks.set(weekKey, { timeSec: 0, rides: 0 });
      }
      const w = weeks.get(weekKey);
      w.timeSec += mt;
      w.rides += 1;
    }

    const ridesCount = rows.length;
    const avgDurationSec =
      ridesCount > 0 ? totalMovingTimeSec / ridesCount : 0;
    const totalDistanceKm = totalDistanceM / 1000;
    const totalElevationGainRounded = Math.round(totalElevationGainM);
    const offroadPct =
      ridesCount > 0 ? Math.round((offroadCount / ridesCount) * 100) : null;

    const weeksArr = Array.from(weeks.values());
    let weeklyHoursAvg = 0;
    let weeklyRidesAvg = 0;

    if (weeksArr.length > 0) {
      const totalWeekTimeSec = weeksArr.reduce(
        (s, w) => s + w.timeSec,
        0
      );
      const totalWeekRides = weeksArr.reduce((s, w) => s + w.rides, 0);
      weeklyHoursAvg = totalWeekTimeSec / 3600 / weeksArr.length;
      weeklyRidesAvg = totalWeekRides / weeksArr.length;
    }

    const trainingSummary = {
      rides_count: ridesCount,
      totalMovingTimeSec: Math.round(totalMovingTimeSec),
      totalDistanceKm: Number(totalDistanceKm.toFixed(1)),
      totalElevationGainM: totalElevationGainRounded,
      avgDurationSec: Math.round(avgDurationSec),
      minDurationSec:
        minDurationSec === Number.POSITIVE_INFINITY
          ? 0
          : Math.round(minDurationSec),
      maxDurationSec: Math.round(maxDurationSec),
      offroadPct,
    };

    const volume = {
      weeksCount: weeksArr.length,
      weeklyHoursAvg: Number(weeklyHoursAvg.toFixed(1)),
      weeklyRidesAvg: Number(weeklyRidesAvg.toFixed(1)),
    };

    return { trainingSummary, volume };
  }

  // ===== חישוב מודלי FTP ודופק מתוך training_params =====

  async function computeFtpAndHrModelsFromDb(userId) {
    const row = await get(
      `SELECT ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
              hr_max, hr_threshold
       FROM training_params
       WHERE user_id = ?`,
      [userId]
    );

    const ftpModels = {};

    if (row) {
      if (row.ftp20 != null) {
        ftpModels.ftp20 = {
          key: "ftp20",
          value: row.ftp20,
          label: "FTP 20min (95%)",
        };
      }
      if (row.ftp_from_3min != null) {
        ftpModels.ftpFrom3min = {
          key: "ftpFrom3min",
          value: row.ftp_from_3min,
          label: "FTP from 3min model",
        };
      }
      if (row.ftp_from_cp != null) {
        ftpModels.ftpFromCP = {
          key: "ftpFromCP",
          value: row.ftp_from_cp,
          label: "Critical Power model",
        };
      }
      if (row.ftp != null) {
        ftpModels.ftpFromStrava = {
          key: "ftpFromStrava",
          value: row.ftp,
          label: "FTP from Strava / manual",
        };
      }
      if (row.ftp_recommended != null) {
        ftpModels.ftpRecommended = {
          key: "ftpRecommended",
          value: row.ftp_recommended,
          label: "Recommended FTP (median)",
        };
      }
    }

    const hr = {
      hrMax: row && row.hr_max != null ? row.hr_max : null,
      hrThreshold:
        row && row.hr_threshold != null ? row.hr_threshold : null,
    };

    return { ftpModels, hr };
  }

  // ===== STRAVA INGEST (כאן כרגע רק חישוב מטריקות מתוך ה-DB) =====

  async function ingestAndComputeFromStrava(userId) {
    console.log(
      "[STRAVA] ingestAndComputeFromStrava (DB metrics only) for",
      userId
    );

    const volumeSummary = await computeVolumeAndSummaryFromDb(userId);
    const ftpModels = await computeFtpAndHrModelsFromDb(userId);

    return {
      trainingSummary: volumeSummary.trainingSummary,
      volume: volumeSummary.volume,
      ftpModels: ftpModels.ftpModels,
      hr: ftpModels.hr,
    };
  }

  // ===== משקל רוכב מסטרבה =====

  async function saveAthleteProfile(userId, weightKg) {
    if (weightKg == null) return;
    const now = Math.floor(Date.now() / 1000);

    await run(
      `INSERT INTO strava_athlete (user_id, weight_kg, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         weight_kg = excluded.weight_kg,
         updated_at = excluded.updated_at`,
      [userId, weightKg, now]
    );
  }

  // ===== Snapshot לאונבורדינג =====

  async function getStravaOnboardingSnapshot(userId) {
    const { trainingSummary, volume } =
      await computeVolumeAndSummaryFromDb(userId);
    const { ftpModels, hr } = await computeFtpAndHrModelsFromDb(userId);

    const athleteRow = await get(
      `SELECT weight_kg FROM strava_athlete WHERE user_id = ?`,
      [userId]
    );

    const personal = {};
    if (athleteRow && athleteRow.weight_kg != null) {
      personal.weightFromStrava = athleteRow.weight_kg;
    }

    return {
      trainingSummary,
      volume,
      ftpModels,
      hr,
      personal,
    };
  }

  return {
    ensureUser,
    getOnboardingState,
    saveOnboardingState,
    getTrainingParams,
    saveTrainingParams,
    getStravaTokens,
    saveStravaTokens,
    clearStravaData,
    ingestAndComputeFromStrava,
    getStravaOnboardingSnapshot,
    saveAthleteProfile,
  };
}
