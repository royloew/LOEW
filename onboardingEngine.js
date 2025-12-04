// onboardingEngine.js
// מנוע אונבורדינג לפי ה-FLOW שלנו, מותאם ל-dbSqlite.js ול-server.js

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // נקודת כניסה עיקרית
  async handleMessage(userId, textRaw) {
    let text = (textRaw || "").trim();
    let state = await this._loadState(userId);

    // אם האונבורדינג כבר הושלם – לא חוזרים לפתיחה
    if (state && state.stage === "done") {
      return await this._handleAfterOnboarding(userId, text);
    }

    // משתמש חדש / state שבור -> אתחול
    if (!state || !state.stage || !state.data) {
      state = {
        stage: "intro",
        data: {
          personal: {},
          ftp: null,
          ftpFinal: null,
          hr: null,
          hrFinal: null,
          goal: null,
          volume: null,
          trainingSummary: null,
          stravaConnected: false,
        },
      };
    }

    let pendingInput = text || null;
    const messages = [];

    while (true) {
      const { newMessages, waitForUser, consumeInput } =
        await this._runStage(userId, state, pendingInput);

      if (newMessages && newMessages.length) {
        messages.push(...newMessages);
      }

      if (consumeInput) {
        pendingInput = null;
      }

      await this._saveState(userId, state);

      if (waitForUser) break;
    }

    return {
      reply: messages.join("\n\n"),
      onboarding: true,
    };
  }

  // תגובה אחרי שהאונבורדינג כבר הסתיים
  async _handleAfterOnboarding(userId, text) {
    // TODO: פה בעתיד יחיה המאמן "הרגיל" של LOEW.
    // בינתיים – הודעה עדינה שלא חוזרים לאונבורדינג.
    if (!text) {
      text = "היי";
    }

    const reply =
      "האונבורדינג שלך כבר הושלם ✅\n" +
      "בגרסה הנוכחית אני עדיין במוד אונבורדינג בלבד, אבל הנתונים שלך שמורים.\n" +
      "בקרוב אוכל לתת גם המלצות אימון חכמות מתוך הפרופיל שלך.";

    return {
      reply,
      onboarding: false,
    };
  }

  // ---------------- לוגיקת סטייג'ים ----------------

  async _runStage(userId, state, userInput) {
    switch (state.stage) {
      case "intro":
        return await this._stageIntro(userId, state, userInput);

      case "await_strava_connect":
        return await this._stageAwaitStrava(userId, state, userInput);

      case "post_strava_import":
        return await this._stagePostStravaSummary(userId, state);

      case "personal_details_collect":
        return this._stagePersonalDetails(state, userInput);

      case "ftp_intro":
      case "ftp_confirm":
        return this._stageFtp(state, userInput);

      case "hr_intro":
      case "hr_confirm":
        return this._stageHr(state, userInput);

      case "goal":
        return this._stageGoal(state, userInput);

      case "summary":
        return await this._stageSummary(userId, state);

      default:
        state.stage = "intro";
        return await this._stageIntro(userId, state, userInput);
    }
  }

  // 1) הודעת פתיחה – תמיד פעם אחת בלבד למשתמש שלא סיים אונבורדינג
  // 1) הודעת פתיחה – תמיד פעם אחת בלבד למשתמש שלא סיים אונבורדינג
async _stageIntro(userId, state, userInput) {
  const msg =
    "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
    "אני מבסס את ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות ותזונה.\n\n" +
    "השלב הראשון שלנו יהיה להתחבר לסטרבה כדי שאוכל ללמוד את ההיסטוריה שלך.";

  // מעדכן סטייג' הבא, אבל *לא* ממשיך אליו באותה בקשה
  state.stage = "await_strava_connect";

  return {
    newMessages: [msg],
    waitForUser: true,   // ✅ עוצרים כאן, מחכים להודעה הבאה מהמשתמש
    consumeInput: true,  // ✅ "היי" נצרך, לא ממשיך הלאה
  };
}


  // 2) שלב סטרבה – הכל קורה אוטומטית:
  // אם יש סטרבה -> ישר סיכום נפח
  // אם אין סטרבה -> מיד הודעה עם לינק
  // אחרי פעמיים בלי סטרבה -> ממשיכים בלי סטרבה לנתונים אישיים
  async _stageIntro(userId, state, userInput) {
  const introMsg =
    "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
    "אני מבסס את ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות ותזונה.\n\n" +
    "השלב הראשון שלנו יהיה להתחבר לסטרבה כדי שאוכל ללמוד את ההיסטוריה שלך.";

  const connectUrl = `/auth/strava?userId=${encodeURIComponent(userId)}`;
  const stravaMsg =
    "כדי שאוכל לנתח את ההיסטוריה שלך אני צריך שתתחבר לסטרבה.\n\n" +
    `לחץ על הלינק להתחברות לסטרבה:\n${connectUrl}\n\n` +
    "אחרי שתאשר את הגישה בסטרבה, תחזור לכאן ונמשיך משם.";

  // אחרי הודעת הפתיחה + סטרבה אנחנו עוברים ל-stage שמחכה לסטטוס סטרבה
  state.stage = "await_strava_connect";

  return {
    newMessages: [introMsg, stravaMsg],
    waitForUser: true,   // מחכים לפעולה (או חיבור סטרבה או 'היי' נוסף)
    consumeInput: true,  // התוכן 'היי' לא חשוב, סיימנו איתו
  };
}

// 2) שלב סטרבה – אחרי ה-intro
async _stageAwaitStrava(userId, state, userInput) {
  if (!state.data) state.data = {};

  // 1) קודם ננסה לראות אם כבר יש נתונים מסטרבה (המשתמש התחבר וחזר)
  if (
    this.db &&
    typeof this.db.getStravaOnboardingSnapshot === "function"
  ) {
    try {
      const snap = await this.db.getStravaOnboardingSnapshot(userId);
      if (snap && (snap.trainingSummary || snap.volume || snap.ftpModels)) {
        // יש סטרבה → מטמיעים ב-state ועוברים לסיכום נפח
        state.data.stravaConnected = true;
        this._applyStravaSnapshotToState(state, snap);
        state.stage = "post_strava_import";
        return {
          newMessages: [],
          waitForUser: false,
          consumeInput: true,
        };
      }
    } catch (err) {
      console.error("getStravaOnboardingSnapshot error (await_strava):", err);
    }
  }

  // 2) אין סטרבה גם אחרי שהמשתמש חזר לצ'אט → ממשיכים בלי סטרבה לנתונים אישיים
  const msgs = [];
  msgs.push(
    "לא מצאתי חיבור פעיל לסטרבה.\n" +
      "זה בסדר, נמשיך לבנות את הפרופיל שלך גם בלי ההיסטוריה, ותמיד נוכל להתחבר לסטרבה בהמשך."
  );

  state.stage = "personal_details_collect";
  const personal = state.data.personal || (state.data.personal = {});
  const firstQuestion = this._nextPersonalQuestion(state);
  if (firstQuestion) {
    personal.pendingField = firstQuestion.field;
    msgs.push(firstQuestion.message);
  }

  return {
    newMessages: msgs,
    waitForUser: true,
    consumeInput: true,
  };
}


  // 3) סיכום נפח מסטרבה + מעבר לנתונים אישיים
  async _stagePostStravaSummary(userId, state) {
    state = await this._ensureStravaMetrics(userId, state);
    const ts = state.data.trainingSummary;
    const volume = state.data.volume;

    const msgs = [];

    if (ts && ts.rides_count > 0) {
      const hoursTotal = (ts.totalMovingTimeSec / 3600).toFixed(1);
      const hoursAvg = (ts.avgDurationSec / 3600).toFixed(1);
      const km =
        ts.totalDistanceKm != null ? ts.totalDistanceKm.toFixed(1) : null;
      const elevation =
        ts.totalElevationGainM != null
          ? Math.round(ts.totalElevationGainM)
          : null;
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct) : null;

      let line =
        `בדקתי את הרכיבות שלך מהתקופה האחרונה.\n` +
        `מצאתי ${ts.rides_count} רכיבות בתקופה שניתחתי.\n` +
        `סה\"כ זמן רכיבה: ~${hoursTotal} שעות, זמן ממוצע לרכיבה: ~${hoursAvg} שעות.`;

      if (km != null) line += `\nסה\"כ מרחק: ~${km} ק\"מ.`;
      if (elevation != null) line += `\nסה\"כ טיפוס: ~${elevation} מטר.`;
      if (offPct != null) {
        line += `\nבערך ${offPct}% מהרכיבות הן שטח / גרבל.`;
      }

      if (volume && volume.avgDurationSec != null) {
        const wh = (volume.avgDurationSec / 3600).toFixed(1);
        line += `\nהיקף האימונים השבועי הממוצע (הערכה) הוא בערך ${wh} שעות.`;
      }

      msgs.push(line);
    } else {
      msgs.push(
        "לא מצאתי מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח משמעותי.\n" +
          "זה לא נורא, נבנה את הפרופיל שלך יחד מהיום והלאה."
      );
    }

    msgs.push(
      "בוא נשלים עכשיו כמה נתונים אישיים בסיסיים: גיל, משקל, גובה וכו'."
    );

    state.stage = "personal_details_collect";

    // מוודא שיש personal
    const personal = state.data.personal || (state.data.personal = {});
    const firstQuestion = this._nextPersonalQuestion(state);
    if (firstQuestion) {
      personal.pendingField = firstQuestion.field;
      msgs.push(firstQuestion.message);
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // אם איכשהו כבר יש הכל
    state.stage = "ftp_intro";
    return {
      newMessages: msgs,
      waitForUser: false,
      consumeInput: true,
    };
  }

  // 4) נתונים אישיים
  _stagePersonalDetails(state, userInput) {
    const msgs = [];
    const personal = state.data.personal || (state.data.personal = {});
    const txt = (userInput || "").trim();

    if (personal.pendingField) {
      const field = personal.pendingField;
      if (!txt) {
        msgs.push("אני צריך תשובה קצרה כדי שאוכל לעדכן את הנתון.");
        return {
          newMessages: msgs,
          waitForUser: true,
          consumeInput: false,
        };
      }

      const num = parseFloat(txt.replace(",", "."));
      if (field === "age") {
        if (isNaN(num) || num < 10 || num > 90) {
          msgs.push("לא בטוח שהבנתי את הגיל. תכתוב מספר סביר (למשל 46).");
          return {
            newMessages: msgs,
            waitForUser: true,
            consumeInput: true,
          };
        }
        personal.age = Math.round(num);
        msgs.push(`עדכנתי גיל: ${personal.age}.`);
      } else if (field === "weightKg") {
        if (isNaN(num) || num < 30 || num > 150) {
          msgs.push("לא בטוח שהבנתי את המשקל. תכתוב מספר בקילו (למשל 67).");
          return {
            newMessages: msgs,
            waitForUser: true,
            consumeInput: true,
          };
        }
        personal.weightKg = Math.round(num);
        msgs.push(`עדכנתי משקל: ${personal.weightKg} ק\"ג.`);
      } else if (field === "heightCm") {
        if (isNaN(num) || num < 120 || num > 220) {
          msgs.push("לא בטוח שהבנתי את הגובה. תכתוב מספר בס\"מ (למשל 178).");
          return {
            newMessages: msgs,
            waitForUser: true,
            consumeInput: true,
          };
        }
        personal.heightCm = Math.round(num);
        msgs.push(`עדכנתי גובה: ${personal.heightCm} ס\"מ.`);
      }

      delete personal.pendingField;
    }

    const nextQ = this._nextPersonalQuestion(state);
    if (nextQ) {
      personal.pendingField = nextQ.field;
      msgs.push("יש עוד נתון אחד שחשוב לי להשלים כדי לדייק את הפרופיל שלך.");
      msgs.push(nextQ.message);
      state.stage = "personal_details_collect";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    msgs.push(
      "מעולה, עדכנתי את הנתונים האישיים שלך.\n" +
        "תמיד תוכל לעדכן גיל, משקל או גובה גם בהמשך."
    );
    state.stage = "ftp_intro";
    return {
      newMessages: msgs,
      waitForUser: false,
      consumeInput: true,
    };
  }

  _nextPersonalQuestion(state) {
    const p = state.data.personal || {};
    if (p.age == null)
      return { field: "age", message: "נתחיל בגיל — בן כמה אתה?" };
    if (p.weightKg == null)
      return {
        field: "weightKg",
        message: "מה המשקל שלך בקילוגרמים (למשל 67)?",
      };
    if (p.heightCm == null)
      return {
        field: "heightCm",
        message: "ומה הגובה שלך בס\"מ (למשל 178)?",
      };
    return null;
  }

  // 5) FTP
  _stageFtp(state, userInput) {
    const msgs = [];
    const data = state.data;

    if (state.stage === "ftp_intro") {
      const ftp = data.ftp || {};
      const lines = [];

      lines.push("עכשיו נעבור ל-FTP — מדד היכולת האירובית שלך על האופניים.");

      if (
        ftp.ftp20 == null &&
        ftp.ftpFrom3min == null &&
        ftp.ftpFromCP == null &&
        ftp.ftpFromStrava == null
      ) {
        lines.push(
          "כרגע אין לי מספיק נתונים מסטרבה כדי לחשב FTP בצורה חכמה.\n" +
            "בוא נגדיר ערך התחלתי, ותמיד נעדכן כשיצטברו עוד נתונים."
        );
      } else {
        lines.push("חישבתי עבורך כמה מודלים שונים של FTP על בסיס הרכיבות שלך:");
        if (ftp.ftp20 != null)
          lines.push(`• FTP20 (20 דק'): ~${ftp.ftp20}W.`);
        if (ftp.ftpFrom3min != null)
          lines.push(
            `• FTP מ-3 דקות: ~${ftp.ftpFrom3min}W (הסקה מיכולת 3 דק').`
          );
        if (ftp.ftpFromCP != null)
          lines.push(
            `• FTP לפי מודל CP: ~${ftp.ftpFromCP}W (עקומת כוח 3–20 דק').`
          );
        if (ftp.ftpFromStrava != null)
          lines.push(
            `• FTP כפי שמופיע אצלך בסטרבה: ~${ftp.ftpFromStrava}W.`
          );
        if (ftp.ftpRecommended != null)
          lines.push(
            `על בסיס כל המודלים, ההמלצה שלי כרגע היא ~${ftp.ftpRecommended}W.`
          );
      }

      lines.push(
        "\nאם תרצה, תוכל לשאול: \"איך חישבת את ה-FTP?\" ואסביר בפירוט."
      );
      lines.push(
        "\nאיזה FTP נשתמש בו כנקודת פתיחה?\n" +
          "אם אתה מסכים להמלצה שלי, תכתוב \"תשתמש בהמלצה\".\n" +
          "אם אתה רוצה ערך אחר, תכתוב מספר בוואטים (למשל 250)."
      );

      msgs.push(lines.join("\n"));
      state.stage = "ftp_confirm";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    const txt = (userInput || "").trim();
    if (!txt) {
      msgs.push(
        "תרשום \"תשתמש בהמלצה\" או מספר בוואטים (למשל 250)."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    const lower = txt.toLowerCase();
    if (
      lower.includes("איך חישבת") ||
      lower.includes("פירוט") ||
      lower.includes("הסבר")
    ) {
      msgs.push(this._explainFtpModels(state));
      msgs.push(
        "עכשיו תרשום אם אתה רוצה שנשתמש בהמלצה או ערך אחר בוואטים."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    const ftp = state.data.ftp || {};
    let chosen = null;

    if (lower.includes("המלצ")) {
      if (ftp.ftpRecommended != null) chosen = ftp.ftpRecommended;
      else if (ftp.ftpFromStrava != null) chosen = ftp.ftpFromStrava;
    } else {
      const num = parseFloat(txt.replace(",", "."));
      if (!isNaN(num) && num > 100 && num < 500) chosen = Math.round(num);
    }

    if (chosen == null) {
      msgs.push(
        "לא בטוח שהבנתי. תכתוב \"תשתמש בהמלצה\" או מספר בוואטים (למשל 250)."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    state.data.ftpFinal = chosen;
    msgs.push(`מעולה, נגדיר כרגע FTP של ${chosen}W.`);
    state.stage = "hr_intro";
    return {
      newMessages: msgs,
      waitForUser: false,
      consumeInput: true,
    };
  }

  _explainFtpModels(state) {
    const ftp = state.data.ftp || {};
    const lines = [];

    lines.push("פירוט חישובי ה-FTP שביצעתי עבורך:");
    if (ftp.ftp20 != null)
      lines.push(
        `• FTP20: ממוצע של מאמצי 20 דק' חזקים * 0.95 ≈ ${ftp.ftp20}W.`
      );
    if (ftp.ftpFrom3min != null)
      lines.push(
        `• מודל 3 דקות: נגזר מהיכולת שלך במאמץ של ~3 דק' ≈ ${ftp.ftpFrom3min}W.`
      );
    if (ftp.ftpFromCP != null)
      lines.push(
        `• מודל CP (Critical Power): שימוש בעקומת כוח ב-3–20 דק' ≈ ${ftp.ftpFromCP}W.`
      );
    if (ftp.ftpFromStrava != null)
      lines.push(`• FTP מסטרבה: הערך שנשמר אצלך בסטרבה ≈ ${ftp.ftpFromStrava}W.`);
    if (ftp.ftpRecommended != null)
      lines.push(
        `בסוף בחרתי ftpRecommended כחציון של כל הערכים הסבירים ≈ ${ftp.ftpRecommended}W.`
      );

    if (lines.length === 1) {
      return (
        "כרגע אין לי מודלים מחושבים ל-FTP כי חסרים נתונים חזקים מספיק מסטרבה.\n" +
        "ככל שתעשה יותר מאמצים ארוכים, אוכל לחשב את זה בצורה חכמה יותר."
      );
    }

    return lines.join("\n");
  }

  // 6) דופק
  _stageHr(state, userInput) {
    const msgs = [];
    const hr = state.data.hr || {};

    if (state.stage === "hr_intro") {
      const lines = [];

      lines.push(
        "עכשיו נעבור לדופק — כדי שאוכל לתכנן עבורך אזורי דופק ואימונים מדויקים."
      );

      if (hr.hrMaxTop3 != null)
        lines.push(
          `מהניתוח של הרכיבות שלך, דופק המקסימום המוערך הוא בערך ${hr.hrMaxTop3} bpm.`
        );
      if (hr.hrThresholdRecommended != null)
        lines.push(
          `דופק הסף המומלץ כרגע הוא בערך ${hr.hrThresholdRecommended} bpm.`
        );

      lines.push(
        "\nאם תרצה, תוכל לשאול: \"איך חישבת את הדופק?\" ואסביר יותר לעומק."
      );
      lines.push(
        "\nקודם כל, בוא נוודא את דופק המקסימום שלך.\n" +
          "אם אתה מסכים לערך שמצאתי, תכתוב \"תשתמש בהמלצה\".\n" +
          "אם יש לך ערך אחר, תכתוב מספר (למשל 180)."
      );

      msgs.push(lines.join("\n"));
      state.stage = "hr_confirm";
      state.data.hrPending = "max";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    const txt = (userInput || "").trim();
    if (!txt) {
      msgs.push(
        "תרשום \"תשתמש בהמלצה\" או מספר בדופק (למשל 180)."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    const lower = txt.toLowerCase();
    if (
      lower.includes("איך חישבת") ||
      lower.includes("פירוט") ||
      lower.includes("הסבר")
    ) {
      msgs.push(this._explainHrModels(state));
      msgs.push(
        "עכשיו תרשום אם אתה מסכים להמלצה או רוצה לעדכן מספר אחר."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    if (state.data.hrPending === "max") {
      let chosen = null;
      if (lower.includes("המלצ")) {
        if (hr.hrMaxTop3 != null) chosen = hr.hrMaxTop3;
      } else {
        const num = parseFloat(txt.replace(",", "."));
        if (!isNaN(num) && num > 120 && num < 220) chosen = Math.round(num);
      }

      if (chosen == null) {
        msgs.push(
          "לא בטוח שהבנתי. תכתוב \"תשתמש בהמלצה\" או מספר (למשל 180)."
        );
        return {
          newMessages: msgs,
          waitForUser: true,
          consumeInput: true,
        };
      }

      state.data.hrFinal = state.data.hrFinal || {};
      state.data.hrFinal.max = chosen;
      msgs.push(`עדכנתי דופק מקסימלי: ${chosen} bpm.`);

      const recTh = hr.hrThresholdRecommended;
      let line = "עכשיו נוודא את דופק הסף (Threshold).";
      if (recTh != null) line += ` ההמלצה שלי היא ~${recTh} bpm.`;
      line +=
        "\nאם אתה מסכים, תכתוב \"תשתמש בהמלצה\".\n" +
        "אם יש לך ערך אחר, תכתוב מספר (למשל 170).";

      msgs.push(line);
      state.data.hrPending = "threshold";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // threshold
    let chosenTh = null;
    if (lower.includes("המלצ")) {
      if (hr.hrThresholdRecommended != null) {
        chosenTh = hr.hrThresholdRecommended;
      } else if (state.data.hrFinal && state.data.hrFinal.max != null) {
        chosenTh = Math.round(state.data.hrFinal.max * 0.9);
      }
    } else {
      const num = parseFloat(txt.replace(",", "."));
      if (!isNaN(num) && num > 100 && num < 220) chosenTh = Math.round(num);
    }

    if (chosenTh == null) {
      msgs.push(
        "לא בטוח שהבנתי. תכתוב \"תשתמש בהמלצה\" או מספר (למשל 170)."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    state.data.hrFinal = state.data.hrFinal || {};
    state.data.hrFinal.threshold = chosenTh;
    delete state.data.hrPending;

    msgs.push(`מעולה, נגדיר דופק סף של ${chosenTh} bpm.`);

    state.stage = "goal";
    return {
      newMessages: msgs,
      waitForUser: false,
      consumeInput: true,
    };
  }

  _explainHrModels(state) {
    const hr = state.data.hr || {};
    const lines = [];

    if (hr.hrMaxTop3 != null)
      lines.push(
        `• HRmax Top3: ממוצע של 3 ערכי הדופק הגבוהים ביותר מחצי השנה האחרונה ≈ ${hr.hrMaxTop3} bpm.`
      );
    if (hr.hrThresholdRecommended != null)
      lines.push(
        `• HR Threshold: נגזר משילוב של HRmax והדינמיקה של הדופק במאמצים ארוכים ≈ ${hr.hrThresholdRecommended} bpm.`
      );

    if (!lines.length) {
      return (
        "כרגע אין מספיק נתוני דופק איכותיים כדי לבנות מודלים מתקדמים.\n" +
        "ככל שתעשה יותר אימונים עם מד דופק, אוכל לדייק את זה."
      );
    }

    return lines.join("\n");
  }

  // 7) מטרה
  _stageGoal(state, userInput) {
    const msgs = [];
    const txt = (userInput || "").trim();

    if (!state.data.goal && !txt) {
      msgs.push(
        "מה המטרה העיקרית שלך בחודשים הקרובים?\n" +
          "לדוגמה: \"Gran Fondo Eilat בדצמבר\", \"להעלות FTP ל-270W\" וכו'."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    if (!state.data.goal) {
      state.data.goal = txt;
      msgs.push(`סימנתי כמטרה: ${txt}.`);
      msgs.push("תמיד נוכל לשנות או לעדכן את המטרה בהמשך.");
      state.stage = "summary";
      return {
        newMessages: msgs,
        waitForUser: false,
        consumeInput: true,
      };
    }

    state.stage = "summary";
    return {
      newMessages: [],
      waitForUser: false,
      consumeInput: false,
    };
  }

  // 8) סיכום + שמירה ל-training_params + סימון done
  async _stageSummary(userId, state) {
    const d = state.data;
    const p = d.personal || {};
    const ftp = d.ftpFinal;
    const hrFinal = d.hrFinal || {};
    const goal = d.goal;

    const lines = [];
    lines.push("סיכום קצר של הפרופיל שבנינו לך:");

    const pd = [];
    if (p.age != null) pd.push(`גיל: ${p.age}`);
    if (p.weightKg != null) pd.push(`משקל: ${p.weightKg} ק\"ג`);
    if (p.heightCm != null) pd.push(`גובה: ${p.heightCm} ס\"מ`);
    if (pd.length) lines.push("• נתונים אישיים: " + pd.join(", "));

    if (ftp != null) lines.push(`• FTP התחלתי: ${ftp}W.`);

    const hrParts = [];
    if (hrFinal.max != null) hrParts.push(`HRmax ≈ ${hrFinal.max}`);
    if (hrFinal.threshold != null)
      hrParts.push(`HRthr ≈ ${hrFinal.threshold}`);
    if (hrParts.length) lines.push("• דופק: " + hrParts.join(", "));

    if (goal) lines.push(`• מטרה: ${goal}`);

    lines.push(
      "\nמכאן נוכל להתחיל לבנות לך אימונים חכמים, לנתח עומס שבועי ולעקוב אחרי ההתקדמות שלך."
    );

    // שמירה ל-training_params
    if (this.db && typeof this.db.saveTrainingParams === "function") {
      try {
        await this.db.saveTrainingParams(userId, {
          age: p.age ?? null,
          weight: p.weightKg ?? null,
          height: p.heightCm ?? null,
          ftp: ftp ?? null,
          hr_max: hrFinal.max ?? null,
          hr_threshold: hrFinal.threshold ?? null,
          min_duration: null,
          typical_duration: null,
          max_duration: null,
          goal: goal ?? null,
          ftp_from_20min: d.ftp?.ftp20 ?? null,
          ftp_from_3min: d.ftp?.ftpFrom3min ?? null,
          ftp_from_cp: d.ftp?.ftpFromCP ?? null,
          ftp_recommended: d.ftp?.ftpRecommended ?? null,
        });
      } catch (e) {
        console.error("saveTrainingParams error:", e);
      }
    }

    // סימון שהאונבורדינג הושלם
    state.stage = "done";

    return {
      newMessages: [lines.join("\n")],
      waitForUser: true,
      consumeInput: false,
    };
  }

  // ---------- סטרבה: סנאפשוט ל-state ----------

  _applyStravaSnapshotToState(state, snap) {
    const d = state.data || (state.data = {});
    if (snap.trainingSummary) d.trainingSummary = snap.trainingSummary;
    if (snap.volume) d.volume = snap.volume;

    if (snap.ftpModels) {
      const m = snap.ftpModels;
      d.ftp = d.ftp || {};
      d.ftp.ftp20 = m.ftpFrom20min ?? null;
      d.ftp.ftpFrom3min = m.ftpFrom3minModel ?? null;
      d.ftp.ftpFromCP = m.ftpFromCP ?? null;
      d.ftp.ftpFromStrava = null; // אם תרצה, אפשר להוסיף תמיכה בערך הזה מה-DB
      d.ftp.ftpRecommended = m.ftpRecommended ?? null;

      d.hr = d.hr || {};
      d.hr.hrMaxTop3 = m.hrMaxCandidate ?? null;
      d.hr.hrThresholdRecommended = m.hrThresholdCandidate ?? null;
      d.hr.hrModelsDetails = null;
    }
  }

  async _ensureStravaMetrics(userId, state) {
    const d = state.data || (state.data = {});
    if (d.trainingSummary && d.volume && d.ftp && d.hr) return state;

    if (
      !this.db ||
      typeof this.db.getStravaOnboardingSnapshot !== "function"
    ) {
      return state;
    }

    try {
      const snap = await this.db.getStravaOnboardingSnapshot(userId);
      if (snap) this._applyStravaSnapshotToState(state, snap);
    } catch (e) {
      console.error("getStravaOnboardingSnapshot error:", e);
    }

    return state;
  }

  // ---------- STATE DB ----------

  async _loadState(userId) {
    if (!this.db || typeof this.db.getOnboardingState !== "function") {
      return null;
    }
    try {
      const s = await this.db.getOnboardingState(userId);
      return s || null;
    } catch (e) {
      console.error("getOnboardingState error:", e);
      return null;
    }
  }

  async _saveState(userId, state) {
    if (!this.db || typeof this.db.saveOnboardingState !== "function") return;
    try {
      await this.db.saveOnboardingState(userId, state);
    } catch (e) {
      console.error("saveOnboardingState error:", e);
    }
  }
}
