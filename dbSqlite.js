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
      console.log("[DB] SQLite DB opened OK");
    }
  }
);

// ---------- Helpers for sqlite ----------

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

// ---------- Schema init ----------

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id   TEXT PRIMARY KEY,
      json      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id   TEXT PRIMARY KEY,
      stage     TEXT,
      data      TEXT,
      updated_at INTEGER
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS training_params (
      user_id           TEXT PRIMARY KEY,
      age               INTEGER,
      weight            REAL,
      height            REAL,
      ftp               INTEGER,
      hr_max            INTEGER,
      hr_threshold      INTEGER,
      min_duration      INTEGER,
      typical_duration  INTEGER,
      max_duration      INTEGER,
      goal              TEXT,
      updated_at        INTEGER
    );
  `);

  // לוודא שהעמודות החדשות של מודלי FTP קיימות גם ב-DB ישן
  try {
    await run(`ALTER TABLE training_params ADD COLUMN ftp_from_20min INTEGER;`);
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
      user_id     TEXT,
      activity_id INTEGER,
      seconds     INTEGER,
      best_watts  REAL,
      PRIMARY KEY (user_id, activity_id, seconds)
    );
  `);
}

// ---------- Helpers ----------

function bestRollingAverage(values, windowSize) {
  if (!Array.isArray(values) || values.length < windowSize || windowSize <= 0) {
    return null;
  }
  let sum = 0;
  for (let i = 0; i < windowSize; i++) {
    sum += values[i];
  }
  let best = sum / windowSize;
  for (let i = windowSize; i < values.length; i++) {
    sum += values[i] - values[i - windowSize];
    const avg = sum / windowSize;
    if (avg > best) best = avg;
  }
  return best;
}

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

// ---------- Main DB impl ----------

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
    const row = await get(
      `SELECT stage, data FROM onboarding_states WHERE user_id = ?`,
      [userId]
    );
    if (!row) {
      return { stage: null, data: {} };
    }
    let data = {};
    if (row.data) {
      try {
        data = JSON.parse(row.data);
      } catch {
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
        `INSERT INTO onboarding_states (user_id, stage, data, updated_at)
         VALUES (?, ?, ?, ?)`,
        [userId, state.stage || null, dataJson, now]
      );
    } else {
      await run(
        `UPDATE onboarding_states
         SET stage = ?, data = ?, updated_at = ?
         WHERE user_id = ?`,
        [state.stage || null, dataJson, now, userId]
      );
    }
  }

  // ===== TRAINING PARAMS =====

  async function getTrainingParams(userId) {
    const row = await get(
      `SELECT * FROM training_params WHERE user_id = ?`,
      [userId]
    );
    return row || null;
  }

  async function saveTrainingParams(userId, params) {
    const now = Math.floor(Date.now() / 1000);
    const existing = await get(
      `SELECT user_id FROM training_params WHERE user_id = ?`,
      [userId]
    );

    const values = [
      params.age ?? null,
      params.weight ?? null,
      params.height ?? null,
      params.ftp ?? null,
      params.hr_max ?? null,
      params.hr_threshold ?? null,
      params.min_duration ?? null,
      params.typical_duration ?? null,
      params.max_duration ?? null,
      params.goal ?? null,
      params.ftp_from_20min ?? null,
      params.ftp_from_3min ?? null,
      params.ftp_from_cp ?? null,
      params.ftp_recommended ?? null,
      now,
      userId,
    ];

    if (!existing) {
      await run(
        `INSERT INTO training_params
        (age, weight, height, ftp, hr_max, hr_threshold,
         min_duration, typical_duration, max_duration, goal,
         ftp_from_20min, ftp_from_3min, ftp_from_cp, ftp_recommended,
         updated_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values
      );
    } else {
      await run(
        `UPDATE training_params
         SET age = ?, weight = ?, height = ?, ftp = ?, hr_max = ?, hr_threshold = ?,
             min_duration = ?, typical_duration = ?, max_duration = ?, goal = ?,
             ftp_from_20min = ?, ftp_from_3min = ?, ftp_from_cp = ?, ftp_recommended = ?,
             updated_at = ?
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

  // ===== STRAVA INGEST =====

  async function clearStravaData(userId) {
    await run(`DELETE FROM strava_activities WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM strava_streams   WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM power_curves    WHERE user_id = ?`, [userId]);
  }

  async function insertStravaActivities(userId, activities) {
    const sql = `
      INSERT OR REPLACE INTO strava_activities
      (id, user_id, start_date, moving_time, elapsed_time, distance,
       total_elevation_gain, avg_power, max_power, avg_hr, max_hr, has_power, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    for (const a of activities) {
      await run(sql, [
        a.id,
        userId,
        a.start_date,
        a.moving_time,
        a.elapsed_time,
        a.distance,
        a.total_elevation_gain,
        a.avg_power,
        a.max_power,
        a.avg_hr,
        a.max_hr,
        a.has_power ? 1 : 0,
        a.type || null,
      ]);
    }
  }

  async function insertStravaStream(userId, activityId, streamType, dataArray) {
    await run(
      `INSERT OR REPLACE INTO strava_streams (user_id, activity_id, stream_type, data)
       VALUES (?, ?, ?, ?)`,
      [userId, activityId, streamType, JSON.stringify(dataArray || [])]
    );
  }

  async function insertPowerCurve(userId, activityId, seconds, bestWatts) {
    if (!bestWatts || bestWatts <= 0) return;
    await run(
      `INSERT OR REPLACE INTO power_curves (user_id, activity_id, seconds, best_watts)
       VALUES (?, ?, ?, ?)`,
      [userId, activityId, seconds, bestWatts]
    );
  }

  async function fetchStravaActivitiesFromAPI(userId, tokens) {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("per_page", "200");

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error("Strava activities fetch failed: " + text);
    }

    const raw = await res.json();
    const nowSec = Math.floor(Date.now() / 1000);
    const oneYearSec = 365 * 24 * 3600;
    const afterTs = nowSec - oneYearSec;

    const cyclingTypes = new Set([
      "Ride",
      "VirtualRide",
      "GravelRide",
      "MountainBikeRide",
      "EBikeRide",
    ]);

    const activities = [];
    for (const a of raw) {
      if (!cyclingTypes.has(a.type)) continue;
      const startTs = Math.floor(new Date(a.start_date).getTime() / 1000);
      if (startTs < afterTs) continue;

      const hasPower = !!a.has_power;
      activities.push({
        id: a.id,
        start_date: startTs,
        moving_time: a.moving_time || 0,
        elapsed_time: a.elapsed_time || 0,
        distance: a.distance || 0,
        total_elevation_gain: a.total_elevation_gain || 0,
        avg_power: hasPower ? a.avg_power || null : null,
        max_power: hasPower ? a.max_power || null : null,
        avg_hr: a.average_heartrate || null,
        max_hr: a.max_heartrate || null,
        has_power: hasPower,
        type: a.type || null,
      });
    }

    return activities;
  }

  async function fetchStreamsForActivity(userId, tokens, activityId) {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    const url = new URL(
      `https://www.strava.com/api/v3/activities/${activityId}/streams`
    );
    url.searchParams.set("keys", "watts,heartrate");
    url.searchParams.set("key_by_type", "true");

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error("Strava streams fetch failed: " + text);
    }

    const raw = await res.json();
    const watts = raw.watts && Array.isArray(raw.watts.data)
      ? raw.watts.data
      : [];
    const hr = raw.heartrate && Array.isArray(raw.heartrate.data)
      ? raw.heartrate.data
      : [];

    await insertStravaStream(userId, activityId, "watts", watts);
    await insertStravaStream(userId, activityId, "heartrate", hr);

    return { watts, hr };
  }

  async function computePowerCurvesForActivity(userId, activityId, watts) {
    if (!Array.isArray(watts) || watts.length === 0) return;
    const windows = [60, 180, 300, 480, 1200]; // 1,3,5,8,20 דקות
    for (const sec of windows) {
      const best = bestRollingAverage(watts, sec);
      if (best && best > 0) {
        await insertPowerCurve(userId, activityId, sec, best);
      }
    }
  }

  async function computeFtpAndHrModelsFromDb(userId) {
    // POWER CURVES – אוספים טופ 3 לכל חלון
    const windows = [180, 300, 480, 1200]; // 3,5,8,20 דקות
    const curves = await all(
      `SELECT seconds, best_watts
       FROM power_curves
       WHERE user_id = ?
       ORDER BY best_watts DESC`,
      [userId]
    );

    const byWindow = new Map();
    for (const row of curves) {
      if (!windows.includes(row.seconds)) continue;
      if (!byWindow.has(row.seconds)) byWindow.set(row.seconds, []);
      byWindow.get(row.seconds).push(row.best_watts);
    }

    function top3avg(sec) {
      const arr = byWindow.get(sec) || [];
      if (arr.length === 0) return null;
      const top3 = arr.slice(0, 3);
      const sum = top3.reduce((a, b) => a + b, 0);
      return sum / top3.length;
    }

    const p3 = {
      s3: top3avg(180),
      s5: top3avg(300),
      s8: top3avg(480),
      s20: top3avg(1200),
    };

    let ftpFrom20 = null;
    if (p3.s20 != null) {
      ftpFrom20 = Math.round(p3.s20 * 0.95);
    }

    let ftpFrom3minModel = null;
    if (p3.s3 != null) {
      ftpFrom3minModel = Math.round(p3.s3 * 0.8);
    }

    let ftpFromCP = null;
    if (p3.s3 != null && p3.s20 != null) {
      // CP מודל פשוט – לא מדויק מדעית אבל סביר כ-estimate
      const p3min = p3.s3;
      const p20min = p3.s20;
      const t3 = 180;
      const t20 = 1200;

      const denom = p20min - p3min;
      if (Math.abs(denom) > 1e-6) {
        const CP = (p20min * p3min * (t20 - t3)) / (denom * (t20 - t3));
        if (CP > 0 && Number.isFinite(CP)) {
          ftpFromCP = Math.round(CP);
        }
      }
    }

    // HR – טופ 3 דפקים
        // HR – טופ דפקים מחצי השנה האחרונה, עם הגנה מפני ספייקים לא ריאליים
    const nowSec = Math.floor(Date.now() / 1000);
    const days180 = 180 * 24 * 3600;
    const sinceTs = nowSec - days180;

    const hrRows = await all(
      `SELECT max_hr
       FROM strava_activities
       WHERE user_id = ?
         AND max_hr IS NOT NULL
         AND start_date >= ?
       ORDER BY max_hr DESC`,
      [userId, sinceTs]
    );

    let hrMaxCandidate = null;
    if (hrRows.length > 0) {
      // ממירים למערך ערכים, מסננים זבל, ממיינים מהגבוה לנמוך
      const valsDesc = hrRows
        .map((r) => r.max_hr)
        .filter((v) => v != null && v > 0)
        .sort((a, b) => b - a);

      if (valsDesc.length > 0) {
        // לוקחים עד טופ 3
        const top = valsDesc.slice(0, 3);

        let use = top;
        // אם הערך הגבוה ביותר רחוק מאוד מהשני (למשל ספייק 199 מול 179) – זורקים אותו
        if (top.length >= 2 && top[0] - top[1] >= 10) {
          use = top.slice(1); // משתמשים רק בשני/שלישי
        }

        const sum = use.reduce((a, b) => a + b, 0);
        hrMaxCandidate = Math.round(sum / use.length);
      }
    }

    let hrThresholdCandidate = null;
    if (hrMaxCandidate != null) {
      // דופק סף ~90% מה- HRmax – זה רק נקודת פתיחה, אתה מאשר ביד
      hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);
    }


    // FTP recommended – מדיום של המודלים הסבירים
    const candidates = [];
    if (ftpFrom20 && ftpFrom20 > 100) candidates.push(ftpFrom20);
    if (ftpFrom3minModel && ftpFrom3minModel > 100)
      candidates.push(ftpFrom3minModel);
    if (ftpFromCP && ftpFromCP > 100) candidates.push(ftpFromCP);

    let ftpRecommended = null;
    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      ftpRecommended = sorted[mid];
    }

    return {
      ftpModels: {
        ftpFrom20min: ftpFrom20,
        ftpFrom3minModel,
        ftpFromCP,
        ftpRecommended,
        hrMaxCandidate,
        hrThresholdCandidate,
      },
    };
  }

  async function computeVolumeAndSummaryFromDb(userId) {
    const nowSec = Math.floor(Date.now() / 1000);
    const days90 = 90 * 24 * 3600;
    const since90 = nowSec - days90;

    const rowsAll = await all(
      `SELECT moving_time, distance, total_elevation_gain, start_date
       FROM strava_activities
       WHERE user_id = ?
         AND moving_time > 0`,
      [userId]
    );

    if (rowsAll.length === 0) {
      return { trainingSummary: null, volume: null };
    }

    const durationsAll = rowsAll
      .map((r) => r.moving_time || 0)
      .filter((x) => x > 0)
      .sort((a, b) => a - b);

    let minDurationSec = null;
    let avgDurationSecVolume = null;
    let maxDurationSec = null;

    if (durationsAll.length > 0) {
      minDurationSec = durationsAll[Math.floor(durationsAll.length * 0.25)];
      avgDurationSecVolume =
        durationsAll.reduce((a, b) => a + b, 0) / durationsAll.length;
      maxDurationSec = durationsAll[Math.floor(durationsAll.length * 0.9)];
    }

    const rows90 = rowsAll.filter((r) => r.start_date >= since90);
    if (rows90.length === 0) {
      return {
        trainingSummary: null,
        volume: {
          ridesCount: durationsAll.length,
          minDurationSec,
          avgDurationSec: avgDurationSecVolume,
          maxDurationSec,
        },
      };
    }

    let totalTime90 = 0;
    let totalDist90 = 0;
    let totalElev90 = 0;
    for (const r of rows90) {
      totalTime90 += r.moving_time || 0;
      totalDist90 += r.distance || 0;
      totalElev90 += r.total_elevation_gain || 0;
    }

    const avgDurationSec90 = totalTime90 / rows90.length;

    const trainingSummary = {
      rides_count: rows90.length,
      totalMovingTimeSec: totalTime90,
      totalDistanceKm: totalDist90 / 1000,
      totalElevationGainM: totalElev90,
      avgDurationSec: avgDurationSec90,
      offroadPct: null, // אפשר לחשב לפי type בעתיד
    };

    const volume = {
      ridesCount: durationsAll.length,
      minDurationSec,
      avgDurationSec: avgDurationSecVolume,
      maxDurationSec,
    };

    return { trainingSummary, volume };
  }

  async function ingestAndComputeFromStrava(userId) {
    const tokens = await getStravaTokens(userId);
    if (!tokens) {
      return {
        trainingSummary: null,
        volume: null,
        ftpModels: null,
      };
    }

    const activities = await fetchStravaActivitiesFromAPI(userId, tokens);
    await clearStravaData(userId);
    await insertStravaActivities(userId, activities);

    // streams + power curves
    for (const a of activities) {
      if (!a.has_power) continue;
      try {
        const { watts } = await fetchStreamsForActivity(userId, tokens, a.id);
        if (watts && watts.length > 0) {
          await computePowerCurvesForActivity(userId, a.id, watts);
        }
      } catch (err) {
        console.error("[STRAVA] streams error for activity", a.id, err.message);
      }
    }

    const volumeSummary = await computeVolumeAndSummaryFromDb(userId);
    const ftpModels = await computeFtpAndHrModelsFromDb(userId);

    return {
      trainingSummary: volumeSummary.trainingSummary,
      volume: volumeSummary.volume,
      ftpModels: ftpModels.ftpModels,
    };
  }

  async function getStravaOnboardingSnapshot(userId) {
    // לא מביא מה-API – רק מסכם מה-DB
    const volumeSummary = await computeVolumeAndSummaryFromDb(userId);
    const ftpModels = await computeFtpAndHrModelsFromDb(userId);

    return {
      trainingSummary: volumeSummary.trainingSummary,
      volume: volumeSummary.volume,
      ftpModels: ftpModels.ftpModels,
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
  };
}
