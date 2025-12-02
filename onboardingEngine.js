// onboardingEngine.js
// מנוע אונבורדינג ל-LOEW – State machine שמנהל את כל השלבים הראשוניים של המשתמש

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  /**
   * טוען State מה-DB, או מחזיר State התחלתי אם אין עדיין
   */
    async _loadState(userId) {
    const existing = await this.db.getOnboarding(userId);

    if (existing && typeof existing === "object") {
      // התאמת ה־state הקיים למה שהאונבורדר מצפה לו
      return {
        userId: existing.userId || userId,
        stage: existing.stage || "intro",
        hasStrava: !!existing.hasStrava,
        answers: existing.answers || {},
        onboardingDone: !!(existing.onboardingDone || existing.onboardingCompleted),
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: existing.updatedAt || new Date().toISOString(),
        stravaConnected: !!existing.stravaConnected,
        stravaMetrics: existing.stravaMetrics || null,
        minRideCandidates: existing.minRideCandidates || null,
      };
    }

    const nowIso = new Date().toISOString();
    return {
      userId,
      stage: "intro",
      hasStrava: false,
      answers: {},
      onboardingDone: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      stravaConnected: false,
      stravaMetrics: null,
      minRideCandidates: null,
    };
  }


  /**
   * שומר State ל-DB
   */
   async _saveState(state) {
    state.updatedAt = new Date().toISOString();
    // ה־DB מצפה לאובייקט עם userId ושאר השדות
    await this.db.saveOnboarding(state);
  }


  /**
   * מבטיח שיש לנו training_params כלשהו למשתמש
   */
    async _ensureTrainingParams(userId) {
    let tp = await this.db.getTrainingParams(userId);

    if (!tp) {
      const nowIso = new Date().toISOString();
      tp = {
        userId,              // זה השדה שה־DB מחפש כששומרים
        age: null,
        weight_kg: null,
        height_cm: null,
        ftp: null,
        hr_max: null,
        hr_threshold: null,
        min_ride_minutes: null,
        goal: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
    } else if (!tp.userId) {
      // תאימות לאחור – אם היה רק user_id או בכלל לא
      tp.userId = userId;
    }

    return tp;
  }


  /**
   * עוזר: מנקה טקסט מהודעת משתמש
   */
  _normalizeText(text) {
    if (!text) return "";
    return String(text).trim();
  }

  /**
   * נקודת הכניסה הראשית – מקבל הודעת משתמש + userId ומחזיר תגובת אונבורדינג
   */
  async handleMessage(userId, userTextRaw) {
    const userText = this._normalizeText(userTextRaw);
    let state = await this._loadState(userId);
    let { stage } = state;

    // אם כבר סיימנו אונבורדינג – לא אמור להגיע לכאן (server.js בודק),
    // אבל נשמור על הגנה.
    if (state.onboardingDone) {
      return {
        text:
          "האונבורדינג שלך כבר הושלם. אם תרצה לעדכן נתונים (גיל, משקל, FTP וכו') תגיד לי במפורש ואני אעזור.",
        done: true,
      };
    }

    // 1) הודעת פתיחה – מי זה LOEW ומה הוא עושה
    if (stage === "intro") {
      state.stage = "ask_age";
      await this._saveState(state);

      return {
        text:
          "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
          "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n\n" +
          "המטרה שלי: לבנות עבורך אימונים חכמים, אישית אליך — שיאפשרו לך להתקדם ביציבות, להימנע מפציעות ולהרגיש שיש לידך מאמן על, לא עוד בוט רנדומלי.\n\n" +
          "נתחיל בכמה דברים בסיסיים עליך, כדי שאוכל לכוון אותך נכון.\n" +
          "בן כמה אתה?",
        done: false,
      };
    }

    // 2) גיל
    if (stage === "ask_age") {
      const ageNum = parseInt(userText, 10);
      if (!ageNum || ageNum < 10 || ageNum > 90) {
        return {
          text:
            "כדי שאוכל להתאים את ההמלצות, תכתוב בבקשה גיל במספרים (למשל 42).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.age = ageNum;
      await this.db.saveTrainingParams(tp);

      state.answers.age = ageNum;
      state.stage = "ask_weight";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי גיל ${ageNum}.\n` +
          "מה המשקל הנוכחי שלך בקילו? (למשל 67)",
        done: false,
      };
    }

    // 3) משקל
    if (stage === "ask_weight") {
      const weightNum = parseFloat(userText.replace(",", "."));
      if (!weightNum || weightNum < 30 || weightNum > 200) {
        return {
          text:
            "תכתוב בבקשה את המשקל שלך בקילוגרמים, רק מספר (למשל 67).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.weight_kg = weightNum;
      await this.db.saveTrainingParams(tp);

      state.answers.weightKg = weightNum;

      // אחרי גיל+משקל – נבדוק אם יש כבר חיבור סטרבה
      const hasStrava = await this.db.hasStravaConnection(userId);

      if (!hasStrava) {
        state.stage = "ask_height";
        await this._saveState(state);
        return {
          text:
            `רשמתי משקל ${weightNum} ק\"ג.\n` +
            "לפני שנחבר סטרבה, חשוב לי לדעת גם את הגובה שלך.\n" +
            "מה הגובה שלך בס\"מ? (למשל 178)",
          done: false,
        };
      }

      // יש סטרבה → נעבור לגובה ואז לשלב בדיקת הנתונים מסטרבה
      state.stage = "ask_height";
      await this._saveState(state);

      return {
        text:
          `רשמתי משקל ${weightNum} ק\"ג.\n` +
          "מה הגובה שלך בס\"מ? (למשל 178)",
        done: false,
      };
    }

    // 4) גובה
    if (stage === "ask_height") {
      const heightNum = parseInt(userText, 10);
      if (!heightNum || heightNum < 130 || heightNum > 220) {
        return {
          text:
            "תכתוב בבקשה את הגובה שלך בסנטימטרים, רק מספר (למשל 178).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.height_cm = heightNum;
      await this.db.saveTrainingParams(tp);

      state.answers.heightCm = heightNum;

      const hasStrava = await this.db.hasStravaConnection(userId);

      if (!hasStrava) {
        state.stage = "ask_strava_connect";
        await this._saveState(state);

        return {
          text:
            `רשמתי גובה ${heightNum} ס\"מ.\n\n` +
            "עכשיו שאלה חשובה: האם יש לך חשבון Strava פעיל שבו אתה מתעד את הרכיבות שלך?\n" +
            "אם כן, אני מאוד ממליץ לחבר אותו – ככה אוכל לנתח את הרכיבות האחרונות שלך ולהעריך FTP, דופק ועוד.\n\n" +
            "אם תרצה לחבר, תכתוב: \"חבר אותי לסטרבה\" ואני אתן לך קישור.",
          done: false,
        };
      }

      // יש כבר סטרבה מחובר – בשלב הזה נחכה לנתונים ממנו, והשרת יקפיץ אותנו ל-post_strava_summary אחרי האינג'סט
      state.stage = "wait_for_strava_import";
      await this._saveState(state);

      return {
        text:
          `רשמתי גובה ${heightNum} ס\"מ.\n` +
          "אני כבר מחובר לסטרבה שלך – ברגע שאסיים לייבא ולנתח את הרכיבות האחרונות שלך, אתן לך סיכום קצר ונמשיך משם.",
        done: false,
      };
    }

    // A) שלב סיכום קצר אחרי ייבוא סטרבה
    if (stage === "post_strava_summary") {
      const metrics = state.stravaMetrics || {};
      const ts =
        metrics.trainingSummary ||
        metrics.training_summary ||
        {};
      const hrModels = metrics.hrModels || {};
      const ftpModels = metrics.ftpModels || {};

      const TRAINING_WINDOW_WEEKS = 90 / 7;

      const avgHoursPerWeek =
        typeof ts.avgHoursPerWeek === "number"
          ? ts.avgHoursPerWeek
          : typeof ts.total_hours === "number"
          ? ts.total_hours / TRAINING_WINDOW_WEEKS
          : typeof ts.totalHours === "number"
          ? ts.totalHours / TRAINING_WINDOW_WEEKS
          : null;

      let ridesPerWeek =
        typeof ts.rides_per_week === "number"
          ? ts.rides_per_week
          : typeof ts.ridesPerWeek === "number"
          ? ts.ridesPerWeek
          : typeof ts.rides_count === "number"
          ? ts.rides_count / TRAINING_WINDOW_WEEKS
          : null;

      const totalRides =
        typeof ts.total_rides === "number"
          ? ts.total_rides
          : typeof ts.rides_count === "number"
          ? ts.rides_count
          : null;

      const ftpRec =
        ftpModels.ftpRecommended ?? metrics.ftpRecommended ?? null;

      const hrMaxCandidate =
        hrModels.hrMaxCandidate ?? metrics.hrMaxCandidate ?? null;
      const hrThresholdCandidate =
        hrModels.hrThresholdCandidate ??
        metrics.hrThresholdCandidate ??
        (hrMaxCandidate ? Math.round(hrMaxCandidate * 0.9) : null);

      const lines = [];

      if (typeof totalRides === "number" && totalRides > 0) {
        lines.push(
          `• הבאתי כ-${totalRides} רכיבות אחרונות מה-90 הימים האחרונים (עם דופק ווואטים).`
        );
      }

      if (typeof ridesPerWeek === "number" && ridesPerWeek > 0) {
        lines.push(
          `• בערך ${ridesPerWeek.toFixed(1)} רכיבות בשבוע ב-90 הימים האחרונים.`
        );
      }

      if (typeof avgHoursPerWeek === "number" && avgHoursPerWeek > 0) {
        lines.push(
          `• כ-${avgHoursPerWeek.toFixed(1)} שעות רכיבה בשבוע בממוצע.`
        );

        // הערכה גסה של איפה אתה עומד יחסית לרוכבים חובבים אחרים
        let relativeNote = "";
        if (avgHoursPerWeek < 3) {
          relativeNote =
            "זה עומס שנחשב יחסית נמוך לרוכב חובב ממוצע – מעולה להתחלה או לשמירה על כושר בסיסי.";
        } else if (avgHoursPerWeek < 6) {
          relativeNote =
            "זה עומס די טיפוסי לרוכב חובב שרוכב ברצינות ושומר על שגרה יפה.";
        } else {
          relativeNote =
            "זה עומס גבוה יחסית לרוב הרוכבים החובבים – רמה שמתקרבת יותר לצד התחרותי.";
        }
        lines.push("• בהערכה גסה מאוד: " + relativeNote);
      }

      if (ftpRec) {
        lines.push(`• FTP משוער סביב ${Math.round(ftpRec)}W.`);
      }

      if (hrMaxCandidate) {
        lines.push(
          `• דופק מקסימלי משוער ~${hrMaxCandidate}, וסף סביב ${hrThresholdCandidate}.`
        );
      }

      const summaryText =
        lines.length > 0
          ? "הבאתי את הנתונים האחרונים שלך מסטרבה, בקצרה:\n" +
            lines.join("\n")
          : "הבאתי את הנתונים האחרונים שלך מסטרבה, אבל אין לי עדיין מספיק נתונים לסיכום חכם.";

      state.stage = "complete_personal_basics";
      await this._saveState(state);

      return {
        text:
          summaryText +
          "\n\nבוא נשלים כמה נתונים בסיסיים שחסרים לי (כמו גיל, משקל וגובה) כדי שאוכל להיות מדויק יותר.",
        done: false,
      };
    }

    // B) השלמת נתונים אישיים בסיסיים (גיל, משקל, גובה) אחרי סטרבה
    if (stage === "complete_personal_basics") {
      const tp = await this._ensureTrainingParams(userId);

      if (!tp.age) {
        state.stage = "ask_age_after_strava";
        await this._saveState(state);
        return {
          text:
            "כדי שאוכל להשוות אותך לחתך הגיל שלך ולכוון עומסים נכון, חשוב לדעת את הגיל שלך.\n" +
            "בן כמה אתה?",
          done: false,
        };
      }

      if (!tp.weight_kg) {
        state.stage = "ask_weight_after_strava";
        await this._saveState(state);
        return {
          text:
            "מה המשקל הנוכחי שלך בקילו? (למשל 67)",
          done: false,
        };
      }

      if (!tp.height_cm) {
        state.stage = "ask_height_after_strava";
        await this._saveState(state);
        return {
          text:
            "ומה הגובה שלך בס\"מ? (למשל 178)",
          done: false,
        };
      }

      state.personalBasicsCompleted = true;
      state.stage = "ftp_from_strava";
      await this._saveState(state);

      return this._handleFtpFromStrava(userId, state);
    }

    // המשך השלבים – גיל/משקל/גובה אחרי סטרבה, FTP, HR, משך אימון, מטרה, סיום וכו'...

    // גיל אחרי סטרבה
    if (stage === "ask_age_after_strava") {
      const ageNum = parseInt(userText, 10);
      if (!ageNum || ageNum < 10 || ageNum > 90) {
        return {
          text: "תכתוב בבקשה גיל במספרים (למשל 42).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.age = ageNum;
      await this.db.saveTrainingParams(tp);

      state.answers.age = ageNum;
      state.stage = "complete_personal_basics";
      await this._saveState(state);

      return {
        text:
          `רשמתי גיל ${ageNum}.\n` +
          "נמשיך להשלים נתונים חסרים.",
        done: false,
      };
    }

    // משקל אחרי סטרבה
    if (stage === "ask_weight_after_strava") {
      const weightNum = parseFloat(userText.replace(",", "."));
      if (!weightNum || weightNum < 30 || weightNum > 200) {
        return {
          text: "תכתוב בבקשה את המשקל שלך בקילוגרמים, רק מספר (למשל 67).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.weight_kg = weightNum;
      await this.db.saveTrainingParams(tp);

      state.answers.weightKg = weightNum;
      state.stage = "complete_personal_basics";
      await this._saveState(state);

      return {
        text: `רשמתי משקל ${weightNum} ק\"ג.\nנמשיך.`,
        done: false,
      };
    }

    // גובה אחרי סטרבה
    if (stage === "ask_height_after_strava") {
      const heightNum = parseInt(userText, 10);
      if (!heightNum || heightNum < 130 || heightNum > 220) {
        return {
          text:
            "תכתוב בבקשה את הגובה שלך בסנטימטרים, רק מספר (למשל 178).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.height_cm = heightNum;
      await this.db.saveTrainingParams(tp);

      state.answers.heightCm = heightNum;
      state.stage = "complete_personal_basics";
      await this._saveState(state);

      return {
        text: `רשמתי גובה ${heightNum} ס\"מ.\nנמשיך.`,
        done: false,
      };
    }

    // FTP מתוך סטרבה – לוגיקה נפרדת
    if (stage === "ftp_from_strava") {
      return this._handleFtpFromStrava(userId, state);
    }

    // HR מתוך סטרבה – לוגיקה נפרדת
    if (stage === "hr_from_strava") {
      return this._handleHrFromStrava(userId, state, userText);
    }

    // 7) משך אימון מינימלי על בסיס סטרבה
    if (stage === "min_ride_from_strava") {
      let stats = null;
      try {
        stats = await this.db.getRideDurationStats(userId);
      } catch (err) {
        console.error("getRideDurationStats error", err);
      }

      if (!stats || !stats.ridesSampleCount) {
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
        minRideMinutesCandidate: minCandidateMinutes,
        avgRideMinutes: avgMinutes,
        maxRideMinutesCandidate: maxCandidateMinutes,
        ridesSampleCount: sampleCount,
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
      const goal = userText || "לא ציינת מטרה מפורשת";

      const tp = await this._ensureTrainingParams(userId);
      tp.goal = goal;
      await this.db.saveTrainingParams(tp);

      state.answers.goal = goal;
      state.goalConfirmed = true;
      state.onboardingDone = true;
      state.stage = "done";
      await this._saveState(state);

      return {
        text:
          "מעולה, יש לי עכשיו תמונה די מלאה עליך: גיל, משקל, גובה, נתוני רכיבה מסטרבה, FTP, דופק ומטרה.\n\n" +
          "מכאן נוכל להתקדם לאימונים חכמים ומדויקים. בכל רגע תוכל להגיד לי למשל:\n" +
          "• \"מה האימון המומלץ למחר?\"\n" +
          "• \"תן לי ניתוח של האימון שעשיתי היום\"\n" +
          "• \"בוא נבנה תוכנית לקראת האירוע הבא שלי\"",
        done: true,
      };
    }

    // ברירת מחדל – אם משום מה הגענו לפה
    return {
      text:
        "משהו בתהליך האונבורדינג לא הסתדר לי בראש.\n" +
        "בוא נתחיל מחדש עם השאלה: בן כמה אתה?",
      done: false,
    };
  }

    /**
   * נקרא אחרי שהחיבור לסטרבה הצליח וה־server סיים computeHrAndFtpFromStrava.
   * המטרה: לעדכן state כדי שההודעה הבאה בצ'אט תציג סיכום קצר.
   */
  async handleStravaConnected(userId) {
    const state = await this._loadState(userId);

    // נסמן שיש סטרבה
    state.hasStrava = true;
    state.stravaConnected = true;

    // ננסה להביא שוב את המטריקות מה־DB (פועל רק על loew.db, לא על ה־API של סטרבה)
    try {
      const metrics = await this.db.computeHrAndFtpFromStrava(userId);
      if (metrics) {
        state.stravaMetrics = metrics;
      }
    } catch (err) {
      console.error("handleStravaConnected: computeHrAndFtpFromStrava failed", err);
    }

    // אם היינו בשלב "מחכה ליבוא" נעבור לשלב הסיכום
    if (
      state.stage === "wait_for_strava_import" ||
      state.stage === "ask_strava_connect" ||
      state.stage === "intro"
    ) {
      state.stage = "post_strava_summary";
    }

    await this._saveState(state);
  }


  /**
   * טיפול ב-FTP מתוך סטרבה
   */
  async _handleFtpFromStrava(userId, state) {
    const metrics = state.stravaMetrics || {};
    const ftpModels = metrics.ftpModels || {};
    const ftp20 = ftpModels.ftp20 ?? null;
    const ftpCp = ftpModels.ftpCp ?? null;
    const ftpCurve = ftpModels.ftpPowerCurve ?? null;
    const ftpFromStrava = ftpModels.ftpFromStrava ?? null;
    const ftpRec =
      ftpModels.ftpRecommended ?? metrics.ftpRecommended ?? null;

    if (!ftpRec) {
      state.stage = "hr_from_strava";
      await this._saveState(state);
      return {
        text:
          "לא הצלחתי להעריך FTP בצורה מספיק טובה מהנתונים האחרונים שלך.\n" +
          "נעבור לדופק, ואז נגדיר יחד יעד ואימונים.",
        done: false,
      };
    }

    state.stage = "ftp_from_strava_confirm";
    await this._saveState(state);

    let explanation =
      "השתמשתי בכמה מודלים כדי להעריך את ה-FTP שלך מהנתונים האחרונים בסטרבה:\n";

    if (ftp20) {
      explanation += `• מודל 20 דקות (Top 3 Efforts) → בערך ${Math.round(
        ftp20
      )}W.\n`;
    }
    if (ftpCp) {
      explanation += `• מודל Critical Power (3–20 דקות) → בערך ${Math.round(
        ftpCp
      )}W.\n`;
    }
    if (ftpCurve) {
      explanation += `• מודל עקומת הספק (Power Curve) → בערך ${Math.round(
        ftpCurve
      )}W.\n`;
    }
    if (ftpFromStrava) {
      explanation += `• ערך FTP שקיים כבר בסטרבה → ${Math.round(
        ftpFromStrava
      )}W.\n`;
    }

    explanation += `\nמתוך כל אלה, אני מציע לעבוד עם FTP משוער של ~${Math.round(
      ftpRec
    )}W.\n`;
    explanation +=
      "אם אתה יודע שה-FTP שלך שונה (למשל מבדיקה במעבדה או מבחן ספציפי) תכתוב לי מספר אחר.\n" +
      "אם זה נראה לך סביר, תכתוב \"כן\" או \"מאשר\".";

    return {
      text: explanation,
      done: false,
    };
  }

  /**
   * טיפול בדופק מתוך סטרבה
   */
  async _handleHrFromStrava(userId, state, userTextRaw) {
    const userText = this._normalizeText(userTextRaw);

    if (state.stage === "ftp_from_strava_confirm") {
      let ftpValue = null;
      if (/^\d+$/u.test(userText)) {
        ftpValue = parseInt(userText, 10);
      } else if (/כן|מאשר|סבבה|נשמע טוב/u.test(userText)) {
        const metrics = state.stravaMetrics || {};
        const ftpModels = metrics.ftpModels || {};
        ftpValue =
          ftpModels.ftpRecommended ?? metrics.ftpRecommended ?? null;
      }

      if (!ftpValue) {
        return {
          text:
            "אם ה-FTP שהצעתי לא נראה לך, תכתוב מספר חדש בוואטים (למשל 240), או תאשר במילה \"כן\".",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.ftp = ftpValue;
      await this.db.saveTrainingParams(tp);

      state.answers.ftp = ftpValue;
      state.ftpConfirmed = true;
      state.stage = "hr_from_strava";
      await this._saveState(state);

      return {
        text:
          `מעולה, רשמתי FTP = ${ftpValue}W.\n` +
          "עכשיו נעבור לדופק מקסימלי וסף דופק.",
        done: false,
      };
    }

    if (state.stage === "hr_from_strava") {
      const metrics = state.stravaMetrics || {};
      const hrModels = metrics.hrModels || {};
      const hrMaxCandidate =
        hrModels.hrMaxCandidate ?? metrics.hrMaxCandidate ?? null;
      const hrThresholdCandidate =
        hrModels.hrThresholdCandidate ??
        metrics.hrThresholdCandidate ??
        (hrMaxCandidate ? Math.round(hrMaxCandidate * 0.9) : null);

      if (!hrMaxCandidate) {
        state.stage = "ask_hr_max_manual";
        await this._saveState(state);
        return {
          text:
            "לא הצלחתי להעריך דופק מקסימלי בצורה מספיק טובה מהנתונים.\n" +
            "תכתוב בבקשה מה הדופק המקסימלי שאתה מכיר אצלך (למשל 178).",
          done: false,
        };
      }

      state.stage = "hr_from_strava_confirm";
      await this._saveState(state);

      let text =
        "מניתוח הרכיבות האחרונות שלך בסטרבה אני רואה:\n" +
        `• דופק מקסימלי משוער סביב ~${hrMaxCandidate}.\n` +
        `• סף דופק משוער סביב ~${hrThresholdCandidate}.\n\n` +
        "אם זה נשמע לך סביר, תכתוב \"כן\" או תתקן אותי עם מספר אחר לדופק המקסימלי.\n" +
        "אם אתה מכיר ערך אחר מבדיקה במעבדה או מאימון ספציפי, עדיף שנלך לפי זה.";

      return {
        text,
        done: false,
      };
    }

    if (state.stage === "hr_from_strava_confirm") {
      let hrMaxValue = null;

      if (/^\d+$/u.test(userText)) {
        hrMaxValue = parseInt(userText, 10);
      } else if (/כן|מאשר|סבבה|נשמע טוב/u.test(userText)) {
        const metrics = state.stravaMetrics || {};
        const hrModels = metrics.hrModels || {};
        hrMaxValue =
          hrModels.hrMaxCandidate ?? metrics.hrMaxCandidate ?? null;
      }

      if (!hrMaxValue) {
        return {
          text:
            "אם הדופק המקסימלי שהצעתי לא נראה לך, תכתוב מספר אחר (למשל 178), או תאשר במילה \"כן\".",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.hr_max = hrMaxValue;
      tp.hr_threshold = Math.round(hrMaxValue * 0.9);
      await this.db.saveTrainingParams(tp);

      state.answers.hrMax = hrMaxValue;
      state.answers.hrThreshold = tp.hr_threshold;
      state.hrConfirmed = true;
      state.stage = "min_ride_from_strava";
      await this._saveState(state);

      return {
        text:
          `רשמתי דופק מקסימלי ${hrMaxValue} וסף דופק ~${tp.hr_threshold}.\n` +
          "עכשיו נחליט מהו משך האימון ה\"רגיל\" שלך כדי שאוכל לתכנן אימונים שמתאימים לשגרת החיים שלך.",
        done: false,
      };
    }

    if (state.stage === "ask_hr_max_manual") {
      const hrMax = parseInt(userText, 10);
      if (!hrMax || hrMax < 120 || hrMax > 220) {
        return {
          text:
            "תכתוב בבקשה דופק מקסימלי סביר במספרים (למשל 178).",
          done: false,
        };
      }

      const tp = await this._ensureTrainingParams(userId);
      tp.hr_max = hrMax;
      tp.hr_threshold = Math.round(hrMax * 0.9);
      await this.db.saveTrainingParams(tp);

      state.answers.hrMax = hrMax;
      state.answers.hrThreshold = tp.hr_threshold;
      state.hrConfirmed = true;
      state.stage = "min_ride_from_strava";
      await this._saveState(state);

      return {
        text:
          `רשמתי דופק מקסימלי ${hrMax} וסף דופק ~${tp.hr_threshold}.\n` +
          "עכשיו נחליט מהו משך האימון ה\"רגיל\" שלך כדי שאוכל לתכנן אימונים שמתאימים לשגרת החיים שלך.",
        done: false,
      };
    }

    return {
      text:
        "משהו בתהליך של הדופק לא הסתדר. בוא נחזור צעד אחד אחורה.\n" +
        "תכתוב לי שוב מה הדופק המקסימלי שאתה מכיר אצלך.",
      done: false,
    };
  }
}
