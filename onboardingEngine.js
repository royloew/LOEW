// onboardingEngine.js
// מנוע אונבורדינג ל-LOEW – State machine פשוט וברור
// אחראי לאסוף פרטים בסיסיים על הרוכב, להשתמש בנתוני סטרבה (HR / FTP / זמני רכיבה),
// ולהגדיר פרמטרים אישיים כמו משך אימון מינימלי ומטרה מרכזית.

export class OnboardingEngine {
  /**
   * @param {ReturnType<import("./dbSqlite.js").createDbImpl>} dbImpl
   */
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // === Helpers ===

  async _loadState(userId) {
    const existing = await this.db.getOnboarding(userId);
    if (existing) return existing;

    const fresh = {
      userId,
      stage: "intro",
      onboardingCompleted: false,
      answers: {},
    };
    await this.db.saveOnboarding(fresh);
    return fresh;
  }

  async _saveState(state) {
    if (!state.userId) {
      throw new Error("Onboarding state must contain userId");
    }
    await this.db.saveOnboarding(state);
  }

  async _ensureTrainingParams(userId) {
    const tp = (await this.db.getTrainingParams(userId)) || { userId };
    return tp;
  }

  _parseNumberFromText(text) {
    const m = text.replace(",", " ").match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // === Public API ===

  /**
   * נקרא אחרי שהמשתמש התחבר בהצלחה לסטרבה (ראה /exchange_token בשרת).
   * כאן אנחנו:
   * 1. מריצים computeHrAndFtpFromStrava כדי להכניס DB שלם.
   * 2. מעדכנים את סטטוס האונבורדינג כך שהשלב הבא יתייחס לנתוני סטרבה.
   */
  async handleStravaConnected(userId) {
    try {
      const metrics = await this.db.computeHrAndFtpFromStrava(userId);

      const state = await this._loadState(userId);
      state.stravaMetrics = metrics || {};
      // אם עדיין לא סיימנו אונבורדינג – נרצה להתחיל מהשלב של HR/FTP
      if (!state.onboardingCompleted) {
        state.stage = "hr_from_strava";
      }
      await this._saveState(state);

      return {
        ok: true,
        message: "Strava connected and metrics computed",
      };
    } catch (err) {
      console.error("handleStravaConnected error:", err);
      return {
        ok: false,
        message: "Failed to compute Strava metrics",
      };
    }
  }

  /**
   * לולאת האונבורדינג – נקראת מכל הודעה בזמן שה-onboarding עדיין לא הושלם.
   * מחזירה אובייקט:
   * { text: string, done?: boolean }
   */
  async handleMessage(userId, rawText) {
    const text = (rawText || "").trim();
    const lower = text.toLowerCase();

    let state = await this._loadState(userId);
    const tp = await this._ensureTrainingParams(userId);

    // אם משום מה סומן כ-completed נחזיר תשובה עדינה אבל נסמן done=true
    if (state.onboardingCompleted) {
      return {
        text:
          "כבר סיימנו את האונבורדינג שלך 🙂 אתה תמיד יכול לשנות נתונים (FTP, דופק, זמן אימון מינימלי וכו') דרך הצ'אט.",
        done: true,
      };
    }

    const stage = state.stage || "intro";

    // --- שלבי אונבורדינג ---

    // 1) פתיחה + גיל
    if (stage === "intro") {
      state.stage = "ask_age";
      await this._saveState(state);
      return {
        text: `נעים מאוד, אני LOEW — המאמן האישי שלך.
              אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.
              המטרה שלי: לבנות עבורך אימונים חכמים, גמישים ומדויקים שמתאימים בדיוק ליום שלך.

              לפני שנתחיל לעבוד יחד, נעשה אונבורדינג קצר: נתחבר לסטרבה ונאסוף כמה נתוני בסיס.

              אחרי זה תוכל לדבר איתי חופשי ולשאול, למשל:
              • תנתח לי את האימון האחרון
              • מה האימון הבא המומלץ?
              • תן לי דוח מצב
              • בנה לי תוכנית ל־90 יום
              • למה בחרת דווקא באימון הזה?

              נתחיל בגיל שלך – בן כמה אתה?`,
        done: false,
      };
    }

    if (stage === "ask_age") {
      const age = this._parseNumberFromText(lower);
      if (!age || age < 10 || age > 90) {
        return {
          text: "לא הצלחתי להבין את הגיל. תכתוב מספר בגילאים סבירים (למשל 46).",
          done: false,
        };
      }

      state.answers.age = age;
      tp.age = age;
      await this.db.saveTrainingParams(tp);

      state.stage = "ask_weight";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי גיל ${age}.\n` +
          "מה המשקל שלך בקילוגרמים? (תכתוב מספר, למשל 67)",
        done: false,
      };
    }

    if (stage === "ask_weight") {
      const weight = this._parseNumberFromText(lower);
      if (!weight || weight < 30 || weight > 200) {
        return {
          text:
            "לא הצלחתי להבין את המשקל. תכתוב מספר בקילוגרמים (למשל 67).",
          done: false,
        };
      }

      state.answers.weight = weight;
      tp.weightKg = weight;
      await this.db.saveTrainingParams(tp);

      // אם כבר יש חיבור סטרבה – נתקדם לשלבים לפי נתוני סטרבה
      const hasStrava = await this.db.hasStravaConnection(userId);
      if (hasStrava) {
        state.stage = "hr_from_strava";
        await this._saveState(state);
        return {
          text:
            `סגור, רשמתי משקל ${weight} ק״ג.\n` +
            "יש לך חיבור לסטרבה, אז בוא נשתמש בנתונים שלך כדי להגדיר דופק ו-FTP.",
          done: false,
        };
      } else {
        state.stage = "ask_strava_connect";
        await this._saveState(state);
        return {
          text:
            `סגור, רשמתי משקל ${weight} ק״ג.\n\n` +
            "האם יש לך חשבון Strava מחובר? אם כן, תכתוב \"חבר אותי לסטרבה\" ואני אתן לך לינק להתחברות.\n" +
            "אם אין לך או לא בא לך, תכתוב \"דלג\" ונגדיר את הנתונים ידנית.",
          done: false,
        };
      }
    }

    // 2) הצעה להתחבר לסטרבה
    if (stage === "ask_strava_connect") {
      if (lower.includes("דלג") || lower.includes("skip")) {
        state.stage = "hr_manual_intro";
        await this._saveState(state);
        return {
          text:
            "אין בעיה, נעשה את זה ידנית.\n" +
            "מה דופק המקסימום שאתה מכיר על עצמך? (מספר, למשל 180)",
          done: false,
        };
      }

      if (
        lower.includes("strava") ||
        lower.includes("סטרבה") ||
        lower.includes("חבר אותי")
      ) {
        state.stage = "await_strava_oauth";
        await this._saveState(state);
        const url = `https://loew.onrender.com/auth/strava?userId=${encodeURIComponent(
          userId
        )}`;
        return {
          text:
            "מצוין. כדי לחבר את Strava, כנס ללינק הבא ותאשר גישה לנתונים שלך:\n" +
            url +
            "\n\nאחרי סיום החיבור, תחזור אליי ותכתוב לי הודעה, ואמשיך את האונבורדינג.",
          done: false,
        };
      }

      return {
        text:
          "אם אתה רוצה להשתמש בנתוני Strava תכתוב \"חבר אותי לסטרבה\".\n" +
          "אם לא, תכתוב \"דלג\" ונגדיר ידנית דופק ו-FTP.",
        done: false,
      };
    }

    if (stage === "await_strava_oauth") {
      const hasStrava = await this.db.hasStravaConnection(userId);
      if (!hasStrava) {
        return {
          text:
            "נראה שעדיין לא הושלם החיבור ל-Strava. תוודא שסיימת את התהליך בדפדפן ואז תחזור אליי.\n" +
            "אם הסתבכת, תכתוב \"דלג\" ונעשה את זה ידנית.",
          done: false,
        };
      }

      // סיימנו חיבור – נניח ש-handleStravaConnected כבר רץ
      state.stage = "hr_from_strava";
      await this._saveState(state);
      return {
        text:
          "רואה שחיברת את Strava ✅\n" +
          "בוא נשתמש עכשיו בנתונים שלך כדי להגדיר דופק ו-FTP.",
        done: false,
      };
    }

    // 3) HR מתוך סטרבה
    if (stage === "hr_from_strava") {
      const metrics = state.stravaMetrics || {};
      const hrModels = metrics.hrModels || {};
      const hrMaxCandidate =
        hrModels.hrMaxCandidate != null
          ? hrModels.hrMaxCandidate
          : metrics.hrMaxCandidate;
      const hrThresholdCandidate =
        hrModels.hrThresholdCandidate != null
          ? hrModels.hrThresholdCandidate
          : metrics.hrThresholdCandidate;

      if (!hrMaxCandidate) {
        // אין מספיק נתונים – נעבור למצב ידני
        state.stage = "hr_manual_intro";
        await this._saveState(state);
        return {
          text:
            "לא הצלחתי להוציא דופק מקסימום אמין מהסטרבה.\n" +
            "תכתוב בבקשה מה דופק המקסימום שאתה מכיר על עצמך (למשל 180).",
          done: false,
        };
      }

      state.stage = "hr_from_strava_confirm";
      state.hrSuggestion = {
        hrMaxCandidate,
        hrThresholdCandidate: hrThresholdCandidate || Math.round(hrMaxCandidate * 0.9),
      };
      await this._saveState(state);

      return {
        text:
          `לפי הנתונים שלך בסטרבה, אני מעריך שדופק המקסימום שלך סביב ${state.hrSuggestion.hrMaxCandidate}.\n` +
          `סף (threshold) מוערך בסביבות ${state.hrSuggestion.hrThresholdCandidate}.\n\n` +
          "אם זה נשמע לך נכון, תכתוב \"מאשר\".\n" +
          "אם אתה מעדיף ערכים אחרים, תכתוב אותם, למשל: \"מקסימום 182, סף 170\".",
        done: false,
      };
    }

    if (stage === "hr_from_strava_confirm") {
      let hrMax = state.hrSuggestion?.hrMaxCandidate || null;
      let hrTh = state.hrSuggestion?.hrThresholdCandidate || null;

      if (lower.includes("מאשר") || lower.includes("סבבה")) {
        // נשאיר את מה שיש
      } else {
        // ננסה לחלץ מספרים מהטקסט
        const numbers = lower.match(/(\d{2,3})/g) || [];
        if (numbers.length === 1) {
          const n = parseInt(numbers[0], 10);
          if (n > 100 && n < 220) {
            hrMax = n;
            hrTh = Math.round(n * 0.9);
          }
        } else if (numbers.length >= 2) {
          const n1 = parseInt(numbers[0], 10);
          const n2 = parseInt(numbers[1], 10);
          if (n1 > n2) {
            hrMax = n1;
            hrTh = n2;
          } else {
            hrMax = n2;
            hrTh = n1;
          }
        }
      }

      if (!hrMax || !hrTh) {
        return {
          text:
            "לא הצלחתי להבין את הערכים. תכתוב או \"מאשר\" או שני מספרים – מקסימום וסף. למשל: 182 170.",
          done: false,
        };
      }

      tp.hrMax = hrMax;
      tp.hrThreshold = hrTh;
      await this.db.saveTrainingParams(tp);

      state.answers.hrMax = hrMax;
      state.answers.hrThreshold = hrTh;
      state.stage = "ftp_from_strava";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי דופק מקסימום ${hrMax} וסף ${hrTh}.\n` +
          "עכשיו נעבור ל-FTP ונקבע את ערך היעד לעבודה.",
        done: false,
      };
    }

    // 4) HR ידני (אם אין סטרבה)
    if (stage === "hr_manual_intro") {
      const hrMax = this._parseNumberFromText(lower);
      if (!hrMax || hrMax < 120 || hrMax > 220) {
        return {
          text:
            "תכתוב בבקשה דופק מקסימום במספר סביר, למשל 180.",
          done: false,
        };
      }

      const hrTh = Math.round(hrMax * 0.9);
      tp.hrMax = hrMax;
      tp.hrThreshold = hrTh;
      await this.db.saveTrainingParams(tp);

      state.answers.hrMax = hrMax;
      state.answers.hrThreshold = hrTh;
      state.stage = "ftp_manual_intro";
      await this._saveState(state);

      return {
        text:
          `רשמתי דופק מקסימום ${hrMax} וסף מוערך ${hrTh}.\n` +
          "מה ה-FTP הנוכחי שאתה מעריך לעצמך? (בוואטים, למשל 240)",
        done: false,
      };
    }

    // 5) FTP מתוך סטרבה
    if (stage === "ftp_from_strava") {
      const metrics = state.stravaMetrics || {};
      const ftpModels = metrics.ftpModels || {};
      const ftp20 = ftpModels.ftp20 ?? metrics.ftp20 ?? null;
      const ftpCp = ftpModels.ftpCp ?? metrics.ftpCp ?? null;
      const ftpPc = ftpModels.ftpPowerCurve ?? metrics.ftpPowerCurve ?? null;
      const ftpFromStrava =
        ftpModels.ftpFromStrava ?? metrics.ftpFromStrava ?? null;
      const ftpRecommended =
        ftpModels.ftpRecommended ?? metrics.ftpRecommended ?? null;

      if (!ftp20 && !ftpCp && !ftpFromStrava && !ftpPc) {
        state.stage = "ftp_manual_intro";
        await this._saveState(state);
        return {
          text:
            "לא מצאתי מספיק נתונים בשביל לחשב FTP אמין מהסטרבה.\n" +
            "מה ה-FTP הנוכחי שאתה מעריך לעצמך? (בוואטים, למשל 240)",
          done: false,
        };
      }

      state.ftpSuggestion = {
        ftp20,
        ftpCp,
        ftpPc,
        ftpFromStrava,
        ftpRecommended,
      };
      state.stage = "ftp_from_strava_confirm";
      await this._saveState(state);

      let lines = [];
      if (ftp20) {
        lines.push(`• מודל 20 דקות (Top3) → ~${ftp20}W`);
      }
      if (ftpCp) {
        lines.push(`• מודל CP (3/20 דקות) → ~${ftpCp}W`);
      }
      if (ftpPc) {
        lines.push(`• PowerCurve קצר (3 דקות × 0.8) → ~${ftpPc}W`);
      }
      if (ftpFromStrava) {
        lines.push(`• FTP כפי שמוגדר בסטרבה → ${ftpFromStrava}W`);
      }

      const rec = ftpRecommended || ftpFromStrava || ftp20 || ftpCp || ftpPc;

      return {
        text:
          "לפי הסטרבה, קיבלתי את המודלים הבאים ל-FTP שלך:\n" +
          lines.join("\n") +
          "\n\n" +
          (rec
            ? `אני מציע להתחיל מ-FTP ≈ ${rec}W בתור \"FTP מומלץ\".\n`
            : "") +
          'אם זה נשמע לך נכון, תכתוב "מאשר".\n' +
          "אם אתה מעדיף מספר אחר, פשוט תכתוב אותו (למשל 250).",
        done: false,
      };
    }

    if (stage === "ftp_from_strava_confirm") {
      const suggestion = state.ftpSuggestion || {};
      let ftp =
        suggestion.ftpRecommended ||
        suggestion.ftpFromStrava ||
        suggestion.ftp20 ||
        suggestion.ftpCp ||
        suggestion.ftpPc ||
        null;

      if (lower.includes("מאשר") || lower.includes("סבבה")) {
        // נשאיר את ה-suggestion
      } else {
        const n = this._parseNumberFromText(lower);
        if (!n || n < 80 || n > 600) {
          return {
            text:
              "לא הצלחתי להבין FTP מהטקסט. תכתוב או \"מאשר\" או מספר וואטים סביר (למשל 240).",
            done: false,
          };
        }
        ftp = n;
      }

      tp.ftp = ftp;
      await this.db.saveTrainingParams(tp);

      state.answers.ftp = ftp;
      state.stage = "min_ride_from_strava";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי FTP = ${ftp}W.\n` +
          "עכשיו נגדיר מה משך האימון ה\"רגיל\" שמתאים לך לפי הנתונים מסטרבה.",
        done: false,
      };
    }

    // 6) FTP ידני (אם אין סטרבה)
    if (stage === "ftp_manual_intro") {
      const ftp = this._parseNumberFromText(lower);
      if (!ftp || ftp < 80 || ftp > 600) {
        return {
          text:
            "תכתוב בבקשה FTP בוואטים – מספר סביר בין 80 ל-600, למשל 240.",
          done: false,
        };
      }

      tp.ftp = ftp;
      await this.db.saveTrainingParams(tp);

      state.answers.ftp = ftp;
      state.stage = "min_ride_from_strava";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי FTP = ${ftp}W.\n` +
          "עכשיו נגדיר מה משך האימון ה\"רגיל\" שמתאים לך.",
        done: false,
      };
    }

    // 7) משך אימון מינימלי על בסיס סטרבה – השלב החדש
    if (stage === "min_ride_from_strava") {
      // ננסה להביא נתונים מה-DB (strava_activities) – 3 הקצרות, ממוצע, 3 הארוכות
      let stats = null;
      try {
        stats = await this.db.getRideDurationStats(userId);
      } catch (err) {
        console.error("getRideDurationStats error", err);
      }

      if (!stats || !stats.sampleCount) {
        state.stage = "min_ride_manual";
        await this._saveState(state);
        return {
          text:
            "לא מצאתי מספיק רכיבות בשביל להעריך משך אימון טיפוסי.\n" +
            "תכתוב בבקשה כמה דקות אתה רוצה שיהיה משך אימון מינימלי \"רגיל\" (למשל 90 או 120).",
          done: false,
        };
      }

      const {
        minCandidateMinutes,
        avgMinutes,
        maxCandidateMinutes,
        sampleCount,
      } = stats;

      state.minRideCandidates = {
        minCandidateMinutes,
        avgMinutes,
        maxCandidateMinutes,
      };
      state.stage = "min_ride_from_strava_choose";
      await this._saveState(state);

      const msg =
        `מסתכל על כ-${sampleCount} רכיבות אחרונות שלך בסטרבה.\n` +
        `אני רואה שמשך 3 הרכיבות הכי קצרות (מדיאן) הוא בערך ~${Math.round(
          minCandidateMinutes
        )} דקות,\n` +
        `הזמן הממוצע לרכיבה הוא ~${Math.round(avgMinutes)} דקות,\n` +
        `והמדיאן של 3 הרכיבות הכי ארוכות הוא ~${Math.round(
          maxCandidateMinutes
        )} דקות.\n\n` +
        "מה בעיניך משך האימון ה\"רגיל\" שאתה רוצה שנתכנן לפיו?\n" +
        "אתה יכול לבחור:\n" +
        "1 – קרוב לצד הקצר יותר\n" +
        "2 – קרוב לממוצע\n" +
        "3 – קרוב לצד הארוך יותר\n" +
        "או פשוט לכתוב מספר בדקות (למשל 120).";

      return {
        text: msg,
        done: false,
      };
    }

    if (stage === "min_ride_from_strava_choose") {
      const cands = state.minRideCandidates || {};
      const textNoSpace = lower.replace(/\s+/g, "");

      let chosen = null;

      if (textNoSpace === "1" || textNoSpace.includes("קצר")) {
        chosen = cands.minCandidateMinutes;
      } else if (textNoSpace === "2" || textNoSpace.includes("ממוצע")) {
        chosen = cands.avgMinutes;
      } else if (textNoSpace === "3" || textNoSpace.includes("ארוך")) {
        chosen = cands.maxCandidateMinutes;
      } else {
        const n = this._parseNumberFromText(lower);
        if (n && n >= 20 && n <= 600) {
          chosen = n;
        }
      }

      if (!chosen) {
        return {
          text:
            "לא הצלחתי להבין. תכתוב 1 (קצר), 2 (ממוצע), 3 (ארוך) או מספר בדקות (למשל 90 או 120).",
          done: false,
        };
      }

      tp.minRideMinutes = Math.round(chosen);
      await this.db.saveTrainingParams(tp);

      state.answers.minRideMinutes = tp.minRideMinutes;
      state.stage = "ask_goal";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי שמשך אימון \"רגיל\" עבורך הוא בערך ${tp.minRideMinutes} דקות.\n` +
          "עכשיו נשלים עוד פרט אחד – המטרה העיקרית שלך.",
        done: false,
      };
    }

    // fallback – במידה ולא הצלחנו להביא נתוני סטרבה
    if (stage === "min_ride_manual") {
      const n = this._parseNumberFromText(lower);
      if (!n || n < 20 || n > 600) {
        return {
          text:
            "תכתוב מספר סביר בדקות (למשל 60, 90, 120) – זה יהיה משך אימון \"רגיל\" עבורך.",
          done: false,
        };
      }

      tp.minRideMinutes = Math.round(n);
      await this.db.saveTrainingParams(tp);

      state.answers.minRideMinutes = tp.minRideMinutes;
      state.stage = "ask_goal";
      await this._saveState(state);

      return {
        text:
          `רשמתי שמשך אימון \"רגיל\" עבורך הוא ${tp.minRideMinutes} דקות.\n` +
          "נשאר לנו להגדיר את המטרה העיקרית שלך.",
        done: false,
      };
    }

    // 8) מטרה
    if (stage === "ask_goal") {
      state.stage = "save_goal";
      await this._saveState(state);
      return {
        text:
          "מה המטרה המרכזית שלך בתקופה הקרובה?\n" +
          "זה יכול להיות אירוע (למשל Gran Fondo), שיפור FTP, ירידה במשקל או כל דבר אחר שאתה רוצה שאכוון אליו.",
        done: false,
      };
    }

    if (stage === "save_goal") {
      const goalText = text.trim();
      if (!goalText) {
        return {
          text:
            "תכתוב במשפט או שניים מה המטרה שלך – למשל:\n" +
            "\"לסיים Gran Fondo אילת בכיף\" או \"להעלות FTP ל-270W\".",
          done: false,
        };
      }

      state.answers.goalText = goalText;

      try {
        await this.db.createGoal({
          userId,
          type: "text",
          description: goalText,
        });
      } catch (err) {
        console.error("createGoal error:", err);
      }

      state.onboardingCompleted = true;
      state.stage = "done";
      await this._saveState(state);

      return {
        text:
          "סגור, יש לנו תמונת מצב מלאה 💚\n" +
          "אני מכיר עכשיו את הגיל, המשקל, דופק מקסימום וסף, FTP, משך אימון \"רגיל\" והמטרה שלך.\n\n" +
          "מכאן אפשר פשוט לכתוב לי כל יום:\n" +
          "• \"מה האימון שלי למחר?\"\n" +
          "• \"תנתח לי את האימון האחרון מסטרבה\"\n" +
          "• או כל שאלה אחרת על האימונים שלך.\n\n" +
          "יאללה, נתחיל לעבוד 💪",
        done: true,
      };
    }

    // ברירת מחדל – אם נפלנו משלב כלשהו
    state.stage = "intro";
    await this._saveState(state);
    return {
      text:
        "משהו השתבש בסדר השלבים של האונבורדינג. נתחיל מחדש בקצרה.\n" +
        "בן כמה אתה?",
      done: false,
    };
  }
}
