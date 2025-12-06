// dbSqlite.js

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
    await run(`ALTER TABLE training_params ADD COLUMN ftp_recommended INTEGER;`);
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

// ---------- ניקוי ספייקים (Outliers) ----------

function filterOutliersRobust(values, { min = null, max = null } = {}) {
  let vals = values.filter((v) => Number.isFinite(v));

  if (min != null) vals = vals.filter((v) => v >= min);
  if (max != null) vals = vals.filter((v) => v <= max);

  if (vals.length <= 2) return vals;

  const sorted = vals.slice().sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const absDeviations = sorted.map((v) => Math.abs(v - median));
  const sortedDev = absDeviations.slice().sort((a, b) => a - b);
  const mad =
    sortedDev.length % 2 === 1
      ? sortedDev[(sortedDev.length - 1) / 2]
      : (sortedDev[sortedDev.length / 2 - 1] +
          sortedDev[sortedDev.length / 2]) /
        2;

  if (!mad || mad === 0) {
    return vals;
  }

  const threshold = 3 * mad; // 3*MAD ~ "חזק" נגד ספייקים
  return vals.filter((v) => Math.abs(v - median) <= threshold);
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

  // ===== STRAVA HELPERS: FETCH + STREAMS + POWER CURVES + FTP =====

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

    const WINDOWS = [60, 180, 300, 480, 1200]; // 1, 3, 5, 8, 20 דקות
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

  async function recomputeFtpFromPowerCurves(userId) {
    const rows = await all(
      `
      SELECT window_sec, best_power
      FROM power_curves
      WHERE user_id = ?
      `,
      [userId]
    );

    if (!rows.length) {
      console.log("[STRAVA] No power_curves rows for", userId);
      return;
    }

    let best3 = null;
    let best20 = null;

    for (const r of rows) {
      if (r.window_sec === 180) best3 = Number(r.best_power) || null;
      if (r.window_sec === 1200) best20 = Number(r.best_power) || null;
    }

    const candidates = [];
    let ftp20 = null;
    if (best20 && best20 > 0) {
      ftp20 = Math.round(best20 * 0.95);
      candidates.push(ftp20);
    }

    let ftpFrom3min = null;
    if (best3 && best3 > 0) {
      ftpFrom3min = Math.round(best3 * 0.8);
      candidates.push(ftpFrom3min);
    }

    let ftpFromCP = null;
    if (best3 && best20 && best3 > 0 && best20 > 0) {
      const t3 = 180;
      const t20 = 1200;
      const cp = (best20 * t20 - best3 * t3) / (t20 - t3);
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
      const sorted = candidates.slice().sort((a, b) => a - b);
      ftpRecommended = sorted[Math.floor(sorted.length / 2)];
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
    };

    await saveTrainingParams(userId, newParams);
    console.log(
      "[STRAVA] Training params (FTP) updated from power curves for",
      userId
    );
  }

  // ===== HR (עם ניקוי ספייקים) =====

  async function recomputeHrFromActivities(userId) {
    const rows = await all(
      `
      SELECT max_hr
      FROM strava_activities
      WHERE user_id = ? AND max_hr IS NOT NULL
      ORDER BY max_hr DESC
      LIMIT 50
      `,
      [userId]
    );

    if (!rows.length) {
      console.log("[STRAVA] No HR data in strava_activities for", userId);
      return;
    }

    let vals = rows
      .map((r) =>
        typeof r.max_hr === "number" ? r.max_hr : Number(r.max_hr) || null
      )
      .filter((v) => Number.isFinite(v));

    // טווח הגיוני לדופק מקסימלי
    vals = filterOutliersRobust(vals, { min: 100, max: 230 });

    if (!vals.length) {
      console.log(
        "[STRAVA] HR rows all filtered as outliers for",
        userId
      );
      return;
    }

    // לוקחים את ה-3 הגבוהים ביותר אחרי הניקוי
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
    };

    await saveTrainingParams(userId, newParams);

    console.log(
      "[STRAVA] Training params (HR) updated from activities for",
      userId,
      "hrMax=",
      newParams.hrMax,
      "hrThreshold=",
      newParams.hrThreshold
    );
  }

  // ===== STRAVA INGEST (מלא: API → DB → Metrics) =====

  async function pullAndStoreStravaData(userId, tokens) {
    const accessToken = tokens && tokens.accessToken;
    if (!accessToken) {
      console.log("[STRAVA] No accessToken for user", userId);
      return;
    }

    // 1) Athlete profile (משקל)
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

    // 2) Activities + basic metrics
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
    const sinceSec = nowSec - 180 * 24 * 3600; // חצי שנה אחורה

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
          // ישנים מדי – לא צריך להמשיך עוד הרבה עמודים
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

    // 3) Streams + power curves + FTP models + HR
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
      await recomputeFtpFromPowerCurves(userId);
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

    // תמיד בסוף מחשבים summary + ftp/hr מה-DB (כמו קודם)
    const { trainingSummary, volume } =
      await computeVolumeAndSummaryFromDb(userId);
    const { ftpModels, hr } = await computeFtpAndHrModelsFromDb(userId);

    return {
      trainingSummary,
      volume,
      ftpModels,
      hr,
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
