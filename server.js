// server.js – LOEW backend (Render-ready) with Strava token persistence + refresh

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import Database from "better-sqlite3";

import { StravaClient } from "./stravaClient.js";
import { StravaIngestService } from "./stravaIngest.js";
import { OnboardingEngine } from "./onboardingEngine.js";
import { createDbImpl } from "./dbSqlite.js";

dotenv.config();

/* ---------------- BASIC APP SETUP ---------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------------- STRAVA TOKEN DB (PERSISTENCE) ---------------- */

const tokenDb = new Database("loew.db");
tokenDb.pragma("journal_mode = WAL");

tokenDb.exec(`
  CREATE TABLE IF NOT EXISTS strava_tokens (
    user_id       TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    INTEGER,
    token_type    TEXT,
    scope         TEXT,
    raw_json      TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );
`);

function saveStravaTokensToDb(userId, tokenJson) {
  const {
    access_token,
    refresh_token,
    expires_at,
    token_type,
    scope,
  } = tokenJson || {};

  const raw_json = JSON.stringify(tokenJson || {});

  tokenDb
    .prepare(
      `
      INSERT INTO strava_tokens (user_id, access_token, refresh_token, expires_at, token_type, scope, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at    = excluded.expires_at,
        token_type    = excluded.token_type,
        scope         = excluded.scope,
        raw_json      = excluded.raw_json,
        updated_at    = datetime('now')
    `
    )
    .run(
      userId,
      access_token || null,
      refresh_token || null,
      expires_at || null,
      token_type || null,
      Array.isArray(scope) ? scope.join(",") : scope || null,
      raw_json
    );
}

function loadStravaTokensFromDb(userId) {
  const row = tokenDb
    .prepare(`SELECT * FROM strava_tokens WHERE user_id = ?`)
    .get(userId);
  if (!row) return null;

  let raw = {};
  if (row.raw_json) {
    try {
      raw = JSON.parse(row.raw_json);
    } catch {
      raw = {};
    }
  }

  return {
    ...raw,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
  };
}

/* ---------------- IN-MEMORY CACHE FOR TOKENS ---------------- */

const stravaTokensByUser = new Map();

/**
 * שומר במפה + DB
 */
function setStravaTokens(userId, tokenJson) {
  if (!tokenJson) return;
  stravaTokensByUser.set(userId, tokenJson);
  saveStravaTokensToDb(userId, tokenJson);
}

/**
 * רענון טוקן סטרבה באמצעות refresh_token
 */
async function refreshStravaTokens(oldTokens) {
  if (!oldTokens || !oldTokens.refresh_token) {
    throw new Error("No refresh_token available for Strava");
  }

  const resp = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: oldTokens.refresh_token,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error("Strava refresh_token error:", json);
    throw new Error("Failed to refresh Strava token");
  }

  return json; // כולל access_token חדש, refresh_token חדש, expires_at וכו'
}

/**
 * פונקציה שה-StravaClient יקבל:
 *  - טוענת טוקנים מהזיכרון / DB
 *  - אם פג תוקף → מרעננת ומעדכנת DB + cache
 *  - מחזירה access_token תקף
 */
async function getAccessTokenForUser(userId) {
  let tokens = stravaTokensByUser.get(userId);

  if (!tokens) {
    tokens = loadStravaTokensFromDb(userId);
    if (!tokens) {
      throw new Error("No Strava tokens for this user: " + userId);
    }
    stravaTokensByUser.set(userId, tokens);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const margin = 60;

  if (tokens.expires_at && tokens.expires_at - margin <= nowSec) {
    // צריך לרענן
    console.log("Refreshing Strava token for user:", userId);
    const refreshed = await refreshStravaTokens(tokens);
    tokens = refreshed;
    setStravaTokens(userId, tokens);
  }

  if (!tokens.access_token) {
    throw new Error("No access_token in Strava tokens for user: " + userId);
  }

  return tokens.access_token;
}

/* ---------------- STRAVA SNAPSHOT HELPER ---------------- */

/**
 * Builder מהיר ל-snapshot מ-API של Strava.
 * כאן אנחנו מקבלים אובייקט tokens (או לפחות access_token בפנים).
 *
 * מחזיר:
 *  - training_summary
 *  - hr_max_from_data / hr_threshold_from_data
 *  - ftp_models (מבוסס FTP של סטרבה)
 *  - latest_activity, latest_activity_date, latest_activity_is_today
 *  - recent_activities (רשימת רכיבות אחרונות)
 */
async function buildStravaSnapshot(tokens) {
  if (!tokens || !tokens.access_token) return null;

  try {
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
    };

    // אתלט
    const athleteResp = await fetch("https://www.strava.com/api/v3/athlete", {
      headers,
    });
    if (!athleteResp.ok) {
      console.error("buildStravaSnapshot: athleteResp not ok");
      return null;
    }
    const athlete = await athleteResp.json();

    // פעילויות
    const actsResp = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=200",
      { headers }
    );
    if (!actsResp.ok) {
      console.error("buildStravaSnapshot: actsResp not ok");
      return null;
    }
    const acts = await actsResp.json();

    const nowMs = Date.now();
    const days90Ms = 90 * 24 * 60 * 60 * 1000;
    const cutoff = nowMs - days90Ms;

    const acts90 = (acts || []).filter((a) => {
      const t = new Date(a.start_date).getTime();
      return t >= cutoff;
    });

    // ----- HR max & threshold -----
    let hrMaxFromData = null;
    for (const a of acts90) {
      if (a.has_heartrate && typeof a.max_heartrate === "number") {
        if (!hrMaxFromData || a.max_heartrate > hrMaxFromData) {
          hrMaxFromData = a.max_heartrate;
        }
      }
    }

    let hrThresholdFromData = null;
    if (hrMaxFromData) {
      hrThresholdFromData = Math.round(hrMaxFromData * 0.9);
    }

    // ----- סיכום נפח 90 יום -----
    const totalSeconds = acts90.reduce(
      (sum, a) => sum + (a.moving_time || 0),
      0
    );
    const totalHours = totalSeconds / 3600;
    const totalDistanceKm =
      acts90.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const totalElevationM = acts90.reduce(
      (s, a) => s + (a.total_elevation_gain || 0),
      0
    );

    const daysWindow = 90;
    const avgHoursPerWeek = (totalHours / daysWindow) * 7;

    const trainingSummary = {
      windowDays: daysWindow,
      totalHours,
      totalDistanceKm,
      totalElevationM,
      avgHoursPerWeek,
    };

    // ----- FTP בסיסי -----
    const ftpFromStrava =
      typeof athlete.ftp === "number" ? athlete.ftp : null;

    let ftpFrom20min = null;
    let ftpFrom8min = null;
    let ftpFrom3min = null;

    if (ftpFromStrava) {
      ftpFrom20min = ftpFromStrava;
      ftpFrom8min = Math.round(ftpFromStrava * 1.04);
      ftpFrom3min = Math.round(ftpFromStrava * 1.08);
    }

    const ftpModels = {
      from_20min: ftpFrom20min,
      from_8min: ftpFrom8min,
      from_3min: ftpFrom3min,
    };

    const ftpFromStreams = null; // הלוגיקה המלאה יושבת ב-dbSqlite/StravaIngest

    // ----- הרכיבה האחרונה + רשימת רכיבות -----

    const sortedActs = (acts || [])
      .slice()
      .sort(
        (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
      );

    let latestActivity = null;
    let latestActivityDate = null;
    let latestActivityIsToday = false;

    if (sortedActs.length > 0) {
      const latest = sortedActs[0];
      const latestDate = new Date(latest.start_date);
      latestActivityDate = latestDate.toISOString();

      const now = new Date();
      const sameDay =
        latestDate.getUTCFullYear() === now.getUTCFullYear() &&
        latestDate.getUTCMonth() === now.getUTCMonth() &&
        latestDate.getUTCDate() === now.getUTCDate();

      latestActivityIsToday = sameDay;

      latestActivity = {
        id: latest.id,
        name: latest.name,
        start_date: latest.start_date,
        distance_km: latest.distance ? latest.distance / 1000 : null,
        moving_time_s: latest.moving_time || null,
        total_elevation_m: latest.total_elevation_gain || null,
        average_power:
          typeof latest.average_watts === "number" ? latest.average_watts : null,
        max_power:
          typeof latest.max_watts === "number" ? latest.max_watts : null,
        average_heartrate: latest.average_heartrate || null,
        max_heartrate: latest.max_heartrate || null,
        has_heartrate: !!latest.has_heartrate,
        type: latest.sport_type || latest.type || null,
      };
    }

    const recentActivities = sortedActs.slice(0, 30).map((a) => ({
      id: a.id,
      name: a.name,
      start_date: a.start_date,
      distance_km: a.distance ? a.distance / 1000 : null,
      moving_time_s: a.moving_time || null,
      total_elevation_m: a.total_elevation_gain || null,
      average_power:
        typeof a.average_watts === "number" ? a.average_watts : null,
      max_power:
        typeof a.max_watts === "number" ? a.max_watts : null,
      average_heartrate: a.average_heartrate || null,
      max_heartrate: a.max_heartrate || null,
      has_heartrate: !!a.has_heartrate,
      type: a.sport_type || a.type || null,
    }));

    return {
      user_from_strava: {
        name: `${athlete.firstname || ""} ${athlete.lastname || ""}`.trim(),
        weight_kg: athlete.weight || null,
        sex: athlete.sex || null,
      },
      training_summary: trainingSummary,
      hr_max_from_data: hrMaxFromData,
      hr_threshold_from_data: hrThresholdFromData,
      ftp_from_strava: ftpFromStrava,
      ftp_from_streams: ftpFromStreams,
      ftp_models: ftpModels,

      latest_activity: latestActivity,
      latest_activity_date: latestActivityDate,
      latest_activity_is_today: latestActivityIsToday,
      recent_activities: recentActivities,
    };
  } catch (err) {
    console.error("buildStravaSnapshot error:", err);
    return null;
  }
}

/* ---------------- DB IMPL + STRAVA CLIENT + INGEST + ONBOARDING ---------------- */

const dbImpl = createDbImpl({
  // dbSqlite עדיין משתמש ב-getStravaTokens (למשל ל-computeHrAndFtpFromStrava)
  // כאן נשאיר את זה כמפה בזיכרון – כי אחרי /exchange_token אנחנו ממלאים אותה.
  getStravaTokens: (userId) => stravaTokensByUser.get(userId) || null,
  buildStravaSnapshot,
});

// Strava client – עכשיו מקבל פונקציה שמטפלת בטוקן + רענון + DB
const stravaClient = new StravaClient(getAccessTokenForUser);

// שירות ingest – אחראי למשוך פעילויות וסטראימים ולעדכן DB
const stravaIngest = new StravaIngestService(stravaClient);

// מנוע אונבורדינג
const onboardingEngine = new OnboardingEngine(dbImpl);

/* ---------------- GENERAL CONSTANTS ---------------- */

const DEFAULT_USER_ID = "loew_single_user";

const LOEW_ASSISTANT_SYSTEM_PROMPT = `
You are LOEW, a world-class cycling coach, AND also a general-purpose AI assistant (like ChatGPT).

General behavior:
- Always answer in the same language the user used (Hebrew or any other).
- Be clear, structured, and concise.
- Use a friendly, confident, grounded tone.

When the user asks about cycling, training, FTP, heart rate, Strava, recovery or planning rides:
- Act as LOEW the coach.
- Give practical, concrete workout guidance with specific heart-rate and/or power targets.
- Prefer simple workouts that are easy to remember (not too many parts).
- Make sure the plan fits into the rider's real life (time constraints, fatigue, recovery).
- Be conservative and safe, especially after illness, injury or long breaks.

You may receive a "Context JSON" in a system message. It can include:
- message: the raw user text (for reference).
- snapshot: recent Strava metrics or training summary.
- trainingParams: FTP, hrMax, hrThreshold, etc., if known.
- weeklyTemplate: typical weekly schedule, if known.
- goal: main goal (e.g., Gran Fondo, event date, target FTP).

Treat this JSON as background context only.
The real user question is always the last user message in the conversation.
Never mention "JSON", "payload" or field names explicitly to the user.

If the Context JSON.snapshot contains ride-related fields like:
- latest_activity, latest_activity_date, latest_activity_is_today
- recent_activities (an array of recent rides with dates and metrics),

then:
- When the user asks if you have today's ride, or about "the last ride",
  use latest_activity and latest_activity_is_today to answer clearly.
  Explicitly say up to which date/time you have data and give a short summary
  (duration, distance, elevation, average power and heart rate if available).

- When the user asks to analyse a specific ride by date
  (for example: "תנתח לי את הרכיבה מ-2025-11-30"),
  scan recent_activities for a ride whose start_date falls on that calendar day
  (ignore time-of-day). If found, base your analysis on its metrics
  (distance_km, moving_time_s, total_elevation_m, average_power, max_power,
   average_heartrate, max_heartrate). If not found, say you don't have that ride
   and explain which date range you do have Strava data for.

When the user asks about anything else (code, emails, work, explanations, relationships, life questions, etc.):
- Behave like a normal, smart, general-purpose assistant.
- Still keep answers concise, helpful, and well-structured.
`;

function isCyclingRelated(message) {
  const text = (message || "").toLowerCase();

  const keywords = [
    "bike",
    "ride",
    "cycling",
    "training",
    "interval",
    "ftp",
    "watt",
    "watts",
    "heart rate",
    "strava",
    "gran fondo",
    "mtb",
    "road ride",
    "trainer",
    "zwift",
    // עברית
    "אימון",
    "אימונים",
    "אופניים",
    "רכיבה",
    "עליה",
    "עליות",
    "וואט",
    "וואטים",
    "דופק",
    "סטרבה",
    "גרן פונדו",
    "טריינר",
    "קצב",
    "ספרינט",
    "זון",
    "זונ",
  ];

  return keywords.some((kw) => text.includes(kw));
}

/* ---------------- STRAVA AUTH ---------------- */

app.get("/auth/strava", (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  const userId = req.query.userId || DEFAULT_USER_ID;

  if (!clientId || !redirectUri) {
    console.error("Missing STRAVA_CLIENT_ID or STRAVA_REDIRECT_URI in .env");
    return res.status(500).send("Strava not configured");
  }

  const url =
    "https://www.strava.com/oauth/mobile/authorize" +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&approval_prompt=auto` +
    `&scope=read,activity:read_all,profile:read_all` +
    `&state=${encodeURIComponent(userId)}`;

  res.redirect(url);
});

app.get("/exchange_token", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state;
    const userId = state || DEFAULT_USER_ID;

    if (!code) {
      console.error("Missing code from Strava");
      return res.status(400).send("Missing code");
    }

    const tokenResp = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    const json = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("Strava token error:", json);
      return res.status(500).send("Strava auth failed");
    }

    // שמירה במפה + DB
    setStravaTokens(userId, json);
    console.log("Strava tokens saved for user:", userId);

    // עדכון מנוע האונבורדינג (יגרור גם ingest ו-computeHrAndFtpFromStrava)
    await onboardingEngine.handleStravaConnected(userId);

    return res.redirect(
      `/?strava=connected&userId=${encodeURIComponent(userId)}`
    );
  } catch (err) {
    console.error("Strava /exchange_token error:", err);
    res.status(500).send("Strava auth failed");
  }
});

/* ---------------- STRAVA SNAPSHOT API ---------------- */

app.post("/api/loew/strava-snapshot", async (req, res) => {
  try {
    const { userId: bodyUserId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    let tokens = stravaTokensByUser.get(userId);
    if (!tokens) {
      // ננסה לטעון מה-DB
      const fromDb = loadStravaTokensFromDb(userId);
      if (!fromDb) {
        return res.status(400).json({
          ok: false,
          error:
            "No Strava tokens for this user. Please connect Strava first.",
        });
      }
      tokens = fromDb;
      stravaTokensByUser.set(userId, tokens);
    }

    const snapshot = await buildStravaSnapshot(tokens);
    if (!snapshot) {
      return res
        .status(500)
        .json({ ok: false, error: "Failed to build Strava snapshot" });
    }

    return res.json({ ok: true, snapshot, userId });
  } catch (err) {
    console.error("/api/loew/strava-snapshot error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Strava snapshot failed on server" });
  }
});

/* ---------------- ADVANCED LOAD & ANALYTICS API ---------------- */

/**
 * עומס שבועי – מחזיר רשימת שבועות עם:
 * weekStart, totalTimeHours, ridesCount, tssLike
 */
app.post("/api/loew/weekly-load", async (req, res) => {
  try {
    const { userId: bodyUserId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    const weeklyLoad = await dbImpl.getWeeklyLoad(userId, 6);
    return res.json({ ok: true, userId, weeklyLoad });
  } catch (err) {
    console.error("/api/loew/weekly-load error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Weekly load failed on server" });
  }
});

/**
 * הרכיבה האחרונה מתוך DB סטרבה
 */
app.post("/api/loew/latest-ride", async (req, res) => {
  try {
    const { userId: bodyUserId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    const latestRide = await dbImpl.getLatestActivitySummary(userId);
    if (!latestRide) {
      return res.json({
        ok: false,
        userId,
        error: "No activities found for this user",
      });
    }

    return res.json({ ok: true, userId, latestRide });
  } catch (err) {
    console.error("/api/loew/latest-ride error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Latest ride failed on server" });
  }
});

/**
 * Drift (HR decoupling) לרכיבה מסוימת
 * body: { userId, activityId }
 */
app.post("/api/loew/drift", async (req, res) => {
  try {
    const { userId: bodyUserId, activityId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    if (!activityId) {
      return res
        .status(400)
        .json({ ok: false, error: "activityId is required" });
    }

    const drift = await dbImpl.getDriftForActivity(userId, activityId);
    if (!drift) {
      return res.json({
        ok: false,
        userId,
        activityId,
        error: "No drift data for this activity",
      });
    }

    return res.json({ ok: true, userId, drift });
  } catch (err) {
    console.error("/api/loew/drift error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Drift analysis failed on server" });
  }
});

/**
 * Execution Score – ציון ביצוע לאימון בודד
 * body: { userId, activityId }
 */
app.post("/api/loew/execution-score", async (req, res) => {
  try {
    const { userId: bodyUserId, activityId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    if (!activityId) {
      return res
        .status(400)
        .json({ ok: false, error: "activityId is required" });
    }

    const score = await dbImpl.getExecutionScoreForActivity(userId, activityId);
    if (!score) {
      return res.json({
        ok: false,
        userId,
        activityId,
        error: "No execution score for this activity",
      });
    }

    return res.json({ ok: true, userId, score });
  } catch (err) {
    console.error("/api/loew/execution-score error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Execution score failed on server" });
  }
});


/* ---------------- STRAVA WEBHOOKS ---------------- */

app.get("/strava/webhook", (req, res) => {
  try {
    const challenge = req.query["hub.challenge"];
    const verifyToken = req.query["hub.verify_token"];
    const expectedToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;

    if (!challenge) {
      console.warn("Strava webhook verification: missing hub.challenge");
      return res.status(400).send("Missing hub.challenge");
    }

    if (expectedToken && verifyToken !== expectedToken) {
      console.warn(
        "Strava webhook verification failed: invalid verify_token",
        verifyToken
      );
      return res.status(403).send("Invalid verify_token");
    }

    console.log("Strava webhook verified successfully");
    return res.status(200).json({ "hub.challenge": challenge });
  } catch (err) {
    console.error("Strava webhook verification error:", err);
    return res.status(500).send("Verification error");
  }
});

app.post("/strava/webhook", async (req, res) => {
  const event = req.body || {};
  console.log("Strava webhook event:", JSON.stringify(event));

  res.status(200).json({ ok: true });

  try {
    if (event.object_type === "activity" && event.aspect_type === "create") {
      const activityId = event.object_id;
      const athleteId = event.owner_id;

      console.log(
        `Webhook: new activity ${activityId} from athlete ${athleteId}`
      );

      const userId = DEFAULT_USER_ID; // אם תרצה: למפות athleteId -> userId בטבלה

      await stravaIngest.ingestActivity(userId, activityId);
      console.log("Ingested via webhook:", activityId);

      try {
        const metrics = await dbImpl.computeHrAndFtpFromStrava(userId);
        console.log("Recomputed HR/FTP from webhook:", {
          hrMax: metrics?.hrMaxCandidate,
          hrThreshold: metrics?.hrThresholdCandidate,
          ftpRecommended: metrics?.ftpRecommended,
        });
      } catch (err) {
        console.error(
          "Error while recomputing metrics from Strava after webhook:",
          err
        );
      }
    } else {
      console.log(
        "Strava webhook: event ignored (not activity/create):",
        event.object_type,
        event.aspect_type
      );
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

/* ---------------- CHAT API (LOEW + GENERAL ASSISTANT) ---------------- */

const conversations = new Map();

app.post("/api/loew/chat", async (req, res) => {
  try {
    const body = req.body ?? {};
    const message = body.message || "";
    const snapshot = body.snapshot || null;
    const bodyUserId = body.userId || null;

    const userId = bodyUserId || DEFAULT_USER_ID;
    const text = message || "";

    const obState = await dbImpl.getOnboarding(userId);
    const onboardingDone = obState && obState.onboardingCompleted;
    const cyclingRelated = isCyclingRelated(text);

    if (!onboardingDone && cyclingRelated) {
      const reply = await onboardingEngine.handleMessage(userId, text);

      return res.json({
        ok: true,
        reply: reply.text,
        onboarding: true,
        done: !!reply.done,
        userId,
      });
    }

    const trainingParams = await dbImpl.getTrainingParams(userId);
    const weeklyTemplate = await dbImpl.getWeeklyTemplate(userId);
    const goal = await dbImpl.getActiveGoal(userId);

    const contextPayload = {
      message: text,
      snapshot: snapshot || null,
      trainingParams: trainingParams || null,
      weeklyTemplate: weeklyTemplate || null,
      goal: goal || null,
    };

    let history = conversations.get(userId);
    if (!history) {
      history = [];
      conversations.set(userId, history);
    }

    history.push({ role: "user", content: text });

    const messages = [
      { role: "system", content: LOEW_ASSISTANT_SYSTEM_PROMPT },
      {
        role: "system",
        content: "Context JSON:\n" + JSON.stringify(contextPayload),
      },
      ...history,
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
    });

    const replyText =
      completion.choices[0]?.message?.content || "לא הצלחתי לענות כרגע.";

    history.push({ role: "assistant", content: replyText });

    return res.json({
      ok: true,
      reply: replyText,
      onboarding: false,
      userId,
    });
  } catch (err) {
    console.error("unified chat error:", err);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(port, () => {
  console.log(`LOEW server listening on port ${port}`);
});
