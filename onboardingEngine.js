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

    // לולאה פנימית – רצה על ה-Flow עד שצריך קלט מהמשתמש
    while (true) {
      const { newMessages, waitForUser, consumeInput } =
        await this._runStage(userId, state, pendingInput);

      if (newMessages && newMessages.length > 0) {
        messages.push(...newMessages);
      }

      if (consumeInput) {
        pendingInput = null;
      }

      if (waitForUser) {
        break;
      }
    }

    await this._saveState(userId, state);

    const reply = messages.join("\n\n");
    return {
      reply: reply || "משהו השתבש באונבורדינג, נסה שוב.",
      onboarding: true,
    };
  }

  async _loadState(userId) {
    try {
      const row = await this.db.getOnboardingState(userId);
      if (!row || !row.json_state) return null;
      return JSON.parse(row.json_state);
    } catch (err) {
      console.error("loadState error:", err);
      return null;
    }
  }

  async _saveState(userId, state) {
    try {
      await this.db.saveOnboardingState(userId, JSON.stringify(state));
    } catch (err) {
      console.error("saveState error:", err);
    }
  }

  // אחרי שסיימנו אונבורדינג – כאן בעתיד נתחבר למאמן (LOEW)
  async _handleAfterOnboarding(userId, text) {
    return {
      reply:
        "האונבורדינג שלך כבר הושלם.\n" +
        "בגרסה הנוכחית אני עדיין במוד אונבורדינג בלבד, בלי מאמן פעיל.\n" +
        "בהמשך נוסיף כאן את ההיגיון של LOEW כמאמן מלא.",
      onboarding: false,
    };
  }

  // מפעיל סטייג' לפי state.stage
  async _runStage(userId, state, userInput) {
    switch (state.stage) {
      case "intro":
        return await this._stageIntro(userId, state, userInput);

      case "await_strava_connect":
        return await this._stageAwaitStrava(userId, state, userInput);

      case "post_strava_summary":
        return await this._stagePostStravaSummary(userId, state);

      case "personal_details_intro":
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
  async _stageIntro(userId, state, userInput) {
    const msg =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים לביצוע ויעילים לטווח ארוך.\n\n" +
      "נתחיל מניתוח של הנתונים שלך מסטרבה ואיסוף כמה פרטים אישיים, כדי שאוכל להכיר אותך טוב יותר.";

    const stravaUrl = `/auth/strava?userId=${encodeURIComponent(userId)}`;
    const stravaLine = `נתחיל בלחבר אותי לסטרבה, כדי שאקבל תמונה ראשונית על הרכיבות שלך:\n${stravaUrl}`;

    state.stage = "await_strava_connect";

    return {
      newMessages: [msg, stravaLine],
      waitForUser: true,
      consumeInput: true,
    };
  }

  // 2) המתנה לחיבור סטרבה
  async _stageAwaitStrava(userId, state, userInput) {
    const snap = await this.db.getStravaOnboardingSnapshot(userId);

    if (snap && snap.trainingSummary) {
      state.data.stravaConnected = true;
      this._applyStravaSnapshotToState(state, snap);
      state.stage = "post_strava_summary";
      return {
        newMessages: [],
        waitForUser: false,
        consumeInput: true,
      };
    }

    const txt = (userInput || "").trim().toLowerCase();

    if (!txt) {
      const msg =
        "אני עדיין לא רואה נתונים מסטרבה.\n" +
        "אם כבר אישרת את החיבור, כנראה שהייבוא עדיין מתבצע.\n" +
        'אם אין לך סטרבה או שאתה מעדיף להמשיך בלעדיה, תכתוב "אין לי סטרבה".';
      return {
        newMessages: [msg],
        waitForUser: true,
        consumeInput: false,
      };
    }

    if (txt.includes("אין לי סטרבה")) {
      state.data.stravaConnected = false;
      state.stage = "personal_details_intro";
      const msg =
        "בסדר גמור, נוכל להמשיך גם בלי נתונים מסטרבה.\n" +
        "נעבור לכמה פרטים אישיים בסיסיים.";
      return {
        newMessages: [msg],
        waitForUser: false,
        consumeInput: true,
      };
    }

    const msg =
      "אם כבר אישרת את החיבור לסטרבה, ייבוא הנתונים כנראה עדיין רץ ברקע.\n" +
      "אם אין לך סטרבה, תכתוב \"אין לי סטרבה\" ונמשיך הלאה.";
    return {
      newMessages: [msg],
      waitForUser: true,
      consumeInput: true,
    };
  }

  _applyStravaSnapshotToState(state, snap) {
    state.data.trainingSummary = snap.trainingSummary || null;
    state.data.volume = snap.volume || null;
    state.data.ftp = snap.ftpModels || null;
    state.data.hr = snap.hrModels || null;
  }

  async _ensureStravaMetrics(userId, state) {
    const snap = await this.db.getStravaOnboardingSnapshot(userId);
    if (!snap) return state;

    if (!state.data.trainingSummary || !state.data.volume) {
      state.data.trainingSummary = snap.trainingSummary || null;
      state.data.volume = snap.volume || null;
    }
    if (!state.data.ftp && snap.ftpModels) {
      state.data.ftp = snap.ftpModels;
    }
    if (!state.data.hr && snap.hrModels) {
      state.data.hr = snap.hrModels;
    }

    return state;
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
      const km = ts.totalDistanceKm != null ? ts.totalDistanceKm.toFixed(1) : null;
      const elevation =
        ts.totalElevationGainM != null
          ? Math.round(ts.totalElevationGainM)
          : null;
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct) : null;

      let line =
        `בדקתי את הרכיבות שלך מהתקופה האחרונה.\n` +
        `מופיעות בסטרבה ${ts.rides_count} רכיבות בתקופה שניתחתי.\n` +
        `סה\"כ זמן רכיבה: ~${hoursTotal} שעות, זמן ממוצע לרכיבה: ~${hoursAvg} שעות.`;

      if (km != null) line += `\nסה\"כ מרחק: ~${km} ק\"מ.`;
      if (elevation != null)
        line += `\nסה\"כ טיפוס מצטבר: ~${elevation} מטר.`;
      if (offPct != null)
        line += `\nבערך ${offPct}% מהזמן שלך הוא ברכיבות שטח/גרבל.`;

      msgs.push(line);
    } else {
      msgs.push(
        "לא מצאתי מספיק רכיבות מ-90 הימים האחרונים כדי להציג סיכום נפח משמעותי.\n" +
          "נמשיך בכל מקרה עם נתונים אישיים שלך."
      );
    }

    if (volume && volume.profileText) {
      msgs.push(
        "לפי הנפח הנוכחי שלך, הפרופיל הכללי שלך נראה בערך כך:\n" +
          volume.profileText
      );
    }

    msgs.push("עכשיו נעבור לכמה פרטים אישיים בסיסיים.");

    state.stage = "personal_details_intro";
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

      if (field === "weightFromStrava") {
        const lower = txt.toLowerCase();
        // אם המשתמש מאשר במילים – נשאיר את המשקל כפי שמופיע בסטרבה
        if (
          lower.includes("אשר") ||
          lower.includes("כן") ||
          lower.includes("השאר") ||
          lower.includes("תשאיר")
        ) {
          if (typeof personal.weightFromStrava === "number") {
            personal.weightKg = Math.round(personal.weightFromStrava);
          }
          personal.weightConfirmed = true;
          delete personal.pendingField;
        } else {
          const num = parseFloat(txt.replace(",", "."));
          if (isNaN(num) || num < 30 || num > 150) {
            msgs.push("לא בטוח שהבנתי את המשקל. תכתוב מספר בקילו (למשל 67).");
            return {
              newMessages: msgs,
              waitForUser: true,
              consumeInput: true,
            };
          }
          personal.weightKg = Math.round(num);
          personal.weightConfirmed = true;
          delete personal.pendingField;
        }
      } else {
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
        }

        delete personal.pendingField;
      }
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

    state.stage = "ftp_intro";
    return {
      newMessages: msgs,
      waitForUser: false,
      consumeInput: true,
    };
  }

  _nextPersonalQuestion(state) {
    const p = state.data.personal || {};
    // אם יש משקל שמופיע בסטרבה ועדיין לא אושר, נטפל בו קודם
    if (p.weightFromStrava != null && !p.weightConfirmed && p.weightKg == null) {
      return {
        field: "weightFromStrava",
        message: `מופיע בסטרבה משקל ${p.weightFromStrava} ק"ג — לאשר או לעדכן?`,
      };
    }
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
        '\nאם תרצה, תוכל לשאול: "איך חישבת את ה-FTP?" ואסביר בפירוט.'
      );
      lines.push(
        '\nאיזה FTP נשתמש בו כנקודת פתיחה?\n' +
          'אם אתה מסכים להמלצה שלי, תכתוב "תשתמש בהמלצה".\n' +
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
        'תרשום "תשתמש בהמלצה" או מספר בוואטים (למשל 250).'
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    const ftp = data.ftp || {};
    let chosen =
      ftp.ftpRecommended ||
      ftp.ftpFromStrava ||
      ftp.ftp20 ||
      ftp.ftpFromCP ||
      ftp.ftpFrom3min ||
      null;

    if (txt === "תשתמש בהמלצה") {
      // משאיר את chosen כמו שהוא
    } else {
      const num = parseInt(txt, 10);
      if (!Number.isFinite(num) || num <= 0) {
        msgs.push(
          'לא הצלחתי להבין את הערך שכתבת. תרשום "תשתמש בהמלצה" או מספר חיובי בוואטים (למשל 250).'
        );
        return {
          newMessages: msgs,
          waitForUser: true,
          consumeInput: false,
        };
      }
      chosen = num;
    }

    if (chosen == null) {
      msgs.push(
        "לא הצלחתי להגדיר FTP על בסיס הנתונים הקיימים. תרשום ערך בוואטים (למשל 250) כדי שאשתמש בו כנקודת פתיחה."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    data.ftpFinal = chosen;
    state.stage = "hr_intro";

    msgs.push(
      `מעולה, נגדיר כרגע FTP של ${chosen}W כנקודת פתיחה. תמיד נוכל לעדכן את זה בהמשך.\n\nעכשיו נעבור לדופק — כדי שאוכל לתכנן עבורך אזורי דופק ואימונים מדויקים.`
    );

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
        `• FTP מ-3 דקות: הסקה מיכולת האנאירובית הקצרה שלך ≈ ${ftp.ftpFrom3min}W.`
      );
    if (ftp.ftpFromCP != null)
      lines.push(
        `• FTP לפי מודל CP (Critical Power): על בסיס עקומת כוח 3–20 דק' ≈ ${ftp.ftpFromCP}W.`
      );
    if (ftp.ftpFromStrava != null)
      lines.push(
        `• FTP כפי שמופיע אצלך בסטרבה: ערך קיים בפרופיל ≈ ${ftp.ftpFromStrava}W.`
      );
    if (ftp.ftpRecommended != null)
      lines.push(
        `• FTP Recommended: חציון / שילוב של כל המודלים הסבירים ≈ ${ftp.ftpRecommended}W.`
      );

    if (lines.length === 1) {
      lines.push(
        "כרגע יש לי רק מודל אחד זמין, לכן אני מתבסס עליו עד שיהיו עוד נתונים."
      );
    } else {
      lines.push(
        "אני משקלל בין המודלים כדי לבחור ערך יציב ולא קיצוני, שמתאים לפרופיל האימונים שלך."
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
        '\nאם תרצה, תוכל לשאול: "איך חישבת את הדופק?" ואסביר יותר לעומק.'
      );
      lines.push(
        "\nקודם כל, בוא נוודא את דופק המקסימום שלך.\n" +
          'אם אתה מסכים לערך שמצאתי, תכתוב "תשתמש בהמלצה".\n' +
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
        'תרשום "תשתמש בהמלצה" או מספר בדופק (למשל 180).'
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
          'לא בטוח שהבנתי. תכתוב "תשתמש בהמלצה" או מספר (למשל 180).'
        );
        return {
          newMessages: msgs,
          waitForUser: true,
          consumeInput: true,
        };
      }

      state.data.hrFinal = state.data.hrFinal || {};
      state.data.hrFinal.max = chosen;

      const recTh = hr.hrThresholdRecommended;
      let line = "עכשיו נוודא את דופק הסף (Threshold).";
      if (recTh != null) line += ` ההמלצה שלי היא ~${recTh} bpm.`;

      line +=
        '\nאם אתה מסכים, תכתוב "תשתמש בהמלצה".\n' +
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
        'לא בטוח שהבנתי. תכתוב "תשתמש בהמלצה" או מספר (למשל 170).'
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
        `• HR Threshold: נגזר משילוב מודלים (יחס ל-HRmax, drift, breakpoint בעקומה ועוד) ≈ ${hr.hrThresholdRecommended} bpm.`
      );

    if (lines.length === 0) {
      lines.push(
        "כרגע אין לי מספיק נתונים איכותיים כדי לחשב דופק מקסימום ודופק סף בצורה מתקדמת, ולכן אני נעזר במודלים כלליים יותר."
      );
    } else {
      lines.push(
        "אני בוחר ערך שמרני יחסית, שאמור לשקף טוב את מה שקורה בפועל ברכיבות שלך, ולא רק מאמץ חד-פעמי."
      );
    }

    return lines.join("\n");
  }

  // 7) מטרה
  _stageGoal(state, userInput) {
    const msgs = [];
    const txt = (userInput || "").trim();

    if (!txt) {
      msgs.push(
        "לסיום האונבורדינג, בוא נגדיר מטרה מרכזית לתקופה הקרובה (למשל: 'להעלות FTP ל-270W', 'להתכונן לגרן פונדו', 'לרדת 3 ק\"ג' וכו')."
      );
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: false,
      };
    }

    if (!state.data.goal) {
      state.data.goal = txt;
      state.stage = "summary";
      return {
        newMessages: [],
        waitForUser: false,
        consumeInput: true,
      };
    }

    msgs.push("אם תרצה לשנות מטרה בעתיד, תמיד נוכל לעדכן אותה.");
    return {
      newMessages: msgs,
      waitForUser: true,
      consumeInput: true,
    };
  }

  // 8) סיכום סופי
  async _stageSummary(userId, state) {
    const personal = state.data.personal || {};
    const ftpFinal = state.data.ftpFinal;
    const hrFinal = state.data.hrFinal || {};
    const goal = state.data.goal;
    const volume = state.data.volume;
    const ts = state.data.trainingSummary;

    const lines = [];
    lines.push("סיכום האונבורדינג שלך אצל LOEW:");

    const personalParts = [];
    if (personal.age != null) personalParts.push(`גיל: ${personal.age}`);
    if (personal.weightKg != null)
      personalParts.push(`משקל: ${personal.weightKg} ק\"ג`);
    if (personal.heightCm != null)
      personalParts.push(`גובה: ${personal.heightCm} ס\"מ`);

    if (personalParts.length > 0)
      lines.push("• פרטים אישיים: " + personalParts.join(", "));

    if (ts && ts.rides_count > 0) {
      const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
      const avgDuration = (ts.avgDurationSec / 60).toFixed(0);
      lines.push(
        `• נפח רכיבה אחרון: בערך ${hours} שעות בתקופה שניתחתי, משך ממוצע לרכיבה ~${avgDuration} דקות.`
      );
    }

    if (ftpFinal != null)
      lines.push(`• FTP התחלתי לעבודה: ${ftpFinal}W.`);

    if (hrFinal.max != null)
      lines.push(`• דופק מקסימלי לעבודה: ${hrFinal.max} bpm.`);
    if (hrFinal.threshold != null)
      lines.push(`• דופק סף לעבודה: ${hrFinal.threshold} bpm.`);

    if (goal) lines.push(`• מטרה מרכזית: ${goal}.`);

    lines.push(
      "\nבגרסה הבאה אשתמש בכל הנתונים האלו כדי לבנות עבורך תוכנית אימונים חכמה, מותאמת לזמן שיש לך, למטרה ולפרופיל האימונים שלך."
    );

    try {
      await this.db.saveTrainingParamsFromOnboarding(userId, {
        age: personal.age ?? null,
        weight: personal.weightKg ?? null,
        height: personal.heightCm ?? null,
        ftp: ftpFinal ?? null,
        hr_max: hrFinal.max ?? null,
        hr_threshold: hrFinal.threshold ?? null,
        goal: goal ?? null,
      });
    } catch (err) {
      console.error("saveTrainingParamsFromOnboarding error:", err);
    }

    state.stage = "done";

    return {
      newMessages: [lines.join("\n")],
      waitForUser: true,
      consumeInput: true,
    };
  }
}
