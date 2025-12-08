// onboardingEngine.js
// אונבורדינג: פתיח מלא → סטרבה → נתונים אישיים → FTP → דופק → משך אימון → מטרה

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
    // זיכרון פנימי לכל משתמש, כדי לא להיות תלויים רק ב-DB
    this._memStates = new Map();
  }

  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();

    let state = await this._loadState(userId);

    // אם כבר סיימנו אונבורדינג – לא חוזרים פנימה
    if (state && state.stage === "done") {
      return {
        reply:
          "האונבורדינג כבר הושלם. אם תרצה לעדכן משקל, FTP, דופק או מטרה — תגיד לי מה לעדכן.",
        onboarding: false,
      };
    }

    // אין state שמור – בוטסטרפ מסטרבה
    if (!state || !state.stage) {
      state = await this._bootstrapStateFromStrava(userId);
      await this._saveState(userId, state);
    }

    let reply = "";

    switch (state.stage) {
      case "intro":
        reply = await this._stageIntro(userId, text, state);
        break;

      case "post_strava_summary":
        // שלב זה נשמר רק למקרה עתידי; כרגע אנחנו תמיד עוברים ישר ל-personal_details
        reply = await this._stagePostStravaSummary(userId, state);
        break;

      case "personal_details":
        reply = await this._stagePersonalDetails(userId, text, state);
        break;

      case "ftp_intro":
        reply = await this._stageFtpIntro(userId, state);
        break;

      case "ftp_choice":
        reply = await this._stageFtpChoice(userId, text, state);
        break;

      case "hr_collect":
        reply = await this._stageHrCollect(userId, text, state);
        break;

      case "training_time":
        reply = await this._stageTrainingTime(userId, text, state);
        break;

      case "goal_collect":
        reply = await this._stageGoalCollect(userId, text, state);
        break;

      default:
        // חשוב: לא מאפסים state ולא חוזרים שוב לסיכום סטרבה,
        // כדי שלא יווצר לופ במשקל/סיכום.
        console.warn(
          "OnboardingEngine.handleMessage: unknown stage",
          state.stage
        );
        return {
          reply:
            "משהו לא היה ברור בתהליך האונבורדינג. תנסה לענות שוב בתשובה קצרה ופשוטה (מספר או מילה אחת), ונמשיך מאותו שלב.",
          onboarding: true,
        };
    }

    return { reply, onboarding: true };
  }

  // ===== DB + MEMORY HELPERS =====

  async _loadState(userId) {
    // 1) ניסיון לקרוא מה-DB
    if (this.db && typeof this.db.getOnboardingState === "function") {
      try {
        const st = await this.db.getOnboardingState(userId);
        if (st && st.stage) {
          const loaded = {
            stage: st.stage,
            data: st.data || {},
          };
          // מסנכרן גם לזיכרון
          this._memStates.set(userId, loaded);
          return loaded;
        }
      } catch (e) {
        console.error("OnboardingEngine._loadState DB error:", e);
      }
    }

    // 2) אם ה-DB לא עבד – fallback לזיכרון
    const mem = this._memStates.get(userId);
    if (mem && mem.stage) {
      return mem;
    }

    // 3) ברירת מחדל – אין state
    return { stage: null, data: {} };
  }

  async _saveState(userId, state) {
    const cleanState = {
      stage: state.stage,
      data: state.data || {},
    };

    // זיכרון פנימי
    this._memStates.set(userId, cleanState);

    if (!this.db || typeof this.db.saveOnboardingState !== "function") {
      return;
    }

    try {
      await this.db.saveOnboardingState(userId, cleanState);
    } catch (e) {
      console.error("OnboardingEngine._saveState DB error:", e);
    }
  }

  async _bootstrapStateFromStrava(userId) {
    let snapshot = null;

    try {
      if (
        this.db &&
        typeof this.db.getStravaOnboardingSnapshot === "function"
      ) {
        snapshot = await this.db.getStravaOnboardingSnapshot(userId);
      }
    } catch (e) {
      console.error("OnboardingEngine._bootstrapStateFromStrava error:", e);
    }

    const state = {
      stage: "intro",
      data: {
        snapshotAvailable: !!snapshot,
        trainingSummary: snapshot ? snapshot.trainingSummary || null : null,
        volume: snapshot ? snapshot.volume || null : null,
        ftpModels: snapshot ? snapshot.ftpModels || null : null,
        hr: snapshot ? snapshot.hr || null : null,
        personal: snapshot ? snapshot.personal || {} : {},
      },
    };

    return state;
  }

  // מעדכן training_params לפי הערכים הסופיים מה-state (FTP / HR)
  async _updateTrainingParamsFromState(userId, state) {
    if (
      !this.db ||
      typeof this.db.getTrainingParams !== "function" ||
      typeof this.db.saveTrainingParams !== "function"
    ) {
      return;
    }

    const d = state.data || {};
    const ftpFinal = d.ftpFinal ?? null;

    const hr = d.hr || {};
    const hrMaxFinal = hr.hrMaxFinal ?? null;
    const hrThresholdFinal = hr.hrThresholdFinal ?? null;

    try {
      const existing = (await this.db.getTrainingParams(userId)) || {};

      const newParams = {
        ...existing,
        // FTP שהמשתמש אישר – זה הערך שהמאמן צריך לעבוד איתו
        ftp: ftpFinal != null ? ftpFinal : existing.ftp ?? null,
        // HR סופי מהאונבורדינג גובר על מודל אוטומטי
        hrMax:
          hrMaxFinal != null ? hrMaxFinal : existing.hrMax ?? null,
        hrThreshold:
          hrThresholdFinal != null
            ? hrThresholdFinal
            : existing.hrThreshold ?? null,
      };

      await this.db.saveTrainingParams(userId, newParams);
    } catch (e) {
      console.error(
        "OnboardingEngine._updateTrainingParamsFromState error:",
        e
      );
    }
  }

  async _ensureStravaMetricsInState(userId, state) {
    state.data = state.data || {};
    const currentPersonal = state.data.personal || {};
    const currentFtpModels = state.data.ftpModels || {};

    const hasTS =
      state.data.trainingSummary &&
      state.data.trainingSummary.rides_count != null;

    const hasHr =
      state.data.hr && typeof state.data.hr.hrMax === "number";

    const hasPersonal =
      currentPersonal &&
      (currentPersonal.weightFromStrava != null ||
        currentPersonal.heightCm != null ||
        currentPersonal.age != null);

    const hasFtp =
      currentFtpModels && Object.keys(currentFtpModels).length > 0;

    const needSnapshot = !hasTS || !hasHr || !hasPersonal || !hasFtp;

    if (!needSnapshot) {
      return state;
    }

    try {
      if (
        this.db &&
        typeof this.db.getStravaOnboardingSnapshot === "function"
      ) {
        const snapshot = await this.db.getStravaOnboardingSnapshot(userId);

        if (snapshot) {
          // ALWAYS MERGE PERSONAL
          const snapshotPersonal = snapshot.personal || {};
          state.data.personal = { ...snapshotPersonal, ...currentPersonal };

          // ALWAYS MERGE FTP MODELS
          const snapshotFtpModels = snapshot.ftpModels || {};
          state.data.ftpModels = {
            ...snapshotFtpModels,
            ...currentFtpModels,
          };

          // MERGE TS & VOLUME IF EMPTY
          if (!hasTS) {
            state.data.trainingSummary = snapshot.trainingSummary || null;
            state.data.volume = snapshot.volume || null;
          }

          // MERGE HR IF EMPTY
          if (!hasHr) {
            state.data.hr = snapshot.hr || null;
          }
        }
      }
    } catch (err) {
      console.error(
        "OnboardingEngine._ensureStravaMetricsInState error:",
        err
      );
    }

    return state;
  }

  // ===== INTRO =====

  async _stageIntro(userId, text, state) {
    const introText =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים ליישום, שמתקדמים בקצב שמתאים בדיוק לך.\n\n" +
      "נתחיל מחיבור לסטרבה כדי שאוכל לראות את הרכיבות האחרונות שלך.";

    // בודק האם כבר יש טוקנים של סטרבה למשתמש הזה
    let hasStravaTokens = false;
    try {
      if (this.db && typeof this.db.getStravaTokens === "function") {
        const tokens = await this.db.getStravaTokens(userId);
        hasStravaTokens = !!(tokens && tokens.accessToken);
      }
    } catch (err) {
      console.error("OnboardingEngine._stageIntro getStravaTokens error:", err);
    }

    // === מקרה 1: אין חיבור סטרבה → פתיח + קישור חיבור ===
    if (!hasStravaTokens) {
      state.stage = "intro";
      await this._saveState(userId, state);

      const connectUrl = `/auth/strava?userId=${encodeURIComponent(userId)}`;

      return (
        introText +
        "\n\n" +
        `לחיבור לסטרבה, תלחץ על הקישור הבא:\n${connectUrl}`
      );
    }

    // === מקרה 2: כבר יש חיבור סטרבה → עוברים לסיכום הנתונים מסטרבה ===
    state = await this._bootstrapStateFromStrava(userId);
    await this._saveState(userId, state);
    return await this._stagePostStravaSummary(userId, state);
  }

  _formatTrainingSummary(ts) {
    if (!ts || !ts.rides_count || ts.rides_count <= 0) {
      return "לא הצלחתי למצוא מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח.";
    }

    const rides = ts.rides_count;
    const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
    const km = ts.totalDistanceKm.toFixed(1);
    const elevation = Math.round(ts.totalElevationGainM);
    const avgMin = Math.round(ts.avgDurationSec / 60);

    return [
      "בדקתי את הרכיבות שלך מהתקופה האחרונה:",
      `• מספר רכיבות: ${rides}`,
      `• זמן רכיבה מצטבר: ${hours} שעות`,
      `• מרחק מצטבר: ${km} ק״מ`,
      `• טיפוס מצטבר: ${elevation} מטר`,
      `• משך רכיבה ממוצעת: כ-${avgMin} דקות לרכיבה.`,
    ].join("\n");
  }

  async _stagePostStravaSummary(userId, state) {
    state = await this._ensureStravaMetricsInState(userId, state);
    const ts = state.data && state.data.trainingSummary;
    const summaryText = this._formatTrainingSummary(ts);

    const personal = state.data.personal || {};
    const weightFromStrava =
      personal.weightFromStrava != null ? personal.weightFromStrava : null;

    state.stage = "personal_details";
    state.data.personal = personal;
    state.data.personalStep = "weight";
    await this._saveState(userId, state);

    let weightLine = "";
    if (weightFromStrava != null) {
      weightLine = `מופיע בסטרבה משקל ${weightFromStrava} ק"ג — לאשר או שאתה מעוניין לעדכן?`;
    } else {
      weightLine = 'נתחיל ממשקל — כמה אתה שוקל בק"ג?';
    }

    return (
      summaryText +
      "\n\n" +
      "עכשיו שיש לנו סטרבה אני צריך להשלים עוד כמה נתונים בסיסים" +
      "\n\n" +
      weightLine
    );
  }

  // ===== PERSONAL DETAILS =====

  async _stagePersonalDetails(userId, text, state) {
    state.data.personal = state.data.personal || {};
    let step = state.data.personalStep || "weight";
    const t = (text || "").trim();

    // משקל
    if (step === "weight") {
      const personal = state.data.personal;
      const weightFromStrava =
        personal && personal.weightFromStrava != null
          ? personal.weightFromStrava
          : null;

      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 30 && num < 200) {
          parsed = Math.round(num * 10) / 10;
        }
      }

      if (!t && weightFromStrava != null) {
        return `מופיע בסטרבה משקל ${weightFromStrava} ק"ג — לאשר או שאתה מעוניין לעדכן?`;
      }

      if (t && !parsed && t !== "אישור") {
        if (weightFromStrava != null) {
          return (
            "לא הצלחתי להבין את המשקל שכתבת.\n" +
            `בסטרבה מופיע ${weightFromStrra} ק\"ג.\n` +
            "תכתוב משקל מספרי בק\"ג (למשל 72.5), או תכתוב 'אישור' אם אתה רוצה להשאיר כמו שמופיע."
          );
        }
        return "לא הצלחתי להבין את המשקל שכתבת. תכתוב מספר בק\"ג (למשל 72.5).";
      }

      if (t === "אישור" && weightFromStrava != null) {
        state.data.personal.weight = weightFromStrava;
      } else if (parsed != null) {
        state.data.personal.weight = parsed;
      } else if (!state.data.personal.weight) {
        return "כדי שאוכל לחשב עומסים בצורה נכונה — אני צריך את המשקל שלך בק\"ג.";
      }

      // ממשיכים לגובה
      state.data.personalStep = "height";
      await this._saveState(userId, state);
      return "מה הגובה שלך בסנטימטרים?";
    }

    // גובה
    if (step === "height") {
      state.data.personal.height = state.data.personal.height || null;

      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 120 && num < 230) {
          parsed = Math.round(num);
        }
      }

      if (!parsed) {
        return "תכתוב גובה בסנטימטרים (למשל 178).";
      }

      state.data.personal.height = parsed;
      state.data.personalStep = "age";
      await this._saveState(userId, state);
      return "בן כמה אתה?";
    }

    // גיל
    if (step === "age") {
      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 10 && num < 100) {
          parsed = Math.round(num);
        }
      }

      if (!parsed) {
        return "תכתוב גיל במספרים (למשל 35).";
      }

      state.data.personal.age = parsed;
      state.data.personalStep = "done";
      state.stage = "ftp_intro";
      await this._saveState(userId, state);

      // ישר ממשיכים לשלב ה-FTP בלי הודעת מעבר נוספת
      return await this._stageFtpIntro(userId, state);
    }

    // fallback – במקרה ששוב נתקענו על personalStep לא ברור
    state.data.personalStep = "done";
    state.stage = "ftp_intro";
    await this._saveState(userId, state);
    return await this._stageFtpIntro(userId, state);
  }

  // ===== FTP =====

  _formatFtpModels(ftpModels) {
    if (!ftpModels) {
      return "עדיין לא הצלחתי לחשב מודלים ל-FTP מהנתונים שלך.";
    }

    const lines = [];

    const addLine = (key, label) => {
      if (ftpModels[key] && ftpModels[key].value != null) {
        lines.push(
          `• ${label}: ${ftpModels[key].value} W${
            ftpModels[key].extraLabel ? ` (${ftpModels[key].extraLabel})` : ""
          }`
        );
      }
    };

    addLine("ftp20", "FTP 20min (95%)");
    addLine("ftpFrom3min", "FTP from 3min model");
    addLine("ftpFromCP", "Critical Power model");
    addLine("ftpFrom8min", "FTP from 8min model");

    if (ftpModels.ftpFromStrava && ftpModels.ftpFromStrava.value != null) {
      lines.push(
        `• FTP from Strava: ${ftpModels.ftpFromStrava.value} W (כפי שמופיע בסטרבה)`
      );
    }

    if (
      ftpModels.ftpRecommended &&
      ftpModels.ftpRecommended.value != null &&
      lines.length > 0
    ) {
      lines.push(
        `• Recommended FTP: ${ftpModels.ftpRecommended.value} W`
      );
    }

    return lines.join("\n");
  }

  async _stageFtpIntro(userId, state) {
    state = await this._ensureStravaMetricsInState(userId, state);
    const ftpModels = state.data.ftpModels || null;

    state.stage = "ftp_choice";
    await this._saveState(userId, state);

    const summary = this._formatFtpModels(ftpModels);

    let recommendedStr = "";
    if (
      ftpModels &&
      ftpModels.ftpRecommended &&
      ftpModels.ftpRecommended.value
    ) {
      recommendedStr = `לפי החישובים שלי, ה-FTP המומלץ עבורך כרגע הוא ${ftpModels.ftpRecommended.value} W.`;
    } else {
      recommendedStr =
        "לא הצלחתי לגזור ערך FTP מומלץ חד-משמעי מהנתונים.";
    }

    // אם אין לנו מודלים בכלל – נשאיר את הפורמט הישן (הודעת שגיאה אחת)
    if (
      !ftpModels ||
      !summary ||
      summary.startsWith("עדיין לא הצלחתי")
    ) {
      return (
        summary +
        "\n\n" +
        (recommendedStr + "\nתאשר לי או שתרשום ערך FTP אחר")
      );
    }

    const header1 = "ניתחתי את הרכיבות שלך מה 60 יום האחרונים";
    const header2 = "FTP Models";

    return (
      header1 +
      "\n\n" +
      header2 +
      "\n" +
      summary +
      "\n\n" +
      (recommendedStr + "\nתאשר לי או שתרשום ערך FTP אחר")
    );
  }

  async _stageFtpChoice(userId, text, state) {
    const t = (text || "").trim();
    const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
    const num = parseFloat(cleaned);

    if (!Number.isFinite(num) || num < 100 || num > 500) {
      return "כדי שאוכל לעבוד עם FTP מדויק – תכתוב מספר בוואטים (למשל 240).";
    }

    const ftpFinal = Math.round(num);
    state.data.ftpFinal = ftpFinal;

    state.data.ftpModels = state.data.ftpModels || {};
    state.data.ftpModels.ftpUserSelected = {
      key: "ftpUserSelected",
      value: ftpFinal,
      label: "FTP chosen by user",
    };

    state.stage = "hr_collect";
    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);

    const { hrMaxCandidate } = this._extractHrCandidates(state);
    const bubbles = [];

    if (hrMaxCandidate != null) {
      bubbles.push(
        `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ${hrMaxCandidate} bpm. אם זה נראה לך סביר, תכתוב "אישור" או תכתוב ערך אחר.`
      );
    } else {
      bubbles.push(
        "לא קיבלתי עדיין דופק מקסימלי ממך. תכתוב מספר בין 120 ל-220 (למשל 175), או תכתוב 'לא יודע' אם אתה לא בטוח."
      );
    }

    return bubbles.join("\n\n");
  }

  _extractHrCandidates(state) {
    const hr = state.data && state.data.hr ? state.data.hr : null;
    let hrMaxCandidate = null;
    let hrThresholdCandidate = null;

    if (hr) {
      if (hr.hrMax != null) hrMaxCandidate = hr.hrMax;
      if (hr.hrThreshold != null) hrThresholdCandidate = hr.hrThreshold;
      if (!hrThresholdCandidate && hr.hrThresholdFromModels != null) {
        hrThresholdCandidate = hr.hrThresholdFromModels;
      }
    }

    return { hrMaxCandidate, hrThresholdCandidate };
  }

  // ===== HR =====

  async _stageHrCollect(userId, text, state) {
    const t = (text || "").trim();
    state.data.hr = state.data.hr || {};
    let step = state.data.hrStep || "hrMax";

    const { hrMaxCandidate, hrThresholdCandidate } =
      this._extractHrCandidates(state);

    // HRmax
    if (step === "hrMax") {
      if (t === "לא יודע" || t === "לא יודעת") {
        state.data.hr.hrMaxUser = null;
        if (hrMaxCandidate != null) {
          state.data.hr.hrMaxFinal = hrMaxCandidate;
        }
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        if (hrThresholdCandidate != null) {
          return (
            `הדופק סף המשוער שלי הוא ${hrThresholdCandidate} bpm.\n\n` +
            'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק סף שלך (למשל 160).'
          );
        }

        return (
          "לא קיבלתי ערך דופק מקסימלי ממך.\n" +
          "נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'."
        );
      }

      if (t === "אישור" && hrMaxCandidate != null) {
        state.data.hr.hrMaxUser = hrMaxCandidate;
        state.data.hr.hrMaxFinal = hrMaxCandidate;
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        if (hrThresholdCandidate != null) {
          return (
            `הדופק סף המשוער שלי הוא ${hrThresholdCandidate} bpm.\n\n` +
            'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק סף שלך (למשל 160).'
          );
        }

        return (
          "מעולה.\n" +
          "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'."
        );
      }

      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 100 && num < 230) {
          parsed = Math.round(num);
        }
      }

      if (parsed == null) {
        const bubbles = [];
        if (hrMaxCandidate != null) {
          bubbles.push(
            "לא הצלחתי להבין את הערך שכתבת לדופק מקסימלי.\nתכתוב מספר בין 120 ל-220 (למשל 175)."
          );
          bubbles.push(
            `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ${hrMaxCandidate} bpm. אם זה נראה לך סביר, תכתוב "אישור".`
          );
        } else {
          bubbles.push(
            "לא הצלחתי להבין את הערך שכתבת לדופק מקסימלי. תכתוב מספר בין 120 ל-220 (למשל 175)."
          );
        }
        return bubbles.join("\n\n");
      }

      state.data.hr.hrMaxUser = parsed;
      state.data.hr.hrMaxFinal = parsed;
      state.data.hrStep = "hrThreshold";
      await this._saveState(userId, state);

      if (hrThresholdCandidate != null) {
        return (
          `הדופק סף המשוער שלי הוא ${hrThresholdCandidate} bpm.\n\n` +
          'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק סף שלך (למשל 160).'
        );
      }

      return (
        "מעולה.\n" +
        "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'."
      );
    }

    // HR threshold
    if (step === "hrThreshold") {
      if (t === "לא יודע" || t === "לא יודעת") {
        state.data.hr.hrThresholdUser = null;
        if (hrThresholdCandidate != null) {
          state.data.hr.hrThresholdFinal = hrThresholdCandidate;
        }
        state.stage = "training_time";
        state.data.trainingTimeStep = "fromStrava";

        await this._updateTrainingParamsFromState(userId, state);
        await this._saveState(userId, state);

        return "נעבור עכשיו למשך האימונים שלך – כמה זמן אתה בדרך כלל רוכב?";
      }

      if (t === "אישור" && hrThresholdCandidate != null) {
        state.data.hr.hrThresholdUser = hrThresholdCandidate;
        state.data.hr.hrThresholdFinal = hrThresholdCandidate;
        state.stage = "training_time";
        state.data.trainingTimeStep = "fromStrava";

        await this._updateTrainingParamsFromState(userId, state);
        await this._saveState(userId, state);

        return "נעבור עכשיו למשך האימונים שלך – כמה זמן אתה בדרך כלל רוכב?";
      }

      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 80 && num < 220) {
          parsed = Math.round(num);
        }
      }

      if (parsed == null) {
        if (hrThresholdCandidate != null) {
          return (
            "לא הצלחתי להבין את הערך שכתבת לדופק סף.\n" +
            'תכתוב מספר בין 120 ל-200 (למשל 160), או תכתוב "לא יודע" אם אתה לא בטוח.\n\n' +
            `לפי הנתונים מסטרבה אני רואה דופק סף משוער של ${hrThresholdCandidate} bpm.`
          );
        }
        return (
          "לא הצלחתי להבין את הערך שכתבת לדופק סף.\n" +
          'תכתוב מספר בין 120 ל-200 (למשל 160), או תכתוב "לא יודע" אם אתה לא בטוח.'
        );
      }

      state.data.hr.hrThresholdUser = parsed;
      state.data.hr.hrThresholdFinal = parsed;
      state.stage = "training_time";
      state.data.trainingTimeStep = "fromStrava";

      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      return "נעבור עכשיו למשך האימונים שלך – כמה זמן אתה בדרך כלל רוכב?";
    }

    // fallback – ממשיכים הלאה למשך אימון
    state.stage = "training_time";
    state.data.trainingTimeStep = "fromStrava";
    await this._saveState(userId, state);
    return "נעבור עכשיו למשך האימונים שלך – כמה זמן אתה בדרך כלל רוכב?";
  }

  // ===== TRAINING TIME =====

  _extractTrainingTimeFromSummary(ts) {
    if (!ts) return null;
    const avgMin = ts.avgDurationSec ? Math.round(ts.avgDurationSec / 60) : null;
    if (!avgMin || avgMin <= 0) return null;

    const minMinutes = Math.max(45, Math.round(avgMin * 0.4));
    const maxMinutes = Math.round(avgMin * 1.8);

    return {
      minMinutes,
      avgMinutes: avgMin,
      maxMinutes,
    };
  }

  async _stageTrainingTime(userId, text, state) {
    state.data.trainingTime = state.data.trainingTime || {};
    let step = state.data.trainingTimeStep || "fromStrava";
    const t = (text || "").trim();

    if (step === "fromStrava") {
      state = await this._ensureStravaMetricsInState(userId, state);
      const ts = state.data.trainingSummary || null;
      const tt = this._extractTrainingTimeFromSummary(ts);

      if (!tt) {
        state.data.trainingTimeStep = "manual";
        await this._saveState(userId, state);
        return (
          "לא מצאתי מספיק נתונים מסטרבה כדי להעריך משך אימון טיפוסי.\n" +
          "תכתוב שלושה מספרים בדקות שמתאימים לרכיבה קצרה / ממוצעת / ארוכה (למשל: 90 120 180)."
        );
      }

      state.data.trainingTimeFromStrava = tt;
      state.data.trainingTimeStep = "confirm";
      await this._saveState(userId, state);

      return (
        "לפי סטרבה זה מה שאני מבין על משך האימונים שלך\n" +
        `• רכיבה קצרה: ${tt.minMinutes} דקות\n` +
        `• רכיבה ממוצעת: ${tt.avgMinutes} דקות\n` +
        `• רכיבה ארוכה: ${tt.maxMinutes} דקות\n\n` +
        'אם זה מתאים — תכתוב "אישור".\n' +
        "אם אתה מעדיף ערכים אחרים, תכתוב שלושה מספרים בדקות בסדר: קצר / ממוצע / ארוך (למשל: 90 120 180)."
      );
    }

    if (step === "confirm") {
      const tt = state.data.trainingTimeFromStrava || null;
      if (!tt) {
        state.data.trainingTimeStep = "manual";
        await this._saveState(userId, state);
        return (
          "לא הצלחתי למצוא שוב את הנתונים מסטרבה לגבי משך האימונים.\n" +
          "תכתוב שלושה מספרים בדקות שמתאימים לרכיבה קצרה / ממוצעת / ארוכה (למשל: 90 120 180)."
        );
      }

      if (t === "אישור") {
        state.data.trainingTime = {
          minMinutes: tt.minMinutes,
          avgMinutes: tt.avgMinutes,
          maxMinutes: tt.maxMinutes,
        };
        state.data.trainingTimeStep = "done";
        state.stage = "goal_collect";
        await this._saveState(userId, state);

        return "נעבור למטרה שלך לתקופה הקרובה.";
      }

      const nums = t
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 20 && n < 600);

      if (nums.length !== 3) {
        return (
          "כדי שאוכל להגדיר זמנים טיפוסיים — תכתוב שלושה מספרים בדקות בסדר: קצר / ממוצע / ארוך (למשל: 90 120 180)."
        );
      }

      const [minMinutes, avgMinutes, maxMinutes] = nums;
      if (!(minMinutes < avgMinutes && avgMinutes <= maxMinutes)) {
        return (
          "המספרים שכתבת לא נראים כמו סדר הגיוני של קצר / ממוצע / ארוך.\n" +
          "תדאג שהראשון הוא הקצר ביותר, השני באמצע והשלישי הארוך ביותר."
        );
      }

      state.data.trainingTime = {
        minMinutes,
        avgMinutes,
        maxMinutes,
      };
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";
      await this._saveState(userId, state);

      return "נעבור למטרה שלך לתקופה הקרובה.";
    }

    // fallback – כבר יש לנו נתונים, ממשיכים
    state.stage = "goal_collect";
    state.data.trainingTimeStep = "done";
    await this._saveState(userId, state);

    return "נעבור למטרה שלך לתקופה הקרובה.";
  }

  // ===== GOAL =====

  async _stageGoalCollect(userId, text, state) {
    const t = (text || "").trim();
    if (!t) {
      return "מה המטרה המרכזית שלך לתקופה הקרובה?";
    }

    state.data.goal = t;
    state.stage = "done";
    await this._saveState(userId, state);

    return (
      "סיימנו את האונבורדינג 🎉\n\n" +
      "מכאן נמשיך לבנות עבורך אימונים חכמים ומותאמים אישית."
    );
  }
}
