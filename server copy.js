import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// מצב גלובלי פשוט לרוכב הנוכחי
const loewState = {
  ftp: null,      // FTP שנבחר
  hr_max: null,   // דופק מקסימלי שנבחר
};


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ------------------------------------------
    שמירה בזיכרון של טוקנים של סטרבה
--------------------------------------------- */
let stravaTokens = null;

/* ------------------------------------------
    SYSTEM PROMPT של LOEW
--------------------------------------------- */
const LOEW_SYSTEM_PROMPT = `
You are LOEW, a world-class cycling coach.

You ALWAYS answer the user in clear, friendly Hebrew,
in a direct, masculine, supportive tone.
You NEVER mention JSON, phase, stage, snapshot, API or system prompts.

You receive a JSON payload with:
- phase: "intro" | "after_strava"
- stage: "profile" | "ftp"
- message: the user's last message (string)
- snapshot: object or null

You must use these only as INTERNAL control signals.
The user must never see the words "phase", "stage" or "snapshot".

================================================
PHASE: "intro"  – תחילת ההיכרות
================================================

When phase == "intro":

• תציג את עצמך בעברית כמאמן האישי לאופניים – LOEW.
• תסביר בקצרה שאתה רוצה להכיר את הרוכב בצורה מקצועית,
  כולל היסטוריית רכיבות, לפני שאתה נותן המלצות אימון רציניות.
• תציע להתחבר לסטרבה, ותסביר בקצרה:
  - אתה ניגש רק לנתוני רכיבה (מרחק, גובה מצטבר, דופק, וואטים, זמנים).
  - אתה לא קורא הודעות, לא קורא תוכן אישי, ולא עושה שום שימוש חיצוני בנתונים.
• תשאל בצורה ברורה:
  "אתה מאשר חיבור לסטרבה כדי שאוכל לנתח את ה־90 ימים האחרונים שלך?"

מאוד חשוב:
- אם המשתמש עונה בצורה שמעידה בבירור על הסכמה, למשל:
  "כן", "יאללה", "מאשר", "go על זה", "בטח", "סבבה, תחבר",
  אתה חייב לענות **רק** בטקסט הבא, בלי שום מילים נוספות:

  __STRAVA_CONNECT__

- אל תוסיף לפני או אחרי שום טקסט נוסף.
- הלקוח בצד השני מזהה את הטוקן הזה ויפתח את חלון ההתחברות לסטרבה.

================================================
PHASE: "after_strava" – אחרי סנכרון סטרבה
================================================

When phase == "after_strava" and snapshot != null,
your behavior depends on "stage".

The snapshot has (among others):

- snapshot.user_from_strava:
    name, weight_kg, sex
- snapshot.training_summary:
    days_window, rides_count, total_hours,
    avg_hours_per_week, total_distance_km,
    total_elevation_m, typical_ride_days
- snapshot.ftp_from_strava (may be null)
- snapshot.ftp_from_streams (may be null)

You must treat snapshot as an initial guess only.
If the user corrects any personal data in the chat (especially weight),
you must treat the latest value from the user as the truth
for all later messages.

------------------------------------------------
STAGE: "profile" – נתונים אישיים בלבד
------------------------------------------------

In this stage you DO NOT talk about FTP at all.
You only validate and refine personal profile data.

1) FIRST RESPONSE after Strava sync:

If snapshot exists AND message is empty or only whitespace:

- תסכם בעברית, בצורה קצרה וקריאה, מי הוא הרוכב על פי 90 הימים האחרונים.
- השתמש בבולטים קצרים. למשל:
  • משקל (אם קיים)
  • כמה שעות רכיבה סך הכל ב־90 יום
  • ממוצע שעות רכיבה לשבוע
  • מרחק מצטבר בק״מ
  • גובה מצטבר בטיפוס
  • באיזה ימים בשבוע בדרך כלל יוצאים לרכיבה
- תסביר בצורה ברורה מה סך הכל ל־90 יום, ומה ממוצע שבועי.
- בסיום תכתוב שאלה ברורה, לדוגמה:
  "זה נראה לך משקף את הסגנון שלך?
   תרצה לעדכן משהו כמו משקל, ימי רכיבה או נפח שבועי?"

- בשלב הזה אסור לך להזכיר FTP בכלל.

2) FOLLOW-UP RESPONSES in "profile" stage:

If snapshot exists AND message is NOT empty:

- תפרש את הודעת המשתמש כעדכון / תיקון נתונים אישיים.
  דוגמאות:
  - "המשקל שלי 67" → אתה חייב:
    • לאשר שאתה מעדכן את המשקל ל־67 ק״ג.
    • להדגיש שמעתה והלאה אתה מתייחס ל־67 כמשקל הנוכחי,
      ולא לערך המשקל שהופיע בסנאפשוט מסטרבה.
  - "אני רוכב בדרך כלל 4 פעמים בשבוע" → אתה מעדכן את מספר ימי הרכיבה.
  - "אני עושה בערך 8–9 שעות בשבוע" → אתה מעדכן נפח שבועי.

- כלל ברזל:
  בכל סיכום עתידי שבו אתה מזכיר משקל, נפח, ימי רכיבה וכד',
  אתה חייב להשתמש **בערך האחרון שהמשתמש אמר בצ'אט**,
  גם אם הוא סותר את מה שהיה ב־snapshot.

- אל תחזור כל פעם על כל הסיכום הארוך.
  במקום זה:
  • תאשר את העדכון.
  • תזכיר בקצרה מה התמונה הכללית (למשל: "סה״כ נפח ה־90 יום די עקבי").
  • תשאל:
    "רוצה לעדכן עוד משהו בפרופיל (משקל, גיל, ימי רכיבה, נפח שבועי)
     או שזהו?"

- גם בשלב הזה אתה עדיין לא מדבר על FTP בכלל.

3) MOVING from "profile" stage to "ftp" stage:

אתה עובר ל־FTP **רק כשהמשתמש מסמן לך שסיימתם לעדכן פרטים**.

זה קורה כאשר הוא עונה משהו בסגנון:

- "זהו"
- "אין עוד מה לעדכן"
- "נמשיך"
- "אפשר לעבור הלאה"
- "אפשר להמשיך"
- "הכל טוב"
- "לא" / "לא צריך" / "לא תודה"
  (כאשר זה נאמר בתגובה לשאלה שלך
   "רוצה לעדכן עוד משהו?" או ניסוח דומה).

כאשר אתה מזהה תשובה כזו:

- תענה בעברית תשובה קצרה וברורה, למשל:
  "מעולה, סגרנו את הנתונים האישיים. עכשיו נעבור לבחור FTP שנעבוד איתו."

- ובסיום התשובה, בשורה נפרדת לגמרי,
  אתה חייב לכתוב בדיוק את הטקסט הבא:

  __GO_FTP__

- אסור להוסיף שום טקסט אחרי __GO_FTP__ באותה שורה.
- הלקוח בצד השני מזהה את הטקסט הזה ומחליף stage ל־"ftp".
- המשתמש עצמו לא רואה את המחרוזת __GO_FTP__, לכן כל שאר הטקסט צריך להיות ברור ומלא בפני עצמו.

------------------------------------------------
STAGE = "ftp" – בחירת FTP ואז מעבר לדופק מקסימלי
------------------------------------------------

בשלב הזה אתה מתעסק רק בבחירת FTP התחלתי, ואז מיד בדופק מקסימלי.

יש לך ב-snapshot:
- ftp_from_strava        → FTP מסטרבה (אם קיים)
- ftp_from_streams       → FTP מחושב מהביצועים (אם קיים)
- hr_max_from_data       → דופק מקסימלי שנמדד ברכיבות (אם קיים)

1) הצגת ה־FTP:

- אם קיימים שני ערכים:
  • תכתוב בעברית:
    "לגבי FTP, יש לי עליך את הנתונים הבאים:
     • FTP מסטרבה: X וואט
     • FTP מחושב מהביצועים ברכיבות האחרונות: Y וואט"

- אם קיים רק ערך אחד:
  • תציג רק אותו, ותסביר שזה הנתון היחיד שיש כעת.

2) הסבר קצר:

- ש־FTP של סטרבה הוא הערכה שלהם.
- ש־FTP שלך מבוסס על ביצועים בפועל.

3) שלוש אפשרויות לבחירה:

תמיד תסיים כך:

"עם איזה FTP תרצה שנעבוד בהתחלה?
תוכל לבחור:
1) ערך סטרבה (אם קיים)
2) הערך שחישבתי מהביצועים שלך
3) לכתוב ערך ידני בוואטים"

4) פירוש תשובות המשתמש:

- "1" → לבחור ftp_from_strava
- "2" → לבחור ftp_from_streams
- "3" → לבקש מהמשתמש לכתוב מספר

- אם המשתמש כותב מספר (למשל 240):
  • תזהה את הערך
  • תאמץ אותו כ־FTP שנבחר
  • מעכשיו זה ה־FTP היחיד שבו תשתמש

5) אחרי שנבחר FTP:

- תכתוב לו:
  "מעולה, נצא מנקודת הנחה שה־FTP שלך הוא XXX וואט"

- ואז מיד תעבור לשלב דופק מקסימלי:

  אם snapshot.hr_max_from_data קיים:
    "לגבי דופק מקסימלי, לפי הנתונים מסטרבה
     הדופק המקסימלי שנמדד אצלך ברכיבות האחרונות הוא בערך YYY.
     זה נראה לך קרוב? או שתרצה לעדכן?"

  אם אין ערך:
    "לגבי דופק מקסימלי, אין לי נתון מסטרבה,
     מה אתה מעריך שהוא הדופק המקסימלי שלך?"

6) קביעת דופק מקסימלי:

- אם המשתמש כותב מספר:
  • תזהה את הערך
  • תאשר לו:
    "מצוין, מעדכן דופק מקסימלי ל־XXX.
     אשתמש בזה לבניית אזורי דופק מדויקים."

- אם הוא כותב:
  "כן / מתאים / נשאיר ככה":
  • תאשר:
    "מעולה, נשאר עם הדופק המקסימלי שהצגתי."

- מכאן:
  *אסור לך לחזור לשאול שוב על FTP*
  אלא אם הוא ביקש לשנות.

------------------------------------------------


================================================
כללי סגנון:
================================================

- תמיד לענות בעברית כשהמשתמש מדבר בעברית.
- להשתמש במשפטים קצרים ופסקאות קצרות, לעיתים בולטים, כדי שיהיה קל לקרוא.
- להיות מקצועי אבל חמים ותומך.
- להימנע מדיבור טכני על JSON, APIs, system prompt, tokens וכו'.
- להתייחס באמפתיה לעייפות, עומס חיים, רקע רפואי וכדומה, אם המשתמש מזכיר זאת.
`;

/* ------------------------------------------
   פונקציה שבונה Snapshot סטרבה מלא
--------------------------------------------- */
// ------------------------------------------
// בניית סנאפשוט סטרבה + חישוב FTP מהביצועים
// ------------------------------------------
// ------------------------------------------
// בניית סנאפשוט סטרבה + חישוב FTP/HR מהביצועים
// ------------------------------------------
async function buildStravaSnapshot(tokens) {
  try {
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
    };

    // --- 1. אתלט ---
    const athleteResp = await fetch("https://www.strava.com/api/v3/athlete", {
      headers,
    });
    const athlete = await athleteResp.json();

    // --- 2. פעילויות 90 יום ---
    const actsResp = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=200",
      { headers }
    );
    const allActs = await actsResp.json();

    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const acts90 = allActs.filter(
      (act) => new Date(act.start_date) >= cutoff
    );

    // הערכת דופק מקסימלי מהפעילויות
    let hrMaxFromData = null;
    acts90.forEach((act) => {
      if (act.max_heartrate) {
        if (!hrMaxFromData || act.max_heartrate > hrMaxFromData) {
          hrMaxFromData = act.max_heartrate;
        }
      }
    });

    // הערכת דופק סף (Threshold HR) ~ 90% מהמקסימום
    let hrThresholdFromData = null;
    if (hrMaxFromData) {
      hrThresholdFromData = Math.round(hrMaxFromData * 0.9);
    }

    // --- 3. סיכום נפח ---
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

    const avgHoursPerWeek = totalHours / 12.857; // 90 יום ≈ 12.857 שבועות

    // ימי רכיבה אופייניים
    const days = acts90.map((a) => new Date(a.start_date).getDay());
    const counts = {};
    days.forEach((d) => (counts[d] = (counts[d] || 0) + 1));
    const typical = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map((d) => Number(d))
      .slice(0, 3);

    // --- 4. FTP מסטרבה (אם קיים) ---
    const ftpFromStrava = athlete.ftp || null;

    // --- 5. חישוב FTP מהביצועים (streams) ---
    let globalBest3 = 0;   // וואטים ממוצעים ל-3 דקות חזקות ביותר
    let globalBest8 = 0;   // וואטים ממוצעים ל-8 דקות חזקות ביותר
    let globalBest20 = 0;  // וואטים ממוצעים ל-20 דקות חזקות ביותר

    // פונקציה פנימית – מוצאת ממוצע הכי גבוה בחלון קבוע (בהנחה לדגימה של ~1 שניה)
    function bestRollingAverage(powerArray, windowSizeSeconds) {
      if (!powerArray || powerArray.length < windowSizeSeconds) return 0;
      let windowSum = 0;
      for (let i = 0; i < windowSizeSeconds; i++) {
        windowSum += powerArray[i];
      }
      let best = windowSum / windowSizeSeconds;

      for (let i = windowSizeSeconds; i < powerArray.length; i++) {
        windowSum += powerArray[i] - powerArray[i - windowSizeSeconds];
        const avg = windowSum / windowSizeSeconds;
        if (avg > best) best = avg;
      }
      return best;
    }

    for (const act of acts90) {
      try {
        // נתייחס רק לפעילויות רכיבה
        if (
          act.sport_type &&
          !act.sport_type.toLowerCase().includes("ride")
        ) {
          continue;
        }

        const url =
          `https://www.strava.com/api/v3/activities/${act.id}/streams` +
          `?keys=watts,time&key_by_type=true`;

        const sResp = await fetch(url, { headers });
        if (!sResp.ok) continue;

        const sJson = await sResp.json();

        const wattsStream = sJson.watts && sJson.watts.data;
        if (!wattsStream || wattsStream.length < 180) {
          // פחות מ-3 דקות נתוני וואטים – לא שימושי
          continue;
        }

        // נניח דגימה שניה-שניה – מספיק טוב כקירוב
        const best3 = bestRollingAverage(wattsStream, 3 * 60);
        const best8 = bestRollingAverage(wattsStream, 8 * 60);
        const best20 = bestRollingAverage(wattsStream, 20 * 60);

        if (best3 > globalBest3) globalBest3 = best3;
        if (best8 > globalBest8) globalBest8 = best8;
        if (best20 > globalBest20) globalBest20 = best20;
      } catch (err) {
        console.error("Error fetching streams for activity", act.id, err);
      }
    }

    // --- 6. שלושת מודלי ה-FTP מהביצועים ---
    let ftpModel20 = null;
    let ftpModel8 = null;
    let ftpModel3 = null;

    if (globalBest20 > 0) {
      // מודל קלאסי: 20 דקות × 0.95
      ftpModel20 = Math.round(0.95 * globalBest20);
    }
    if (globalBest8 > 0) {
      // מודל 8 דקות × 0.90
      ftpModel8 = Math.round(0.90 * globalBest8);
    }
    if (globalBest3 > 0) {
      // מודל 3 דקות × 0.85
      ftpModel3 = Math.round(0.85 * globalBest3);
    }

    const ftpCandidates = [];
    if (ftpModel20) ftpCandidates.push(ftpModel20);
    if (ftpModel8)  ftpCandidates.push(ftpModel8);
    if (ftpModel3)  ftpCandidates.push(ftpModel3);

    let ftpFromStreams = null;
    if (ftpCandidates.length > 0) {
      // ניקח את החציון של המודלים (מדד יציב יחסית)
      ftpCandidates.sort((a, b) => a - b);
      const mid = Math.floor(ftpCandidates.length / 2);
      const median =
        ftpCandidates.length % 2 === 0
          ? (ftpCandidates[mid - 1] + ftpCandidates[mid]) / 2
          : ftpCandidates[mid];
      ftpFromStreams = Math.round(median);
    }

    // --- 7. בניית snapshot סופי ל-LOEW ---
    return {
      user_from_strava: {
        name: (athlete.firstname || "") + " " + (athlete.lastname || ""),
        weight_kg: athlete.weight || null,
        sex: athlete.sex || null,
      },
      ftp_from_strava: ftpFromStrava,
      ftp_from_streams: ftpFromStreams,
      ftp_models: {
        from_20min: ftpModel20,
        from_8min: ftpModel8,
        from_3min: ftpModel3,
      },
      hr_max_from_data: hrMaxFromData || null,
      hr_threshold_from_data: hrThresholdFromData || null,
      training_summary: {
        days_window: 90,
        rides_count: acts90.length,
        total_hours: Number(totalHours.toFixed(1)),
        avg_hours_per_week: Number(avgHoursPerWeek.toFixed(1)),
        total_distance_km: Number(totalDistance.toFixed(1)),
        total_elevation_m: totalElevation,
        typical_ride_days: typical,
      },
    };
  } catch (err) {
    console.error("Snapshot build error:", err);
    return null;
  }
}



/* ------------------------------------------
   STRAVA AUTH – קבלת טוקנים
--------------------------------------------- */
app.get("/auth/strava", (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;

  const url =
    `https://www.strava.com/oauth/mobile/authorize` +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&approval_prompt=auto` +
    `&scope=read,activity:read_all,profile:read_all`;

  res.redirect(url);
});



app.get("/auth/strava/callback", async (req, res) => {
  try {
    const code = req.query.code;

    const tokenResp = await fetch(
      "https://www.strava.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
        }),
      }
    );

    stravaTokens = await tokenResp.json();
    console.log("Strava tokens:", stravaTokens);

    return res.redirect("/?strava=connected");
  } catch (err) {
    console.error("Strava callback error:", err);
    res.send("Strava auth failed");
  }
});

// alias ל-callback של סטרבה, במקרה שה-redirect של האפליקציה מוגדר ל-/exchange_token
app.get("/exchange_token", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      console.error("Missing code from Strava");
      return res.status(400).send("Missing code from Strava");
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
      console.error("Strava token error (/exchange_token):", json);
      return res.status(500).send("Strava token exchange failed");
    }

    stravaTokens = json;
    console.log("Strava tokens (via /exchange_token):", stravaTokens);

    return res.redirect("/?strava=connected");
  } catch (err) {
    console.error("Strava /exchange_token error:", err);
    res.status(500).send("Strava auth failed");
  }
});




/* ------------------------------------------
   STRAVA SNAPSHOT API
--------------------------------------------- */
app.get("/api/loew/strava-snapshot", async (req, res) => {
  try {
    if (!stravaTokens) {
      return res.json({ ok: false, error: "Strava not connected" });
    }

    const snapshot = await buildStravaSnapshot(stravaTokens);
    return res.json({ ok: true, snapshot });
  } catch (err) {
    console.error("snapshot error:", err);
    return res.json({ ok: false, error: "Snapshot failed" });
  }
});

/* ------------------------------------------
   LOEW CHAT API
--------------------------------------------- */
app.post("/api/loew/chat", async (req, res) => {

  try {
    const { phase, stage, message, snapshot } = req.body;

    const effectivePhase = phase || (snapshot ? "after_strava" : "intro");
    const effectiveStage = stage || "profile";

    // 1. שמירת FTP אם אנחנו בשלב FTP והמשתמש בחר ערך
    if (effectivePhase === "after_strava" && effectiveStage === "ftp" && message && !loewState.ftp) {
      const trimmed = String(message).trim();

      let chosenFtp = null;

      // מקרה 1: המשתמש כותב "1" / "2" / "3"
      if (["1", "2", "3"].includes(trimmed) && snapshot) {
        const sFtp = snapshot.ftp_from_strava || null;
        const cFtp = snapshot.ftp_from_streams || null;

        if (trimmed === "1" && sFtp) {
          chosenFtp = sFtp;
        } else if (trimmed === "2" && cFtp) {
          chosenFtp = cFtp;
        }
      }

      // מקרה 2: כתב מספר FTP מפורש (למשל "240")
      const numMatch = trimmed.match(/(\d{2,3})/);
      if (!chosenFtp && numMatch) {
        const val = parseInt(numMatch[1], 10);
        // רק טווח הגיוני, נניח 120–450 וואט
        if (val >= 120 && val <= 450) {
          chosenFtp = val;
        }
      }

      if (chosenFtp) {
        loewState.ftp = chosenFtp;
        console.log("LOEW: FTP chosen =", chosenFtp);
      }
    }

    // 2. שמירת דופק מקסימלי, אם אנחנו בשלב HRMAX (נוסיף עוד רגע)
    if (effectivePhase === "after_strava" && effectiveStage === "hrmax" && message && !loewState.ftp) {
      const trimmed = String(message).trim();
      const numMatch = trimmed.match(/(\d{2,3})/);
      if (numMatch) {
        const hrVal = parseInt(numMatch[1], 10);
        // טווח הגיוני לדופק מקסימלי (160–220)
        if (hrVal >= 150 && hrVal <= 220) {
          loewState.hr_max = hrVal;
          console.log("LOEW: HR max chosen =", hrVal);
        }
      }
    }

    // 3. payload שנשלח ל-LOEW – כולל גם הערכים שנשמרו
    const payload = {
      phase: effectivePhase,
      stage: effectiveStage,
      message: message || "",
      snapshot: snapshot || null,
      state: {
        ftp_chosen: loewState.ftp,
        hr_max_chosen: loewState.hr_max,
      },
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: LOEW_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content || "לא הצלחתי לענות כרגע.";

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("loew chat error:", err);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});


/* ------------------------------------------
   START SERVER
--------------------------------------------- */
app.listen(port, () => {
  console.log(`LOEW server listening on http://localhost:${port}`);
});
