// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

import { createDbImpl } from "./dbSqlite.js";
import { OnboardingEngine } from "./onboardingEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const dbImpl = await createDbImpl();
const onboarding = new OnboardingEngine(dbImpl);

// ===== STATIC FRONTEND (index.html) =====
app.use(express.static(__dirname)); // מגיש את index.html והקבצים מאותה תיקייה

// ===== UTIL =====
function getUserIdFromBody(req) {
  const userId =
    (req.body && req.body.userId && String(req.body.userId).trim()) || "roy";
  return userId;
}

// ===== STRAVA SNAPSHOT (לפרונט) =====
// מחזיר האם יש סטרבה מחובר למשתמש
app.post("/api/loew/strava-snapshot", async (req, res) => {
  try {
    const userId = getUserIdFromBody(req);
    const tokens = await dbImpl.getStravaTokens(userId);

    const hasStrava = !!tokens;
    // אפשר להרחיב בעתיד עם summary, כרגע מספיק hasStrava
    return res.json({
      ok: true,
      snapshot: {
        hasStrava,
      },
    });
  } catch (err) {
    console.error("strava-snapshot error:", err);
    return res.json({
      ok: false,
      error: "snapshot_failed",
    });
  }
});

// ===== MAIN CHAT API =====
app.post("/api/loew/chat", async (req, res) => {
  try {
    const userId = getUserIdFromBody(req);
    const message =
      (req.body && typeof req.body.message === "string"
        ? req.body.message
        : ""
      ).trim();

    if (!message) {
      return res.json({
        ok: true,
        reply:
          "קיבלתי בקשה ריקה. תכתוב לי שאלה על האימונים שלך, ואני אעזור בשמחה 😊",
        onboarding: false,
      });
    }

    await dbImpl.ensureUser(userId);

    const result = await onboarding.handleMessage(userId, message);

    return res.json({
      ok: true,
      reply: result.reply,
      onboarding: !!result.onboarding,
    });
  } catch (err) {
    console.error("/api/loew/chat error:", err);
    return res.json({
      ok: false,
      error: "chat_failed",
    });
  }
});

// ===== STRAVA AUTH FLOW =====

// שלב 1 – שליחת המשתמש למסך ההרשאה של סטרבה
app.get("/auth/strava", (req, res) => {
  const userId = (req.query.userId && String(req.query.userId)) || "roy";

  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri =
    process.env.STRAVA_REDIRECT_URI || `${BASE_URL}/exchange_token`;

  if (!clientId) {
    return res.status(500).send("STRAVA_CLIENT_ID חסר ב־env");
  }

  const authUrl = new URL("https://www.strava.com/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("approval_prompt", "auto");
  authUrl.searchParams.set(
    "scope",
    "read,activity:read,activity:read_all,profile:read_all"
  );
  authUrl.searchParams.set("state", userId);

  res.redirect(authUrl.toString());
});

// שלב 2 – סטרבה מחזירה code, אנחנו מחליפים בטוקן ושומרים בדאטה
app.get("/exchange_token", async (req, res) => {
  try {
    const code = req.query.code;
    const userId = (req.query.state && String(req.query.state)) || "roy";

    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;
    const redirectUri =
      process.env.STRAVA_REDIRECT_URI || `${BASE_URL}/exchange_token`;

    if (!clientId || !clientSecret) {
      return res.status(500).send("חסרים STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET");
    }

    const tokenRes = await fetch(
      "https://www.strava.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      }
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Strava token error:", text);
      return res.status(500).send("שגיאה בחיבור לסטרבה");
    }

    const tokenJson = await tokenRes.json();

    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;
    const expiresAt = tokenJson.expires_at || 0;

    await dbImpl.saveStravaTokens(userId, {
      accessToken,
      refreshToken,
      expiresAt,
    });

    // לא מבצעים כאן אינג'סט מלא – זה יעשה ע"י מנוע האונבורדינג בשיחה הראשונה אחרי ההתחברות
    const redirectUrl = `${BASE_URL}/index.html?userId=${encodeURIComponent(
      userId
    )}&strava=connected`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error("/exchange_token error:", err);
    res.status(500).send("שגיאה בעת עיבוד החיבור לסטרבה");
  }
});

// ===== HEALTHCHECK =====
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`LOEW server running on port ${PORT}`);
});
