import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

import OpenAI from "openai";

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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------------- CONSTANTS & IN-MEMORY STATE ---------------- */

// ברירת מחדל אם הלקוח לא שולח userId
const DEFAULT_USER_ID = "loew_single_user";

// מפה לזיכרון־זמני של userId -> טוקני סטרבה
// (משמשת גם ל-snapshot המהיר; הלוגיקה העמוקה יותר יושבת ב-DB דרך dbImpl)
const stravaTokensByUser = new Map();

/* ---------------- STRAVA SNAPSHOT HELPER ---------------- */

/**
 * Builder מהיר ל-snapshot
 * משתמש ישירות ב-Strava API על בסיס access_token.
 *
 * מחזיר:
 * - training_summary (90 יום)
 * - hr_max_from_data / hr_threshold_from_data
 * - ftp_models (מ-Ftp של Strava)
 * - וגם:
 *   - latest_activity
 *   - latest_activity_date
 *   - latest_activity_is_today
 *   - recent_activities (רשימת רכיבות אחרונות)
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

    // פעילויות אחרונות
    const actsResp = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=200",
      { headers }
    );
    if (!actsResp.ok) {
      console.error("buildStravaSnapshot: actsResp not ok");
      return null;
    }
    const acts = await actsResp.json();

    // מיון מהחדשה לישנה
    const sortedActs = (acts || [])
      .slice()
      .sort(
        (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
      );

    const nowMs = Date.now();
    const days90Ms = 90 * 24 * 60 * 60 * 1000;
    const cutoff = nowMs - days90Ms;

    const acts90 = sortedActs.filter((a) => {
      const t = new Date(a.start_date).getTime();
      return t >= cutoff;
    });

    /* ----- HR max & threshold מה-90 יום ----- */

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

    /* ----- סיכום נפח 90 יום ----- */

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

    /* ----- FTP בסיסי על סמך athlete.ftp ----- */

    const ftpFromStrava =
      typeof athlete.ftp === "number" ? athlete.ftp : null;

    let ftpFrom20min = null;
    let ftpFrom8min = null;
    let ftpFrom3min = null;

    if (ftpFromStrava) {
      // מודל 20 דקות – כאן פשוט שווה ל-FTP מסטרבה
      ftpFrom20min = ftpFromStrava;
      // מודל 8 דקות (קצת יותר גבוה)
      ftpFrom8min = Math.round(ftpFromStrava * 1.04);
      // מודל 3 דקות (עוד קצת יותר גבוה)
      ftpFrom3min = Math.round(ftpFromStrava * 1.08);
    }

    const ftpModels = {
      from_20min: ftpFrom20min,
      from_8min: ftpFrom8min,
      from_3min: ftpFrom3min,
    };

    const ftpFromStreams = null; // לוגיקה עמוקה יותר ב-dbSqlite/StravaIngest

    /* ----- הרכיבה האחרונה + רכיבות אחרונות ----- */

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
        start_date: latest.start_date, // UTC from Strava
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

    // רשימת רכיבות אחרונות (נגיד 30) – לשימוש בניתוח לפי תאריך
    const recentActivities = sortedActs.slice(0, 30).map((a) => ({
      id: a.id,
      name: a.name,
      start_date: a.start_date,
      distance_km: a.distance ? a.distance / 1000 : null,
      moving_time_s: a.moving_time || null,
      total_elevation_m: a.total_elevation_gain || null,
      average_power:
        typeof a.average_watts === "number" ? a.average_watts : null,
      max_power: typeof a.max_watts === "number" ? a.max_watts : null,
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

      // שדות חדשים:
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

/* ---------------- DB + STRAVA CLIENT + INGEST + ONBOARDING ---------------- */

// יצירת שכבת ה־DB (SQLite דרך dbSqlite.js)
// מעבירים את getStravaTokens כדי שפונקציות עמוקות יותר יוכלו להשתמש בטוקנים מהזיכרון
const dbImpl = createDbImpl({
  getStravaTokens: (userId) => stravaTokensByUser.get(userId) || null,
  buildStravaSnapshot,
});

// Strava client – מקבל access_token לכל userId מתוך ה-DB
const stravaClient = new StravaClient(async (userId) => {
  const tokens = await dbImpl.getStravaTokens(userId);
  if (!tokens || !tokens.access_token) {
    throw new Error("No Strava access token for user " + userId);
  }
  return tokens.access_token;
});

// שירות ingest – אחראי להביא פעילויות, סטרימים, power curves וכו'
const stravaIngest = new StravaIngestService(stravaClient);

// מנוע אונבורדינג
const onboardingEngine = new OnboardingEngine(dbImpl);

/* ---------------- CONVERSATION MEMORY + SYSTEM PROMPT ---------------- */

// זיכרון שיחה כפי שקורה ב-ChatGPT, פר userId
const conversations = new Map();

// System prompt מאוחד – גם מאמן אופניים (LOEW) וגם עוזר כללי
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

// זיהוי גס אם השאלה קשורה לאופניים/אימונים
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

/* ---------------- STRAVA AUTH (MULTI USER) ---------------- */

/**
 * התחלת OAuth ל-Strava.
 * הקליינט צריך לקרוא:
 *   GET /auth/strava?userId=<some-user-id>
 */
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

/**
 * callback מ-Strava אחרי אישור.
 * כאן אנחנו קוראים לטוקנים ושומרים אותם לפי userId.
 */
app.get("/exchange_token", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // ה-userId שחזר מ-Strava
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

    // שמירת הטוקנים במפה בזיכרון
    stravaTokensByUser.set(userId, json);
    console.log("Strava tokens saved for user:", userId);

    // עדכון מנוע האונבורדינג (שבתוכו נקראת computeHrAndFtpFromStrava וכו')
    await onboardingEngine.handleStravaConnected(userId);

    // חזרה לפרונט
    return res.redirect(
      `/?strava=connected&userId=${encodeURIComponent(userId)}`
    );
  } catch (err) {
    console.error("Strava /exchange_token error:", err);
    res.status(500).send("Strava auth failed");
  }
});

/* ---------------- STRAVA SNAPSHOT API ---------------- */

/**
 * endpoint מהיר להחזרת snapshot מ-Strava
 * הקליינט יכול לקרוא:
 *   POST /api/loew/strava-snapshot  { userId?: string }
 */
app.post("/api/loew/strava-snapshot", async (req, res) => {
  try {
    const { userId: bodyUserId } = req.body || {};
    const userId = bodyUserId || DEFAULT_USER_ID;

    const tokens = stravaTokensByUser.get(userId);
    if (!tokens) {
      return res.status(400).json({
        ok: false,
        error: "No Strava tokens for this user. Please connect Strava first.",
      });
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

/* ---------------- STRAVA WEBHOOKS ---------------- */

/**
 * אימות מנוי webhook מול סטרבה (Verification Challenge)
 * Strava שולחת GET עם hub.mode, hub.challenge, hub.verify_token
 */
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

/**
 * קבלת אירועים מסטרבה (יצירת פעילות חדשה וכו')
 */
app.post("/strava/webhook", async (req, res) => {
  const event = req.body || {};
  console.log("Strava webhook event:", JSON.stringify(event));

  // סטרבה מצפה ל-200 מהר – מטפלים באירוע "ברקע"
  res.status(200).json({ ok: true });

  try {
    if (event.object_type === "activity" && event.aspect_type === "create") {
      const activityId = event.object_id;
      const athleteId = event.owner_id;

      console.log(
        `Webhook: new activity ${activityId} from athlete ${athleteId}`
      );

      // כרגע: משתמש יחיד (עד שלא נוסיף מיפוי athleteId -> userId)
      const userId = DEFAULT_USER_ID;

      await stravaIngest.ingestActivity(userId, activityId);
      console.log("Ingested via webhook:", activityId);

      // אופציונלי: להפעיל גם computeHrAndFtpFromStrava(userId) כאן
      // כדי לעדכן FTP/HR אחרי כל פעילות חדשה
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
    console.error("Strava webhook handler error:", err);
  }
});

/* ---------------- UNIFIED CHAT – LOEW + GENERAL ASSISTANT ---------------- */

app.post("/api/loew/chat", async (req, res) => {
  try {
    const body = req.body ?? {};
    const message = body.message || "";
    const snapshot = body.snapshot || null;
    const bodyUserId = body.userId || null;

    const userId = bodyUserId || DEFAULT_USER_ID;
    const text = message || "";

    // סטטוס אונבורדינג
    const obState = await dbImpl.getOnboarding(userId);
    const onboardingDone = obState && obState.onboardingCompleted;
    const cyclingRelated = isCyclingRelated(text);

    // אם עוד לא סיימנו אונבורדינג והשאלה קשורה לאימונים – משתמשים במנוע האונבורדינג
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

    // אחרי אונבורדינג, או אם הבקשה לא קשורה לאופניים → עוזר מאוחד (LOEW + כללי)
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

    // מוסיפים את הודעת המשתמש להיסטוריה
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

    // מוסיפים את תשובת העוזר להיסטוריה
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
