// onboardingEngine.js
// אונבורדינג: פתיח מלא → סטרבה → נתונים אישיים → FTP → דופק → משך אימון → מטרה

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
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

  // ===== DB HELPERS =====

  async _loadState(userId) {
    if (!this.db || typeof this.db.getOnboardingState !== "function") {
      return { stage: null, data: {} };
    }
    try {
      const st = await this.db.getOnboardingState(userId);
      if (!st || !st.stage) return { stage: null, data: {} };
      return {
        stage: st.stage,
        data: st.data || {},
      };
    } catch (e) {
      console.error("OnboardingEngine._loadState error:", e);
      return { stage: null, data: {} };
    }
  }

  async _saveState(userId, state) {
    if (!this.db || typeof this.db.saveOnboardingState !== "function") return;
    try {
      await this.db.saveOnboardingState(userId, state.stage, state.data || {});
    } catch (e) {
      console.error("OnboardingEngine._saveState error:", e);
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

  async _ensureStravaMetricsInState(userId, state) {
    state.data = state.data || {};
    const hasTS =
      state.data.trainingSummary &&
      state.data.trainingSummary.rides_count != null;
    const hasFtp = state.data.ftpModels != null;
    const hasHr = state.data.hr != null;

    if (hasTS && hasFtp && hasHr) return state;

    try {
      if (
        this.db &&
        typeof this.db.getStravaOnboardingSnapshot === "function"
      ) {
        const snapshot = await this.db.getStravaOnboardingSnapshot(userId);
        if (snapshot) {
          if (!hasTS) {
            state.data.trainingSummary = snapshot.trainingSummary || null;
            state.data.volume = snapshot.volume || null;
          }
          if (!hasFtp) {
            state.data.ftpModels = snapshot.ftpModels || null;
          }
          if (!hasHr) {
            state.data.hr = snapshot.hr || null;
          }
          const currentPersonal = state.data.personal || {};
          const snapshotPersonal = snapshot.personal || {};
          state.data.personal = { ...snapshotPersonal, ...currentPersonal };
        }
      }
    } catch (e) {
      console.error(
        "OnboardingEngine._ensureStravaMetricsInState error:",
        e
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
      `• משך רכיבה ממוצע: כ-${avgMin} דקות לרכיבה.`,
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

      if (t && !parsed) {
        if (weightFromStrava != null) {
