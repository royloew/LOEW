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
          "האונבורדינג כבר הסתיים ✅\n" +
          "בגרסה הנוכחית אני עדיין מוגבל לשלב ההגדרות הראשוני, אבל בהמשך אשתמש בנתונים שלך כדי להציע אימונים חכמים.",
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
        reply = await this._stageIntro(userId, state);
        break;

      case "post_strava_import":
      case "post_strava_summary":
        reply = await this._stagePostStravaSummary(userId, state);
        break;

      case "personal_details":
        reply = await this._stagePersonalDetails(userId, text, state);
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
        // fallback בטוח – אם משהו לא ברור חוזרים לסיכום מסטרבה או לפתיחה
        state = await this._bootstrapStateFromStrava(userId);
        await this._saveState(userId, state);

        if (state.stage === "post_strava_summary") {
          reply = await this._stagePostStravaSummary(userId, state);
        } else {
          reply = await this._stageIntro(userId, state);
        }
        break;
    }

    return { reply, onboarding: true };
  }

  // ===== טעינה ושמירה של state =====

  async _loadState(userId) {
    if (!this.db || typeof this.db.getOnboardingState !== "function") {
      return { stage: null, data: {} };
    }
    try {
      const st = await this.db.getOnboardingState(userId);
      if (!st) return { stage: null, data: {} };
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

    const data = {
      stravaConnected: !!hasStravaTokens,
      trainingSummary: snapshot ? snapshot.trainingSummary || null : null,
      volume: snapshot ? snapshot.volume || null : null,
      ftpModels: snapshot ? snapshot.ftpModels || null : null,
      hr: snapshot ? snapshot.hr || null : null,
      personal: snapshot && snapshot.personal ? snapshot.personal : {},
      ftpFinal: null,
      hrFinal: null,
      goal: null,
      personalStep: null,
    };

    if (data.personal && data.personal.weightFromStrava != null) {
      data.personal.weightFromStrava = Number(
        data.personal.weightFromStrava.toFixed
          ? data.personal.weightFromStrava.toFixed(1)
          : data.personal.weightFromStrava
      );
    }

    if (data.stravaConnected && data.trainingSummary) {
      return {
        stage: "post_strava_summary",
        data,
      };
    }

    return {
      stage: "intro",
      data,
    };
  }

  // ===== שלב פתיחה למשתמש חדש בלי סטרבה =====

  async _stageIntro(userId, state) {
    const intro =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות ותזונה.\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים ליישום ומתאימים לקצב החיים שלך.\n\n" +
      "כדי להתחיל אני צריך גישה לרכיבות שלך בסטרבה.\n" +
      `תלחץ על הקישור כדי להתחבר: /auth/strava?userId=${encodeURIComponent(
        userId
      )}`;

    state.stage = "intro";
    await this._saveState(userId, state);

    return intro;
  }

  // ===== אחרי שהמשתמש חזר מסטרבה – סיכום נפח ורכיבות =====

  async _ensureStravaMetricsInState(userId, state) {
    if (
      state.data &&
      state.data.trainingSummary &&
      state.data.volume &&
      state.data.ftpModels != null
    ) {
      return state;
    }

    if (
      !this.db ||
      typeof this.db.getStravaOnboardingSnapshot !== "function"
    ) {
      return state;
    }

    try {
      const snap = await this.db.getStravaOnboardingSnapshot(userId);
      if (!snap) return state;

      state.data = state.data || {};
      if (snap.trainingSummary) {
        state.data.trainingSummary = snap.trainingSummary;
      }
      if (snap.volume) {
        state.data.volume = snap.volume;
      }
      if (snap.ftpModels) {
        state.data.ftpModels = snap.ftpModels;
      }
      if (snap.hr) {
        state.data.hr = snap.hr;
      }
      if (snap.personal) {
        state.data.personal = {
          ...(state.data.personal || {}),
          ...snap.personal,
        };
      }
    } catch (err) {
      console.error("_ensureStravaMetricsInState error:", err);
    }

    return state;
  }

  _formatTrainingSummary(ts) {
    if (!ts || !ts.rides_count) {
      return "לא מצאתי מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח.";
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
      `• טיפוס מצטבר: ${elevation.toLocaleString("he-IL")} מטר`,
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

    const lines = [];
    lines.push(summaryText);
    lines.push("עכשיו נעבור לכמה פרטים אישיים בסיסיים.");

    if (weightFromStrava != null) {
      lines.push(
        `מופיע בסטרבה משקל ${weightFromStrava} ק\"ג — לאשר או שאתה מעוניין לעדכן?`
      );
    } else {
      lines.push("מה המשקל שלך בק\"ג? (למשל 71)");
    }

    // נחזיר כטקסט אחד, frontend יפצל לבועות לפי \n\n
    return lines.join("\n\n");
  }

  // ===== שלב פרטים אישיים: משקל → גיל → גובה =====

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

      if (parsed == null && weightFromStrava == null) {
        return 'רק לוודא – מה המשקל שלך בק"ג? (למשל 71)';
      }

      const finalWeight =
        parsed != null
          ? parsed
          : weightFromStrava != null
          ? weightFromStrava
          : null;

      if (finalWeight == null) {
        return 'רק לוודא – מה המשקל שלך בק"ג? (למשל 71)';
      }

      state.data.personal.weightKg = finalWeight;
      state.data.personalStep = "age";
      state.stage = "personal_details";
      await this._saveState(userId, state);

      // לפי בקשה – בלי משפטי "עדכנתי"
      return "בן כמה אתה?";
    }

    // --- גיל ---
    if (step === "age") {
      const age = parseInt(t, 10);
      if (!Number.isFinite(age) || age < 10 || age > 90) {
        return "כדי שאדע לעבוד לפי טווח גיל מתאים – בן כמה אתה?";
      }

      state.data.personal.age = age;
      state.data.personalStep = "height";
      state.stage = "personal_details";
      await this._saveState(userId, state);

      return 'ומה הגובה שלך בס"מ (למשל 178)?';
    }

    // --- גובה ---
    if (step === "height") {
      const h = parseInt(t, 10);
      if (!Number.isFinite(h) || h < 120 || h > 220) {
        return 'ומה הגובה שלך בס"מ? (למשל 178)';
      }

      state.data.personal.heightCm = h;
      state.data.personalStep = null;

      // ממשיכים ל-FTP
      state.stage = "ftp_choice";
      await this._saveState(userId, state);

      return this._buildFtpIntro(state);
    }

    // fallback – אם משום מה אין step
    state.data.personalStep = "weight";
    await this._saveState(userId, state);
    return "נתחיל מהמשקל שלך – מה המשקל שלך בק\"ג?";
  }

  // ===== שלב FTP =====

  _buildFtpIntro(state) {
    const ftpModels = state.data.ftpModels || {};
    const ftp20 =
      ftpModels.ftp20 && typeof ftpModels.ftp20.value === "number"
        ? ftpModels.ftp20.value
        : null;
    const ftpFrom3 =
      ftpModels.ftpFrom3min && typeof ftpModels.ftpFrom3min.value === "number"
        ? ftpModels.ftpFrom3min.value
        : null;
    const ftpFromCP =
      ftpModels.ftpFromCP && typeof ftpModels.ftpFromCP.value === "number"
        ? ftpModels.ftpFromCP.value
        : null;
    const ftpRecommended =
      ftpModels.ftpRecommended &&
      typeof ftpModels.ftpRecommended.value === "number"
        ? ftpModels.ftpRecommended.value
        : ftp20 || ftpFrom3 || ftpFromCP || null;

    const lines = [];
    lines.push(
      "עכשיו נעבור ל-FTP — מדד היכולת האירובית שלך על האופניים.\n" +
        "חישבתי עבורך כמה מודלים שונים של FTP על בסיס הרכיבות שלך:"
    );

    const modelLines = [];
    if (ftp20 != null) {
      modelLines.push(
        `FTP לפי מודל של 20 דקות (הסקה מיכולת 20 דק'): ${ftp20}W`
      );
    }
    if (ftpFrom3 != null) {
      modelLines.push(
        `FTP לפי מודל של 3 דקות (הסקה מיכולת 3 דק'): ${ftpFrom3}W`
      );
    }
    if (ftpFromCP != null) {
      modelLines.push(
        `FTP לפי מודל משולב CP (עקומת כוח 3–20 דק'): ${ftpFromCP}W`
      );
    }

    if (modelLines.length) {
      lines.push(modelLines.join("\n"));
    }

    if (ftpRecommended != null) {
      lines.push(
        `על בסיס כל המודלים, ההמלצה שלי כרגע היא ~${ftpRecommended}W.`
      );
    }

    lines.push("באיזו רמת FTP תרצה להשתמש כרגע? (תכתוב מספר כמו 240)");

    return lines.join("\n");
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
      lines.push("עכשיו נעבור לדופק.");
      if (hrMaxCandidate != null && hrThresholdCandidate != null) {
        lines.push(
          `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ~${hrMaxCandidate} bpm ודופק סף משוער של ~${hrThresholdCandidate} bpm.`
        );
      } else if (hrMaxCandidate != null) {
        lines.push(
          `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ~${hrMaxCandidate} bpm.`
        );
      }

      lines.push(
        "אם זה נראה לך סביר, תכתוב \"אישור\".\n" +
          "אם אתה מעדיף לעדכן, תכתוב את הדופק המקסימלי שלך (למשל 175)."
      );
    } else {
      lines.push(
        "עכשיו נעבור לדופק.\n" +
          "אם אתה יודע את הדופק המקסימלי שלך, תכתוב לי אותו (למשל 175).\n" +
          "אם אתה לא בטוח, תכתוב לי שאתה לא יודע ונמשיך הלאה."
      );
    }

    return lines.join("\n");
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

    const { hrMaxCandidate, hrThresholdCandidate } =
      this._extractHrCandidates(state);

    let hrMax = null;
    let hrThreshold = null;

    if (!t) {
      // אין תשובה – במקרה כזה פשוט מתקדמים בלי דופק
      state.data.hrFinal = null;
      state.stage = "goal_collect";
      await this._saveState(userId, state);
      return "מה המטרה הקרובה שלך? (לדוגמה: גרן פונדו אילת, שיפור FTP, ירידה במשקל)";
    }

    if (/^אישור$|^מאשר$|^כן$|^ok$|^okay$/i.test(t)) {
      hrMax = hrMaxCandidate || null;
      hrThreshold = hrThresholdCandidate || null;
    } else {
      const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
      const num = parseFloat(cleaned);
      if (Number.isFinite(num) && num > 100 && num < 230) {
        hrMax = Math.round(num);
        hrThreshold = Math.round(hrMax * 0.9);
      } else {
        return (
          "כדי שאדע לעבוד עם דופק – תכתוב מספר הגיוני לדופק מקסימלי (למשל 175),\n" +
          'או תכתוב "אישור" אם אתה רוצה להשתמש בערכים שחישבתי מסטרבה.'
        );
      }
    }

    state.data.hrFinal = {
      hrMax: hrMax || null,
      hrThreshold: hrThreshold || null,
    };

    state.stage = "goal_collect";
    await this._saveState(userId, state);

    return "מה המטרה הקרובה שלך? (לדוגמה: גרן פונדו אילת, שיפור FTP, ירידה במשקל)";
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
