// onboardingEngine.js
// מנוע אונבורדינג לפי ה-FLOW שסיכמנו, מותאם ל-dbSqlite.js ול-server.js

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // נקודת כניסה עיקרית
  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();

    // טוען מצב אונבורדינג מה-DB
    let state = await this._loadState(userId);

    // אם האונבורדינג כבר הושלם – לא חוזרים לפתיחה
    if (state && state.stage === "done") {
      return {
        reply:
          "האונבורדינג כבר הושלם. אם תרצה לעדכן נתונים (משקל, FTP, דופק וכו׳) תכתוב לי מה תרצה לשנות.",
        onboarding: false,
      };
    }

    // אם אין state בכלל או שאין בו stage – מנסים לבנות אחד מצילום מצב מסטרבה
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
        // fallback בטוח – אם משהו לא ברור חוזרים לפתיחה
        state = await this._bootstrapStateFromStrava(userId);
        await this._saveState(userId, state);

        reply =
          "משהו לא היה ברור בתהליך האונבורדינג. נתחיל שוב מסיכום הנתונים מסטרבה ונמשיך משם.";
        break;
    }

    return { reply, onboarding: true };
  }

  // ===== שלב פתיחה =====

  async _stageIntro(userId, text, state) {
    // הסבר קבוע על LOEW
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

    // אם כבר יש טוקנים – מדלגים ישירות לסיכום מסטרבה
    state = await this._bootstrapStateFromStrava(userId);
    await this._saveState(userId, state);

    return this._formatStravaSummaryAndNext(state);
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
    const elevation = Math.round(
      ts.totalElevationGainM
    ).toLocaleString("he-IL");
    const avgMin = Math.round(ts.avgDurationSec / 60);

    return [
      "בדקתי את הרכיבות שלך מהתקופה האחרונה:",
      `• מספר רכיבות: ${rides}`,
      `• זמן רכיבה מצטבר: ${hours} שעות`,
      `• מרחק מצטבר: ${kmStr} ק״מ`,
      `• טיפוס מצטבר: ${elevation} מטר`,
      `• משך רכיבה ממוצע: כ-${avgMin} דקות לרכיבה.`,
    ].join("\n");
  }

  _formatStravaSummaryAndNext(state) {
    const ts = state.data && state.data.trainingSummary;
    const summaryText = this._formatTrainingSummary(ts);

    return (
      summaryText +
      "\n\n" +
      "עכשיו אני רוצה להשלים כמה פרטים בסיסיים עליך (משקל, גיל ועוד), ואז נעבור ל-FTP ולדופק."
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

    return summaryText + "\n\n" + weightLine;
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
        // המשתמש לא כתב כלום – מאשרים את הנתון מסטרבה
        personal.weightKg = weightFromStrava;
      } else if (parsed != null) {
        personal.weightKg = parsed;
      } else {
        return 'כדי שאוכל לעבוד עם אזורי מאמץ נכונים – תכתוב משקל בק"ג (למשל 71).';
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

      return (
        "מעולה, יש לי את הנתונים הבסיסיים.\n\n" +
        "עכשיו נעבור ל-FTP — הסמן המרכזי לעומס ולרמת הקושי באימונים."
      );
    }

    // fallback – אם משום מה הגענו לפה בלי צעד ברור
    state.data.personalStep = "weight";
    await this._saveState(userId, state);
    return 'נתחיל ממשקל — כמה אתה שוקל בק"ג?';
  }

  // ===== שלב FTP =====

  _formatFtpModels(ftpModels) {
    if (!ftpModels) return "לא הצלחתי לחשב מודלים ל-FTP מהנתונים הקיימים.";

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
      recommendedStr = `לפי החישובים שלי, ה-FTP המומלץ עבורך כרגע הוא כ-${ftpModels.ftpRecommended.value} W.`;
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

    // עוברים לדופק
    state.stage = "hr_collect";
    await this._saveState(userId, state);

    const { hrMaxCandidate, hrThresholdCandidate } =
      this._extractHrCandidates(state);

    const lines = [];
    if (hrMaxCandidate != null || hrThresholdCandidate != null) {
      // בועה ראשונה – מעבר לדופק + הערכים מסטרבה
      const firstBubble = [];
      firstBubble.push("עכשיו נעבור לדופק.");
      if (hrMaxCandidate != null && hrThresholdCandidate != null) {
        firstBubble.push(
          `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ~${hrMaxCandidate} bpm ודופק סף משוער של ~${hrThresholdCandidate} bpm.`
        );
      } else if (hrMaxCandidate != null) {
        firstBubble.push(
          `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ~${hrMaxCandidate} bpm.`
        );
      }

      // זו תהיה בועה 1
      lines.push(firstBubble.join("\n"));

      // בועה שנייה – הוראות למשתמש
      lines.push(
        'אם זה נראה לך סביר, תכתוב "אישור".\n' +
          "אם אתה מעדיף לעדכן, תכתוב את הדופק המקסימלי שלך (למשל 175)."
      );

      return lines.join("\n\n");
    } else {
      lines.push(
        "עכשיו נעבור לדופק.\n" +
          "אם אתה יודע את הדופק המקסימלי שלך, תכתוב לי אותו (למשל 175).\n" +
          'אם אתה לא בטוח, תכתוב לי שאתה לא יודע ונמשיך הלאה.'
      );

      return lines.join("\n");
    }
  }

  _extractHrCandidates(state) {
    const hr = (state.data && state.data.hr) || {};
    let hrMaxCandidate = null;
    let hrThresholdCandidate = null;

    if (typeof hr.hrMaxTop3 === "number") {
      hrMaxCandidate = Math.round(hr.hrMaxTop3);
    } else if (typeof hr.hrMax === "number") {
      hrMaxCandidate = Math.round(hr.hrMax);
    }

    if (typeof hr.hrThresholdRecommended === "number") {
      hrThresholdCandidate = Math.round(hr.hrThresholdRecommended);
    } else if (typeof hr.hrThreshold === "number") {
      hrThresholdCandidate = Math.round(hr.hrThreshold);
    } else if (hrMaxCandidate != null) {
      hrThresholdCandidate = Math.round(hrMaxCandidate * 0.9);
    }

    return { hrMaxCandidate, hrThresholdCandidate };
  }

  // ===== שלב דופק =====

  async _stageHrCollect(userId, text, state) {
    const t = (text || "").trim();

    // אם המשתמש כותב "אישור" – מאשרים את הערכים מהחישוב
    if (t === "אישור" || t.toLowerCase() === "ok") {
      const { hrMaxCandidate, hrThresholdCandidate } =
        this._extractHrCandidates(state);

      if (hrMaxCandidate != null) {
        state.data.hrMaxFinal = hrMaxCandidate;
      }
      if (hrThresholdCandidate != null) {
        state.data.hrThresholdFinal = hrThresholdCandidate;
      }

      state.stage = "goal_collect";
      await this._saveState(userId, state);

      return (
        "מצוין, נשתמש בערכים האלו כבסיס לאזורים שלך.\n\n" +
        "לסיום האונבורדינג, תכתוב לי מה המטרה המרכזית שלך לתקופה הקרובה (למשל: גרן פונדו אילת, מרתון, שיפור FTP, חזרה לכושר אחרי פציעה וכדומה)."
      );
    }

    // אחרת – מנסים לפרש דופק מקסימלי
    const cleaned = t.replace(/[^\d]/g, "");
    const num = parseInt(cleaned, 10);
    if (!Number.isFinite(num) || num < 100 || num > 230) {
      return (
        "כדי שאוכל לעבוד עם אזורי דופק מדויקים – תכתוב את הדופק המקסימלי שלך (בין 100 ל-230 bpm, למשל 175).\n" +
        'אם אתה לא יודע, אפשר לכתוב "לא יודע" ונמשיך הלאה.'
      );
    }

    state.data.hrMaxFinal = num;
    state.data.hrThresholdFinal = Math.round(num * 0.9);

    state.stage = "goal_collect";
    await this._saveState(userId, state);

    return (
      `מעולה, נשתמש בדופק מקסימלי ${num} bpm ובדופק סף משוער של כ-${Math.round(
        num * 0.9
      )} bpm.\n\n` +
      "לסיום האונבורדינג, תכתוב לי מה המטרה המרכזית שלך לתקופה הקרובה."
    );
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
        stage: st.stage,
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

    // אם אין חיבור לסטרבה – מתחילים מ-intro רגיל
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

    // אם יש חיבור לסטרבה – נבנה state עם הנתונים שקיימים
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
          state.data.trainingSummary =
            snapshot.trainingSummary || state.data.trainingSummary || null;
          state.data.volume = snapshot.volume || state.data.volume || null;
          state.data.ftpModels =
            snapshot.ftpModels || state.data.ftpModels || null;
          state.data.hr = snapshot.hr || state.data.hr || null;
          state.data.personal =
            snapshot.personal ||
            state.data.personal ||
            state.data.personal ||
            {};
        }
      }
    } catch (err) {
      console.error("OnboardingEngine._ensureStravaMetricsInState error:", err);
    }

    return state;
  }
}
