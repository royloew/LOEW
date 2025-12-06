// onboardingEngine.js
export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  //
  // ------------------------- LOAD / SAVE STATE -------------------------
  //

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

  //
  // --------------------- APPLY SNAPSHOT FROM STRAVA ---------------------
  //

  _applyStravaSnapshotToState(state, snap) {
    const d = state.data || (state.data = {});

    // summary + volume
    if (snap.trainingSummary) d.trainingSummary = snap.trainingSummary;
    if (snap.volume) d.volume = snap.volume;

    // ftp models
    if (snap.ftpModels) {
      const m = snap.ftpModels;
      const ftp = d.ftp || (d.ftp = {});

      ftp.ftp20 = m.ftp20 && m.ftp20.value != null ? m.ftp20.value : null;
      ftp.ftpFrom3min =
        m.ftpFrom3min && m.ftpFrom3min.value != null
          ? m.ftpFrom3min.value
          : null;
      ftp.ftpFromCP =
        m.ftpFromCP && m.ftpFromCP.value != null ? m.ftpFromCP.value : null;
      ftp.ftpRecommended =
        m.ftpRecommended && m.ftpRecommended.value != null
          ? m.ftpRecommended.value
          : null;
    }

    // HR
    if (snap.hr) {
      const hr = d.hr || (d.hr = {});
      if (snap.hr.hrMax != null) hr.hrMax = snap.hr.hrMax;
      if (snap.hr.hrThreshold != null) hr.hrThreshold = snap.hr.hrThreshold;
    }

    // personal – weight from strava
    if (snap.personal && snap.personal.weightFromStrava != null) {
      const personal = d.personal || (d.personal = {});
      if (personal.weightKg == null) {
        personal.weightFromStrava = Math.round(
          snap.personal.weightFromStrava
        );
      }
    }
  }

  async _ensureStravaMetrics(userId, state) {
    try {
      if (
        !this.db ||
        typeof this.db.getStravaOnboardingSnapshot !== "function"
      ) {
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

  //
  // -------------------------- MAIN HANDLE --------------------------
  //

  async handleMessage(userId, userInputRaw) {
    let txt = (userInputRaw || "").trim();
    let state = await this._loadState(userId);

    // If state empty → initialize
    if (!state || !state.stage || !state.data) {
      // if user still not connected to strava
      const hasTokens =
        await this.db.hasStravaTokensForUser(userId);

      if (!hasTokens) {
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
        await this._saveState(userId, state);

        return {
          reply: this._introMessage(),
          onboarding: true,
        };
      }

      // If tokens exist → get snapshot
      state = {
        stage: "post_strava_summary",
        data: {
          personal: {},
          ftp: null,
          ftpFinal: null,
          hr: null,
          hrFinal: null,
          goal: null,
          volume: null,
          trainingSummary: null,
          stravaConnected: true,
        },
      };

      await this._ensureStravaMetrics(userId, state);
      await this._saveState(userId, state);

      const summaryMsg = await this._stagePostStravaSummary(userId, state);
      await this._saveState(userId, state);
      return summaryMsg;
    }

    // run current stage
    const result = await this._runStage(userId, state, txt);
    await this._saveState(userId, state);
    return result;
  }

  //
  // ---------------------- STAGE SWITCHER ----------------------
  //

  async _runStage(userId, state, txt) {
    switch (state.stage) {
      case "intro":
        return this._stageIntro(state);
      case "post_strava_summary":
        return await this._stagePostStravaSummary(userId, state);
      case "personal_details":
      case "personal_details_collect":
        return this._stagePersonalDetails(state, txt);
      case "ftp_intro":
      case "ftp_collect":
        return this._stageFtp(state, txt);
      case "hr_intro":
      case "hr_collect":
        return this._stageHr(state, txt);
      case "goal_intro":
      case "goal_collect":
        return this._stageGoal(state, txt);
      default:
        state.stage = "intro";
        return {
          reply: this._introMessage(),
          onboarding: true,
        };
    }
  }

  //
  // ---------------------- INTRO ----------------------
  //

  _introMessage() {
    return (
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n\n" +
      "כדי להתחיל, אנא חבר אותי לסטרבה."
    );
  }

  _stageIntro(state) {
    return {
      reply:
        "נראה שעוד לא חיברת סטרבה. כרגע אני צריך שתתחבר כדי שאוכל לנתח את הרכיבות שלך.",
      onboarding: true,
      expectInput: false,
    };
  }

  //
  // ------------------ POST STRAVA SUMMARY ------------------
  //

  async _stagePostStravaSummary(userId, state) {
    state = await this._ensureStravaMetrics(userId, state);

    const ts = state.data.trainingSummary;
    const volume = state.data.volume;
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

      msgs.push("עכשיו נעבור לכמה פרטים אישיים בסיסיים.");
    } else {
      msgs.push(
        "לא מצאתי מספיק רכיבות אחרונות כדי להציג סיכום מלא.\nעכשיו נעבור לכמה פרטים אישיים בסיסיים."
      );
    }

    state.stage = "personal_details";
    return {
      reply: msgs.join("\n\n"),
      onboarding: true,
    };
  }

  //
  // ------------------ PERSONAL DETAILS ------------------
  //

  _stagePersonalDetails(state, userInput) {
    const msgs = [];
    const personal = state.data.personal || (state.data.personal = {});
    const txt = (userInput || "").trim();

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
            return {
              newMessages: msgs,
              waitForUser: true,
              consumeInput: true,
            };
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
            return {
              newMessages: msgs,
              waitForUser: true,
              consumeInput: true,
            };
          }
          personal.age = Math.round(num);
        } else if (field === "weightKg") {
          if (isNaN(num) || num < 30 || num > 150) {
            msgs.push(
              "לא בטוח שהבנתי את המשקל. תכתוב מספר בקילו (למשל 67)."
            );
            return {
              newMessages: msgs,
              waitForUser: true,
              consumeInput: true,
            };
          }
          personal.weightKg = Math.round(num);
        } else if (field === "heightCm") {
          if (isNaN(num) || num < 120 || num > 220) {
            msgs.push(
              'לא בטוח שהבנתי את הגובה. תכתוב מספר בס"מ (למשל 178).'
            );
            return {
              newMessages: msgs,
              waitForUser: true,
              consumeInput: true,
            };
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
      return {
        newMessages: msgs,
        waitForUser: true,
        consumeInput: true,
      };
    }

    // done – move to FTP
    state.stage = "ftp_intro";
    return {
      newMessages: [],
      waitForUser: false,
      consumeInput: true,
    };
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
        message: `מופיע בסטרבה משקל ${p.weightFromStrava} ק"ג — לאשר או לעדכן?`,
      };
    }

    if (p.age == null)
      return { field: "age", message: "נתחיל בגיל — בן כמה אתה?" };

    if (p.weightKg == null)
      return {
        field: "weightKg",
        message: "מה המשקל שלך בקילוגרמים (למשל 67)?",
      };

    if (p.heightCm == null)
      return {
        field: "heightCm",
        message: 'ומה הגובה שלך בס"מ (למשל 178)?',
      };

    return null;
  }

  //
  // --------------------------- FTP ---------------------------
  //

  _stageFtp(state, userInput) {
    const ftp = state.data.ftp || {};
    const txt = (userInput || "").trim();

    if (state.stage === "ftp_intro") {
      const lines = [];

      if (ftp.ftp20 != null)
        lines.push(
          `FTP לפי מודל של 20 דקות (הסקה מיכולת 20 דק'): ${ftp.ftp20}W`
        );
      if (ftp.ftpFrom3min != null)
        lines.push(
          `FTP לפי מודל של 3 דקות (הסקה מיכולת 3 דק'): ${ftp.ftpFrom3min}W`
        );
      if (ftp.ftpFromCP != null)
        lines.push(
          `FTP לפי מודל משולב CP (עקומת כוח 3–20 דק'): ${ftp.ftpFromCP}W`
        );

      if (ftp.ftpRecommended != null)
        lines.push(
          `על בסיס כל המודלים, ההמלצה שלי כרגע היא ${ftp.ftpRecommended}W.`
        );

      const msg = lines.join("\n");

      state.stage = "ftp_collect";
      return {
        reply: msg + "\n\nבאיזו רמת FTP תרצה להשתמש כרגע?",
        onboarding: true,
      };
    }

    // FTP collect
    const num = parseFloat(txt.replace(",", "."));
    if (isNaN(num) || num < 100 || num > 450) {
      return {
        reply: "לא בטוח שהבנתי. תכתוב מספר כמו 240.",
        onboarding: true,
      };
    }

    state.data.ftpFinal = Math.round(num);

    // move quietly to HR
    state.stage = "hr_intro";
    return {
      reply: null,
      onboarding: true,
      expectInput: false,
    };
  }

  //
  // ---------------------------- HR ----------------------------
  //

  _stageHr(state, userInput) {
    // simplified – after FTP you already know what you want
    if (state.stage === "hr_intro") {
      state.stage = "hr_collect";
      return {
        reply:
          "עכשיו נעבור לדופק.\nאם תרצה, תוכל לעדכן את הדופק המקסימלי שלך או פשוט להמשיך.",
        onboarding: true,
      };
    }

    const txt = (userInput || "").trim();
    if (!txt) {
      // skip → go to goal
      state.stage = "goal_intro";
      return {
        reply: null,
        onboarding: true,
        expectInput: false,
      };
    }

    const num = parseFloat(txt.replace(",", "."));
    if (isNaN(num) || num < 120 || num > 220) {
      return {
        reply: "לא בטוח שהבנתי. תכתוב דופק מקסימלי כמו 175.",
        onboarding: true,
      };
    }

    state.data.hrFinal = Math.round(num);

    // next → goal
    state.stage = "goal_intro";
    return {
      reply: null,
      onboarding: true,
      expectInput: false,
    };
  }

  //
  // --------------------------- GOAL ---------------------------
  //

  _stageGoal(state, userInput) {
    const txt = (userInput || "").trim();

    if (state.stage === "goal_intro") {
      state.stage = "goal_collect";
      return {
        reply: "מה המטרה הקרובה שלך?",
        onboarding: true,
      };
    }

    if (!txt) {
      return {
        reply: "תכתוב מטרה קצרה.",
        onboarding: true,
      };
    }

    state.data.goal = txt;
    state.stage = "done";

    return {
      reply:
        "סיימנו את האונבורדינג 🎉\nעכשיו אוכל להתחיל לתכנן עבורך אימונים מדויקים.",
      onboarding: true,
    };
  }
}
