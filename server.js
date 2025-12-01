import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import OpenAI from "openai";

import { OnboardingEngine } from "./onboardingEngine.js";
import { createDbImpl } from "./dbSqlite.js";

dotenv.config();

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

// ---------------- STRAVA TOKENS – MULTI USER ----------------

// מפה של userId -> טוקנים של סטרבה
const stravaTokensByUser = new Map();

/**
 * Builder אופציונלי ל-snapshot "מהיר"
 */
async function buildStravaSnapshot(tokens) {
  try {
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
    };

    // אתלט
    const athleteResp = await fetch("https://www.strava.com/api/v3/athlete", {
      headers,
    });
    const athlete = await athleteResp.json();

    // פעילויות
    const actsResp = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=200",
      { headers }
    );
    const acts = await actsResp.json();

    const now = Date.now();
    const days90 = 90 * 24 * 60 * 60 * 1000;
    const cutoff = now - days90;

    const acts90 = (acts || []).filter((a) => {
      const t = new Date(a.start_date).getTime();
      return t >= cutoff;
    });

    // HR max & threshold
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

    // סיכום נפח 90 יום
    const totalSeconds = acts90.reduce(
      (sum, a) => sum + (a.moving_time || 0),
      0
    );
    const totalHours = totalSeconds / 3600;
    const totalDistance =
      acts90.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
    const totalElevation = acts90.reduce(
      (s, a) => s + (a.total_elevation_gain || 0),
      0
    );

    const daysWindow = 90;
    const avgHoursPerWeek = (totalHours / daysWindow) * 7;

    const trainingSummary = {
      windowDays: daysWindow,
      totalHours,
      totalDistanceKm: totalDistance,
      totalElevationM: totalElevation,
      avgHoursPerWeek,
    };

    // ----- FTP -----

    const ftpFromStrava =
      typeof athlete.ftp === "number" ? athlete.ftp : null;

    let ftpFrom20min = null;
    let ftpFrom8min = null;
    let ftpFrom3min = null;

    if (ftpFromStrava) {
      ftpFrom20min = ftpFromStrava; // מודל 20 דקות
      ftpFrom8min = Math.round(ftpFromStrava * 1.04); // מודל 8 דקות
      ftpFrom3min = Math.round(ftpFromStrava * 1.08); // מודל מאמצים קצרים
    }

    const ftpModels = {
      from_20min: ftpFrom20min,
      from_8min: ftpFrom8min,
      from_3min: ftpFrom3min,
    };

    const ftpFromStreams = null;

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
    };
  } catch (err) {
    console.error("buildStravaSnapshot error:", err);
    return null;
  }
}

// יצירת שכבת ה־DB והמנוע (SQLite דרך dbSqlite.js)
const dbImpl = createDbImpl({
  // חשוב: עכשיו getStravaTokens מקבל userId
  getStravaTokens: (userId) => stravaTokensByUser.get(userId) || null,
  buildStravaSnapshot,
});

const onboardingEngine = new OnboardingEngine(dbImpl);

// userId ברירת מחדל – לשימוש אם הקליינט לא שולח userId (לבדיקות / single user)
const DEFAULT_USER_ID = "loew_single_user";

// system prompt מאוחד – LOEW + עוזר כללי
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

When the user asks about anything else (code, emails, work, explanations, relationships, life questions, etc.):
- Behave like a normal, smart, general-purpose assistant.
- Still keep answers concise, helpful, and well-structured.
`;

// זיכרון שיחה – כמו ChatGPT, פר userId
const conversations = new Map();

// זיהוי גס אם השאלה קשורה לאופניים/אימון
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

/* ---------------- STRAVA AUTH – MULTI USER ---------------- */

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
    const state = req.query.state; // כאן נמצא ה-userId שחזר מ-Strava
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

    // שמירה במפה לפי userId
    stravaTokensByUser.set(userId, json);
    console.log("Strava tokens saved for user:", userId);

    // עדכון מנוע האונבורדינג
    await onboardingEngine.handleStravaConnected(userId);

    return res.redirect(
      `/?strava=connected&userId=${encodeURIComponent(userId)}`
    );
  } catch (err) {
    console.error("Strava /exchange_token error:", err);
    res.status(500).send("Strava auth failed");
  }
});

// החזרת snapshot לקליינט (לא חובה בשביל האונבורדינג)
app.get("/api/loew/strava-snapshot", async (req, res) => {
  try {
    const userId = req.query.userId || DEFAULT_USER_ID;

    const tokens = stravaTokensByUser.get(userId);
    if (!tokens || !tokens.access_token) {
      return res.status(401).json({
        ok: false,
        error: "No Strava tokens for this user",
      });
    }

    const metrics = await dbImpl.computeHrAndFtpFromStrava(userId);

    return res.json({ ok: true, snapshot: metrics, userId });
  } catch (err) {
    console.error("Strava snapshot error:", err);
    return res.status(500).json({ ok: false, error: "Snapshot failed" });
  }
});

/* ---------------- UNIFIED CHAT – LOEW + GENERAL ASSISTANT ---------------- */

app.post("/api/loew/chat", async (req, res) => {
  try {
    const { message, snapshot, userId: bodyUserId } = req.body;
    const userId = bodyUserId || DEFAULT_USER_ID;
    const text = message || "";

    // אונבורדינג – רק אם זה קשור לאימונים
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

    // אחרי אונבורדינג, או אם הבקשה לא קשורה לאופניים → עוזר מאוחד
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

    // מוסיפים גם את התשובה להיסטוריה
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
