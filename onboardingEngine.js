// onboardingEngine.js
// מנוע אונבורדינג לפי ה-FLOW שסיכמנו, עם לולאה פנימית ומבנה מסודר.

// ציפיות מ-dbImpl (תתאם לפי מה שיש לך בפועל):
// - getOnboardingState(userId) -> { stage, data } | null
// - saveOnboardingState(userId, state)
// - markOnboardingCompleted(userId, finalProfile)   (אופציונלי)
// - getStravaSnapshot(userId) -> { volume, trainingSummary, ftp, hr }  (אופציונלי)
//   * ftp: { ftp20, ftpFrom3min, ftpFromCP, ftpFromStrava, ftpRecommended }
//   * hr:  { hrMaxTop3, hrThresholdRecommended, hrModelsDetails }
//
// הערה: אם יש לך שמות אחרים (למשל getStravaOnboardingMetrics במקום getStravaSnapshot)
// פשוט תעדכן את הפונקציה _ensureStravaMetrics לממשק הקיים.

export default class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // נקודת הכניסה העיקרית מהשרת /api/loew/chat
  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();
    let state = await this._loadState(userId);

    // אם אין state — משתמש חדש
    if (!state) {
      state = {
        stage: "intro",
        data: {
          personal: {}, // age, weightKg, heightCm וכו'
          ftp: null, // כל המודלים
          ftpFinal: null,
          hr: null, // מודלים וערכים
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

    // לולאה פנימית: מתקדמים בין סטייג'ים כל עוד לא חייבים תשובת משתמש
    // או פעולה חיצונית (כמו חיבור סטרבה)
    while (true) {
      const {
        newMessages,
        waitForUser,
        consumeInput,
      } = await this._runStage(userId, state, pendingInput);

      if (newMessages && newMessages.length) {
        messages.push(...newMessages);
      }

      if (consumeInput) {
        pendingInput = null;
      }

      await this._saveState(userId, state);

      if (waitForUser) {
        break;
      }
    }

    const reply = messages.join("\n\n");
    return { reply, onboarding: true };
  }

  // נקודה שהשרת יקרא אחרי שסטרבה מחזירה קוד / טוקן
  // לדוגמה ב-/exchange_token
  async handleStravaConnected(userId) {
    let state = await this._loadState(userId);
    if (!state) {
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

    state.data.stravaConnected = true;
    state.stage = "post_strava_import"; // בשיחה הבאה נציג סיכום ונעבור לנתונים אישיים

    // מנסה לטעון כבר עכשיו את המטריקות מסטרבה – אם זמין
    state = await this._ensureStravaMetrics(userId, state);

    await this._saveState(userId, state);

    return {
      reply:
        "התחברתי לסטרבה שלך וסיימתי לייבא את הנתונים.\n" +
        "בוא נחזור לצ'אט ונעשה סיכום קצר ונמשיך משם.",
      onboarding: true,
    };
  }

  // -------- לוגיקת הסטייג'ים --------

  async _runStage(userId, state, userInput) {
    switch (state.stage) {
      case "intro":
        return this._stageIntro(state);

      case "await_strava_connect":
        return this._stageAwaitStrava(state, userInput);

      case "post_strava_import":
        return this._stagePostStravaSummary(userId, state);

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
        return this._stageSummary(userId, state);

      default:
        // fallback בטוח
        state.stage = "intro";
        return this._stageIntro(state);
    }
  }

  // 1) הודעת פתיחה
  _stageIntro(state) {
    const msg =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות ותזונה.\n\n" +
      "השלב הראשון שלנו יהיה להתחבר לסטרבה כדי שאוכל ללמוד את ההיסטוריה שלך.\n" +
      "לחץ על כפתור/קישור החיבור לסטרבה שמופיע במסך, וברגע שתאשר את הגישה נחזור לפה ונמשיך.";

    state.stage = "await_strava_connect";
    return {
      newMessages: [msg],
      waitForUser: true, // עכשיו צריך פעולה חיצונית – חיבור סטרבה
      consumeInput: true,
    };
  }

  // 2) מחכים לחיבור סטרבה
  _stageAwaitStrava(state, userInput) {
    const txt = (userInput || "").trim();

    // אם המשתמש כותב "התחברתי", "סיימתי" – אפשר להשיב טכנית,
    // אבל בפועל השרת יקרא handleStravaConnected אחרי סטרבה.
    if (!state.data.stravaConnected) {
      const msg =
        "לפני שנמשיך אני צריך שתתחבר לסטרבה.\n" +
        "לחץ על כפתור/קישור החיבור לסטרבה, תאשר את הבקשה, ואז תחזור לצ'אט.";
      return {
        newMessages: txt ? [msg] : [msg],
        waitForUser: true,
        consumeInput: true,
      };
    }

    // אם כבר מסומן connected אבל עוד לא עברנו ל-post_strava_import (מקרה קצה)
    state.stage = "post_strava_import";
    return {
      newMessages: [],
      waitForUser: false,
      consumeInput: false,
    };
  }

  // 3) סיכום נפח מסטרבה + מעבר לנתונים אישיים
  async _stagePostStravaSummary(userId, state) {
    state = await this._ensureStravaMetrics(userId, state);
    const ts = state.data.trainingSummary;
    const volume = state.data.volume;

    let msgs = [];

    if (ts && ts.rides_count > 0) {
      const hoursTotal = (ts.totalMovingTimeSec / 3600).toFixed(1);
      const hoursAvg = (ts.avgDurationSec / 3600).toFixed(1);
      const km = ts.totalDistanceKm != null ? ts.totalDistanceKm.toFixed(1) : null;
      const elevation = ts.totalElevationGainM != null
        ? Math.round(ts.totalElevationGainM)
        : null;
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct) : null;

      let line =
        `בדקתי את הרכיבות שלך מהתקופה האחרונה.\n` +
        `מצאתי ${ts.rides_count} רכיבות בתקופה שניתחתי.\n` +
        `סה\"כ זמן רכיבה: ~${hoursTotal} שעות, זמן ממוצע לרכיבה: ~${hoursAvg} שעות.`;

      if (km != null) {
        line += `\nסה\"כ מרחק: ~${km} ק\"מ.`;
      }
      if (elevation != null) {
        line += `\nסה\"כ טיפוס: ~${elevation} מטר.`;
      }
      if (offPct != null) {
        line += `\nבערך ${offPct}% מהרכיבות הן שטח / גרבל.`;
      }

      if (volume && volume.weeklyHoursAvg != null) {
        const wh = volume.weeklyHoursAvg.toFixed(1);
        line += `\nהיקף האימונים השבועי הממוצע שלך הוא בערך ${wh} שעות.`;
      }

      msgs.push(line);
    } else {
      msgs.push(
        "לא מצאתי מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח משמעותי.\n" +
          "זה לא נורא, נבנה את הפרופיל שלך יחד מהיום והלאה."
      );
    }

    // מעבר לנתונים אישיים – באותה הודעה
    msgs.push(
      "בוא נשלים עכשיו כמה נתונים אישיים בסיסיים: גיל, משקל, גובה וכו'."
    );

    state.stage = "personal_details_collect";
    // נתחיל מהשדה הראשון שחסר
    const firstQuestion = this._nextPersonalQuestion(state);
    if (firstQuestion) {
      msgs.push(firstQuestion.message);
      state.data.personal.pendingField = firstQuestion.field;
    } else {
      // במקרה שכל הנתונים כבר קיימים – מדלגים ל-FTP
      state.stage = "ftp_intro";
    }

    return {
      newMessages: msgs,
      waitForUser: state.stage === "personal_details_collect",
      consumeInput: true,
    };
  }

  // 4) איסוף נתונים אישיים
  _stagePersonalDetails(state, userInput) {
    const msgs = [];
    const personal = state.data.personal || (state.data.personal = {});

    const txt = (userInput || "").trim();

    // אם יש לנו שדה ממתין – ננסה לפרש את התשובה אליו
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
          msgs.push("לא בטוח שהבנתי את המשקל. תכתוב מספר בקילוגרמים (למשל 67).");
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

    // בדיקה אם חסרים עוד נתונים
    const nextQ = this._nextPersonalQuestion(state);
    if (nextQ) {
      personal.pendingField = nextQ.field;
      msgs.push(
        "יש עוד נתון אחד שחשוב לי להשלים כדי לדייק את הפרופיל שלך."
      );
      msgs.push(nextQ.message);
      state.stage = "personal_details_collect";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // כל הנתונים האישיים קיימים – מסכמים ועוברים ל-FTP
    msgs.push(
      "מעולה, עדכנתי את הנתונים האישיים שלך.\n" +
        "תמיד תוכל לבקש ממני בהמשך לעדכן גיל, משקל או גובה אם משהו משתנה."
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
    if (p.age == null) {
      return {
        field: "age",
        message: "נתחיל בגיל — בן כמה אתה?",
      };
    }
    if (p.weightKg == null) {
      return {
        field: "weightKg",
        message: "מה המשקל שלך בקילוגרמים (למשל 67)?",
      };
    }
    if (p.heightCm == null) {
      return {
        field: "heightCm",
        message: "ומה הגובה שלך בס\"מ (למשל 178)?",
      };
    }
    return null;
  }

  // 5) FTP – מציג מודלים + בחירה / עדכון
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
            "בוא נגדיר ערך התחלתי, ותמיד נוכל לעדכן כשיצטברו עוד נתונים."
        );
      } else {
        lines.push(
          "חישבתי עבורך כמה מודלים שונים של FTP על בסיס הרכיבות שלך:"
        );
        if (ftp.ftp20 != null) {
          lines.push(`• FTP20 (20 דק'): ~${ftp.ftp20}W (ממוצע 20 דק' * 0.95).`);
        }
        if (ftp.ftpFrom3min != null) {
          lines.push(
            `• FTP מ-3 דקות: ~${ftp.ftpFrom3min}W (הסקה מיכולת ספרינט ארוכה).`
          );
        }
        if (ftp.ftpFromCP != null) {
          lines.push(
            `• FTP לפי מודל CP: ~${ftp.ftpFromCP}W (עקומת כוח 3–20 דק').`
          );
        }
        if (ftp.ftpFromStrava != null) {
          lines.push(
            `• FTP כפי שמופיע אצלך בסטרבה: ~${ftp.ftpFromStrava}W.`
          );
        }
        if (ftp.ftpRecommended != null) {
          lines.push(
            `על בסיס כל המודלים, ההמלצה שלי כרגע היא FTP של ~${ftp.ftpRecommended}W (חציון הערכים הסבירים).`
          );
        }
      }

      lines.push(
        "\nאם תרצה, תוכל גם לשאול אותי: \"איך חישבת את ה-FTP?\" ואסביר בפירוט."
      );

      let question =
        "איזה FTP נשתמש בו כנקודת פתיחה?\n" +
        "אם אתה מסכים להמלצה שלי, תכתוב \"תשתמש בהמלצה\".\n" +
        "אם אתה רוצה ערך אחר, תכתוב מספר בוואטים (למשל 250).";

      msgs.push(lines.join("\n"));
      msgs.push(question);

      state.stage = "ftp_confirm";
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // ftp_confirm – מחכים לתשובת המשתמש
    const txt = (userInput || "").trim();

    if (!txt) {
      msgs.push("תרשום או \"תשתמש בהמלצה\" או מספר בוואטים (למשל 250).");
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
        "עכשיו תרשום אם אתה רוצה שנשתמש בהמלצה שלי או תכתוב מספר אחר בוואטים."
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
      if (ftp.ftpRecommended != null) {
        chosen = ftp.ftpRecommended;
      } else if (ftp.ftpFromStrava != null) {
        chosen = ftp.ftpFromStrava;
      }
    } else {
      const num = parseFloat(txt.replace(",", "."));
      if (!isNaN(num) && num > 100 && num < 500) {
        chosen = Math.round(num);
      }
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

    if (ftp.ftp20 != null) {
      lines.push(
        `• FTP20: לקחתי את שלושת מאמצי ה-20 דק' הכי חזקים שלך, עשיתי ממוצע, וכפלתי ב-0.95. יצא ~${ftp.ftp20}W.`
      );
    }
    if (ftp.ftpFrom3min != null) {
      lines.push(
        `• FTP מ-3 דקות: ניתחתי את שלושת מאמצי ה-3 דק' הכי חזקים, והסקתי מהם FTP משוער ~${ftp.ftpFrom3min}W.`
      );
    }
    if (ftp.ftpFromCP != null) {
      lines.push(
        `• מודל CP: בניתי עקומת כוח על בסיס מאמצים של כמה חלונות זמן (3–20 דק') וקיבלתי ~${ftp.ftpFromCP}W.`
      );
    }
    if (ftp.ftpFromStrava != null) {
      lines.push(
        `• FTP מסטרבה: זה הערך שמופיע אצלך בסטרבה — ~${ftp.ftpFromStrava}W.`
      );
    }
    if (ftp.ftpRecommended != null) {
      lines.push(
        `בסוף בחרתי ftpRecommended כחציון של כל הערכים הסבירים — ~${ftp.ftpRecommended}W.`
      );
    }

    if (!lines.length) {
      return (
        "כרגע אין לי מודלים מחושבים ל-FTP כי חסרים נתונים חזקים מספיק מסטרבה.\n" +
        "ככל שתעשה יותר מאמצים ארוכים, אוכל לחשב את זה בצורה חכמה יותר."
      );
    }

    return lines.join("\n");
  }

  // 6) דופק – HRmax + HR Threshold
  _stageHr(state, userInput) {
    const msgs = [];
    const hr = state.data.hr || {};

    if (state.stage === "hr_intro") {
      const lines = [];

      lines.push(
        "עכשיו נעבור לדופק — כדי שאוכל לתכנן עבורך אזורי דופק ואימונים מדויקים."
      );

      if (hr.hrMaxTop3 != null) {
        lines.push(
          `מהניתוח של הרכיבות שלך, דופק המקסימום המוערך (על בסיס Top3 מהחצי שנה האחרונה) הוא בערך ${hr.hrMaxTop3} פעימות לדקה.`
        );
      }

      if (hr.hrThresholdRecommended != null) {
        lines.push(
          `דופק הסף (Threshold) המומלץ כרגע הוא בערך ${hr.hrThresholdRecommended} פעימות לדקה.`
        );
      }

      lines.push(
        "\nאם תרצה, תוכל לשאול: \"איך חישבת את הדופק?\" ואסביר בפירוט."
      );

      lines.push(
        "\nקודם כל, בוא נוודא את דופק המקסימום שלך.\n" +
          "אם אתה מסכים לערך שמצאתי, תכתוב \"תשתמש בהמלצה\".\n" +
          "אם יש לך ערך אחר שאתה יודע עליו, תכתוב מספר (למשל 180)."
      );

      msgs.push(lines.join("\n"));
      state.stage = "hr_confirm";
      state.data.hrPending = "max"; // קודם מאשרים HRmax, אחר כך threshold
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // hr_confirm
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
        if (hr.hrMaxTop3 != null) {
          chosen = hr.hrMaxTop3;
        }
      } else {
        const num = parseFloat(txt.replace(",", "."));
        if (!isNaN(num) && num > 120 && num < 220) {
          chosen = Math.round(num);
        }
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
      msgs.push(`עדכנתי דופק מקסימלי: ${chosen} פעימות לדקה.`);

      // עכשיו נשאל על Threshold
      const recTh = hr.hrThresholdRecommended;
      let line = "עכשיו נוודא את דופק הסף (Threshold).";
      if (recTh != null) {
        line += ` ההמלצה שלי כרגע היא בערך ${recTh} פעימות לדקה.`;
      }
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

    // hrPending === "threshold"
    let chosenTh = null;

    if (lower.includes("המלצ")) {
      if (hr.hrThresholdRecommended != null) {
        chosenTh = hr.hrThresholdRecommended;
      } else if (state.data.hrFinal && state.data.hrFinal.max != null) {
        chosenTh = Math.round(state.data.hrFinal.max * 0.9);
      }
    } else {
      const num = parseFloat(txt.replace(",", "."));
      if (!isNaN(num) && num > 100 && num < 220) {
        chosenTh = Math.round(num);
      }
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

    msgs.push(`מעולה, נגדיר דופק סף של ${chosenTh} פעימות לדקה.`);

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

    if (hr.hrMaxTop3 != null) {
      lines.push(
        `• HRmax Top3: לקחתי את שלושת ערכי הדופק הכי גבוהים שלך מחצי השנה האחרונה ועשיתי מהם ממוצע ~${hr.hrMaxTop3} bpm.`
      );
    }

    if (hr.hrThresholdRecommended != null) {
      lines.push(
        `• HR Threshold Recommended: חישבתי דופק סף משוער לפי היחס ל-HRmax, דפוסי מאמץ וקצב ירידת הדופק במאמצים ארוכים, וקיבלתי ~${hr.hrThresholdRecommended} bpm.`
      );
    }

    if (hr.hrModelsDetails) {
      lines.push(
        "\nבנוסף, השתמשתי בעוד מודלים (drift, breakpoint וכו') — אפשר להרחיב על זה בהמשך אם תרצה."
      );
    }

    if (!lines.length) {
      return (
        "כרגע אין לי מספיק נתונים איכותיים על הדופק כדי לבנות מודלים מתקדמים.\n" +
        "ככל שתעשה יותר אימונים עם מד דופק, אוכל לדייק את זה."
      );
    }

    return lines.join("\n");
  }

  // 7) מטרה (Goal)
  _stageGoal(state, userInput) {
    const msgs = [];
    const txt = (userInput || "").trim();

    if (!state.data.goal && !txt) {
      msgs.push(
        "מה המטרה העיקרית שלך בחודשים הקרובים?\n" +
          "לדוגמה: \"Gran Fondo Eilat בדצמבר\", \"להעלות FTP ל-270W\", או שילוב של אירוע + יעד."
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
      msgs.push(
        "תמיד נוכל לשנות או לעדכן את המטרה בהמשך אם משהו משתנה."
      );
      state.stage = "summary";
      return {
        newMessages: msgs,
        waitForUser: false,
        consumeInput: true,
      };
    }

    // אם כבר יש goal (מקרה קצה) – פשוט ממשיכים לסיכום
    state.stage = "summary";
    return {
      newMessages: [],
      waitForUser: false,
      consumeInput: false,
    };
  }

  // 8) סיכום סופי
  async _stageSummary(userId, state) {
    const d = state.data;
    const p = d.personal || {};
    const ftp = d.ftpFinal;
    const hr = d.hrFinal || {};
    const goal = d.goal;

    const lines = [];

    lines.push("סיכום קצר של הפרופיל שבנינו לך:");

    const pd = [];
    if (p.age != null) pd.push(`גיל: ${p.age}`);
    if (p.weightKg != null) pd.push(`משקל: ${p.weightKg} ק\"ג`);
    if (p.heightCm != null) pd.push(`גובה: ${p.heightCm} ס\"מ`);
    if (pd.length) {
      lines.push("• נתונים אישיים: " + pd.join(", "));
    }

    if (ftp != null) {
      lines.push(`• FTP התחלתי: ${ftp}W.`);
    }

    const hrParts = [];
    if (hr.max != null) hrParts.push(`HRmax ≈ ${hr.max}`);
    if (hr.threshold != null) hrParts.push(`HRthr ≈ ${hr.threshold}`);
    if (hrParts.length) {
      lines.push("• דופק: " + hrParts.join(", "));
    }

    if (goal) {
      lines.push(`• מטרה: ${goal}`);
    }

    lines.push(
      "\nמכאן נוכל להתחיל לבנות לך אימונים חכמים, לנתח עומס שבועי ולעקוב אחרי ההתקדמות שלך."
    );

    // נסמן שהאונבורדינג הושלם בבסיס הנתונים אם יש פונקציה מתאימה
    const finalProfile = {
      personal: p,
      ftp: ftp,
      hr: hr,
      goal: goal,
    };

    if (this.db && typeof this.db.markOnboardingCompleted === "function") {
      try {
        await this.db.markOnboardingCompleted(userId, finalProfile);
      } catch (e) {
        // לא מפילים את התהליך אם יש תקלה – רק מדלגים בשקט
        console.error("markOnboardingCompleted error:", e);
      }
    }

    // אפשר להגדיר סטייג' "done" כדי שהודעות עתידיות יופנו למאמן / לוגיקה אחרת
    state.stage = "done";

    return {
      newMessages: [lines.join("\n")],
      waitForUser: true,
      consumeInput: false,
    };
  }

  // -------- עזרי DB / מטריקות מסטרבה --------

  async _ensureStravaMetrics(userId, state) {
    const d = state.data || (state.data = {});
    if (d.trainingSummary && d.volume && d.ftp && d.hr) {
      return state;
    }

    if (!this.db) return state;

    // ניסיון להשתמש ב-getStravaSnapshot (או שתתאים לשם שיש לך)
    if (typeof this.db.getStravaSnapshot === "function") {
      try {
        const snap = await this.db.getStravaSnapshot(userId);
        if (snap) {
          if (snap.trainingSummary) d.trainingSummary = snap.trainingSummary;
          if (snap.volume) d.volume = snap.volume;
          if (snap.ftp) d.ftp = snap.ftp;
          if (snap.hr) d.hr = snap.hr;
        }
      } catch (e) {
        console.error("getStravaSnapshot error:", e);
      }
    }

    return state;
  }

  // -------- עזרי state --------

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
    if (!this.db || typeof this.db.saveOnboardingState !== "function") {
      return;
    }
    try {
      await this.db.saveOnboardingState(userId, state);
    } catch (e) {
      console.error("saveOnboardingState error:", e);
    }
  }
}
