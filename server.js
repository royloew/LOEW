// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import { fileURLToPath } from "url";
import path from "path";

import { createDbImpl } from "./dbSqlite.js";
import { OnboardingEngine } from "./onboardingEngine.js";

import fs from "fs";

// קונפיגורציית DB דרך Environment Variables
// חשוב: ב-Render להגדיר LOEW_DB_FILE=/opt/render/project/src/loew.db
const DB_FILE = process.env.LOEW_DB_FILE || "/tmp/loew.db";
const DB_DOWNLOAD_SECRET = process.env.DB_DOWNLOAD_SECRET || "CHANGE_ME";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== ADMIN: הורדת קובץ ה-DB =====
app.get("/admin/download-db", (req, res) => {
  const key = req.query.key;
  if (!key || key !== DB_DOWNLOAD_SECRET) {
    return res.status(403).send("Forbidden");
  }

  if (!fs.existsSync(DB_FILE)) {
    return res.status(404).send("DB file not found at " + DB_FILE);
  }

  res.download(DB_FILE, "loew.db", (err) => {
    if (err) {
      console.error("Error sending DB:", err);
      if (!res.headersSent) {
        res.status(500).send("Error sending DB");
      }
    }
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// יצירת DB + מנוע אונבורדינג
const dbImpl = await createDbImpl();
const onboarding = new OnboardingEngine(dbImpl);

// ===== STATIC FRONTEND (index.html) =====

// מגיש את כל הקבצים מתוך public (index.html, style.css וכו')
app.use(express.static(path.join(__dirname, "public")));

// כשנכנסים ל-root, מגיש את public/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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


// ===== WORKOUT ANALYSIS APIS =====

app.post("/api/loew/last-workout-analysis", async (req, res) => {
  try {
    const userId = getUserIdFromBody(req);

    const analysis = await dbImpl.getLastWorkoutAnalysis(userId);
    if (!analysis) {
      return res.json({
        ok: true,
        hasWorkout: false,
        message: "לא מצאתי אימון אחרון מסטרבה עבור המשתמש הזה.",
      });
    }

    const { summary } = analysis;
    const parts = [];

    const dateStr = summary.startDateIso
      ? summary.startDateIso.slice(0, 10)
      : "תאריך לא ידוע";

    parts.push(`האימון האחרון שלך היה ב-${dateStr}.`);

    if (summary.distanceKm != null && summary.durationMin != null) {
      parts.push(
        `רכבת ${summary.distanceKm.toFixed(
          1
        )} ק\"מ במשך כ-${Math.round(summary.durationMin)} דקות.`
      );
    } else if (summary.durationMin != null) {
      parts.push(`משך האימון היה כ-${Math.round(summary.durationMin)} דקות.`);
    }

    if (summary.elevationGainM != null && summary.elevationGainM > 0) {
      parts.push(`צברת בערך ${summary.elevationGainM} מטר טיפוס.`);
    }

    if (summary.avgPower != null && summary.ftpUsed) {
      const rel = ((summary.avgPower / summary.ftpUsed) * 100).toFixed(1);
      parts.push(
        `הוואטים הממוצעים היו ${Math.round(
          summary.avgPower
        )}W (~${rel}% מה-FTP שלך).`
      );
    } else if (summary.avgPower != null) {
      parts.push(
        `הוואטים הממוצעים באימון היו בערך ${Math.round(
          summary.avgPower
        )}W.`
      );
    }

    if (summary.avgHr != null) {
      parts.push(
        `הדופק הממוצע היה סביב ${Math.round(summary.avgHr)} פעימות לדקה.`
      );
    }

    if (summary.intensityFtp != null) {
      parts.push(
        `האימון כולו היה בעצימות IF ≈ ${summary.intensityFtp} ביחס ל-FTP.`
      );
    }

    if (
      summary.segments &&
      summary.segments.decouplingPct != null &&
      Number.isFinite(summary.segments.decouplingPct)
    ) {
      const dec = summary.segments.decouplingPct;
      const decAbs = Math.abs(dec).toFixed(1);
      if (decAbs >= 3) {
        const direction =
          dec > 0
            ? "הדופק עלה יותר מהוואטים (decoupling חיובי)"
            : "הדופק עלה פחות מהוואטים (decoupling שלילי)";
        parts.push(
          `היה decoupling של כ-${decAbs}% בין דופק לוואטים – ${direction}, מה שנותן תחושה על העומס המצטבר באימון.`
        );
      }
    }

    if (summary.windows && summary.windows.w1200 && summary.windows.w1200.avg) {
      const w = summary.windows.w1200;
      const rel = w.relToFtp != null ? ` (~${w.relToFtp}% מה-FTP)` : "";
      parts.push(
        `ה-20 הדקות החזקות באימון היו סביב ${Math.round(
          w.avg
        )}W${rel}.`
      );
    } else if (summary.windows && summary.windows.w300 && summary.windows.w300.avg) {
      const w = summary.windows.w300;
      const rel = w.relToFtp != null ? ` (~${w.relToFtp}% מה-FTP)` : "";
      parts.push(
        `ה-5 הדקות החזקות באימון היו סביב ${Math.round(
          w.avg
        )}W${rel}.`
      );
    }

    const message = parts.join(" ");

    return res.json({
      ok: true,
      hasWorkout: true,
      message,
      analysis,
    });
  } catch (err) {
    console.error("/api/loew/last-workout-analysis error:", err);
    return res.status(500).json({
      ok: false,
      error: "last_workout_failed",
    });
  }
});

app.post("/api/loew/workout-analysis-by-date", async (req, res) => {
  try {
    const userId = getUserIdFromBody(req);
    const isoDate =
      (req.body && typeof req.body.date === "string"
        ? req.body.date.trim()
        : "") || null;

    if (!isoDate) {
      return res.json({
        ok: false,
        error: "missing_date",
        message: 'צריך לשלוח שדה "date" בפורמט YYYY-MM-DD בגוף הבקשה.',
      });
    }

    const analysis = await dbImpl.getWorkoutAnalysisByDate(userId, isoDate);
    if (!analysis) {
      return res.json({
        ok: true,
        hasWorkout: false,
        message: `לא מצאתי אימון בתאריך ${isoDate} עבור המשתמש הזה.`,
      });
    }

    const { summary } = analysis;
    const parts = [];

    parts.push(`האימון בתאריך ${isoDate}:`);

    if (summary.distanceKm != null && summary.durationMin != null) {
      parts.push(
        `רכבת ${summary.distanceKm.toFixed(
          1
        )} ק\"מ במשך כ-${Math.round(summary.durationMin)} דקות.`
      );
    } else if (summary.durationMin != null) {
      parts.push(`משך האימון היה כ-${Math.round(summary.durationMin)} דקות.`);
    }

    if (summary.elevationGainM != null && summary.elevationGainM > 0) {
      parts.push(`צברת בערך ${summary.elevationGainM} מטר טיפוס.`);
    }

    if (summary.avgPower != null && summary.ftpUsed) {
      const rel = ((summary.avgPower / summary.ftpUsed) * 100).toFixed(1);
      parts.push(
        `הוואטים הממוצעים היו ${Math.round(
          summary.avgPower
        )}W (~${rel}% מה-FTP שלך).`
      );
    } else if (summary.avgPower != null) {
      parts.push(
        `הוואטים הממוצעים באימון היו בערך ${Math.round(
          summary.avgPower
        )}W.`
      );
    }

    if (summary.avgHr != null) {
      parts.push(
        `הדופק הממוצע היה סביב ${Math.round(summary.avgHr)} פעימות לדקה.`
      );
    }

    if (summary.intensityFtp != null) {
      parts.push(
        `האימון כולו היה בעצימות IF ≈ ${summary.intensityFtp} ביחס ל-FTP.`
      );
    }

    if (
      summary.segments &&
      summary.segments.decouplingPct != null &&
      Number.isFinite(summary.segments.decouplingPct)
    ) {
      const dec = summary.segments.decouplingPct;
      const decAbs = Math.abs(dec).toFixed(1);
      if (decAbs >= 3) {
        const direction =
          dec > 0
            ? "הדופק עלה יותר מהוואטים (decoupling חיובי)"
            : "הדופק עלה פחות מהוואטים (decoupling שלילי)";
        parts.push(
          `היה decoupling של כ-${decAbs}% בין דופק לוואטים – ${direction}.`
        );
      }
    }

    if (summary.windows && summary.windows.w1200 && summary.windows.w1200.avg) {
      const w = summary.windows.w1200;
      const rel = w.relToFtp != null ? ` (~${w.relToFtp}% מה-FTP)` : "";
      parts.push(
        `ה-20 הדקות החזקות באימון היו סביב ${Math.round(
          w.avg
        )}W${rel}.`
      );
    } else if (summary.windows && summary.windows.w300 && summary.windows.w300.avg) {
      const w = summary.windows.w300;
      const rel = w.relToFtp != null ? ` (~${w.relToFtp}% מה-FTP)` : "";
      parts.push(
        `ה-5 הדקות החזקות באימון היו סביב ${Math.round(
          w.avg
        )}W${rel}.`
      );
    }

    const message = parts.join(" ");

    return res.json({
      ok: true,
      hasWorkout: true,
      message,
      analysis,
    });
  } catch (err) {
    console.error("/api/loew/workout-analysis-by-date error:", err);
    return res.status(500).json({
      ok: false,
      error: "workout_by_date_failed",
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
      return res
        .status(500)
        .send("חסרים STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET");
    }

    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

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

    // אינג'סט + חישוב מטריקות בסיסיות מיד אחרי החיבור
    try {
      console.log("[STRAVA] Starting ingestAndComputeFromStrava for", userId);
      const metrics = await dbImpl.ingestAndComputeFromStrava(userId);
      console.log("[STRAVA] Ingest done for", userId, "metrics:", metrics);

      // 🔥 עדכון מצב אונבורדינג ל-post_strava_summary עם הנתונים מה-DB
      if (
        metrics &&
        typeof dbImpl.getOnboardingState === "function" &&
        typeof dbImpl.saveOnboardingState === "function"
      ) {
        try {
          const row = await dbImpl.getOnboardingState(userId);
          let state = null;

          if (row && row.stage) {
            state = {
              stage: row.stage,
              data: row.data || {},
            };
          }

          console.log(
            "[ONBOARDING] handleMessage for",
            userId,
            "loaded stage:",
            state ? state.stage : null
          );

          if (!state || !state.data) {
            state = {
              stage: "post_strava_summary",
              data: {
                personal: {},
                ftp: null,
                ftpFinal: null,
                hr: null,
                hrFinal: null,
                goal: null,
                volume: null,
                trainingSummary: null,
                stravaConnected: true,
              },
            };
          } else {
            state.stage = "post_strava_summary";
            state.data = state.data || {};
            state.data.stravaConnected = true;
          }

          if (metrics.trainingSummary) {
            state.data.trainingSummary = metrics.trainingSummary;
          }
          if (metrics.volume) {
            state.data.volume = metrics.volume;
          }

          if (metrics.ftpModels) {
            const fm = metrics.ftpModels;
            state.data.ftp = state.data.ftp || {};
            state.data.ftp.ftp20 =
              fm.ftp20 && typeof fm.ftp20.value === "number"
                ? fm.ftp20.value
                : null;
            state.data.ftp.ftpFrom3min =
              fm.ftpFrom3min && typeof fm.ftpFrom3min.value === "number"
                ? fm.ftpFrom3min.value
                : null;
            state.data.ftp.ftpFromCP =
              fm.ftpFromCP && typeof fm.ftpFromCP.value === "number"
                ? fm.ftpFromCP.value
                : null;
            state.data.ftp.ftpRecommended =
              fm.ftpRecommended && typeof fm.ftpRecommended.value === "number"
                ? fm.ftpRecommended.value
                : null;
          }

          if (metrics.hr) {
            state.data.hr = state.data.hr || {};
            if (metrics.hr.hrMax != null) {
              state.data.hr.hrMaxTop3 = metrics.hr.hrMax;
            }
            if (metrics.hr.hrThreshold != null) {
              state.data.hr.hrThresholdRecommended = metrics.hr.hrThreshold;
            }
          }

          await dbImpl.saveOnboardingState(userId, state);
          console.log(
            "[STRAVA] Onboarding state updated to post_strava_summary for",
            userId
          );
        } catch (e) {
          console.error(
            "[STRAVA] Failed to update onboarding state after ingest:",
            e
          );
        }
      }
    } catch (err) {
      console.error("[STRAVA] ingestAndComputeFromStrava failed:", err);
    }

    const redirectUrl = `/index.html?userId=${encodeURIComponent(
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
