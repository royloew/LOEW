import sqlite3 from "sqlite3";
import path from "path";

sqlite3.verbose();

// בחירת מיקום ה־DB בצורה עמידה וברורה
function resolveDbFile() {
  // 1) אם הוגדר נתיב מפורש ב-ENV, נשתמש בו
  if (process.env.LOEW_DB_FILE) {
    console.log("[DB] Using DB path from LOEW_DB_FILE:", process.env.LOEW_DB_FILE);
    return process.env.LOEW_DB_FILE;
  }

  // 2) בפרודקשן (Render) — משתמשים בדיסק הקבוע /var/data
  if (process.env.NODE_ENV === "production") {
    const diskPath = "/var/data/loew.db";
    console.log("[DB] NODE_ENV=production, using Render disk path:", diskPath);
    return diskPath;
  }

  // 3) לוקאל — קובץ loew.db בתיקיית הפרויקט
  const localPath = path.join(process.cwd(), "loew.db");
  console.log("[DB] Using local dev DB path:", localPath);
  return localPath;
}

const DB_FILE = resolveDbFile();

console.log("[DB] Final SQLite file path:", DB_FILE);

const DEFAULT_METRICS_WINDOW_DAYS = 60;

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

// ---------- Schema ----------

async function init() {
  // users
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY,
      json       TEXT,
      created_at INTEGER
    );
  `);

  // training_params
  await run(`
    CREATE TABLE IF NOT EXISTS training_params (
      user_id              TEXT PRIMARY KEY,
      ftp                  INTEGER,
      ftp20                INTEGER,
      ftp_from_3min        INTEGER,
      ftp_from_cp          INTEGER,
      ftp_recommended      INTEGER,
      hr_max               INTEGER,
      hr_threshold         INTEGER,
      metrics_window_days  INTEGER,
      created_at           INTEGER,
      updated_at           INTEGER
    );
  `);

  // onboarding state
  await run(`
    CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id    TEXT PRIMARY KEY,
      stage      TEXT,
      data_json  TEXT,
      updated_at INTEGER
    );
  `);

  // goals – מטרה מרכזית לכל משתמש
  await run(`
    CREATE TABLE IF NOT EXISTS goals (
      user_id    TEXT PRIMARY KEY,
      goal_text  TEXT,
      updated_at INTEGER
    );
  `);



  // הרחבות בטיחות (ל־DB ישן יותר)
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
  try {
    await run(
      `ALTER TABLE training_params ADD COLUMN metrics_window_days INTEGER;`
    );
  } catch (_) {}

  // טבלת OAuth טוקנים של סטרבה
  await run(`
    CREATE TABLE IF NOT EXISTS strava_tokens (
      user_id       TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER
    );
  `);

  // פרופיל אתלט מסטרבה (כרגע משקל)
  await run(`
    CREATE TABLE IF NOT EXISTS strava_athlete (
      user_id    TEXT PRIMARY KEY,
      weight_kg  REAL,
      updated_at INTEGER
    );
  `);

  // פעילויות מסטרבה
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

  // streams (watts / heartrate)
  await run(`
    CREATE TABLE IF NOT EXISTS strava_streams (
      user_id     TEXT,
      activity_id INTEGER,
      stream_type TEXT,
      data        TEXT,
      PRIMARY KEY (user_id, activity_id, stream_type)
    );
  `);

  // עקומות כוח
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

// ---------- JSON helpers ----------

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

// ---------- Outliers helper ----------

function filterOutliersRobust(values, { min = null, max = null } = {}) {
  let vals = values.filter((v) => Number.isFinite(v));

  if (min != null) vals = vals.filter((v) => v >= min);
  if (max != null) vals = vals.filter((v) => v <= max);

  if (vals.length <= 2) return vals;

  const sorted = vals.slice().sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] +
          sorted[sorted.length / 2]) /
        2;

  const absDeviations = sorted.map((v) => Math.abs(v - median));
  const sortedDev = absDeviations.slice().sort((a, b) => a - b);
  const mad =
    sortedDev.length % 2 === 1
      ? sortedDev[(sortedDev.length - 1) / 2]
      : (sortedDev[sortedDev.length / 2 - 1] +
          sortedDev[sortedDev.length / 2]) /
        2;

  if (!mad || mad === 0) return vals;

  const threshold = 3 * mad;
  return vals.filter((v) => Math.abs(v - median) <= threshold);
}

// ---------- DB logic ----------

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
        [userId, state.stage, dataJson, now]
      );
    } else {
      await run(
        `UPDATE onboarding_states
           SET stage = ?, data_json = ?, updated_at = ?
         WHERE user_id = ?`,
        [state.stage, dataJson, now, userId]
      );
    }
  }


  // ===== GOALS =====

  async function updateGoal(userId, goalText) {
    await ensureUser(userId);
    const now = Math.floor(Date.now() / 1000);

    await run(
      `INSERT INTO goals (user_id, goal_text, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         goal_text  = excluded.goal_text,
         updated_at = excluded.updated_at`,
      [userId, goalText, now]
    );
  }

  async function getGoal(userId) {
    const row = await get(
      `SELECT goal_text FROM goals WHERE user_id = ?`,
      [userId]
    );
    return row ? row.goal_text : null;
  }

  // ===== TRAINING PARAMS & METRICS WINDOW =====

  async function getTrainingParams(userId) {
    const row = await get(
      `SELECT ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
              hr_max, hr_threshold, metrics_window_days
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
      metricsWindowDays: row.metrics_window_days ?? null,
    };
  }

  async function saveTrainingParams(userId, params) {
    const now = Math.floor(Date.now() / 1000);
    const existing = await get(
      `SELECT user_id FROM training_params WHERE user_id = ?`,
      [userId]
    );

    const metricsWindowDays =
      params.metricsWindowDays != null
        ? Number(params.metricsWindowDays)
        : null;

    if (!existing) {
      await run(
        `INSERT INTO training_params
         (user_id,
          ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
          hr_max, hr_threshold, metrics_window_days,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          params.ftp ?? null,
          params.ftp20 ?? null,
          params.ftpFrom3min ?? null,
          params.ftpFromCP ?? null,
          params.ftpRecommended ?? null,
          params.hrMax ?? null,
          params.hrThreshold ?? null,
          metricsWindowDays,
          now,
          now,
        ]
      );
    } else {
      await run(
        `UPDATE training_params
         SET ftp = ?, ftp20 = ?, ftp_from_3min = ?, ftp_from_cp = ?,
             ftp_recommended = ?, hr_max = ?, hr_threshold = ?,
             metrics_window_days = ?, updated_at = ?
         WHERE user_id = ?`,
        [
          params.ftp ?? null,
          params.ftp20 ?? null,
          params.ftpFrom3min ?? null,
          params.ftpFromCP ?? null,
          params.ftpRecommended ?? null,
          params.hrMax ?? null,
          params.hrThreshold ?? null,
          metricsWindowDays,
          now,
          userId,
        ]
      );
    }
  }

  async function getMetricsWindowDays(userId) {
    const params = await getTrainingParams(userId);
    if (!params || params.metricsWindowDays == null) {
      return DEFAULT_METRICS_WINDOW_DAYS;
    }
    const n = Number(params.metricsWindowDays);
    if (!Number.isFinite(n) || n <= 0) {
      return DEFAULT_METRICS_WINDOW_DAYS;
    }
    return n;
  }

  async function setMetricsWindowDays(userId, days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("metrics_window_days must be a positive number");
    }
    const existing = (await getTrainingParams(userId)) || {};
    const newParams = {
      ...existing,
      metricsWindowDays: n,
    };
    await saveTrainingParams(userId, newParams);
    return n;
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

  // ===== SUMMARY & VOLUME =====

  async function computeVolumeAndSummaryFromDb(userId) {
    const DAYS_BACK = await getMetricsWindowDays(userId);
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

    const weeks = new Map();

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
      const dayOfYear =
        Math.floor((d - firstJan) / (24 * 3600 * 1000)) + 1;
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

  // ===== FTP & HR MODELS FROM DB =====

  async function computeFtpAndHrModelsFromDb(userId) {
    const row = await get(
      `SELECT ftp, ftp20, ftp_from_3min, ftp_from_cp, ftp_recommended,
              hr_max, hr_threshold, metrics_window_days
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

    const metricsWindowDays =
      (row && row.metrics_window_days != null
        ? row.metrics_window_days
        : null) || DEFAULT_METRICS_WINDOW_DAYS;

    return { ftpModels, hr, metricsWindowDays };
  }

  // ===== STRAVA helpers (fetch + streams + power curves + FTP + HR) =====

  async function fetchStravaJson(url, accessToken, label) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        "[STRAVA] fetch failed",
        label || url,
        "status=",
        res.status,
        text
      );
      throw new Error(
        `Strava API error ${res.status} for ${label || url}`
      );
    }

    return await res.json();
  }

  async function fetchAndStoreStreamsForActivities(
    userId,
    accessToken,
    activityIds
  ) {
    for (const activityId of activityIds) {
      try {
        const url = new URL(
          `https://www.strava.com/api/v3/activities/${activityId}/streams`
        );
        url.searchParams.set("keys", "watts,heartrate");
        url.searchParams.set("key_by_type", "true");

        const json = await fetchStravaJson(
          url.toString(),
          accessToken,
          `streams for activity ${activityId}`
        );

        if (!json || typeof json !== "object") continue;

        async function storeStream(streamType) {
          const st = json[streamType];
          if (!st) return;
          const dataArr = Array.isArray(st.data) ? st.data : null;
          if (!dataArr || !dataArr.length) return;

          await run(
            `INSERT INTO strava_streams (user_id, activity_id, stream_type, data)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, activity_id, stream_type) DO UPDATE SET
               data = excluded.data`,
            [userId, activityId, streamType, JSON.stringify(dataArr)]
          );
        }

        await storeStream("watts");
        await storeStream("heartrate");
      } catch (err) {
        console.error(
          "[STRAVA] Failed fetching streams for activity",
          activityId,
          err
        );
      }
    }
  }

  async function recomputePowerCurvesFromStreams(userId) {
    const rows = await all(
      `
      SELECT activity_id, data
      FROM strava_streams
      WHERE user_id = ?
        AND stream_type = 'watts'
      `,
      [userId]
    );

    if (!rows.length) {
      console.log(
        "[STRAVA] No watts streams found for power curve computation for",
        userId
      );
      return;
    }

    const WINDOWS = [60, 180, 300, 480, 1200]; // 1,3,5,8,20 דקות
    const best = new Map();
    for (const w of WINDOWS) best.set(w, 0);

    for (const row of rows) {
      const arr = parseJsonArray(row.data);
      if (!arr || !arr.length) continue;

      for (const windowSec of WINDOWS) {
        if (arr.length < windowSec) continue;

        let sum = 0;
        for (let i = 0; i < windowSec; i++) {
          const v = Number(arr[i]) || 0;
          sum += v;
        }
        let bestAvg = sum / windowSec;

        for (let i = windowSec; i < arr.length; i++) {
          const vNew = Number(arr[i]) || 0;
          const vOld = Number(arr[i - windowSec]) || 0;
          sum += vNew - vOld;
          const avg = sum / windowSec;
          if (avg > bestAvg) bestAvg = avg;
        }

        if (bestAvg > 0) {
          const prev = best.get(windowSec) || 0;
          if (bestAvg > prev) {
            best.set(windowSec, bestAvg);
          }
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    for (const [windowSec, bestPower] of best.entries()) {
      if (!bestPower || bestPower <= 0) continue;
      await run(
        `INSERT INTO power_curves (user_id, window_sec, best_power, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, window_sec) DO UPDATE SET
           best_power = excluded.best_power,
           updated_at = excluded.updated_at`,
        [userId, windowSec, bestPower, now]
      );
    }

    console.log("[STRAVA] Power curves updated for", userId);
  }

  async function computeFtpModelsFromStreamsWithWindow(userId) {
    const DAYS_BACK = await getMetricsWindowDays(userId);
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - DAYS_BACK * 24 * 3600;

    const activities = await all(
      `
      SELECT id, start_date, has_power
      FROM strava_activities
      WHERE user_id = ?
        AND has_power = 1
        AND start_date >= ?
      ORDER BY start_date ASC
      `,
      [userId, sinceSec]
    );

    if (!activities.length) {
      console.log("[STRAVA][FTP] No power activities in window for", userId);
      return;
    }

    const ids = activities.map((a) => a.id);
    const placeholders = ids.map(() => "?").join(",");
    const streamsRows = await all(
      `
      SELECT activity_id, data
      FROM strava_streams
      WHERE user_id = ?
        AND stream_type = 'watts'
        AND activity_id IN (${placeholders})
      `,
      [userId, ...ids]
    );

    const wattsMap = new Map();
    for (const r of streamsRows) {
      const arr = parseJsonArray(r.data);
      if (arr && arr.length) {
        wattsMap.set(r.activity_id, arr.map((v) => Number(v) || 0));
      }
    }

    function bestWindowMeanPower(series, windowSec) {
      const n = series.length;
      if (n < windowSec || windowSec <= 0) return null;
      let sum = 0;
      for (let i = 0; i < windowSec; i++) {
        sum += series[i];
      }
      let bestAvg = sum / windowSec;
      for (let i = windowSec; i < n; i++) {
        sum += series[i] - series[i - windowSec];
        const avg = sum / windowSec;
        if (avg > bestAvg) bestAvg = avg;
      }
      return bestAvg;
    }

    const records20 = [];
    const records3 = [];

    for (const a of activities) {
      const arr = wattsMap.get(a.id);
      if (!arr || !arr.length) continue;
      const b20 = bestWindowMeanPower(arr, 1200);
      const b3 = bestWindowMeanPower(arr, 180);
      if (b20 != null) records20.push(b20);
      if (b3 != null) records3.push(b3);
    }

    let ftp20 = null;
    let ftpFrom3min = null;
    let ftpFromCP = null;

    const candidates = [];

    if (records20.length) {
      const sorted = records20.slice().sort((a, b) => b - a);
      const top3 = sorted.slice(0, 3);
      const mean20 = top3.reduce((s, v) => s + v, 0) / top3.length;
      ftp20 = Math.round(mean20 * 0.95);
      candidates.push(ftp20);
    }

    if (records3.length) {
      const sorted = records3.slice().sort((a, b) => b - a);
      const top3 = sorted.slice(0, 3);
      const mean3 = top3.reduce((s, v) => s + v, 0) / top3.length;
      ftpFrom3min = Math.round(mean3 * 0.8);
      candidates.push(ftpFrom3min);
    }

    if (records20.length && records3.length) {
      const sorted20 = records20.slice().sort((a, b) => b - a);
      const sorted3 = records3.slice().sort((a, b) => b - a);
      const top3_20 = sorted20.slice(0, 3);
      const top3_3 = sorted3.slice(0, 3);
      const mean20 =
        top3_20.reduce((s, v) => s + v, 0) / top3_20.length;
      const mean3 =
        top3_3.reduce((s, v) => s + v, 0) / top3_3.length;
      const t3 = 180;
      const t20 = 1200;
      const cp = (mean20 * t20 - mean3 * t3) / (t20 - t3);
      if (cp > 0) {
        ftpFromCP = Math.round(cp);
        candidates.push(ftpFromCP);
      }
    }

    const existing = await getTrainingParams(userId);
    const ftpFromStrava =
      existing && existing.ftp && existing.ftp > 0 ? existing.ftp : null;
    if (ftpFromStrava) {
      candidates.push(ftpFromStrava);
    }

    let ftpRecommended = null;
    if (candidates.length) {
      const sortedCand = candidates.slice().sort((a, b) => a - b);
      ftpRecommended = sortedCand[Math.floor(sortedCand.length / 2)];
    }

    const newParams = {
      ftp: ftpFromStrava ?? (existing ? existing.ftp ?? null : null),
      ftp20: ftp20 ?? (existing ? existing.ftp20 ?? null : null),
      ftpFrom3min:
        ftpFrom3min ?? (existing ? existing.ftpFrom3min ?? null : null),
      ftpFromCP:
        ftpFromCP ?? (existing ? existing.ftpFromCP ?? null : null),
      ftpRecommended:
        ftpRecommended ??
        (existing ? existing.ftpRecommended ?? null : null),
      hrMax: existing ? existing.hrMax ?? null : null,
      hrThreshold: existing ? existing.hrThreshold ?? null : null,
      metricsWindowDays: await getMetricsWindowDays(userId),
    };

    await saveTrainingParams(userId, newParams);
    console.log(
      "[STRAVA][FTP] Training params (FTP) updated from streams for",
      userId,
      "windowDays=",
      await getMetricsWindowDays(userId)
    );
  }

  async function recomputeHrFromActivities(userId) {
    const DAYS_BACK = await getMetricsWindowDays(userId);
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - DAYS_BACK * 24 * 3600;

    const rows = await all(
      `
      SELECT max_hr
      FROM strava_activities
      WHERE user_id = ?
        AND max_hr IS NOT NULL
        AND start_date >= ?
      ORDER BY max_hr DESC
      LIMIT 50
      `,
      [userId, sinceSec]
    );

    if (!rows.length) {
      console.log("[STRAVA] No HR data in window for", userId);
      return;
    }

    let vals = rows
      .map((r) =>
        typeof r.max_hr === "number" ? r.max_hr : Number(r.max_hr) || null
      )
      .filter((v) => Number.isFinite(v));

    vals = filterOutliersRobust(vals, { min: 100, max: 230 });

    if (!vals.length) {
      console.log(
        "[STRAVA] HR rows all filtered as outliers for",
        userId
      );
      return;
    }

    const topSorted = vals.slice().sort((a, b) => b - a);
    const top3 = topSorted.slice(0, 3);
    const hrMaxCandidate = Math.round(
      top3.reduce((s, v) => s + v, 0) / top3.length
    );
    const hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);

    const existing = await getTrainingParams(userId);

    const newParams = {
      ftp: existing ? existing.ftp ?? null : null,
      ftp20: existing ? existing.ftp20 ?? null : null,
      ftpFrom3min: existing ? existing.ftpFrom3min ?? null : null,
      ftpFromCP: existing ? existing.ftpFromCP ?? null : null,
      ftpRecommended: existing ? existing.ftpRecommended ?? null : null,
      hrMax: hrMaxCandidate,
      hrThreshold: hrThresholdCandidate,
      metricsWindowDays: await getMetricsWindowDays(userId),
    };

    await saveTrainingParams(userId, newParams);

    console.log(
      "[STRAVA] Training params (HR) updated from activities for",
      userId,
      "hrMax=",
      newParams.hrMax,
      "hrThreshold=",
      newParams.hrThreshold,
      "windowDays=",
      await getMetricsWindowDays(userId)
    );
  }

  // ===== STRAVA ingest (full) =====

  async function pullAndStoreStravaData(userId, tokens) {
    const accessToken = tokens && tokens.accessToken;
    if (!accessToken) {
      console.log("[STRAVA] No accessToken for user", userId);
      return;
    }

    // 1) Athlete profile
    try {
      const athlete = await fetchStravaJson(
        "https://www.strava.com/api/v3/athlete",
        accessToken,
        "athlete"
      );
      if (athlete && typeof athlete.weight === "number") {
        await saveAthleteProfile(userId, athlete.weight);
      }
    } catch (err) {
      console.error("[STRAVA] Failed to fetch athlete profile:", err);
    }

    const RIDE_TYPES = [
      "Ride",
      "VirtualRide",
      "GravelRide",
      "MountainBikeRide",
      "EBikeRide",
    ];
    const perPage = 100;
    const maxPages = 3;
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - 180 * 24 * 3600; // חצי שנה אחורה לאינג'סט

    const activityIdsForPower = [];

    for (let page = 1; page <= maxPages; page++) {
      let activities;
      try {
        const url = new URL(
          "https://www.strava.com/api/v3/athlete/activities"
        );
        url.searchParams.set("per_page", String(perPage));
        url.searchParams.set("page", String(page));

        activities = await fetchStravaJson(
          url.toString(),
          accessToken,
          `activities page ${page}`
        );
      } catch (err) {
        console.error("[STRAVA] Failed fetching activities page", page, err);
        break;
      }

      if (!Array.isArray(activities) || !activities.length) {
        break;
      }

      for (const a of activities) {
        if (!a) continue;
        if (!RIDE_TYPES.includes(a.type)) continue;

        const startDateSec = a.start_date
          ? Math.floor(new Date(a.start_date).getTime() / 1000)
          : 0;
        if (startDateSec && startDateSec < sinceSec) {
          continue;
        }

        const hasPower =
          a.device_watts ||
          (typeof a.average_watts === "number" && a.average_watts > 0);

        const avgPower =
          typeof a.average_watts === "number" ? a.average_watts : null;
        const maxPower =
          typeof a.max_watts === "number" ? a.max_watts : null;
        const avgHr =
          typeof a.average_heartrate === "number"
            ? a.average_heartrate
            : null;
        const maxHr =
          typeof a.max_heartrate === "number" ? a.max_heartrate : null;

        await run(
          `
          INSERT INTO strava_activities (
            id, user_id, start_date,
            moving_time, elapsed_time,
            distance, total_elevation_gain,
            avg_power, max_power,
            avg_hr, max_hr,
            has_power, type
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            start_date = excluded.start_date,
            moving_time = excluded.moving_time,
            elapsed_time = excluded.elapsed_time,
            distance = excluded.distance,
            total_elevation_gain = excluded.total_elevation_gain,
            avg_power = excluded.avg_power,
            max_power = excluded.max_power,
            avg_hr = excluded.avg_hr,
            max_hr = excluded.max_hr,
            has_power = excluded.has_power,
            type = excluded.type
          `,
          [
            a.id,
            userId,
            startDateSec,
            a.moving_time || 0,
            a.elapsed_time || 0,
            a.distance || 0,
            a.total_elevation_gain || 0,
            avgPower,
            maxPower,
            avgHr,
            maxHr,
            hasPower ? 1 : 0,
            a.type || null,
          ]
        );

        if (hasPower) {
          activityIdsForPower.push(a.id);
        }
      }
    }

    if (activityIdsForPower.length) {
      console.log(
        "[STRAVA] Fetching streams for",
        activityIdsForPower.length,
        "activities for user",
        userId
      );
      await fetchAndStoreStreamsForActivities(
        userId,
        accessToken,
        activityIdsForPower
      );
      await recomputePowerCurvesFromStreams(userId);
      await computeFtpModelsFromStreamsWithWindow(userId);
      await recomputeHrFromActivities(userId);
    } else {
      console.log(
        "[STRAVA] No power-capable activities found for user",
        userId
      );
    }
  }

  async function ingestAndComputeFromStrava(userId) {
    console.log("[STRAVA] ingestAndComputeFromStrava (full) for", userId);

    try {
      const tokens = await getStravaTokens(userId);
      if (!tokens || !tokens.accessToken) {
        console.log(
          "[STRAVA] No tokens for user during ingest, falling back to DB-only metrics for",
          userId
        );
      } else {
        await pullAndStoreStravaData(userId, tokens);
      }
    } catch (err) {
      console.error(
        "[STRAVA] ingestAndComputeFromStrava raw ingest failed:",
        err
      );
    }

    const { trainingSummary, volume } =
      await computeVolumeAndSummaryFromDb(userId);
    const { ftpModels, hr, metricsWindowDays } =
      await computeFtpAndHrModelsFromDb(userId);

    return {
      trainingSummary,
      volume,
      ftpModels,
      hr,
      metricsWindowDays,
    };
  }

  // ===== Athlete profile (weight) =====

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
    const { ftpModels, hr, metricsWindowDays } =
      await computeFtpAndHrModelsFromDb(userId);

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
      metricsWindowDays,
    };
  }

    // ===== Snapshot כללי (onboarding + עדכון מסטרבה) =====
  async function getStravaSnapshot(userId) {
    // כרגע פשוט משתמשים באותה לוגיקה של האונבורדינג,
    // כולל personal.weightFromStrava
    return await getStravaOnboardingSnapshot(userId);
  }


  // ===== WORKOUT ANALYSIS (LAST / BY DATE) =====

  function computeAvgAndMax(series) {
    if (!Array.isArray(series) || !series.length) {
      return { avg: null, max: null, min: null };
    }
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const raw of series) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      sum += v;
      count += 1;
      if (v > max) max = v;
      if (v < min) min = v;
    }
    if (!count) {
      return { avg: null, max: null, min: null };
    }
    return {
      avg: sum / count,
      max,
      min,
    };
  }

  function computeTwoHalvesDrift(series) {
    if (!Array.isArray(series) || series.length < 4) {
      return {
        firstAvg: null,
        secondAvg: null,
        driftPct: null,
      };
    }
    const mid = Math.floor(series.length / 2);
    const first = series.slice(0, mid);
    const second = series.slice(mid);

    const s1 = computeAvgAndMax(first);
    const s2 = computeAvgAndMax(second);

    if (s1.avg == null || s2.avg == null || s1.avg === 0) {
      return {
        firstAvg: s1.avg,
        secondAvg: s2.avg,
        driftPct: null,
      };
    }

    const driftPct = ((s2.avg - s1.avg) / s1.avg) * 100;

    return {
      firstAvg: s1.avg,
      secondAvg: s2.avg,
      driftPct,
    };
  }

  function computeBestWindowFromSeries(series, durationSec, windowSec) {
    if (!Array.isArray(series) || !series.length) return null;
    if (!durationSec || durationSec <= 0) return null;

    const totalSamples = series.length;
    const approxSampleSec = durationSec / totalSamples;
    if (!Number.isFinite(approxSampleSec) || approxSampleSec <= 0) {
      return null;
    }

    const windowSamples = Math.round(windowSec / approxSampleSec);
    if (!Number.isFinite(windowSamples) || windowSamples < 1) return null;
    if (windowSamples > totalSamples) return null;

    let bestAvg = -Infinity;
    let bestStart = 0;

    // sliding window
    let windowSum = 0;
    for (let i = 0; i < totalSamples; i++) {
      const v = Number(series[i]);
      if (Number.isFinite(v)) {
        windowSum += v;
      }
      if (i >= windowSamples) {
        const old = Number(series[i - windowSamples]);
        if (Number.isFinite(old)) {
          windowSum -= old;
        }
      }
      if (i >= windowSamples - 1) {
        const avg = windowSum / windowSamples;
        if (avg > bestAvg) {
          bestAvg = avg;
          bestStart = i - windowSamples + 1;
        }
      }
    }

    if (!Number.isFinite(bestAvg) || bestAvg <= 0) {
      return null;
    }

    return {
      avg: bestAvg,
      startIndex: bestStart,
      endIndex: bestStart + windowSamples - 1,
    };
  }

  async function getWorkoutAnalysisCore(userId, { isoDate = null } = {}) {
    let activityRow = null;

    if (isoDate) {
      activityRow = await get(
        `
        SELECT *
        FROM strava_activities
        WHERE user_id = ?
          AND date(start_date, 'unixepoch') = ?
        ORDER BY start_date ASC
        LIMIT 1
        `,
        [userId, isoDate]
      );
    } else {
      activityRow = await get(
        `
        SELECT *
        FROM strava_activities
        WHERE user_id = ?
        ORDER BY start_date DESC
        LIMIT 1
        `,
        [userId]
      );
    }

    if (!activityRow) {
      return null;
    }

    const activityId = activityRow.id;

    const streamRows = await all(
      `
      SELECT stream_type, data
      FROM strava_streams
      WHERE user_id = ?
        AND activity_id = ?
      `,
      [userId, activityId]
    );

    const streams = {};
    for (const row of streamRows) {
      const arr = parseJsonArray(row.data);
      if (arr && Array.isArray(arr) && arr.length) {
        streams[row.stream_type] = arr.map((v) => Number(v) || 0);
      }
    }

    const durationSec =
      Number(activityRow.moving_time || activityRow.elapsed_time || 0) || 0;
    const distanceKm = (Number(activityRow.distance || 0) || 0) / 1000;
    const elevationGainM =
      Number(activityRow.total_elevation_gain || 0) || 0;

    const wattsSeries = streams.watts || streams.power || null;
    const hrSeries =
      streams.heartrate || streams.heart_rate || streams.hr || null;

    const wattsStats = wattsSeries
      ? computeAvgAndMax(wattsSeries)
      : { avg: null, max: null };
    const hrStats = hrSeries
      ? computeAvgAndMax(hrSeries)
      : { avg: null, max: null };

    const avgPowerFromActivity =
      typeof activityRow.avg_power === "number"
        ? activityRow.avg_power
        : null;
    const maxPowerFromActivity =
      typeof activityRow.max_power === "number"
        ? activityRow.max_power
        : null;
    const avgHrFromActivity =
      typeof activityRow.avg_hr === "number" ? activityRow.avg_hr : null;
    const maxHrFromActivity =
      typeof activityRow.max_hr === "number" ? activityRow.max_hr : null;

    const avgPower =
      avgPowerFromActivity != null ? avgPowerFromActivity : wattsStats.avg;
    const maxPower =
      maxPowerFromActivity != null ? maxPowerFromActivity : wattsStats.max;
    const avgHr = avgHrFromActivity != null ? avgHrFromActivity : hrStats.avg;
    const maxHr = maxHrFromActivity != null ? maxHrFromActivity : hrStats.max;

    const params = await getTrainingParams(userId);
    const ftpCandidate =
      (params && params.ftp) ||
      (params && params.ftpRecommended) ||
      null;

    let intensityFtp = null;
    if (ftpCandidate && avgPower) {
      intensityFtp = Number((avgPower / ftpCandidate).toFixed(2));
    }

    // drift / decoupling בין החצי הראשון לחצי השני
    const powerHalves = wattsSeries
      ? computeTwoHalvesDrift(wattsSeries)
      : {
          firstAvg: null,
          secondAvg: null,
          driftPct: null,
        };
    const hrHalves = hrSeries
      ? computeTwoHalvesDrift(hrSeries)
      : {
          firstAvg: null,
          secondAvg: null,
          driftPct: null,
        };

    let decouplingPct = null;
    if (
      powerHalves.driftPct != null &&
      hrHalves.driftPct != null
    ) {
      decouplingPct = hrHalves.driftPct - powerHalves.driftPct;
    }

    const best60 = wattsSeries
      ? computeBestWindowFromSeries(wattsSeries, durationSec, 60)
      : null;
    const best300 = wattsSeries
      ? computeBestWindowFromSeries(wattsSeries, durationSec, 300)
      : null;
    const best1200 = wattsSeries
      ? computeBestWindowFromSeries(wattsSeries, durationSec, 1200)
      : null;

    function enrichWindow(win) {
      if (!win || !ftpCandidate) return win;
      return {
        ...win,
        relToFtp: ftpCandidate
          ? Number(((win.avg / ftpCandidate) * 100).toFixed(1))
          : null,
      };
    }

    const windows = {
      w60: enrichWindow(best60),
      w300: enrichWindow(best300),
      w1200: enrichWindow(best1200),
    };

    const startDateSec = Number(activityRow.start_date || 0) || 0;
    const startDateIso = startDateSec
      ? new Date(startDateSec * 1000).toISOString()
      : null;

    const summary = {
      durationSec,
      durationMin: durationSec ? durationSec / 60 : null,
      distanceKm: Number(distanceKm.toFixed(1)),
      elevationGainM: Math.round(elevationGainM),
      avgPower: avgPower != null ? Number(avgPower.toFixed(1)) : null,
      maxPower: maxPower != null ? Math.round(maxPower) : null,
      avgHr: avgHr != null ? Number(avgHr.toFixed(1)) : null,
      maxHr: maxHr != null ? Math.round(maxHr) : null,
      ftpUsed: ftpCandidate,
      intensityFtp,
      startDateIso,
      segments: {
        power: powerHalves,
        hr: hrHalves,
        decouplingPct,
      },
      windows,
    };

    return {
      activity: activityRow,
      summary,
      streams,
    };
  }

  async function getLastWorkoutAnalysis(userId) {
    return await getWorkoutAnalysisCore(userId, { isoDate: null });
  }

  async function getWorkoutAnalysisByDate(userId, isoDate) {
    if (!isoDate) return null;
    return await getWorkoutAnalysisCore(userId, { isoDate });
  }

  return {
    ensureUser,

    // אונבורדינג
    getOnboardingState,
    saveOnboardingState,

    // goals
    getGoal,
    updateGoal,

    // פרמטרי אימון
    getTrainingParams,
    saveTrainingParams,
    getMetricsWindowDays,
    setMetricsWindowDays,

    // סטרבה
    getStravaTokens,
    saveStravaTokens,
    clearStravaData,
    ingestAndComputeFromStrava,

    // NEW: משמש את ה-onboardingEngine לצורך טעינת הנתונים
    getStravaSnapshot,
    // נשאיר גם את זה לשימוש ישיר אם צריך
    getStravaOnboardingSnapshot,

    // פרופיל ואימונים
    saveAthleteProfile,
    getLastWorkoutAnalysis,
    getWorkoutAnalysisByDate,
  };
}

