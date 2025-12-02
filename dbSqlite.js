// dbSqlite.js
import sqlite3 from "sqlite3";

sqlite3.verbose();

const DB_FILE = process.env.LOEW_DB_FILE || "./loew.db";
const db = new sqlite3.Database(DB_FILE);

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

async function init() {
  // טבלת משתמשים
  await run(
    `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      created_at INTEGER
    )`
  );

  // טבלת סטייט של אונבורדינג (JSON)
  await run(
    `CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id TEXT PRIMARY KEY,
      stage TEXT,
      data TEXT,
      updated_at INTEGER
    )`
  );

  // טבלת פרמטרי אימון
  await run(
    `CREATE TABLE IF NOT EXISTS training_params (
      user_id TEXT PRIMARY KEY,
      age INTEGER,
      weight REAL,
      height REAL,
      ftp INTEGER,
      hr_max INTEGER,
      hr_threshold INTEGER,
      min_duration INTEGER,
      typical_duration INTEGER,
      max_duration INTEGER,
      goal TEXT,
      updated_at INTEGER
    )`
  );

  // טבלת טוקנים של סטרבה
  await run(
    `CREATE TABLE IF NOT EXISTS strava_tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER
    )`
  );

  // פעילויות בסיסיות מסטרבה (לסיכום, FTP, דופק וכו')
  await run(
    `CREATE TABLE IF NOT EXISTS strava_activities (
      id INTEGER PRIMARY KEY,
      user_id TEXT,
      start_date INTEGER,
      moving_time INTEGER,
      distance REAL,
      avg_power REAL,
      max_power REAL,
      avg_hr REAL,
      max_hr REAL
    )`
  );
}

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
      return {
        stage: null,
        data: {},
      };
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

  // ===== STRAVA INGEST & METRICS (מודל פשוט אבל יציב) =====

  async function clearStravaActivities(userId) {
    await run(`DELETE FROM strava_activities WHERE user_id = ?`, [userId]);
  }

  async function insertStravaActivities(userId, activities) {
    const sql = `INSERT OR REPLACE INTO strava_activities
      (id, user_id, start_date, moving_time, distance, avg_power, max_power, avg_hr, max_hr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const act of activities) {
      await run(sql, [
        act.id,
        userId,
        act.start_date,
        act.moving_time,
        act.distance,
        act.avg_power,
        act.max_power,
        act.avg_hr,
        act.max_hr,
      ]);
    }
  }

  async function fetchStravaActivitiesFromAPI(userId, tokens) {
    // מודל פשוט: מביא עד 200 פעילויות אחרונות, בלי STREAMS
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
    const ninetyDaysSec = 90 * 24 * 3600;
    const afterTs = nowSec - ninetyDaysSec;

    const filtered = raw.filter((a) => {
      const startTs = Math.floor(new Date(a.start_date).getTime() / 1000);
      return startTs >= afterTs && a.type && a.type.includes("Ride");
    });

    return filtered.map((a) => ({
      id: a.id,
      start_date: Math.floor(new Date(a.start_date).getTime() / 1000),
      moving_time: a.moving_time || 0,
      distance: a.distance || 0,
      avg_power: a.average_watts || null,
      max_power: a.max_watts || null,
      avg_hr: a.average_heartrate || null,
      max_hr: a.max_heartrate || null,
    }));
  }

  function computeFtpAndHrFromActivities(activities) {
    const withPower = activities.filter((a) => a.avg_power != null);
    const withHr = activities.filter((a) => a.max_hr != null);

    // חישוב FTP – מודל פשוט: משתמש בממוצע הכוח של הרכיבות
    let ftpFrom20min = null;
    let ftpFrom3minModel = null;
    let ftpFromCP = null;
    let ftpRecommended = null;

    if (withPower.length > 0) {
      const avgPowers = withPower.map((a) => a.avg_power).sort((a, b) => b - a);
      const top3 = avgPowers.slice(0, 3);
      const mean = top3.reduce((s, v) => s + v, 0) / top3.length;

      // הנחות פשוטות: 20 דקות ≈ 0.75 מהסף, 3 דקות ≈ 1.2 מהסף
      ftpFrom20min = Math.round(mean * 0.95); // מודל דמוי 20min
      ftpFrom3minModel = Math.round(mean * 0.8); // מודל קצר
      ftpFromCP = Math.round((ftpFrom20min + ftpFrom3minModel) / 2);

      const candidates = [ftpFrom20min, ftpFrom3minModel, ftpFromCP].filter(
        (x) => x && x > 0
      );
      if (candidates.length > 0) {
        const sorted = [...candidates].sort((a, b) => a - b);
        ftpRecommended = sorted[Math.floor(sorted.length / 2)];
      }
    }

    // חישוב דופק
    let hrMaxCandidate = null;
    let hrThresholdCandidate = null;
    if (withHr.length > 0) {
      const maxHrs = withHr.map((a) => a.max_hr).sort((a, b) => b - a);
      const top3 = maxHrs.slice(0, 3);
      const meanMax =
        top3.reduce((sum, v) => sum + v, 0) / Math.max(top3.length, 1);
      hrMaxCandidate = Math.round(meanMax);
      hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);
    }

    // סיכום נפח
    const durations = activities.map((a) => a.moving_time || 0);
    let minDuration = null;
    let avgDuration = null;
    let maxDuration = null;

    if (durations.length > 0) {
      durations.sort((a, b) => a - b);
      minDuration = durations[0];
      maxDuration = durations[durations.length - 1];
      avgDuration =
        durations.reduce((s, v) => s + v, 0) / Math.max(durations.length, 1);
    }

    return {
      ftpFrom20min,
      ftpFrom3minModel,
      ftpFromCP,
      ftpRecommended,
      hrMaxCandidate,
      hrThresholdCandidate,
      volumeSummary: {
        ridesCount: activities.length,
        minDurationSec: minDuration,
        avgDurationSec: avgDuration,
        maxDurationSec: maxDuration,
      },
    };
  }

  async function ingestAndComputeFromStrava(userId) {
    const tokens = await getStravaTokens(userId);
    if (!tokens) {
      return null;
    }

    const activities = await fetchStravaActivitiesFromAPI(userId, tokens);

    await clearStravaActivities(userId);
    await insertStravaActivities(userId, activities);

    const metrics = computeFtpAndHrFromActivities(activities);
    return metrics;
  }

  async function getVolumeSummaryFromDb(userId) {
    const rows = await all(
      `SELECT moving_time FROM strava_activities WHERE user_id = ?`,
      [userId]
    );
    if (!rows || rows.length === 0) {
      return null;
    }
    const durations = rows.map((r) => r.moving_time || 0).sort((a, b) => a - b);
    const minDuration = durations[0];
    const maxDuration = durations[durations.length - 1];
    const avgDuration =
      durations.reduce((s, v) => s + v, 0) / Math.max(durations.length, 1);

    return {
      ridesCount: rows.length,
      minDurationSec: minDuration,
      avgDurationSec: avgDuration,
      maxDurationSec: maxDuration,
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
    ingestAndComputeFromStrava,
    getVolumeSummaryFromDb,
  };
}
