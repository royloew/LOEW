// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import { fileURLToPath } from "url";
import path from "path";

import { createDbImpl } from "./dbSqlite.js";
import { OnboardingEngine } from "./onboardingEngine.js";

import fs from "fs";


const dbPromise = createDbImpl();


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

    // זיהוי בקשה לניתוח האימון האחרון
    const lower = message.toLowerCase();
    const isHebrewLastWorkout =
      lower.includes("אימון אחרון") &&
      (lower.includes("נתח") || lower.includes("ניתוח"));
    const isEnglishLastWorkout =
      lower.includes("last workout") &&
      (lower.includes("analyze") || lower.includes("analysis"));

    if (isHebrewLastWorkout || isEnglishLastWorkout) {
      try {
        const analysis = await dbImpl.getLastWorkoutAnalysis(userId);
        if (!analysis || !analysis.summary) {
          return res.json({
            ok: true,
            reply:
              "לא מצאתי אימון אחרון מסטרבה עבור המשתמש הזה.\n" +
              "תוודא שחיברת את סטרבה ויש לפחות אימון אחד עם נתוני וואטים.",
            onboarding: false,
          });
        }

        const summary = analysis.summary;
        const dateStr = summary.startDateIso
          ? summary.startDateIso.slice(0, 10)
          : "תאריך לא ידוע";

        const lines = [];

        // כותרת
        lines.push(`ניתוח האימון האחרון שלך (${dateStr}):`);
        lines.push("");

        // נתוני בסיס
        if (summary.durationMin != null) {
          lines.push(`⏱ משך: ${Math.round(summary.durationMin)} דק׳`);
        }
        if (summary.distanceKm != null) {
          lines.push(`📍 מרחק: ${summary.distanceKm.toFixed(1)} ק״מ`);
        }
        if (summary.elevationGainM != null && summary.elevationGainM > 0) {
          lines.push(`🏔 טיפוס מצטבר: ${summary.elevationGainM} מ׳`);
        }

        lines.push("");

        // הספק ודופק
        if (summary.avgPower != null) {
          if (summary.ftpUsed) {
            const rel = ((summary.avgPower / summary.ftpUsed) * 100).toFixed(1);
            lines.push(
              `⚡ וואטים ממוצעים: ${Math.round(
                summary.avgPower
              )}W (~${rel}% מה-FTP שלך)`
            );
          } else {
            lines.push(
              `⚡ וואטים ממוצעים: ${Math.round(summary.avgPower)}W`
            );
          }
        }

        if (summary.avgHr != null) {
          lines.push(`❤️ דופק ממוצע: ${Math.round(summary.avgHr)} bpm`);
        }

        lines.push("");

        // Decoupling (HR drift)
        const dec =
          summary.segments && summary.segments.decouplingPct != null
            ? summary.segments.decouplingPct
            : null;

        if (dec != null && Number.isFinite(dec)) {
          const decFixed = dec.toFixed(1);
          lines.push(`📉 Decoupling: ${decFixed}%`);
          lines.push(
            "= שינוי ביחס בין דופק לוואטים לאורך האימון (ככל שהמספר גבוה יותר – יש יותר שחיקה/עייפות)."
          );

          if (Math.abs(dec) < 5) {
            lines.push(
              "ה-Decoupling נמוך – הגוף שמר על יציבות יפה לאורך האימון."
            );
          } else if (Math.abs(dec) < 10) {
            lines.push(
              "ה-Decoupling בינוני – יש סימנים לעייפות, אבל עדיין בטווח הגיוני."
            );
          } else {
            lines.push(
              "ה-Decoupling גבוה – סימן לעומס מצטבר או לכך שהגוף הגיע עייף לאימון."
            );
          }
        }

        const replyText = lines.join("\n");

        return res.json({
          ok: true,
          reply: replyText,
          onboarding: false,
        });
      } catch (err) {
        console.error("chat last-workout analysis error:", err);
        return res.json({
          ok: false,
          error: "chat_last_workout_failed",
        });
      }
    }

    // ברירת מחדל – מעבירים ל-onboarding / צ'אט הרגיל
  // ברירת מחדל – מעבירים ל-onboarding / צ'אט הרגיל
const result = await onboarding.handleMessage(userId, message);

return res.json({
  ok: true,
  reply: result.reply,
  onboarding: !!result.onboarding,
  followups: result.followups || [],   // 👈 זה השורה החדשה
});

  } catch (err) {
    console.error("/api/loew/chat error:", err);
    return res.json({
      ok: false,
      error: "chat_failed",
    });
  }
});


app.post("/api/loew/strava-sync", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const db = await dbPromise;

    console.log("[STRAVA] Manual sync requested for", userId);

    // זה עושה ingest מלא + חישובי FTP/HR ומחזיר snapshot עדכני
    const snapshot = await db.ingestAndComputeFromStrava(userId);

    return res.json({
      ok: true,
      snapshot,
    });
  } catch (err) {
    console.error("[STRAVA] /api/loew/strava-sync error", err);
    return res.status(500).json({ error: "Strava sync failed" });
  }
});


// ===== WORKOUT ANALYSIS APIS =====

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
    const dateStr = summary.startDateIso
      ? summary.startDateIso.slice(0, 10)
      : "תאריך לא ידוע";

    const lines = [];

    // כותרת
    lines.push(`סיכום אימון אחרון – ${dateStr}`);
    lines.push("");

    // נתוני בסיס
    if (summary.durationMin != null) {
      lines.push(`⏱ משך: ${Math.round(summary.durationMin)} דק'`);
    }
    if (summary.distanceKm != null) {
      lines.push(`📍 מרחק: ${summary.distanceKm.toFixed(1)} ק״מ`);
    }
    if (summary.elevationGainM != null && summary.elevationGainM > 0) {
      lines.push(`🏔 טיפוס: ${summary.elevationGainM} מ'`);
    }

    lines.push("");

    // עצימות בסיסית
    if (summary.avgPower != null) {
      if (summary.ftpUsed) {
        const rel = ((summary.avgPower / summary.ftpUsed) * 100).toFixed(1);
        lines.push(
          `⚡ וואטים ממוצעים: ${Math.round(
            summary.avgPower
          )}W (~${rel}% מה-FTP שלך)`
        );
      } else {
        lines.push(
          `⚡ וואטים ממוצעים: ${Math.round(summary.avgPower)}W`
        );
      }
    }

    if (summary.avgHr != null) {
      lines.push(
        `❤️ דופק ממוצע: ${Math.round(summary.avgHr)} bpm`
      );
    }

    if (summary.intensityFtp != null) {
      lines.push(`IF: ${summary.intensityFtp} – עצימות אימונית ביחס ל-FTP`);
    }

    lines.push("");

    // חלונות חזקים (20 דק' או 5 דק')
    const w1200 = summary.windows && summary.windows.w1200;
    const w300 = summary.windows && summary.windows.w300;

    if (w1200 && w1200.avg) {
      const rel = w1200.relToFtp != null ? ` (~${w1200.relToFtp}% FTP)` : "";
      lines.push(
        `🔥 20 דק׳ חזקות: ${Math.round(w1200.avg)}W${rel}`
      );
    } else if (w300 && w300.avg) {
      const rel = w300.relToFtp != null ? ` (~${w300.relToFtp}% FTP)` : "";
      lines.push(
        `🔥 5 דק׳ חזקות: ${Math.round(w300.avg)}W${rel}`
      );
    }

    lines.push("");

    // Decoupling + הסבר קצר
    const dec = summary.segments && summary.segments.decouplingPct;
    if (dec != null && Number.isFinite(dec)) {
      const decFixed = dec.toFixed(1);
      lines.push(`📉 Decoupling: ${decFixed}%`);
      lines.push(
        `= שינוי ביחס בין דופק לוואטים לאורך האימון (ככל שהמספר גבוה יותר – יש יותר שחיקה/עייפות).`
      );

      // פרשנות קצרה לפי רמה
      if (Math.abs(dec) < 5) {
        lines.push(
          `הפעם ה-Decoupling נמוך יחסית – הגוף שמר על יציבות יפה לאורך האימון.`
        );
      } else if (Math.abs(dec) < 10) {
        lines.push(
          `ה-Decoupling בינוני – יש סימנים קלים לעייפות, אבל עדיין בגבולות סבירים.`
        );
      } else {
        lines.push(
          `ה-Decoupling גבוה – הגוף התעייף משמעותית לאורך האימון, זה סימן לעומס מצטבר או צורך בהתאוששות טובה.`
        );
      }
    }

    lines.push("");

    // הערכה על התאוששות ומצב הכושר לפי IF + Decoupling
    const ifVal = summary.intensityFtp;
    let recoveryNote = "";
    let fitnessNote = "";

    if (ifVal != null) {
      if (ifVal < 0.7) {
        fitnessNote =
          "מבחינת עצימות זה יותר אימון בסיס אירובי/התאוששות – טוב לשמירה על כושר בלי להעמיס יותר מדי.";
      } else if (ifVal < 0.85) {
        fitnessNote =
          "האימון היה בעצימות אירובית מתונה – מתאים לבניית סיבולת ויכולת בסיסית לאורך זמן.";
      } else {
        fitnessNote =
          "האימון היה עצים יחסית – זה אימון שמדגדג את ה-Threshold ויכול לתרום לשיפור FTP, אבל גם דורש התאוששות טובה.";
      }
    }

    if (dec != null && Number.isFinite(dec)) {
      if (Math.abs(dec) > 10) {
        recoveryNote =
          "בהתחשב ב-Decoupling הגבוה, כדאי לתת לגוף התאוששות (שינה, תזונה, אימון קל) לפני עוד אימון עצים.";
      } else if (Math.abs(dec) < 5 && ifVal && ifVal >= 0.7) {
        recoveryNote =
          "למרות העצימות, הגוף שמר על יציבות יפה – זה סימן טוב לכושר יציב וליכולת להתמודד עם האימון.";
      } else {
        recoveryNote =
          "מבחינת התאוששות – אין סימן חריג, אבל שווה לעקוב אחרי התחושה ביום-יומיים הקרובים.";
      }
    }

    if (fitnessNote) {
      lines.push(`🧭 מצב כושר: ${fitnessNote}`);
    }
    if (recoveryNote) {
      lines.push(`🛌 התאוששות: ${recoveryNote}`);
    }

    const message = lines.join("\n");

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
    const lines = [];

    // כותרת
    lines.push(`סיכום אימון מתאריך ${isoDate}`);
    lines.push("");

    // נתוני בסיס
    if (summary.durationMin != null) {
      lines.push(`⏱ משך: ${Math.round(summary.durationMin)} דק'`);
    }
    if (summary.distanceKm != null) {
      lines.push(`📍 מרחק: ${summary.distanceKm.toFixed(1)} ק״מ`);
    }
    if (summary.elevationGainM != null && summary.elevationGainM > 0) {
      lines.push(`🏔 טיפוס: ${summary.elevationGainM} מ'`);
    }

    lines.push("");

    // עצימות בסיסית
    if (summary.avgPower != null) {
      if (summary.ftpUsed) {
        const rel = ((summary.avgPower / summary.ftpUsed) * 100).toFixed(1);
        lines.push(
          `⚡ וואטים ממוצעים: ${Math.round(
            summary.avgPower
          )}W (~${rel}% מה-FTP שלך)`
        );
      } else {
        lines.push(
          `⚡ וואטים ממוצעים: ${Math.round(summary.avgPower)}W`
        );
      }
    }

    if (summary.avgHr != null) {
      lines.push(
        `❤️ דופק ממוצע: ${Math.round(summary.avgHr)} bpm`
      );
    }

    if (summary.intensityFtp != null) {
      lines.push(`IF: ${summary.intensityFtp} – עצימות אימונית ביחס ל-FTP`);
    }

    lines.push("");

    // חלונות חזקים
    const w1200 = summary.windows && summary.windows.w1200;
    const w300 = summary.windows && summary.windows.w300;

    if (w1200 && w1200.avg) {
      const rel = w1200.relToFtp != null ? ` (~${w1200.relToFtp}% FTP)` : "";
      lines.push(
        `🔥 20 דק׳ חזקות: ${Math.round(w1200.avg)}W${rel}`
      );
    } else if (w300 && w300.avg) {
      const rel = w300.relToFtp != null ? ` (~${w300.relToFtp}% FTP)` : "";
      lines.push(
        `🔥 5 דק׳ חזקות: ${Math.round(w300.avg)}W${rel}`
      );
    }

    lines.push("");

    // Decoupling + הסבר קצר
    const dec = summary.segments && summary.segments.decouplingPct;
    if (dec != null && Number.isFinite(dec)) {
      const decFixed = dec.toFixed(1);
      lines.push(`📉 Decoupling: ${decFixed}%`);
      lines.push(
        `= שינוי ביחס בין דופק לוואטים לאורך האימון (ככל שהמספר גבוה יותר – יש יותר שחיקה/עייפות).`
      );

      if (Math.abs(dec) < 5) {
        lines.push(
          `באותו יום ה-Decoupling היה נמוך – הגוף שמר על יציבות יפה לאורך האימון.`
        );
      } else if (Math.abs(dec) < 10) {
        lines.push(
          `באותו אימון ה-Decoupling היה בינוני – יש סימנים קלים לעייפות, אבל בגבולות סבירים.`
        );
      } else {
        lines.push(
          `באותו אימון ה-Decoupling היה גבוה – סימן לעומס מצטבר או לכך שהגוף היה עייף יחסית באותו יום.`
        );
      }
    }

    lines.push("");

    // הערכה על התאוששות ומצב כושר באותו אימון
    const ifVal = summary.intensityFtp;
    let recoveryNote = "";
    let fitnessNote = "";

    if (ifVal != null) {
      if (ifVal < 0.7) {
        fitnessNote =
          "מבחינת עצימות זה נראה כמו אימון בסיס אירובי/התאוששות – יום שמחזק את הבסיס בלי להעמיס יותר מדי.";
      } else if (ifVal < 0.85) {
        fitnessNote =
          "זה היה אימון סיבולת מתון – מתאים לבניית כושר ארוך טווח ויכולת אירובית יציבה.";
      } else {
        fitnessNote =
          "זה היה אימון עצים יחסית – הוא תורם לשיפור ביצועים, אבל גם דורש התאוששות טובה אחריו.";
      }
    }

    if (dec != null && Number.isFinite(dec)) {
      if (Math.abs(dec) > 10) {
        recoveryNote =
          "בהתחשב ב-Decoupling הגבוה באותו יום, סביר שהגוף היה עמוס – התאוששות טובה אחרי האימון הזה הייתה חשובה.";
      } else if (Math.abs(dec) < 5 && ifVal && ifVal >= 0.7) {
        recoveryNote =
          "למרות העצימות, היציבות בין דופק לוואטים הייתה טובה – זה סימן חיובי ליכולת ולהתאוששות שלך באותה תקופה.";
      } else {
        recoveryNote =
          "אין סימן קיצוני לעומס, אבל כדאי תמיד לשים לב לתחושה הכללית סביב האימון הזה (שינה, רגליים, אנרגיה).";
      }
    }

    if (fitnessNote) {
      lines.push(`🧭 מצב כושר באותו אימון: ${fitnessNote}`);
    }
    if (recoveryNote) {
      lines.push(`🛌 התאוששות: ${recoveryNote}`);
    }

    const message = lines.join("\n");

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

      // 🔥 עדכון מצב אונבורדינג ל-strava_summary עם הנתונים מה-DB
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
              stage: "strava_summary",
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
            state.stage = "strava_summary";
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
            "[STRAVA] Onboarding state updated to strava_summary for",
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
