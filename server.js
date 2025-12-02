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

const CYCLING_TYPES = [
  "Ride",
  "EBikeRide",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
];


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
 * מחזיר:
 *  - training_summary
 *  - hr_max_from_data / hr_threshold_from_data
 *  - ftp_models (מבוסס FTP של סטרבה)
 *  - latest_activity, latest_activity_date, latest_activity_is_today
 *  - recent_activities (רשימת רכיבות אחרונות)
 */
async function buildStravaSnapshot(tokens) {
  if (!tokens || !tokens.access_token) {
    return { ok: false, error: "No Strava tokens" };
  }

  const accessToken = tokens.access_token;

  const [athlete, acts] = await Promise.all([
    fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json()),
    fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=200",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then((r) => r.json()),
  ]);

  const now = Date.now();
  const cutoff90 = now - 90 * 24 * 60 * 60 * 1000;

  const acts90 = (acts || []).filter((a) => {
    const t = new Date(a.start_date).getTime();
    return t >= cutoff90;
  });

  const rides90 = acts90.filter((a) =>
    CYCLING_TYPES.includes(a.sport_type || a.type || "")
  );

  const total_time_s = rides90.reduce(
    (acc, a) => acc + (a.moving_time || 0),
    0
  );
  const total_dist_m = rides90.reduce(
    (acc, a) => acc + (a.distance || 0),
    0
  );
  const total_elev_m = rides90.reduce(
    (acc, a) => acc + (a.total_elevation_gain || 0),
    0
  );

  const weeks = 90 / 7;
  const total_hours = total_time_s / 3600;
  const total_rides = rides90.length;
  const avg_hours_per_week = weeks > 0 ? total_hours / weeks : 0;
  const rides_per_week = weeks > 0 ? total_rides / weeks : 0;

  // חישוב זמני רכיבה: מינימום/ממוצע/מקסימום
  const durationsMin = rides90
    .map((a) => (a.moving_time || 0) / 60)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  let avgRideMinutes = null;
  let minRideMinutesCandidate = null;
  let maxRideMinutesCandidate = null;
  let ridesSampleCount = 0;

  if (durationsMin.length) {
    ridesSampleCount = durationsMin.length;
    const sum = durationsMin.reduce((a, b) => a + b, 0);
    avgRideMinutes = sum / durationsMin.length;

    const shortest3 = durationsMin.slice(0, Math.min(3, durationsMin.length));
    const longest3 = durationsMin.slice(
      Math.max(durationsMin.length - 3, 0)
    );

    const medianLocal = (arr) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[mid];
      return (sorted[mid - 1] + sorted[mid]) / 2;
    };

    minRideMinutesCandidate = medianLocal(shortest3);
    maxRideMinutesCandidate = medianLocal(longest3);
  }

  const training_summary = {
    total_time_s,
    total_dist_m,
    total_elev_m,
    total_rides,
    total_hours,
    avg_hours_per_week,
    rides_per_week,
    avg_ride_minutes: avgRideMinutes,
    min_ride_minutes_candidate: minRideMinutesCandidate,
    max_ride_minutes_candidate: maxRideMinutesCandidate,
    rides_sample_count: ridesSampleCount,
  };

  return {
    ok: true,
    athlete: {
      id: athlete.id,
      username: athlete.username,
      firstname: athlete.firstname,
      lastname: athlete.lastname,
      sex: athlete.sex,
      weight: athlete.weight,
      ftp: athlete.ftp,
    },
    training_summary,
    raw_activities_90d: acts90,
  };
}


/* ---------------- DB IMPL + STRAVA SERVICES + ONBOARDING ---------------- */

const dbImpl = createDbImpl({
  // dbSqlite עדיין משתמש ב-getStravaTokens (למשל ל-computeHrAndFtpFromStrava)
  getStravaTokens: (userId) => stravaTokensByUser.get(userId) || null,
  buildStravaSnapshot,
});

// Strava client – מקבל פונקציה שמטפלת בטוקן + רענון + DB
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

- אם ב-Context קיים אובייקט rideDurationStats עם
  avgRideMinutes, minRideMinutesCandidate, maxRideMinutesCandidate:
  השתמש בערכים האלה כדי לקבוע זמני אימון ריאליים.
  אל תציע אימונים קצרים בהרבה מ-minRideMinutesCandidate
  אלא אם הרוכב מבקש במפורש "אימון קצר" או "Recovery",
  ובאימונים רגילים כוון לאורך שנמצא בין המינימום למקסימום.


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
`;

/* ---------------- HELPERS ---------------- */

function isCyclingRelated(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const keywords = [
    "אימון",
    "אימונים",
    "אופניים",
    "רכיבה",
    "ftp",
    "וואט",
    "watt",
    "זון",
    "zones",
    "מאמן",
    "strava",
    "סטרבה",
  ];
  return keywords.some((k) => t.includes(k));
}

/* ---------------- ROOT & STATIC ---------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- STRAVA OAUTH FLOW ---------------- */

app.get("/auth/strava", (req, res) => {
  const userId = req.query.userId || DEFAULT_USER_ID;
  const redirectUri =
    process.env.STRAVA_REDIRECT_URI ||
    "https://loew.onrender.com/exchange_token";

  const url = new URL("https://www.strava.com/oauth/authorize");
  url.searchParams.set("client_id", process.env.STRAVA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", "read,activity:read_all");
  url.searchParams.set("state", userId);

  res.redirect(url.toString());
});

app.get("/exchange_token", async (req, res) => {
  const { code, state } = req.query;
  const userId = state || DEFAULT_USER_ID;

  if (!code) {
    return res.status(400).send("Missing 'code'");
  }

  try {
    const resp = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    const json = await resp.json();
    if (!resp.ok) {
      console.error("Error exchanging Strava code:", json);
      return res.status(500).send("Failed to exchange Strava code");
    }

    setStravaTokens(userId, json);

    try {
      const metrics = await dbImpl.computeHrAndFtpFromStrava(userId);
      console.log("computeHrAndFtpFromStrava after connect:", metrics);
    } catch (err) {
      console.error("Error computeHrAndFtpFromStrava:", err);
    }

    try {
      await onboardingEngine.handleStravaConnected(userId);
    } catch (err) {
      console.error("Error in handleStravaConnected:", err);
    }

    const redirectUrl = `/?userId=${encodeURIComponent(
      userId
    )}&strava=connected`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error("exchange_token error:", err);
    res.status(500).send("Strava exchange_token failed");
  }
});

/* ---------------- STRAVA WEBHOOK (OPTIONAL) ---------------- */

// אימות webhook
app.get("/api/strava/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log("Strava webhook verified");
    return res.json({ "hub.challenge": challenge });
  }

  res.status(403).send("Verification failed");
});

// קבלת events מ-Strava
app.post("/api/strava/webhook", async (req, res) => {
  const event = req.body || {};
  console.log("Strava webhook event:", event);

  res.status(200).json({ ok: true });

  try {
    if (event.object_type === "activity" && event.aspect_type === "create") {
      const activityId = event.object_id;
      const athleteId = event.owner_id;

      console.log(
        `Webhook: new activity ${activityId} from athlete ${athleteId}`
      );

      const userId = DEFAULT_USER_ID; // אפשר בהמשך למפות athleteId -> userId

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

/* ---------------- STRAVA SNAPSHOT API ---------------- */

app.post("/api/loew/strava-snapshot", async (req, res) => {
  try {
    const { userId: bodyUserId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    const tokens = loadStravaTokensFromDb(userId);
    if (!tokens) {
      return res.json({
        ok: false,
        error: "No Strava tokens for this user. Please connect Strava first.",
        userId,
      });
    }

    const snapshot = await buildStravaSnapshot(tokens);
    if (!snapshot) {
      return res.json({
        ok: false,
        error: "Failed to build Strava snapshot",
        userId,
      });
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

    return res.json({ ok: true, userId, execution: score });
  } catch (err) {
    console.error("/api/loew/execution-score error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Execution score failed on server" });
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

    // 1. לבדוק סטטוס אונבורדינג
    const obState = await dbImpl.getOnboarding(userId);
    const onboardingDone = obState && obState.onboardingCompleted;

    // 2. אם האונבורדינג עדיין לא הושלם – כל הודעה הולכת למנוע אונבורדינג
    if (!onboardingDone) {
      const reply = await onboardingEngine.handleMessage(userId, text);

      return res.json({
        ok: true,
        reply: reply.text,
        onboarding: true,
        done: !!reply.done,
        userId,
      });
    }

    // 3. מכאן והלאה – משתמש "onboarded": אפשר להשתמש ב־snapshot, FTP, מטרות וכו'
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

    return res.json({ ok: true, reply: replyText, userId });
  } catch (err) {
    console.error("/api/loew/chat error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Chat failed on server" });
  }
});


/* ---------------- START SERVER ---------------- */

app.listen(port, () => {
  console.log(`LOEW server listening on port ${port}`);
});
