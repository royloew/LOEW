// onboardingEngine.js
// גרסה פשוטה ונקייה של מנוע האונבורדינג, מותאמת ל-dbSqlite.js ול-server.js הקיימים.

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // ---------- עזרי DB: טעינת / שמירת מצב ----------

  async _loadState(userId) {
    try {
      if (!this.db || typeof this.db.getOnboardingState !== "function") {
        return null;
      }
      const row = await this.db.getOnboardingState(userId);
      if (!row) return null;

      return {
        stage: row.stage || null,
        data: row.data || {},
      };
    } catch (err) {
      console.error("loadState error:", err);
      return null;
    }
  }

  async _saveState(userId, state) {
    try {
      if (!this.db || typeof this.db.saveOnboardingState !== "function") {
        return;
      }
      await this.db.saveOnboardingState(userId, state);
    } catch (err) {
      console.error("saveState error:", err);
    }
  }

  // ---------- אימפורט נתוני סטרבה ל-state ----------

  _applyStravaSnapshotToState(state, snap) {
    const d = state.data || (state.data = {});

    if (snap.trainingSummary) d.trainingSummary = snap.trainingSummary;
    if (snap.volume) d.volume = snap.volume;

    if (snap.ftpModels) {
      const m = snap.ftpModels;
      const ftp = d.ftp || (d.ftp = {});
      ftp.ftp20 = m.ftp20 && m.ftp20.value != null ? m.ftp20.value : null;
      ftp.ftpFrom3min =
        m.ftpFrom3min && m.ftpFrom3min.value != null ? m.ftpFrom3min.value : null;
      ftp.ftpFromCP =
        m.ftpFromCP && m.ftpFromCP.value != null ? m.ftpFromCP.value : null;
      ftp.ftpRecommended =
        m.ftpRecommended && m.ftpRecommended.value != null
          ? m.ftpRecommended.value
          : null;
    }

    if (snap.hr) {
      const hr = d.hr || (d.hr = {});
      if (snap.hr.hrMax != null) hr.hrMax = snap.hr.hrMax;
      if (snap.hr.hrThreshold != null) hr.hrThreshold = snap.hr.hrThreshold;
    }

    if (snap.personal && snap.personal.weightFromStrava != null) {
      const personal = d.personal || (d.personal = {});
      if (personal.weightKg == null) {
        personal.weightFromStrava = Math.round(snap.personal.weightFromStrava);
      }
    }
  }

  async _ensureStravaMetrics(userId, state) {
    try {
      if (!this.db || typeof this.db.getStravaOnboardingSnapshot !== "function") {
        return state;
      }
      const snap = await this.db.getStravaOnboardingSnapshot(userId);
      if (!snap) return state;
      this._applyStravaSnapshotToState(state, snap);
      return state;
    } catch (err) {
      console.error("_ensureStravaMetrics error:", err);
      return state;
    }
  }

  // ---------- נקודת כניסה ראשית ----------

  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();
    let state = await this._loadState(userId);

    const baseData = {
      personal: {},
      ftp: null,
      ftpFinal: null,
      hr: null,
      goal: null,
      volume: null,
      trainingSummary: null,
      stravaConnected: false,
    };

    if (!state || !state.stage) {
      let hasStravaTokens = false;
      try {
        if (this.db && typeof this.db.getStravaTokens === "function") {
          const tokens = await this.db.getStravaTokens(userId);
          hasStravaTokens = !!tokens;
        }
      } catch (err) {
        console.error("getStravaTokens error:", err);
      }

      if (hasStravaTokens) {
        state = {
          stage: "post_strava_summary",
          data: { ...baseData, stravaConnected: true },
        };
        await this._ensureStravaMetrics(userId, state);
      } else {
        state = {
          stage: "intro",
          data: baseData,
        };
      }
      await this._saveState(userId, state);
    }

    if (state.stage === "done") {
      return {
        reply:
          "האונבורדינג כבר הושלם. אתה יכול לשאול אותי כל דבר על האימונים שלך 🙂",
        onboarding: false,
      };
    }

    const result = await this._runStage(userId, state, text);
    await this._saveState(userId, state);
    return result;
  }

  // ---------- router פנימי ----------

  async _runStage(userId, state, text) {
    switch (state.stage) {
      case "intro":
        return this._stageIntro(userId, state);
      case "post_strava_summary":
        return await this._stagePostStravaSummary(userId, state);
      case "personal_details":
      case "personal_details_collect":
        return this._stagePersonalDetails(state, text);
      case "ftp_intro":
      case "ftp_collect":
        return this._stageFtp(state, text);
      case "hr_intro":
      case "hr_collect":
        return this._stageHr(state, text);
      case "goal_intro":
      case "goal_collect":
        return this._stageGoal(state, text);
      default:
        state.stage = "intro";
        return this._stageIntro(userId, state);
    }
  }

  // ---------- INTRO / חיבור סטרבה ----------

  _stageIntro(userId, state) {
    const authLink = `/auth/strava?userId=${encodeURIComponent(userId)}`;

    const msg =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, מדויקים וברי ביצוע, שיתפסו מקום נכון בחיים ויקדמו אותך לאורך זמן.\n\n" +
      "כדי להתחיל אני צריך גישה לרכיבות שלך בסטרבה.\n" +
      `תלחץ על הקישור כדי להתחבר: ${authLink}`;

    return {
      reply: msg,
      onboarding: true,
    };
  }

  // ---------- סיכום סטרבה אחרי חיבור ----------

  async _stagePostStravaSummary(userId, state) {
    await this._ensureStravaMetrics(userId, state);

    const ts = state.data.trainingSummary;
    const msgs = [];

    if (ts && ts.rides_count > 0) {
      const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
      const km = ts.totalDistanceKm.toFixed(1);
      const elevation = Math.round(ts.totalElevationGainM);
      const avgMin = Math.round(ts.avgDurationSec / 60);

      msgs.push(
        `בדקתי את הרכיבות שלך מהתקופה האחרונה — מצאתי ${ts.rides_count} רכיבות, ` +
          `${hours} שעות, ${km} ק״מ, ${elevation} מטר טיפוס, ממוצע של כ-${avgMin} דק׳ לרכיבה.`
      );
    } else {
      msgs.push(
        "חיברנו סטרבה, אבל לא מצאתי מספיק רכיבות כדי להציג סיכום מלא."
      );
    }

    msgs.push("עכשיו נעבור לכמה פרטים אישיים בסיסיים.");

    const personal = state.data.personal || (state.data.personal = {});
    const nextQ = this._nextPersonalQuestion(state);
    if (nextQ) {
      personal.pendingField = nextQ.field;
      msgs.push(nextQ.message);
      state.stage = "personal_details_collect";
    } else {
      state.stage = "ftp_intro";
    }

    return {
      reply: msgs.join("\n\n"),
      onboarding: true,
    };
  }

  // ---------- נתונים אישיים ----------

  _stagePersonalDetails(state, userInput) {
    const personal = state.data.personal || (state.data.personal = {});
    const txt = (userInput || "").trim();
    const msgs = [];

    if (personal.pendingField) {
      const field = personal.pendingField;

      if (!txt) {
        msgs.push("אני צריך תשובה קצרה כדי שאוכל לעדכן את הנתון.");
        return { reply: msgs.join("\n\n"), onboarding: true };
      }

      if (field === "weightFromStrava") {
        const lower = txt.toLowerCase();
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
            msgs.push(
              "לא בטוח שהבנתי את המשקל. תכתוב מספר בקילו (למשל 67)."
            );
            return { reply: msgs.join("\n\n"), onboarding: true };
          }
          personal.weightKg = Math.round(num);
          personal.weightConfirmed = true;
          delete personal.pendingField;
        }
      } else {
        const num = parseFloat(txt.replace(",", "."));
        if (field === "age") {
          if (isNaN(num) || num < 10 || num > 90) {
            msgs.push(
              "לא בטוח שהבנתי את הגיל. תכתוב מספר סביר (למשל 46)."
            );
            return { reply: msgs.join("\n\n"), onboarding: true };
          }
          personal.age = Math.round(num);
        } else if (field === "weightKg") {
          if (isNaN(num) || num < 30 || num > 150) {
            msgs.push(
              "לא בטוח שהבנתי את המשקל. תכתוב מספר בקילו (למשל 67)."
            );
            return { reply: msgs.join("\n\n"), onboarding: true };
          }
          personal.weightKg = Math.round(num);
        } else if (field === "heightCm") {
          if (isNaN(num) || num < 120 || num > 220) {
            msgs.push(
              'לא בטוח שהבנתי את הגובה. תכתוב מספר בס"מ (למשל 178).'
            );
            return { reply: msgs.join("\n\n"), onboarding: true };
          }
          personal.heightCm = Math.round(num);
        }

        delete personal.pendingField;
      }
    }

    const nextQ = this._nextPersonalQuestion(state);
    if (nextQ) {
      personal.pendingField = nextQ.field;
      msgs.push(nextQ.message);
      state.stage = "personal_details_collect";
      return { reply: msgs.join("\n\n"), onboarding: true };
    }

    state.stage = "ftp_intro";
    return this._stageFtp(state, "");
  }

  _nextPersonalQuestion(state) {
    const p = state.data.personal || {};

    if (
      p.weightFromStrava != null &&
      !p.weightConfirmed &&
      p.weightKg == null
    ) {
      return {
        field: "weightFromStrava",
        message: `מופיע בסטרבה משקל ${p.weightFromStrava} ק"ג — לאשר או שאתה מעוניין לעדכן?`,
      };
    }

    if (p.age == null) {
      return { field: "age", message: "נתחיל בגיל — בן כמה אתה?" };
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
        message: 'ומה הגובה שלך בס"מ (למשל 178)?',
      };
    }

    return null;
  }

  // ---------- FTP ----------

  _stageFtp(state, userInput) {
    const ftp = state.data.ftp || (state.data.ftp = {});
    const txt = (userInput || "").trim();

    if (state.stage === "ftp_intro") {
      const lines = [];

      if (ftp.ftp20 != null) {
        lines.push(
          `FTP לפי מודל של 20 דקות (הסקה מיכולת 20 דק'): ${ftp.ftp20}W`
        );
      }
      if (ftp.ftpFrom3min != null) {
        lines.push(
          `FTP לפי מודל של 3 דקות (הסקה מיכולת 3 דק'): ${ftp.ftpFrom3min}W`
        );
      }
      if (ftp.ftpFromCP != null) {
        lines.push(
          `FTP לפי מודל משולב CP (עקומת כוח 3–20 דק'): ${ftp.ftpFromCP}W`
        );
      }
      if (ftp.ftpRecommended != null) {
        lines.push(
          `על בסיס כל המודלים, ההמלצה שלי כרגע היא ${ftp.ftpRecommended}W.`
        );
      }

      const msg =
        lines.join("\n") +
        "\n\nבאיזו רמת FTP תרצה להשתמש כרגע? (תכתוב מספר כמו 240)";
      state.stage = "ftp_collect";
      return { reply: msg, onboarding: true };
    }

    const num = parseFloat(txt.replace(",", "."));
    if (isNaN(num) || num < 100 || num > 450) {
      return {
        reply: "לא בטוח שהבנתי. תכתוב מספר כמו 240.",
        onboarding: true,
      };
    }

    state.data.ftpFinal = Math.round(num);
    state.stage = "hr_intro";
    return this._stageHr(state, "");
  }

  // ---------- HR ----------

  _stageHr(state, userInput) {
    const hr = state.data.hr || (state.data.hr = {});
    const txt = (userInput || "").trim();

    if (state.stage === "hr_intro") {
      // אם יש נתונים מסטרבה – מציגים אותם ומבקשים אישור / עדכון
      if (hr.hrMax != null || hr.hrThreshold != null) {
        const lines = [];
        lines.push("עכשיו נעבור לדופק.");

        if (hr.hrMax != null && hr.hrThreshold != null) {
          lines.push(
            `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ${hr.hrMax} bpm ` +
              `ודופק סף משוער של ${hr.hrThreshold} bpm.`
          );
        } else if (hr.hrMax != null) {
          lines.push(
            `לפי הנתונים מסטרבה אני רואה דופק מקסימלי משוער של ${hr.hrMax} bpm.`
          );
        } else if (hr.hrThreshold != null) {
          lines.push(
            `לפי הנתונים מסטרבה אני רואה דופק סף משוער של ${hr.hrThreshold} bpm.`
          );
        }

        lines.push(
          'אם זה נראה לך סביר, תכתוב "אישור". אם אתה מעדיף לעדכן את הדופק המקסימלי, תכתוב מספר כמו 175.'
        );

        hr.pendingMode = "from_strava";
        state.stage = "hr_collect";
        return { reply: lines.join("\n"), onboarding: true };
      }

      // אין נתונים מסטרבה – לוגיקה פשוטה כמו קודם
      state.stage = "hr_collect";
      hr.pendingMode = "manual";
      const msg =
        "עכשיו נעבור לדופק.\n" +
        "אם אתה יודע את הדופק המקסימלי שלך, תכתוב לי אותו (למשל 175).\n" +
        'אם אתה לא בטוח, אפשר פשוט ללחוץ אנטר ונמשיך הלאה.';
      return { reply: msg, onboarding: true };
    }

    // hr_collect
    if (hr.pendingMode === "from_strava") {
      if (!txt) {
        // בלי תשובה – נתייחס כאישור
        state.stage = "goal_intro";
        return this._stageGoal(state, "");
      }

      const lower = txt.toLowerCase();
      if (
        lower.includes("אשר") ||
        lower.includes("כן") ||
        lower.includes("סבב") ||
        lower.includes("נכון")
      ) {
        state.stage = "goal_intro";
        return this._stageGoal(state, "");
      }

      const num = parseFloat(txt.replace(",", "."));
      if (isNaN(num) || num < 120 || num > 220) {
        return {
          reply: "לא בטוח שהבנתי. תכתוב דופק מקסימלי סביר, למשל 175.",
          onboarding: true,
        };
      }

      hr.hrMax = Math.round(num);
      state.stage = "goal_intro";
      return this._stageGoal(state, "");
    }

    // manual mode
    if (!txt) {
      state.stage = "goal_intro";
      return this._stageGoal(state, "");
    }

    const num = parseFloat(txt.replace(",", "."));
    if (isNaN(num) || num < 120 || num > 220) {
      return {
        reply: "לא בטוח שהבנתי. תכתוב דופק מקסימלי סביר, למשל 175.",
        onboarding: true,
      };
    }

    hr.hrMax = Math.round(num);
    state.stage = "goal_intro";
    return this._stageGoal(state, "");
  }

  // ---------- GOAL ----------

  _stageGoal(state, userInput) {
    const txt = (userInput || "").trim();

    if (state.stage === "goal_intro") {
      state.stage = "goal_collect";
      return {
        reply:
          "מה המטרה הקרובה שלך? (לדוגמה: גרן פונדו אילת, שיפור FTP, ירידה במשקל)",
        onboarding: true,
      };
    }

    if (!txt) {
      return {
        reply: "תכתוב מטרה קצרה וברורה, למשל: 'גרן פונדו אילת בדצמבר'.",
        onboarding: true,
      };
    }

    state.data.goal = txt;
    state.stage = "done";

    const lines = [];
    lines.push("סיימנו את האונבורדינג 🎉");
    lines.push("מכאן נמשיך לבנות עבורך אימונים חכמים ומותאמים אישית.");

    return {
      reply: lines.join("\n\n"),
      onboarding: true,
    };
  }
}
