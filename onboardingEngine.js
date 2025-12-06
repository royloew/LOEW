// onboardingEngine.js
// מנוע אונבורדינג נקי לפי ה-FLOW שסיכמנו, מותאם ל-dbSqlite.js ול-server.js

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // נקודת כניסה עיקרית לצ'אט
  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();

    // טוען מצב אונבורדינג מה-DB
    let state = await this._loadState(userId);

    // אם האונבורדינג כבר הושלם – לא חוזרים לפתיחה
    if (state && state.stage === "done") {
      return {
        reply:
          "האונבורדינג כבר הושלם. אם תרצה לעדכן נתונים (משקל, FTP, דופק, מטרה וכו׳) תכתוב לי מה תרצה לשנות.",
        onboarding: false,
      };
    }

    // אם אין state בכלל – מנסים לבנות אחד מצילום מצב מסטרבה
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

      case "goal_collect":
        reply = await this._stageGoalCollect(userId, text, state);
        break;

      default:
        // fallback בטוח – אם משהו לא ברור חוזרים לפתיחה/סטרבה
        state = await this._bootstrapStateFromStrava(userId);
        await this._saveState(userId, state);
        reply =
          "משהו לא היה ברור בתהליך האונבורדינג. נתחיל שוב מסיכום הנתונים מסטרבה ונמשיך משם.";
        break;
    }

    return { reply, onboarding: true };
  }

  // ===== עזרי DB פנימיים =====

  async _loadState(userId) {
    if (!this.db || typeof this.db.getOnboardingState !== "function") {
      return { stage: null, data: {} };
    }
    try {
      const st = await this.db.getOnboardingState(userId);
      if (!st || !st.stage) {
        return { stage: null, data: {} };
      }
      return {
        stage: st.stage || null,
        data: st.data || {},
      };
    } catch (err) {
      console.error("OnboardingEngine._loadState error:", err);
      return { stage: null, data: {} };
    }
  }

  async _saveState(userId, state) {
    if (!this.db || typeof this.db.saveOnboardingState !== "function") {
      return;
    }
    try {
      await this.db.saveOnboardingState(userId, {
        stage: state.stage || null,
        data: state.data || {},
      });
    } catch (err) {
      console.error("OnboardingEngine._saveState error:", err);
    }
  }

  // ===== Bootstrap ראשוני ממצב סטרבה =====

  async _bootstrapStateFromStrava(userId) {
    let hasStravaTokens = false;
    let snapshot = null;

    try {
      if (this.db && typeof this.db.getStravaTokens === "function") {
        const tokens = await this.db.getStravaTokens(userId);
        hasStravaTokens = !!(tokens && tokens.accessToken);
      }

      if (
        hasStravaTokens &&
        this.db &&
        typeof this.db.getStravaOnboardingSnapshot === "function"
      ) {
        snapshot = await this.db.getStravaOnboardingSnapshot(userId);
      }
    } catch (err) {
      console.error("OnboardingEngine._bootstrapStateFromStrava error:", err);
    }

    // אין חיבור לסטרבה – נתחיל מ-intro
    if (!hasStravaTokens) {
      return {
        stage: "intro",
        data: {
          stravaConnected: false,
          trainingSummary: null,
          volume: null,
          ftpModels: null,
          hr: null,
          personal: {},
        },
      };
    }

    // יש חיבור לסטרבה – משתמשים ב-snapshot אם קיים
    const data = {
      stravaConnected: true,
      trainingSummary: snapshot ? snapshot.trainingSummary || null : null,
      volume: snapshot ? snapshot.volume || null : null,
      ftpModels: snapshot ? snapshot.ftpModels || null : null,
      hr: snapshot ? snapshot.hr || null : null,
      personal: snapshot && snapshot.personal ? snapshot.personal : {},
    };

    return {
      stage: "post_strava_summary",
      data,
    };
  }

  async _ensureStravaMetricsInState(userId, state) {
    state.data = state.data || {};

    const hasSummary =
      state.data.trainingSummary &&
      state.data.trainingSummary.rides_count != null;
    const hasFtp = state.data.ftpModels != null;
    const hasHr = state.data.hr != null;

    if (hasSummary && hasFtp && hasHr) {
      return state;
    }

    try {
      if (this.db && typeof this.db.getStravaOnboardingSnapshot === "function") {
        const snapshot = await this.db.getStravaOnboardingSnapshot(userId);
        if (snapshot) {
          if (!hasSummary) {
            state.data.trainingSummary = snapshot.trainingSummary || null;
            state.data.volume = snapshot.volume || null;
          }
          if (!hasFtp) {
            state.data.ftpModels = snapshot.ftpModels || null;
          }
          if (!hasHr) {
            state.data.hr = snapshot.hr || null;
          }
          if (!state.data.personal) {
            state.data.personal = snapshot.personal || {};
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

  // ===== שלב פתיחה =====

  async _stageIntro(userId, text, state) {
    const introText =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים ליישום, שמתקדמים בקצב שמתאים בדיוק לך.\n\n" +
      "נתחיל מחיבור לסטרבה כדי שאוכל לראות את הרכיבות האחרונות שלך.";

    // בודקים אם יש טוקנים של סטרבה
    let hasStravaTokens = false;
    try {
      if (this.db && typeof this.db.getStravaTokens === "function") {
        const tokens = await this.db.getStravaTokens(userId);
        hasStravaTokens = !!(tokens && tokens.accessToken);
      }
    } catch (err) {
      console.error("OnboardingEngine._stageIntro getStravaTokens error:", err);
    }

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

    // אם כבר יש טוקנים – נביא סיכום מסטרבה ונמשיך ישר לנתונים האישיים
    state = await this._bootstrapStateFromStrava(userId);
    await this._saveState(userId, state);
    return await this._stagePostStravaSummary(userId, state);
  }

  // ===== שלב סיכום מסטרבה =====

  _formatTrainingSummary(ts) {
    if (!ts || !ts.rides_count) {
      return "לא מצאתי מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח.";
    }

    const rides = ts.rides_count;
    const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
    const kmStr = ts.totalDistanceKm.toLocaleString("he-IL", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const elevationStr = Math.round(
      ts.totalElevationGainM
    ).toLocaleString("he-IL");
    const avgMin = Math.round(ts.avgDurationSec / 60);

    return [
      "בדקתי את הרכיבות שלך מהתקופה האחרונה:",
      `• מספר רכיבות: ${rides}`,
      `• זמן רכיבה מצטבר: ${hours} שעות`,
      `• מרחק מצטבר: ${kmStr} ק״מ`,
      `• טיפוס מצטבר: ${elevationStr} מטר`,
      `• משך רכיבה ממוצע: כ-${avgMin} דקות לרכיבה.`,
    ].join("\n");
  }

  _formatStravaSummaryAndNext(state) {
    const ts = state.data && state.data.trainingSummary;
    const summaryText = this._formatTrainingSummary(ts);
    return (
      summaryText +
      "\n\n" +
      "עכשיו אני רוצה להשלים כמה פרטים בסיסיים עליך (משקל, גובה, גיל), ואז נעבור ל-FTP ולדופק."
    );
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
      "עכשיו שיש לנו סטרבה אני צריך להשלים עוד כמה נתונים בסיסים " +
      "\n\n" +
      weightLine
    );
  }

  // ===== שלב נתונים אישיים =====

  async _stagePersonalDetails(userId, text, state) {
    state.data.personal = state.data.personal || {};
    let step = state.data.personalStep || "weight";
    const t = (text || "").trim();

    // --- משקל ---
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
        personal.weightKg = weightFromStrava;
      } else if (parsed != null) {
        personal.weightKg = parsed;
      } else {
        return 'כדי שאוכל לעבוד עם אזורי מאמץ נכונים – תכתוב משקל בק"ג (למשל 71).';
      }

      state.data.personal = personal;
      state.data.personalStep = "height";
      await this._saveState(userId, state);

      return "מה הגובה שלך בסנטימטרים?";
    }

    // --- גובה ---
    if (step === "height") {
      const personal = state.data.personal;

      let parsed = null;
      if (t) {
        const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
        const num = parseFloat(cleaned);
        if (Number.isFinite(num) && num > 120 && num < 230) {
          parsed = Math.round(num);
        }
      }

      if (parsed != null) {
        personal.heightCm = parsed;
      } else {
        return 'כדי שאוכל לדייק את החישובים – תכתוב גובה בס"מ (למשל 178).';
      }

      state.data.personal = personal;
      state.data.personalStep = "age";
      await this._saveState(userId, state);

      return "בן כמה אתה?";
    }

    // --- גיל ---
    if (step === "age") {
      const age = parseInt(t, 10);
      if (!Number.isFinite(age) || age < 10 || age > 90) {
        return "כדי שאדע לעבוד לפי טווח גיל מתאים – בן כמה אתה?";
      }

      state.data.personal.age = age;
      state.data.personalStep = "done";
      state.stage = "ftp_intro";
      await this._saveState(userId, state);

      // לא מחזירים כאן טקסט – עוברים ישירות ל-FTP intro
      return await this._stageFtpIntro(userId, state);
    }

    // fallback – אם משום מה הגענו לפה בלי צעד ברור
    state.data.personalStep = "weight";
    await this._saveState(userId, state);
    return 'נתחיל ממשקל — כמה אתה שוקל בק"ג?';
  }

  // ===== שלב FTP =====

  _formatFtpModels(ftpModels) {
    if (!ftpModels) {
      return "לא הצלחתי לחשב מודלים ל-FTP מהנתונים הקיימים.";
    }

    const lines = ["בדקתי את הרכיבות שלך ובניתי כמה מודלים ל-FTP:"];

    if (ftpModels.ftp20 && ftpModels.ftp20.value != null) {
      lines.push(
        `• ${ftpModels.ftp20.label}: ${ftpModels.ftp20.value} W (מבוסס על 20 דקות חזקות)`
      );
    }
    if (ftpModels.ftpFrom3min && ftpModels.ftpFrom3min.value != null) {
      lines.push(
        `• ${ftpModels.ftpFrom3min.label}: ${ftpModels.ftpFrom3min.value} W (מודל שמתבסס על 3 דקות חזקות)`
      );
    }
    if (ftpModels.ftpFromCP && ftpModels.ftpFromCP.value != null) {
      lines.push(
        `• ${ftpModels.ftpFromCP.label}: ${ftpModels.ftpFromCP.value} W (Critical Power מחושב ממספר חלונות זמן)`
      );
    }
    if (ftpModels.ftpRecommended && ftpModels.ftpRecommended.value != null) {
      lines.push(
        `• ${ftpModels.ftpRecommended.label}: ${ftpModels.ftpRecommended.value} W (חציון בין המודלים הסבירים)`
      );
    }

    return lines.join("\n");
  }

  async _stageFtpIntro(userId, state) {
    state = await this._ensureStravaMetricsInState(userId, state);

    const ftpModels = state.data.ftpModels || null;
    const summary = this._formatFtpModels(ftpModels);

    state.stage = "ftp_choice";
    await this._saveState(userId, state);

    let recommendedStr = "";
    if (ftpModels && ftpModels.ftpRecommended && ftpModels.ftpRecommended.value) {
      recommendedStr = `לפי החישובים שלי, ה-FTP המומלץ עבורך כרגע הוא ${ftpModels.ftpRecommended.value} W.`;
    } else {
      recommendedStr = "לא הצלחתי לגזור ערך FTP מומלץ חד-משמעי מהנתונים.";
    }

    return (
      summary +
      "\n\n" +
      recommendedStr +
      "\n\n" +
      "אם ה-FTP שאתה משתמש בו היום דומה למה שאני מציע, תכתוב לי את הערך שאתה רוצה שנעבוד איתו (למשל 240)."
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

    // שומרים גם ב-ftpModels כערך נבחר
    state.data.ftpModels = state.data.ftpModels || {};
    state.data.ftpModels.ftpUserSelected = {
      key: "ftpUserSelected",
      value: ftpFinal,
      label: "FTP chosen by user",
    };

    // מתחילים שלב דופק – קודם דופק מקסימלי
    state.stage = "hr_collect";
    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);

    const { hrMaxCandidate } = this._extractHrCandidates(state);
    const bubbles = [];

    if (hrMaxCandidate != null) {
      bubbles.push(
        `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ${hrMaxCandidate} bpm.`
      );
      bubbles.push(
        'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק המקסימלי שלך (למשל 175).'
      );
    } else {
      bubbles.push(
        "אם אתה יודע את הדופק המקסימלי שלך, תכתוב לי אותו (למשל 175)."
      );
      bubbles.push(
        'אם אתה לא בטוח, תכתוב לי שאתה לא יודע ונמשיך הלאה.'
      );
    }

    return bubbles.join("\n\n");
  }

  _extractHrCandidates(state) {
    const hr = (state.data && state.data.hr) || {};
    let hrMaxCandidate = null;
    let hrThresholdCandidate = null;

    if (typeof hr.hrMax === "number") {
      hrMaxCandidate = Math.round(hr.hrMax);
    }

    if (typeof hr.hrThreshold === "number") {
      hrThresholdCandidate = Math.round(hr.hrThreshold);
    } else if (hrMaxCandidate != null) {
      hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);
    }

    return { hrMaxCandidate, hrThresholdCandidate };
  }

  // ===== שלב דופק =====

  async _stageHrCollect(userId, text, state) {
    const t = (text || "").trim();
    state.data = state.data || {};

    // hrStep אומר לנו באיזה תת-שלב אנחנו: דופק מקס או דופק סף
    const step = state.data.hrStep || "hrMax";

    const { hrMaxCandidate, hrThresholdCandidate } =
      this._extractHrCandidates(state);

    // --- שלב 1: דופק מקסימלי ---
    if (step === "hrMax") {
      // המשתמש מאשר את הערך מהחישוב
      if (
        t === "אישור" ||
        t.toLowerCase() === "ok" ||
        t.toLowerCase() === "okay"
      ) {
        if (hrMaxCandidate != null) {
          state.data.hrMaxFinal = hrMaxCandidate;
          state.data.hrStep = "hrThreshold";
          await this._saveState(userId, state);

          const thr =
            hrThresholdCandidate != null
              ? hrThresholdCandidate
              : Math.round(hrMaxCandidate * 0.9);

          return [
            "מצוין, נמשיך לדופק סף.",
            `הדופק סף המשוער שלי הוא ${thr} bpm.`,
            'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק סף שלך (למשל 160).',
          ].join("\n\n");
        }

        // אין מועמד הגיוני – מבקשים מהמשתמש ערך מספרי
        return (
          "כדי שאוכל לעבוד עם אזורי דופק מדויקים – תכתוב את הדופק המקסימלי שלך (בין 100 ל-230 bpm, למשל 175)."
        );
      }

      // המשתמש ניסה לתת ערך ידני (דופק מקסימלי)
      const num = parseInt(t.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(num) && num >= 100 && num <= 230) {
        state.data.hrMaxFinal = num;
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        const thr = Math.round(num * 0.9);

        return [
          `הדופק סף המשוער שלי הוא ${thr} bpm.`,
          'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב את הדופק סף שלך (למשל 160).',
        ].join("\n\n");
      }

      // תשובה לא תקינה – מסבירים שוב
      if (hrMaxCandidate != null) {
        return [
          `כדי שאוכל לעבוד עם אזורי דופק מדויקים – תכתוב את הדופק המקסימלי שלך (בין 100 ל-230 bpm, למשל 175).`,
          `לפי הנתונים מסטרבה אני רואה כרגע דופק מקסימלי משוער של ${hrMaxCandidate} bpm.`,
        ].join("\n\n");
      } else {
        return (
          "כדי שאוכל לעבוד עם אזורי דופק מדויקים – תכתוב את הדופק המקסימלי שלך (בין 100 ל-230 bpm, למשל 175)."
        );
      }
    }

    // --- שלב 2: דופק סף ---
    if (step === "hrThreshold") {
      // המשתמש מאשר את הערך מהחישוב
      if (
        t === "אישור" ||
        t.toLowerCase() === "ok" ||
        t.toLowerCase() === "okay"
      ) {
        const maxFinal = state.data.hrMaxFinal || hrMaxCandidate || null;
        const thr =
          hrThresholdCandidate != null
            ? hrThresholdCandidate
            : maxFinal != null
            ? Math.round(maxFinal * 0.9)
            : null;

        if (thr != null) {
          state.data.hrThresholdFinal = thr;
        }

        state.data.hrStep = "done";
        state.stage = "goal_collect";
        await this._saveState(userId, state);

        return [
          "מצוין, יש לנו דופק מקס ודופק סף.",
          "מה המטרה המרכזית שלך לתקופה הקרובה?",
        ].join("\n\n");
      }

      // המשתמש נותן ערך ידני לדופק סף
      const num = parseInt(t.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(num) && num >= 90 && num <= 220) {
        state.data.hrThresholdFinal = num;
        state.data.hrStep = "done";
        state.stage = "goal_collect";
        await this._saveState(userId, state);

        return "מה המטרה המרכזית שלך לתקופה הקרובה?";
      }

      // תשובה לא תקינה – מסבירים שוב
      const maxFinal = state.data.hrMaxFinal || hrMaxCandidate || null;
      const thr =
        hrThresholdCandidate != null
          ? hrThresholdCandidate
          : maxFinal != null
          ? Math.round(maxFinal * 0.9)
          : null;

      if (thr != null) {
        return [
          `הדופק סף המשוער שלי הוא ${thr} bpm.`,
          'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן, תכתוב מספר אחר.',
        ].join("\n\n");
      }

      return (
        "כדי שאוכל לעבוד עם דופק סף מדויק – תכתוב את הדופק סף שלך (אם אתה יודע). אם לא, אפשר לכתוב שאתה לא יודע ונמשיך הלאה."
      );
    }

    // fallback – אם משום מה hrStep לא מוגדר, נחזור להתחלה של דופק מקס
    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);
    return await this._stageHrCollect(userId, text, state);
  }

  // ===== שלב מטרה =====

  async _stageGoalCollect(userId, text, state) {
    const t = (text || "").trim();
    if (!t) {
      return "כדי שאוכל לתכנן עבורך אימונים – תכתוב מטרה אחת ברורה (למשל: גרן פונדו אילת או שיפור FTP).";
    }

    state.data.goal = t;
    state.stage = "done";
    await this._saveState(userId, state);

    return "סיימנו את האונבורדינג 🎉\n\nמכאן נמשיך לבנות עבורך אימונים חכמים ומותאמים אישית.";
  }
}
