// dbSqlite.js
// מימוש createDbImpl על גבי SQLite, כולל שמירת נתוני סטרבה (activities + streams + power curves)
// ומימוש הפונקציות שמנוע האונבורדינג מצפה מה-DB.

import Database from "better-sqlite3";
import fetch from "node-fetch";

/**
 * יוצר אובייקט DB למנוע האונבורדינג.
 * @param {{ getStravaTokens: (userId:string) => any, buildStravaSnapshot?: (tokens:any) => Promise<any> }} deps
 */
export function createDbImpl({ getStravaTokens, buildStravaSnapshot }) {
  const db = new Database("loew.db");
  db.pragma("journal_mode = WAL");

  // סכימת טבלאות
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS training_params (
      user_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_templates (
      user_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS onboarding_states (
      user_id    TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS goals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      type        TEXT,
      description TEXT,
      is_active   INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- סיכום פעילויות סטרבה
    CREATE TABLE IF NOT EXISTS strava_activities (
      user_id          TEXT NOT NULL,
      activity_id      TEXT NOT NULL,
      name             TEXT,
      type             TEXT,
      start_date       TEXT,
      distance_m       REAL,
      moving_time_s    INTEGER,
      elapsed_time_s   INTEGER,
      avg_power        REAL,
      max_power        REAL,
      avg_hr           REAL,
      max_hr           REAL,
      tss              REAL,
      np               REAL,
      intensity_factor REAL,
      is_commute       INTEGER,
      is_race          INTEGER,
      raw_json         TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, activity_id)
    );

    -- streams גולמיים לניתוח
    CREATE TABLE IF NOT EXISTS strava_streams (
      user_id       TEXT NOT NULL,
      activity_id   TEXT NOT NULL,
      stream_type   TEXT NOT NULL,   -- 'watts', 'heartrate', 'time', 'distance'
      series_type   TEXT,
      resolution    TEXT,
      data_json     TEXT NOT NULL,   -- JSON array של sampleים
      samples_count INTEGER,
      created_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, activity_id, stream_type)
    );

    -- Power curve נקודות מפתח
    CREATE TABLE IF NOT EXISTS power_curves (
      user_id        TEXT NOT NULL,
      activity_id    TEXT NOT NULL,
      window_s       INTEGER NOT NULL, -- 60,180,300,480,1200...
      best_power     REAL,
      best_hr        REAL,
      start_offset_s INTEGER,
      created_at     TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, activity_id, window_s)
    );
  `);

  // ---------- Helper JSON per table ----------
  function getJson(table, userId) {
    const row = db.prepare(`SELECT json FROM ${table} WHERE user_id = ?`).get(userId);
    if (!row) return null;
    try {
      return JSON.parse(row.json);
    } catch {
      return null;
    }
  }

  function saveJson(table, userId, obj) {
    const json = JSON.stringify(obj || {});
    db.prepare(`
      INSERT INTO ${table} (user_id, json, created_at, updated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        json = excluded.json,
        updated_at = datetime('now')
    `).run(userId, json);
  }

  // ---------- Strava helpers ----------

  async function fetchJson(url, accessToken) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Strava fetch failed ${res.status}: ${text}`);
    }
    return res.json();
  }

  async function fetchActivityStreams(userId, activityId, accessToken) {
    const url = new URL(`https://www.strava.com/api/v3/activities/${activityId}/streams`);
    url.searchParams.set("keys", "time,watts,heartrate,distance");
    url.searchParams.set("key_by_type", "true");
    const data = await fetchJson(url.toString(), accessToken);
    return data || {};
  }

  function computeSummaryFromStreams(activity, streams) {
    const watts = streams.watts?.data || [];
    const hr = streams.heartrate?.data || [];

    const avgPower = watts.length ? watts.reduce((a, b) => a + b, 0) / watts.length : null;
    const maxPower = watts.length ? Math.max(...watts) : null;
    const avgHr = hr.length ? hr.reduce((a, b) => a + b, 0) / hr.length : null;
    const maxHr = hr.length ? Math.max(...hr) : null;

    // בשלב ראשון: NP / IF / TSS – placeholder
    const np = avgPower ?? null;
    const intensityFactor = null;
    const tss = null;

    return {
      activity_id: String(activity.id),
      name: activity.name,
      type: activity.type,
      start_date: activity.start_date,
      distance_m: activity.distance,
      moving_time_s: activity.moving_time,
      elapsed_time_s: activity.elapsed_time,
      avg_power: avgPower,
      max_power: maxPower,
      avg_hr: avgHr,
      max_hr: maxHr,
      tss,
      np,
      intensity_factor: intensityFactor,
      is_commute: activity.commute ? 1 : 0,
      is_race: activity.race ? 1 : 0,
      raw_json: activity,
    };
  }

  function saveStravaActivitySummary(userId, summary) {
    db.prepare(`
      INSERT INTO strava_activities (
        user_id, activity_id, name, type, start_date,
        distance_m, moving_time_s, elapsed_time_s,
        avg_power, max_power, avg_hr, max_hr,
        tss, np, intensity_factor,
        is_commute, is_race, raw_json,
        created_at, updated_at
      ) VALUES (
        @user_id, @activity_id, @name, @type, @start_date,
        @distance_m, @moving_time_s, @elapsed_time_s,
        @avg_power, @max_power, @avg_hr, @max_hr,
        @tss, @np, @intensity_factor,
        @is_commute, @is_race, @raw_json,
        datetime('now'), datetime('now')
      )
      ON CONFLICT(user_id, activity_id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        start_date = excluded.start_date,
        distance_m = excluded.distance_m,
        moving_time_s = excluded.moving_time_s,
        elapsed_time_s = excluded.elapsed_time_s,
        avg_power = excluded.avg_power,
        max_power = excluded.max_power,
        avg_hr = excluded.avg_hr,
        max_hr = excluded.max_hr,
        tss = excluded.tss,
        np = excluded.np,
        intensity_factor = excluded.intensity_factor,
        is_commute = excluded.is_commute,
        is_race = excluded.is_race,
        raw_json = excluded.raw_json,
        updated_at = datetime('now')
    `).run({
      user_id: userId,
      ...summary,
      raw_json: summary.raw_json ? JSON.stringify(summary.raw_json) : null,
    });
  }

  function saveStravaStreams(userId, activityId, streamsByType) {
    const stmt = db.prepare(`
      INSERT INTO strava_streams (
        user_id, activity_id, stream_type,
        series_type, resolution, data_json, samples_count,
        created_at
      ) VALUES (
        @user_id, @activity_id, @stream_type,
        @series_type, @resolution, @data_json, @samples_count,
        datetime('now')
      )
      ON CONFLICT(user_id, activity_id, stream_type) DO UPDATE SET
        series_type = excluded.series_type,
        resolution = excluded.resolution,
        data_json = excluded.data_json,
        samples_count = excluded.samples_count
    `);

    for (const [type, stream] of Object.entries(streamsByType || {})) {
      const data = Array.isArray(stream.data) ? stream.data : [];
      stmt.run({
        user_id: userId,
        activity_id: String(activityId),
        stream_type: type,
        series_type: stream.series_type || null,
        resolution: stream.resolution || null,
        data_json: JSON.stringify(data),
        samples_count: data.length,
      });
    }
  }

  function computePowerCurvePoints(streams, windowsSec) {
    const watts = streams.watts?.data || [];
    const hr = streams.heartrate?.data || [];
    const timeStream = streams.time?.data || null;

    if (!watts.length) return [];

    const dt = 1; // נניח 1Hz אם אין time מפורש
    const res = [];

    for (const window_s of windowsSec) {
      const windowSamples = Math.round(window_s / dt);
      if (windowSamples <= 0 || windowSamples > watts.length) continue;

      let windowSum = watts.slice(0, windowSamples).reduce((a, b) => a + b, 0);
      let bestAvg = windowSum / windowSamples;
      let bestIdx = 0;

      for (let i = windowSamples; i < watts.length; i++) {
        windowSum += watts[i] - watts[i - windowSamples];
        const avg = windowSum / windowSamples;
        if (avg > bestAvg) {
          bestAvg = avg;
          bestIdx = i - windowSamples + 1;
        }
      }

      let hrAvg = null;
      if (hr.length === watts.length && hr.length > 0) {
        const slice = hr.slice(bestIdx, bestIdx + windowSamples);
        hrAvg = slice.reduce((a, b) => a + b, 0) / slice.length;
      }

      const startOffset_s =
        timeStream && timeStream.length === watts.length
          ? timeStream[bestIdx]
          : bestIdx * dt;

      res.push({
        window_s,
        best_power: bestAvg,
        best_hr: hrAvg,
        start_offset_s: startOffset_s,
      });
    }

    return res;
  }

  function savePowerCurves(userId, activityId, curvePoints) {
    const stmt = db.prepare(`
      INSERT INTO power_curves (
        user_id, activity_id, window_s,
        best_power, best_hr, start_offset_s,
        created_at
      ) VALUES (
        @user_id, @activity_id, @window_s,
        @best_power, @best_hr, @start_offset_s,
        datetime('now')
      )
      ON CONFLICT(user_id, activity_id, window_s) DO UPDATE SET
        best_power = excluded.best_power,
        best_hr = excluded.best_hr,
        start_offset_s = excluded.start_offset_s
    `);

    for (const p of curvePoints || []) {
      stmt.run({
        user_id: userId,
        activity_id: String(activityId),
        window_s: p.window_s,
        best_power: p.best_power,
        best_hr: p.best_hr ?? null,
        start_offset_s: p.start_offset_s ?? null,
      });
    }
  }

  function average(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }



  function median(arr) {
    if (!arr || !arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }


  const CYCLING_TYPES = [
    "Ride",
    "EBikeRide",
    "VirtualRide",
    "GravelRide",
    "MountainBikeRide",
  ];

  // ---------- Public API ----------
  return {
    // Users
    async getUser(userId) {
      return getJson("users", userId);
    },

    async saveUser(user) {
      if (!user || !user.id) {
        throw new Error("saveUser: user.id is required");
      }
      saveJson("users", user.id, user);
    },

    // Training params
    async getTrainingParams(userId) {
      return getJson("training_params", userId);
    },

    async saveTrainingParams(params) {
      if (!params || !params.userId) {
        throw new Error("saveTrainingParams: params.userId is required");
      }
      saveJson("training_params", params.userId, params);
    },

    // Weekly template
    async getWeeklyTemplate(userId) {
      return getJson("weekly_templates", userId);
    },

    async saveWeeklyTemplate(template) {
      if (!template || !template.userId) {
        throw new Error("saveWeeklyTemplate: template.userId is required");
      }
      saveJson("weekly_templates", template.userId, template);
    },

    // Goals
    async getActiveGoal(userId) {
      const row = db
        .prepare(`
          SELECT id, user_id, type, description, is_active, created_at, updated_at
          FROM goals
          WHERE user_id = ? AND is_active = 1
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(userId);

      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        type: row.type,
        description: row.description,
        isActive: !!row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async createGoal(goal) {
      const info = db
        .prepare(`
          INSERT INTO goals (user_id, type, description, is_active, created_at, updated_at)
          VALUES (@user_id, @type, @description, 1, datetime('now'), datetime('now'))
        `)
        .run({
          user_id: goal.userId,
          type: goal.type || "text",
          description: goal.description || "",
        });

      return {
        id: info.lastInsertRowid,
        ...goal,
        isActive: true,
      };
    },

    async archiveGoal(goalId) {
      db.prepare(`
        UPDATE goals
        SET is_active = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(goalId);
    },

    // Onboarding state
    async getOnboarding(userId) {
      return getJson("onboarding_states", userId);
    },

    async saveOnboarding(onboarding) {
      if (!onboarding || !onboarding.userId) {
        throw new Error("saveOnboarding: onboarding.userId is required");
      }
      saveJson("onboarding_states", onboarding.userId, onboarding);
    },

    // Strava connection
    async hasStravaConnection(userId) {
      const tokens = getStravaTokens && getStravaTokens(userId);
      return !!(tokens && tokens.access_token);
    },

    /**
     * Full flow:
     * 1. Fetch Athlete + Activities (last 90 days, rides only)
     * 2. Fetch Streams for each ride (must have watts + heartrate)
     * 3. Save into strava_activities / strava_streams / power_curves
     * 4. Return:
     *    - hrMaxCandidate
     *    - hrThresholdCandidate
     *    - ftp20 (Top3 20min)
     *    - ftpCp (CP מ-3 ו-20 דקות)
     *    - ftpPowerCurve (3min Top3 × 0.8)
     *    - ftpFromStrava
     *    - ftpRecommended (מדיָן המועמדים)
     *    - trainingSummary (avgHoursPerWeek, rides_count)
     *    - userWeightKg
     */
    async computeHrAndFtpFromStrava(userId) {
      const tokens = getStravaTokens && getStravaTokens(userId);
      if (!tokens || !tokens.access_token) {
        console.log("computeHrAndFtpFromStrava: no tokens, abort");
        return {};
      }
      const accessToken = tokens.access_token;

      // 1. Athlete
      const athlete = await fetchJson(
        "https://www.strava.com/api/v3/athlete",
        accessToken
      );

      // 2. Activities (raw)
      const acts = await fetchJson(
        "https://www.strava.com/api/v3/athlete/activities?per_page=200",
        accessToken
      );

      const now = Date.now();
      const cutoff = now - 90 * 24 * 60 * 60 * 1000;

      // keep only recent RIDES
      const recentActs = (acts || []).filter((a) => {
        const t = new Date(a.start_date).getTime();
        const isRide = CYCLING_TYPES.includes(a.type);
        return t >= cutoff && isRide;
      });

      console.log(
        "computeHrAndFtpFromStrava: total activities:",
        acts ? acts.length : 0,
        "recent rides (90d):",
        recentActs.length
      );

      const POWER_WINDOWS_S = [60, 180, 300, 480, 1200];

      // 3. ingestion per activity
      for (const act of recentActs) {
        try {
          console.log(
            "computeHrAndFtpFromStrava: ingesting activity",
            act.id,
            act.name,
            act.type
          );

          const streams = await fetchActivityStreams(userId, act.id, accessToken);

          // require both heart rate and power data
          const hasHr =
            streams &&
            streams.heartrate &&
            Array.isArray(streams.heartrate.data) &&
            streams.heartrate.data.length > 0;
          const hasWatts =
            streams &&
            streams.watts &&
            Array.isArray(streams.watts.data) &&
            streams.watts.data.length > 0;

          if (!hasHr || !hasWatts) {
            console.log(
              "computeHrAndFtpFromStrava: skipping activity (no HR or no watts)",
              act.id,
              { hasHr, hasWatts }
            );
            continue;
          }

          const summary = computeSummaryFromStreams(act, streams);
          const curves = computePowerCurvePoints(streams, POWER_WINDOWS_S);

          saveStravaActivitySummary(userId, summary);
          saveStravaStreams(userId, act.id, streams);
          savePowerCurves(userId, act.id, curves);

          console.log(
            "computeHrAndFtpFromStrava: saved activity",
            act.id,
            "curves:",
            curves.length
          );
        } catch (e) {
          console.error(
            "computeHrAndFtpFromStrava ingestion error:",
            act.id,
            e
          );
        }
      }

      // 4. HRmax candidate – from max_hr in 180 days (rides only, עם נתוני דופק)
            // 4. HRmax candidate – Top3 מה-180 ימים האחרונים, רק רכיבות אופניים
      const hrRows = db
        .prepare(`
          SELECT max_hr
          FROM strava_activities
          WHERE user_id = ?
            AND datetime(start_date) >= datetime('now', '-180 days')
            AND avg_hr IS NOT NULL
            AND max_hr IS NOT NULL
            AND type IN ('Ride','EBikeRide','VirtualRide','GravelRide','MountainBikeRide')
          ORDER BY max_hr DESC
          LIMIT 3
        `)
        .all(userId);

      const hrValues = hrRows
        .map((r) => r.max_hr)
        .filter((v) => typeof v === "number" && v > 0);

      const hrMaxTop3 = hrValues;
      const hrMaxCandidate =
        hrValues.length > 0 ? Math.round(median(hrValues)) : null;

      const hrThresholdCandidate =
        hrMaxCandidate != null ? Math.round(hrMaxCandidate * 0.9) : null;


      // 5. FTP models from power_curves (rides with power + HR, last 90 days)
            // 5. FTP models from power_curves (rides with power + HR, last 90 days)
      const rows = db
        .prepare(`
          SELECT
            pc20.best_power AS p20,
            pc8.best_power  AS p8,
            pc3.best_power  AS p3
          FROM strava_activities a
          LEFT JOIN power_curves pc20
            ON pc20.user_id = a.user_id
           AND pc20.activity_id = a.activity_id
           AND pc20.window_s = 1200   -- 20min
          LEFT JOIN power_curves pc8
            ON pc8.user_id = a.user_id
           AND pc8.activity_id = a.activity_id
           AND pc8.window_s = 480    -- 8min (אם יחושב בעתיד)
          LEFT JOIN power_curves pc3
            ON pc3.user_id = a.user_id
           AND pc3.activity_id = a.activity_id
           AND pc3.window_s = 180    -- 3min
          WHERE a.user_id = ?
            AND datetime(a.start_date) >= datetime('now', '-90 days')
            AND a.avg_power IS NOT NULL
            AND a.avg_hr    IS NOT NULL
            AND a.type IN ('Ride','VirtualRide','GravelRide','MountainBikeRide','EBikeRide')
        `)
        .all(userId);

      const p20List = rows
        .map((r) => r.p20)
        .filter((v) => typeof v === "number" && v > 50);
      const p8List = rows
        .map((r) => r.p8)
        .filter((v) => typeof v === "number" && v > 50);
      const p3List = rows
        .map((r) => r.p3)
        .filter((v) => typeof v === "number" && v > 50);

      const p20Top3 = [...p20List].sort((a, b) => b - a).slice(0, 3);
      const p8Top3  = [...p8List].sort((a, b) => b - a).slice(0, 3);
      const p3Top3  = [...p3List].sort((a, b) => b - a).slice(0, 3);

      // מודל 20 דקות – Top3
      const ftp20 =
        p20Top3.length > 0 ? Math.round(average(p20Top3) * 0.95) : null;

      // מודל PowerCurve פשוט – 3 דקות × 0.8, Top3
      let ftpPowerCurve = null;
      if (p3Top3.length > 0) {
        ftpPowerCurve = Math.round(average(p3Top3) * 0.8);
      }

      // מודל CP מלא – מ-3 ו-20 דקות (Top3)
      let ftpCp = null;
      if (p3Top3.length > 0 && p20Top3.length > 0) {
        const P3  = average(p3Top3);
        const P20 = average(p20Top3);
        const t3  = 180;
        const t20 = 1200;
        const cp  = (P20 * t20 - P3 * t3) / (t20 - t3);
        if (cp && isFinite(cp)) {
          ftpCp = Math.round(cp);
        }
      } else if (p8Top3.length > 0) {
        // fallback – אם בעתיד נוסיף חישוב 8 דקות
        ftpCp = Math.round(average(p8Top3) * 0.9);
      }

      const ftpFromStrava =
        typeof athlete?.ftp === "number" ? athlete.ftp : null;

      // מועמדים סבירים ל-FTP
      const ftpCandidates = [];
      if (typeof ftp20 === "number" && ftp20 > 50) ftpCandidates.push(ftp20);
      if (typeof ftpCp === "number" && ftpCp > 50) ftpCandidates.push(ftpCp);
      if (typeof ftpFromStrava === "number" && ftpFromStrava > 50) {
        ftpCandidates.push(ftpFromStrava);
      }

      const ftpRecommended =
        ftpCandidates.length > 0 ? Math.round(median(ftpCandidates)) : null;

      // נאסוף את המודלים בצורה נוחה לאונבורדר
      const ftpModels = {
        ftp20,
        ftpCp,
        ftpPowerCurve,
        ftpFromStrava,
        ftpRecommended,
        p20Top3,
        p3Top3,
        p8Top3,
      };

      const hrModels = {
        hrMaxCandidate,
        hrMaxTop3,
        hrThresholdCandidate,
      };


      // 6. Training volume (rides only, last 90 days, עם דופק ווואטים)
      const tsRow = db
        .prepare(`
          SELECT
            SUM(moving_time_s) AS total_time_s,
            COUNT(*) AS rides_count
          FROM strava_activities
          WHERE user_id = ?
            AND datetime(start_date) >= datetime('now', '-90 days')
            AND avg_power IS NOT NULL
            AND avg_hr    IS NOT NULL
            AND type IN ('Ride','EBikeRide','VirtualRide','GravelRide','MountainBikeRide')
        `)
        .get(userId);

      let trainingSummary = null;
      if (tsRow && tsRow.total_time_s) {
        const hours = tsRow.total_time_s / 3600;
        const weeks = 90 / 7;
        trainingSummary = {
          avgHoursPerWeek: hours / weeks,
          rides_count: tsRow.rides_count,
        };
      }

      const userWeightKg =
        typeof athlete?.weight === "number" ? athlete.weight : null;

        return {
        hrMaxCandidate,
        hrMaxTop3,
        hrThresholdCandidate,
        ftp20,
        ftpCp,
        ftpPowerCurve,
        ftpFromStrava,
        ftpRecommended,
        ftpModels,
        hrModels,
        userWeightKg,
        trainingSummary,
      };

    },
  };
}
