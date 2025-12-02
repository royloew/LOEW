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

    if (existing) {
      let base = existing;

      // תמיכה לאחור במקרה ששמרנו פעם state_json
      if (existing.state_json && typeof existing.state_json === "string") {
        try {
          base = JSON.parse(existing.state_json) || {};
        } catch (err) {
          console.error(
            "Failed parsing onboarding state JSON, starting fresh from default + existing",
            err
          );
          base = existing || {};
        }
      }

      const nowIso = new Date().toISOString();

      const merged = {
        userId,
        stage: "intro",
        answers: {},
        onboardingCompleted: false,
        personalBasicsCompleted: false,
        ftpConfirmed: false,
        hrConfirmed: false,
        minRideMinutesConfirmed: false,
        goalConfirmed: false,
        stravaConnected: false,
        stravaMetrics: null,
        minRideCandidates: null,
        createdAt: base.createdAt || base.created_at || nowIso,
        updatedAt: base.updatedAt || base.updated_at || nowIso,
        ...base,
      };

      // שדה ישן – תרגום לחדש
      if (merged.onboardingDone && !merged.onboardingCompleted) {
        merged.onboardingCompleted = merged.onboardingDone;
      }

      merged.userId = userId;

      return merged;
    }

    const nowIso = new Date().toISOString();

    // State התחלתי
    return {
      userId,
      stage: "intro",
      answers: {},
      onboardingCompleted: false,
      personalBasicsCompleted: false,
      ftpConfirmed: false,
      hrConfirmed: false,
      minRideMinutesConfirmed: false,
      goalConfirmed: false,
      stravaConnected: false,
      stravaMetrics: null,
      minRideCandidates: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /**
   * שומר State ל-DB
   */
  async _saveState(state) {
    const nowIso = new Date().toISOString();

    if (!state) {
      throw new Error("_saveState: state is required");
    }

    if (!state.userId) {
      throw new Error("_saveState: state.userId is required");
    }

    if (!state.createdAt) {
      state.createdAt = state.created_at || nowIso;
    }

    state.updatedAt = nowIso;

    const toSave = {
      ...state,
      userId: state.userId,
    };

    await this.db.saveOnboarding(toSave);
  }

  /**
   * מבטיח שיש לנו training_params כלשהו למשתמש
   */
  async _ensureTrainingParams(userId) {
    let tp = await this.db.getTrainingParams(userId);
    const nowIso = new Date().toISOString();

    if (!tp) {
      tp = {
        userId,
        user_id: userId,
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
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    } else {
      // נוודא שתמיד יש userId לפונקציית השמירה
      tp = {
        ...tp,
        userId,
        user_id: tp.user_id || userId,
      };

      if (!tp.created_at && tp.createdAt) {
        tp.created_at = tp.createdAt;
      } else if (!tp.createdAt && tp.created_at) {
        tp.createdAt = tp.created_at;
      }
    }

    tp.updated_at = nowIso;
    tp.updatedAt = nowIso;

    await this.db.saveTrainingParams(tp);
    return tp;
  }

  /**
   * עוזר: מנקה טקסט מהודעת משתמש
   */
  _normalizeText(text) {
    if (!text) return "";
    return String(text).trim();
  }

  _isYes(text) {
    const t = (text || "").toString().trim().toLowerCase();
    if (!t) return false;
    return /^(כן|בטח|ברור|סבבה|נשמע טוב|יאללה|מאשר|מאשרת|ok|okay|אוקי|אוקיי)\b/u.test(t);
  }

  _isNo(text) {
    const t = (text || "").toString().trim().toLowerCase();
    if (!t) return false;
    return /^(לא|ממש לא|no|לא תודה|לא רוצה)/u.test(t);
  }

  /**
   * נקודת הכניסה הראשית – הודעה מהצ'אט
   */
  async handleMessage(userId, userTextRaw) {
    const state = await this._loadState(userId);
    const userText = this._normalizeText(userTextRaw);

    // אם כבר סיימנו אונבורדינג – לא אמור להגיע לכאן (server.js בודק),
    // אבל נשמור על הגנה.
    if (state.onboardingCompleted) {
      return {
        text:
          "האונבורדינג שלך כבר הושלם. אם תרצה לעדכן נתונים (גיל, משקל, FTP וכו') תגיד לי, ואני אכוון אותך.",
        done: true,
      };
    }

    // מסלול לפי stage
    switch (state.stage) {
      case "intro":
        return this._handleIntro(state);

      case "ask_age":
      case "ask_weight":
      case "ask_height":
      case "complete_personal_basics":
        return this._handlePersonalBasics(state, userText);

      case "ask_strava_connect":
        return this._handleAskStravaConnect(state, userText);

      case "wait_for_strava_import":
        return this._handleWaitForStrava(state);

      case "post_strava_summary":
      case "ftp_from_strava_confirm":
      case "ftp_manual":
        return this._handleFtpFlow(state, userText);

      case "hr_from_strava_confirm":
      case "hr_manual":
        return this._handleHrFlow(state, userText);

      case "min_ride_from_strava":
      case "min_ride_from_strava_choose":
      case "min_ride_manual":
        return this._handleMinRideFlow(state, userText);

      case "goal":
      case "goal_confirm":
        return this._handleGoalFlow(state, userText);

      case "done":
        return {
          text:
            "האונבורדינג שלך כבר הושלם. מהיום אתה יכול לשאול את LOEW על אימונים, עומס, ניתוח רכיבות וכל מה שמעניין אותך.",
          done: true,
        };

      default:
        console.warn("Unknown onboarding stage, resetting to intro:", state.stage);
        state.stage = "intro";
        await this._saveState(state);
        return this._handleIntro(state);
    }
  }

  /**
   * שלב פתיחה – טקסט ההסבר הראשון על LOEW
   */
  async _handleIntro(state) {
    state.stage = "ask_age";
    await this._saveState(state);

    const text = [
      "נעים מאוד, אני LOEW — המאמן האישי שלך.",
      "",
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.",
      "",
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים לביצוע ועם מינימום בלאגן — כדי שתדע בדיוק מה כדאי לעשות בכל יום.",
      "",
      "נתחיל מכמה פרטים אישיים בסיסיים כדי להכיר אותך יותר טוב.",
      "",
      "בן כמה אתה?",
    ].join("\n");

    return {
      text,
      done: false,
    };
  }

  /**
   * שלב פרטים אישיים: גיל, משקל, גובה
   */
  async _handlePersonalBasics(state, userText) {
    const userId = state.userId;
    let trainingParams = await this._ensureTrainingParams(userId);

    if (state.stage === "ask_age") {
      const ageMatch = userText.match(/(\d{2})/u);
      if (!ageMatch) {
        return {
          text: "בשביל להתחיל, אני צריך את הגיל שלך (למשל 42). בן כמה אתה?",
          done: false,
        };
      }
      const age = parseInt(ageMatch[1], 10);
      trainingParams.age = age;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.age = age;
      state.stage = "ask_weight";
      await this._saveState(state);

      return {
        text: `מעולה, רשמתי גיל ${age}. מה המשקל הנוכחי שלך בקילוגרמים?`,
        done: false,
      };
    }

    if (state.stage === "ask_weight") {
      const weightMatch = userText.match(/(\d{2,3})/u);
      if (!weightMatch) {
        return {
          text: "מה המשקל שלך בק\"ג? (למשל 67)",
          done: false,
        };
      }
      const weight = parseInt(weightMatch[1], 10);
      trainingParams.weight_kg = weight;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.weight_kg = weight;
      state.stage = "ask_height";
      await this._saveState(state);

      return {
        text: `מצוין, רשמתי ${weight} ק\"ג. מה הגובה שלך בס\"מ?`,
        done: false,
      };
    }

    if (state.stage === "ask_height") {
      const heightMatch = userText.match(/(\d{3})/u);
      if (!heightMatch) {
        return {
          text: "מה הגובה שלך בס\"מ? (למשל 178)",
          done: false,
        };
      }
      const height = parseInt(heightMatch[1], 10);
      trainingParams.height_cm = height;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.height_cm = height;
      state.personalBasicsCompleted = true;
      state.stage = "ask_strava_connect";
      await this._saveState(state);

      const text = [
        `רשמתי גובה ${height} ס\"מ.`,
        "",
        "עכשיו נעבור לחיבור ל- Strava, כדי שאוכל ללמוד מהנתונים של הרכיבות האחרונות שלך.",
        "יש לך חשבון Strava שדרכו אתה מתעד את רוב הרכיבות שלך?",
        "",
        "אם כן, תגיד למשל: \"כן, תחבר אותי לסטרבה\".",
        "אם לא – תגיד שאין לך, ונעשה אונבורדינג ידני.",
      ].join("\n");

      return {
        text,
        done: false,
      };
    }

    return {
      text: "בוא נחזור רגע להתחלה של הפרטים האישיים. מה הגיל שלך?",
      done: false,
    };
  }

  /**
   * חיבור ל-Strava
   */
  async _handleAskStravaConnect(state, userText) {
    const lower = userText.toLowerCase();

    if (!userText) {
      return {
        text:
          "יש לך חשבון Strava שדרכו אתה מתעד את רוב הרכיבות שלך? אם כן תגיד \"כן, תחבר אותי לסטרבה\", ואם לא – נמשיך אונבורדינג ידני.",
        done: false,
      };
    }

    if (/אין|לא/i.test(lower)) {
      state.stravaConnected = false;
      state.stage = "ftp_manual";
      await this._saveState(state);

      return {
        text:
          "סבבה, נתקדם בלי Strava.\n\nמה ה-FTP הנוכחי שלך (אם אתה יודע)? תכתוב מספר בוואטים. אם אתה לא יודע, תכתוב \"לא יודע\".",
        done: false,
      };
    }

    if (/strava|סטרבה|תחבר/i.test(lower)) {
      state.stage = "wait_for_strava_import";
      await this._saveState(state);

      return {
        text:
          "מעולה. לחיצה על כפתור החיבור לסטרבה תפתח חלון התחברות.\nאחרי שתאשר שם, תחזור לצ'אט – אני אייבא את הנתונים ואסכם לך אותם.",
        done: false,
      };
    }

    return {
      text:
        "רק כדי לוודא שהבנתי נכון – יש לך חשבון Strava? אם כן, תכתוב משהו כמו \"כן, תחבר אותי לסטרבה\". אם אין – תכתוב \"אין לי סטרבה\".",
      done: false,
    };
  }

  /**
   * מצב ביניים – מחכה לאישור ש-Strava חוברה ואינג'סט הסתיים
   */
  async _handleWaitForStrava(state) {
    return {
      text:
        "אני עדיין מחכה לסיום החיבור ל-Strava. אחרי שתאשר את החיבור בחלון שנפתח, תחזור לכאן ונמשיך.",
      done: false,
    };
  }

  /**
   * נקראת מהשרת אחרי שסטרבה חוברה והאינג'סט הסתיים
   * (server.js קורא לפונקציה הזו אחרי computeHrAndFtpFromStrava)
   */
  async handleStravaConnected(userId) {
    const state = await this._loadState(userId);
    state.stravaConnected = true;

    // ננסה להביא את המטריקות מה-DB (computeHrAndFtpFromStrava כבר עדכן אותן)
    try {
      const metrics = await this.db.computeHrAndFtpFromStrava(userId);
      state.stravaMetrics = metrics || null;
    } catch (err) {
      console.error("Error getting Strava metrics for onboarding:", err);
    }

    state.stage = "post_strava_summary";
    await this._saveState(state);
  }

  /**
   * זרימת FTP – גם מהנתונים של סטרבה וגם קלט ידני
   */
  async _handleFtpFlow(state, userText) {
    const userId = state.userId;
    let trainingParams = await this._ensureTrainingParams(userId);

    if (state.stage === "post_strava_summary") {
      const metrics = state.stravaMetrics;

      if (!metrics) {
        state.stage = "ftp_manual";
        await this._saveState(state);
        return {
          text:
            "לא הצלחתי להוציא מספיק מידע מסטרבה בשביל לחשב FTP.\n\nמה ה-FTP הנוכחי שלך (אם אתה יודע)? תכתוב מספר בוואטים. אם אתה לא יודע, תכתוב \"לא יודע\".",
          done: false,
        };
      }

      const { ftpModels, hrModels, trainingSummary, userWeightKg } = metrics;
      const lines = [];

      lines.push("סיימתי לנתח את הרכיבות האחרונות שלך מסטרבה.");
      if (trainingSummary) {
        lines.push(
          `• שעות אימון ממוצעות בשבוע: ${trainingSummary.avgHoursPerWeek?.toFixed?.(
            1
          ) || "-"}`
        );
        lines.push(
          `• מספר רכיבות ממוצע בשבוע: ${trainingSummary.ridesPerWeek?.toFixed?.(1) || "-"}`
        );
      }

      if (userWeightKg) {
        trainingParams.weight_kg = userWeightKg;
        state.answers.weight_kg = userWeightKg;
      }

      if (ftpModels) {
        const { ftp20, ftpPowerCurve, ftpCp, ftpFromStrava, ftpRecommended } = ftpModels;
        lines.push("");
        lines.push("חישבתי עבורך כמה מודלים של FTP:");
        if (ftp20) {
          lines.push(`• FTP ממאמץ 20 דק׳: ~${Math.round(ftp20)}W`);
        }
        if (ftpPowerCurve) {
          lines.push(`• FTP מעקומת כוח: ~${Math.round(ftpPowerCurve)}W`);
        }
        if (ftpCp) {
          lines.push(`• מודל CP: ~${Math.round(ftpCp)}W`);
        }
        if (ftpFromStrava) {
          lines.push(`• FTP שמוגדר לך בסטרבה: ${Math.round(ftpFromStrava)}W`);
        }
        if (ftpRecommended) {
          lines.push("");
          lines.push(`ההמלצה שלי לפי כל המודלים: ~${Math.round(ftpRecommended)}W.`);
        }
      }

      lines.push("");
      lines.push(
        "אם המספר הזה נשמע לך הגיוני, תכתוב \"כן\" או \"אוקי\". אם אתה מעדיף ערך אחר – תכתוב את ה-FTP שאתה רוצה שנשתמש בו."
      );

      state.stage = "ftp_from_strava_confirm";
      await this._saveState(state);
      return {
        text: lines.join("\n"),
        done: false,
      };
    }

    if (state.stage === "ftp_from_strava_confirm") {
      let ftpValue = null;
      if (/^\d+$/u.test(userText)) {
        ftpValue = parseInt(userText, 10);
      } else if (this._isYes(userText)) {
        const metrics = state.stravaMetrics || {};
        const ftpModels = metrics.ftpModels || {};
        ftpValue =
          ftpModels.ftpRecommended ||
          ftpModels.ftp20 ||
          ftpModels.ftpPowerCurve ||
          ftpModels.ftpCp ||
          ftpModels.ftpFromStrava ||
          null;
      }

      if (!ftpValue) {
        return {
          text:
            "בשביל שנוכל להמשיך, אני צריך FTP מספרי.\nתכתוב או את המספר שאתה רוצה (למשל 240), או תאשר שהחישוב שלי הגיוני עם \"כן\" / \"אוקי\".",
          done: false,
        };
      }

      trainingParams.ftp = ftpValue;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.ftp = ftpValue;
      state.ftpConfirmed = true;
      state.stage = "hr_from_strava_confirm";
      await this._saveState(state);

      return {
        text: `סגור, ה-FTP שלך מוגדר כ-${ftpValue}W. עכשיו נעבור לדופק מקסימלי.`,
        done: false,
      };
    }

    if (state.stage === "ftp_manual") {
      if (/לא יודע|אין לי מושג|לא בטוח/u.test(userText)) {
        trainingParams.ftp = null;
        await this.db.saveTrainingParams(trainingParams);

        state.answers.ftp = null;
        state.ftpConfirmed = false;
        state.stage = "hr_manual";
        await this._saveState(state);

        return {
          text:
            "אין בעיה, נתחיל בלי FTP ונעדכן את זה בהמשך כשיהיו לנו נתונים טובים.\n\nמה הדופק המקסימלי הגבוה ביותר שאתה זוכר שראית ברכיבה או במאמץ?",
          done: false,
        };
      }

      const match = userText.match(/(\d{2,3})/u);
      if (!match) {
        return {
          text:
            "אם אתה יודע את ה-FTP שלך, תכתוב אותו כמספר בוואטים (למשל 230). אם אתה לא יודע, תכתוב \"לא יודע\".",
          done: false,
        };
      }

      const ftpValue = parseInt(match[1], 10);
      trainingParams.ftp = ftpValue;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.ftp = ftpValue;
      state.ftpConfirmed = true;
      state.stage = "hr_manual";
      await this._saveState(state);

      return {
        text:
          "מעולה. עכשיו נעבור לדופק מקסימלי.\nמה הדופק המקסימלי הגבוה ביותר שאתה זוכר שראית ברכיבה או במאמץ?",
        done: false,
      };
    }

    return {
      text: "בוא נחזור רגע – מה ה-FTP שלך (אם אתה יודע)?",
      done: false,
    };
  }

  /**
   * זרימת דופק מקסימלי
   */
  async _handleHrFlow(state, userText) {
    const userId = state.userId;
    let trainingParams = await this._ensureTrainingParams(userId);

    if (state.stage === "hr_from_strava_confirm") {
      let hrMaxValue = null;

      if (/^\d+$/u.test(userText)) {
        hrMaxValue = parseInt(userText, 10);
      } else if (this._isYes(userText)) {
        const metrics = state.stravaMetrics || {};
        const hrModels = metrics.hrModels || {};
        hrMaxValue = hrModels.hrMaxCandidate || null;
      }

      if (!hrMaxValue) {
        const metrics = state.stravaMetrics || {};
        const hrModels = metrics.hrModels || {};
        const suggestion = hrModels.hrMaxCandidate
          ? `החישוב שלי הציע משהו באזור ${hrModels.hrMaxCandidate} פעימות.`
          : "";

        return {
          text: [
            "בשביל להגדיר אזורי דופק אני צריך דופק מקסימלי מספרי.",
            suggestion,
            "",
            "תכתוב פשוט את המספר הגבוה ביותר שאתה זוכר שראית (למשל 178), או תאשר שהחישוב שלי הגיוני עם \"כן\" / \"אוקי\".",
          ]
            .filter(Boolean)
            .join("\n"),
          done: false,
        };
      }

      trainingParams.hr_max = hrMaxValue;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.hr_max = hrMaxValue;
      state.hrConfirmed = true;
      state.stage = "min_ride_from_strava";
      await this._saveState(state);

      return {
        text:
          `סבבה, הגדרתי דופק מקסימלי ${hrMaxValue}.\n` +
          "עכשיו נדבר על משך אימון טיפוסי – כמה זמן בדרך כלל יש לך לרכיבת אימון רגילה (לא ארוכה מיוחדת)?",
        done: false,
      };
    }

    if (state.stage === "hr_manual") {
      const match = userText.match(/(\d{2,3})/u);
      if (!match) {
        return {
          text:
            "מה הדופק המקסימלי הגבוה ביותר שאתה זוכר? תכתוב רק מספר (למשל 180). אם אתה ממש לא יודע, תכתוב \"לא יודע\".",
          done: false,
        };
      }

      const hrMaxValue = parseInt(match[1], 10);
      trainingParams.hr_max = hrMaxValue;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.hr_max = hrMaxValue;
      state.hrConfirmed = true;
      state.stage = "min_ride_manual";
      await this._saveState(state);

      return {
        text:
          `מעולה, דופק מקסימלי ${hrMaxValue} נרשם.\n` +
          "עכשיו נדבר על משך אימון טיפוסי – כמה זמן בדרך כלל יש לך לרכיבת אימון רגילה (למשל 90 או 120 דקות)?",
        done: false,
      };
    }

    return {
      text: "בוא נחזור רגע – מה הדופק המקסימלי הגבוה ביותר שאתה זוכר?",
      done: false,
    };
  }

  /**
   * זרימת משך אימון טיפוסי
   */
  async _handleMinRideFlow(state, userText) {
    const userId = state.userId;
    let trainingParams = await this._ensureTrainingParams(userId);

    if (state.stage === "min_ride_from_strava") {
      try {
        const stats = await this.db.getRideDurationStats(userId);
        state.minRideCandidates = stats || null;
        state.stage = "min_ride_from_strava_choose";
        await this._saveState(state);

        if (!stats) {
          state.stage = "min_ride_manual";
          await this._saveState(state);
          return {
            text:
              "לא מצאתי מספיק רכיבות בשביל להעריך משך אימון טיפוסי.\n" +
              "תכתוב בבקשה כמה דקות אתה רוצה שיהיה משך אימון מינימלי \"רגיל\" (למשל 90 או 120).",
            done: false,
          };
        }

        const lines = [];
        lines.push("הנה מה שראיתי מהרכיבות האחרונות שלך:");
        if (stats.medianDurationMinutes) {
          lines.push(
            `• חציון משך רכיבה: ~${Math.round(stats.medianDurationMinutes)} דקות`
          );
        }
        if (stats.commonDurations && stats.commonDurations.length > 0) {
          const common = stats.commonDurations
            .slice(0, 3)
            .map((d) => `${Math.round(d)} דק׳`)
            .join(", ");
          lines.push(`• משכים נפוצים: ${common}`);
        }
        lines.push("");
        lines.push(
          "מה הכי מתאים לך כמשך מינימלי לרכיבת אימון \"רגילה\"?\n" +
            "1️⃣ 90 דקות\n" +
            "2️⃣ 120 דקות\n" +
            "3️⃣ משהו אחר – אני אכתוב מספר בעצמי"
        );

        return {
          text: lines.join("\n"),
          done: false,
        };
      } catch (err) {
        console.error("getRideDurationStats error:", err);
        state.stage = "min_ride_manual";
        await this._saveState(state);
        return {
          text:
            "לא הצלחתי לנתח את משך האימונים מסטרבה.\n" +
            "תכתוב בבקשה כמה דקות אתה רוצה שיהיה משך אימון מינימלי רגיל (למשל 90 או 120).",
          done: false,
        };
      }
    }

    if (state.stage === "min_ride_from_strava_choose") {
      const trimmed = userText.trim();
      let minutes = null;

      if (trimmed === "1") {
        minutes = 90;
      } else if (trimmed === "2") {
        minutes = 120;
      } else if (trimmed === "3") {
        return {
          text: "אוקיי, תכתוב אתה כמה דקות אתה רוצה (למשל 90 או 120).",
          done: false,
        };
      } else {
        const match = trimmed.match(/(\d{2,3})/u);
        if (match) {
          minutes = parseInt(match[1], 10);
        }
      }

      if (!minutes) {
        return {
          text:
            "אני צריך מספר בדקות. תכתוב 1 בשביל 90 דקות, 2 בשביל 120 דקות, 3 אם אתה רוצה לבחור מספר אחר – או פשוט תכתוב את מספר הדקות.",
          done: false,
        };
      }

      trainingParams.min_ride_minutes = minutes;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.min_ride_minutes = minutes;
      state.minRideMinutesConfirmed = true;
      state.stage = "goal";
      await this._saveState(state);

      return {
        text:
          `נהדר, משך אימון מינימלי רגיל הוגדר כ-${minutes} דקות.\n` +
          "ולסיום – מה המטרה העיקרית שלך כרגע באימונים? (למשל: לשפר FTP, להתכונן לגרן פונדו, לרדת במשקל וכו׳)",
        done: false,
      };
    }

    if (state.stage === "min_ride_manual") {
      const match = userText.match(/(\d{2,3})/u);
      if (!match) {
        return {
          text:
            "כמה דקות אתה רוצה שיהיה משך אימון מינימלי רגיל? תכתוב מספר כמו 90 או 120.",
          done: false,
        };
      }

      const minutes = parseInt(match[1], 10);
      trainingParams.min_ride_minutes = minutes;
      await this.db.saveTrainingParams(trainingParams);

      state.answers.min_ride_minutes = minutes;
      state.minRideMinutesConfirmed = true;
      state.stage = "goal";
      await this._saveState(state);

      return {
        text:
          `סגור, משך אימון מינימלי רגיל הוגדר כ-${minutes} דקות.\n` +
          "עכשיו – מה המטרה העיקרית שלך כרגע באימונים?",
        done: false,
      };
    }

    return {
      text: "בוא נגדיר כמה זמן יש לך בדרך כלל לאימון רגיל – תכתוב מספר בדקות (למשל 90).",
      done: false,
    };
  }

  /**
   * זרימת הגדרת מטרה
   */
  async _handleGoalFlow(state, userText) {
    const userId = state.userId;
    let trainingParams = await this._ensureTrainingParams(userId);

    if (state.stage === "goal") {
      if (!userText || userText.length < 3) {
        return {
          text:
            "תכתוב במשפט חופשי מה המטרה העיקרית שלך כרגע באימונים (למשל: \"גרן פונדו אילת בדצמבר\", \"שיפור FTP ל-270W\" וכו').",
          done: false,
        };
      }

      state.answers.goal = userText;
      state.stage = "goal_confirm";
      await this._saveState(state);

      return {
        text: `אם אני מסכם במילים שלך, המטרה שלך כרגע היא:\n\n"${userText}"\n\nזה נשמע נכון? אם כן תכתוב \"כן\" / \"אוקי\", ואם יש תיקון – תכתוב מטרה אחרת.`,
        done: false,
      };
    }

    if (state.stage === "goal_confirm") {
      if (this._isYes(userText)) {
        const goal = state.answers.goal;
        trainingParams.goal = goal;
        await this.db.saveTrainingParams(trainingParams);

        const age = state.answers.age;
        const weight = state.answers.weight_kg;
        const height = state.answers.height_cm;
        const ftp = state.answers.ftp;
        const hrMax = state.answers.hr_max;
        const minRide = state.answers.min_ride_minutes;

        const summaryLines = [];
        summaryLines.push("מעולה, סיימנו את האונבורדינג הראשוני שלך. הנה סיכום קצר:");
        summaryLines.push("");
        if (age) summaryLines.push(`• גיל: ${age}`);
        if (weight) summaryLines.push(`• משקל: ${weight} ק\"ג`);
        if (height) summaryLines.push(`• גובה: ${height} ס\"מ`);
        if (ftp != null) summaryLines.push(`• FTP: ${ftp}W`);
        if (hrMax) summaryLines.push(`• דופק מקסימלי: ${hrMax}`);
        if (minRide)
          summaryLines.push(`• משך אימון מינימלי רגיל: ${minRide} דקות`);
        if (goal) summaryLines.push(`• מטרה נוכחית: ${goal}`);
        summaryLines.push("");
        summaryLines.push(
          "מהנקודה הזו LOEW כבר יכול להמליץ לך על אימונים חכמים, לעזור לנתח רכיבות ולעקוב אחרי ההתקדמות שלך."
        );
        summaryLines.push(
          "כדי להתחיל, אתה יכול לשאול למשל: \"מה האימון המומלץ שלי למחר?\" או \"איך נראית התקופה האחרונה שלי מבחינת עומס?\""
        );

        const text = summaryLines.join("\n");

        state.answers.goal = goal;
        state.goalConfirmed = true;
        state.onboardingCompleted = true;
        state.stage = "done";
        await this._saveState(state);

        return {
          text,
          done: true,
        };
      }

      // אם המשתמש כותב משהו אחר – נפרש כמטרה חדשה
      state.answers.goal = userText;
      state.stage = "goal_confirm";
      await this._saveState(state);

      return {
        text: `אוקיי, נעדכן את המטרה שלך ל:\n\n"${userText}"\n\nאם זה מדויק, תכתוב \"כן\" / \"אוקי\". אם תרצה לשנות שוב – תכתוב ניסוח אחר.`,
        done: false,
      };
    }

    return {
      text:
        "בוא נסכם במטרה אחת ברורה. תכתוב במשפט חופשי מה אתה רוצה להשיג בתקופה הקרובה באימונים.",
      done: false,
    };
  }
}
