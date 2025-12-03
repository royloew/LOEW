import sqlite3 from "sqlite3";

sqlite3.verbose();

// ברירת מחדל: /tmp/loew.db (מתאים ל-Render)
// אפשר לשנות עם משתנה סביבה LOEW_DB_FILE אם תרצה
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
  // משתמשים – עם json כדי שנוכל לשמור future profile/chat אם צריך
  await run(`DROP TABLE IF EXISTS users;`);
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
      has_power              INTEGER
    );
  `);

  // streams – נשמור JSON של המערכים הגולמיים (time/watts/heartrate)
  await run(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      user_id     TEXT,
      activity_id INTEGER,
      stream_type TEXT,
      data        TEXT,
      PRIMARY KEY (user_id, activity_id, stream_type)
    );
  `);

  // power curves – best watts לכל חלון זמן בפר פעילות
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

// ---------- Power curve helpers ----------

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
      now,
      userId,
    ];

    if (!existing) {
      await run(
        `INSERT INTO training_params
        (age, weight, height, ftp, hr_max, hr_threshold,
         min_duration, typical_duration, max_duration, goal, updated_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values
      );
    } else {
      await run(
        `UPDATE training_params
         SET age = ?, weight = ?, height = ?, ftp = ?, hr_max = ?, hr_threshold = ?,
             min_duration = ?, typical_duration = ?, max_duration = ?, goal = ?, updated_at = ?
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
       total_elevation_gain, avg_power, max_power, avg_hr, max_hr, has_power)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const filtered = raw.filter((a) => {
      const startTs = Math.floor(new Date(a.start_date).getTime() / 1000);
      return (
        startTs >= afterTs &&
        a.type &&
        cyclingTypes.has(a.type) &&
        (a.average_watts || a.max_watts || a.device_watts)
      );
    });

    return filtered.map((a) => ({
      id: a.id,
      start_date: Math.floor(new Date(a.start_date).getTime() / 1000),
      moving_time: a.moving_time || 0,
      elapsed_time: a.elapsed_time || a.moving_time || 0,
      distance: a.distance || 0,
      total_elevation_gain: a.total_elevation_gain || 0,
      avg_power: a.average_watts || null,
      max_power: a.max_watts || null,
      avg_hr: a.average_heartrate || null,
      max_hr: a.max_heartrate || null,
      has_power: !!(a.average_watts || a.max_watts || a.device_watts),
    }));
  }

  async function fetchStreamsForActivity(tokens, activityId) {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    const url = new URL(
      `https://www.strava.com/api/v3/activities/${activityId}/streams`
    );
    url.searchParams.set("keys", "time,watts,heartrate");
    url.searchParams.set("key_by_type", "true");

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const text = await res.text();
      console.error("Strava streams fetch failed:", activityId, text);
      return null;
    }
    const json = await res.json();
    return json;
  }

  async function buildPowerCurvesForActivity(userId, activityId, streamsJson) {
    if (!streamsJson) return;

    const wattsStream = streamsJson.watts && streamsJson.watts.data;
    if (!Array.isArray(wattsStream) || wattsStream.length < 30) {
      return;
    }

    // נניח דגימה של 1Hz – חלון ב"שניות" = חלון באורך זהה במערך
    const windowsSec = [60, 180, 300, 480, 1200]; // 1,3,5,8,20 דקות

    for (const win of windowsSec) {
      const best = bestRollingAverage(wattsStream, win);
      if (best && best > 0) {
        await insertPowerCurve(userId, activityId, win, best);
      }
    }
  }

  async function fetchAndStoreStravaData(userId) {
    const tokens = await getStravaTokens(userId);
    if (!tokens) return null;

    const activities = await fetchStravaActivitiesFromAPI(userId, tokens);

    await clearStravaData(userId);
    await insertStravaActivities(userId, activities);

    // עבור כל פעילות עם power – נביא streams ונבנה power curve
    for (const act of activities) {
      if (!act.has_power) continue;
      try {
        const streams = await fetchStreamsForActivity(tokens, act.id);
        if (!streams) continue;

        const timeArr = streams.time && streams.time.data;
        const wattsArr = streams.watts && streams.watts.data;
        const hrArr = streams.heartrate && streams.heartrate.data;

        if (Array.isArray(timeArr)) {
          await insertStravaStream(userId, act.id, "time", timeArr);
        }
        if (Array.isArray(wattsArr)) {
          await insertStravaStream(userId, act.id, "watts", wattsArr);
        }
        if (Array.isArray(hrArr)) {
          await insertStravaStream(userId, act.id, "heartrate", hrArr);
        }

        await buildPowerCurvesForActivity(userId, act.id, streams);
      } catch (e) {
        console.error("Error building streams/curves for activity", act.id, e);
      }
    }

    return activities;
  }

  // ===== Metrics from DB (FTP / HR / Volume) =====

  async function computeMetricsFromDb(userId) {
    // power curves לכל חלון
    async function top3ForWindow(seconds) {
      const rows = await all(
        `SELECT best_watts FROM power_curves
         WHERE user_id = ? AND seconds = ?
         ORDER BY best_watts DESC
         LIMIT 3`,
        [userId, seconds]
      );
      if (!rows || rows.length === 0) return null;
      const vals = rows.map((r) => r.best_watts).filter((x) => x > 0);
      if (vals.length === 0) return null;
      const mean =
        vals.reduce((sum, v) => sum + v, 0) / Math.max(vals.length, 1);
      return mean;
    }

    const mean20 = await top3ForWindow(1200); // 20 דק׳
    const mean3 = await top3ForWindow(180);   // 3 דק׳
    const mean8 = await top3ForWindow(480);   // 8 דק׳ (אם יהיה בעתיד)

    let ftpFrom20min = null;
    let ftpFromPowerCurve = null;
    let ftpFromCP = null;

    if (mean20 != null) {
      ftpFrom20min = Math.round(mean20 * 0.95);
    }
    if (mean3 != null) {
      ftpFromPowerCurve = Math.round(mean3 * 0.8);
    }
    if (mean3 != null && mean20 != null) {
      // מודל CP פשוט: משקל יתר ל-20min
      const cp = 0.5 * (mean20 * 0.95) + 0.5 * (mean3 * 0.8);
      ftpFromCP = Math.round(cp);
    } else if (mean8 != null) {
      const cp = mean8 * 0.9;
      ftpFromCP = Math.round(cp);
    }

    const ftpCandidates = [
      ftpFrom20min,
      ftpFromPowerCurve,
      ftpFromCP,
    ].filter((x) => x && x > 0);

    let ftpRecommended = null;
    if (ftpCandidates.length > 0) {
      const sorted = [...ftpCandidates].sort((a, b) => a - b);
      ftpRecommended = sorted[Math.floor(sorted.length / 2)];
    }

    // HR metrics – לפי max_hr מה-180 ימים האחרונים
    const nowSec = Math.floor(Date.now() / 1000);
    const days180 = 180 * 24 * 3600;
    const hrRows = await all(
      `SELECT max_hr
       FROM strava_activities
       WHERE user_id = ? AND start_date >= ? AND max_hr IS NOT NULL`,
      [userId, nowSec - days180]
    );

    let hrMaxCandidate = null;
    let hrThresholdCandidate = null;

    if (hrRows.length > 0) {
      const maxHrs = hrRows
        .map((r) => r.max_hr)
        .filter((x) => x != null)
        .sort((a, b) => b - a);
      const top3 = maxHrs.slice(0, 3);
      const meanMax =
        top3.reduce((sum, v) => sum + v, 0) / Math.max(top3.length, 1);
      hrMaxCandidate = Math.round(meanMax);
      hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);
    }

    // Volume summary – min/avg/max משך לכל הפעילויות (שנה אחרונה)
    const volRows = await all(
      `SELECT moving_time
       FROM strava_activities
       WHERE user_id = ?`,
      [userId]
    );

    let volumeSummary = null;
    if (volRows.length > 0) {
      const durations = volRows
        .map((r) => r.moving_time || 0)
        .filter((x) => x > 0)
        .sort((a, b) => a - b);
      if (durations.length > 0) {
        const minDuration = durations[0];
        const maxDuration = durations[durations.length - 1];
        const avgDuration =
          durations.reduce((s, v) => s + v, 0) /
          Math.max(durations.length, 1);
        volumeSummary = {
          ridesCount: durations.length,
          minDurationSec: minDuration,
          avgDurationSec: avgDuration,
          maxDurationSec: maxDuration,
        };
      }
    }

    // training summary – 90 הימים האחרונים
    const days90 = 90 * 24 * 3600;
    const tsRows = await all(
      `SELECT moving_time
       FROM strava_activities
       WHERE user_id = ? AND start_date >= ?`,
      [userId, nowSec - days90]
    );
    let trainingSummary = null;
    if (tsRows.length > 0) {
      const secs = tsRows.map((r) => r.moving_time || 0);
      const totalSec = secs.reduce((s, v) => s + v, 0);
      const ridesCount = secs.length;
      const weeks = 90 / 7;
      const avgHoursPerWeek = (totalSec / 3600) / weeks;
      trainingSummary = {
        avgHoursPerWeek,
        rides_count: ridesCount,
      };
    }

    return {
      ftpFrom20min,
      ftpFrom3minModel: ftpFromPowerCurve,
      ftpFromCP,
      ftpRecommended,
      hrMaxCandidate,
      hrThresholdCandidate,
      volumeSummary,
      trainingSummary,
    };
  }

  // נקראת ע"י מנוע האונבורדינג – גם אינג'סט וגם חישוב
  async function ingestAndComputeFromStrava(userId) {
    const tokens = await getStravaTokens(userId);
    if (!tokens) return null;

    await fetchAndStoreStravaData(userId);
    const metrics = await computeMetricsFromDb(userId);
    return metrics;
  }

  // משמשת ב-_ensureStravaMetrics לפני/אחרי אינג'סט
  async function getVolumeSummaryFromDb(userId) {
    const rows = await all(
      `SELECT moving_time FROM strava_activities WHERE user_id = ?`,
      [userId]
    );
    if (!rows || rows.length === 0) return null;

    const durations = rows
      .map((r) => r.moving_time || 0)
      .filter((x) => x > 0)
      .sort((a, b) => a - b);

    if (durations.length === 0) return null;

    const minDuration = durations[0];
    const maxDuration = durations[durations.length - 1];
    const avgDuration =
      durations.reduce((s, v) => s + v, 0) / Math.max(durations.length, 1);

    return {
      ridesCount: durations.length,
      minDurationSec: minDuration,
      avgDurationSec: avgDuration,
      maxDurationSec: maxDuration,
    };
  }

  // האובייקט שהשרת וה-onboardingEngine משתמשים בו
  return {
    ensureUser,
    getOnboardingState,
    saveOnboardingState,
    getTrainingParams,
    saveTrainingParams,
    getStravaTokens,
    saveStravaTokens,
    ingestAndComputeFromStrava,
    getVolumeSummaryFromDb,
  };
}
