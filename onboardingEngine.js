// onboardingEngine.js (FULL — FINAL VERSION)
// כולל personal → FTP → HR → TRAINING_TIME → GOAL
// ללא "משך רכיבה טיפוסי" כשאלת אונבורדינג, אלא רק ערכים לשלבי אימון
// ללא "נשמור" / "נעבור"

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  async handleMessage(userId, textRaw) {
    const text = (textRaw || "").trim();

    let state = await this._loadState(userId);

    if (state && state.stage === "done") {
      return {
        reply:
          "האונבורדינג כבר הושלם. אם תרצה לעדכן משקל, FTP, דופק או מטרה — תגיד לי מה לעדכן.",
        onboarding: false,
      };
    }

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
        state = await this._bootstrapStateFromStrava(userId);
        await this._saveState(userId, state);
        reply = "נתחיל שוב מסטרבה ונמשיך משם.";
        break;
    }

    return { reply, onboarding: true };
  }

  // ===== DB HELPERS =====

  async _loadState(userId) {
    try {
      const st = await this.db.getOnboardingState(userId);
      if (!st || !st.stage) return { stage: null, data: {} };
      return {
        stage: st.stage,
        data: st.data || {},
      };
    } catch (e) {
      return { stage: null, data: {} };
    }
  }

  async _saveState(userId, state) {
    try {
      await this.db.saveOnboardingState(userId, {
        stage: state.stage,
        data: state.data || {},
      });
    } catch (e) {}
  }

  // ===== STRAVA BOOTSTRAP =====

  async _bootstrapStateFromStrava(userId) {
    let hasTokens = false;
    let snapshot = null;

    try {
      const tokens = await this.db.getStravaTokens(userId);
      hasTokens = !!(tokens && tokens.accessToken);

      if (hasTokens) {
        snapshot = await this.db.getStravaOnboardingSnapshot(userId);
      }
    } catch (e) {}

    if (!hasTokens) {
      return {
        stage: "intro",
        data: {
          stravaConnected: false,
          personal: {},
        },
      };
    }

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
    const hasTS =
      state.data.trainingSummary &&
      state.data.trainingSummary.rides_count != null;
    const hasFtp = state.data.ftpModels != null;
    const hasHr = state.data.hr != null;

    if (hasTS && hasFtp && hasHr) return state;

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
      if (!state.data.personal) {
        state.data.personal = snapshot.personal || {};
      }
    }

    return state;
  }

  // ===== INTRO =====

  async _stageIntro(userId, text, state) {
    const intro =
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "נתחיל מחיבור לסטרבה כדי שאוכל לראות את הרכיבות האחרונות שלך.";

    const tokens = await this.db.getStravaTokens(userId);
    const hasStrava = !!(tokens && tokens.accessToken);

    if (!hasStrava) {
      state.stage = "intro";
      await this._saveState(userId, state);
      const connect = `/auth/strava?userId=${encodeURIComponent(userId)}`;
      return intro + "\n\n" + `לחיבור לסטרבה:\n${connect}`;
    }

    state = await this._bootstrapStateFromStrava(userId);
    await this._saveState(userId, state);
    return await this._stagePostStravaSummary(userId, state);
  }

  // ===== STRAVA SUMMARY =====

  _formatTrainingSummary(ts) {
    if (!ts || !ts.rides_count) {
      return "לא מצאתי מספיק רכיבות מהתקופה האחרונה כדי להציג סיכום נפח.";
    }

    const rides = ts.rides_count;
    const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
    const km = ts.totalDistanceKm.toLocaleString("he-IL", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const elevation = Math.round(ts.totalElevationGainM).toLocaleString(
      "he-IL"
    );
    const avgMin = Math.round(ts.avgDurationSec / 60);

    return [
      "בדקתי את הרכיבות שלך:",
      `• מספר רכיבות: ${rides}`,
      `• זמן רכיבה מצטבר: ${hours} שעות`,
      `• מרחק מצטבר: ${km} ק״מ`,
      `• טיפוס מצטבר: ${elevation} מטר`,
      `• משך רכיבה ממוצע: ${avgMin} דקות`,
    ].join("\n");
  }

  async _stagePostStravaSummary(userId, state) {
    state = await this._ensureStravaMetricsInState(userId, state);
    const ts = state.data.trainingSummary;
    const summary = this._formatTrainingSummary(ts);

    const personal = state.data.personal || {};
    const w = personal.weightFromStrava != null ? personal.weightFromStrava : null;

    state.stage = "personal_details";
    state.data.personal = personal;
    state.data.personalStep = "weight";
    await this._saveState(userId, state);

    let ask = "";
    if (w != null) {
      ask = `מופיע בסטרבה משקל ${w} ק"ג — לאשר או לעדכן?`;
    } else {
      ask = 'נתחיל ממשקל — כמה אתה שוקל בק"ג?';
    }

    return (
      summary +
      "\n\n" +
      "עכשיו שיש לנו סטרבה אני צריך להשלים עוד כמה נתונים בסיסים\n\n" +
      ask
    );
  }

  // ===== PERSONAL =====

  async _stagePersonalDetails(userId, text, state) {
    const t = (text || "").trim();
    state.data.personal = state.data.personal || {};
    let step = state.data.personalStep || "weight";

    // WEIGHT
    if (step === "weight") {
      const personal = state.data.personal;
      const ws = personal.weightFromStrava != null ? personal.weightFromStrava : null;

      let parsed = null;
      if (t) {
        const n = parseFloat(t.replace(/[^\d.,]/g, "").replace(",", "."));
        if (Number.isFinite(n) && n > 30 && n < 200) parsed = Math.round(n * 10) / 10;
      }

      if (!t && ws != null) {
        personal.weightKg = ws;
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

    // HEIGHT
    if (step === "height") {
      let parsed = null;
      if (t) {
        const n = parseFloat(t.replace(/[^\d.,]/g, "").replace(",", "."));
        if (Number.isFinite(n) && n > 120 && n < 230) parsed = Math.round(n);
      }

      if (parsed != null) {
        state.data.personal.heightCm = parsed;
      } else {
        return 'כדי לדייק את החישובים – תכתוב גובה בס"מ (למשל 178).';
      }

      state.data.personalStep = "age";
      await this._saveState(userId, state);
      return "בן כמה אתה?";
    }

    // AGE
    if (step === "age") {
      const age = parseInt(t, 10);
      if (!Number.isFinite(age) || age < 10 || age > 90) {
        return "בן כמה אתה?";
      }

      state.data.personal.age = age;
      state.data.personalStep = "done";
      state.stage = "ftp_intro";
      await this._saveState(userId, state);

      return await this._stageFtpIntro(userId, state);
    }

    state.data.personalStep = "weight";
    await this._saveState(userId, state);
    return 'נתחיל ממשקל — כמה אתה שוקל בק"ג?';
  }

  // ===== FTP =====

  _formatFtpModels(ftpModels) {
    if (!ftpModels) return "לא הצלחתי לחשב מודלים ל-FTP.";

    const out = ["בדקתי את הרכיבות שלך ובניתי מודלים ל-FTP:"];
    if (ftpModels.ftp20 && ftpModels.ftp20.value != null)
      out.push(`• ${ftpModels.ftp20.label}: ${ftpModels.ftp20.value} W`);
    if (ftpModels.ftpFrom3min && ftpModels.ftpFrom3min.value != null)
      out.push(`• ${ftpModels.ftpFrom3min.label}: ${ftpModels.ftpFrom3min.value} W`);
    if (ftpModels.ftpFromCP && ftpModels.ftpFromCP.value != null)
      out.push(`• ${ftpModels.ftpFromCP.label}: ${ftpModels.ftpFromCP.value} W`);
    if (ftpModels.ftpRecommended && ftpModels.ftpRecommended.value != null)
      out.push(
        `• ${ftpModels.ftpRecommended.label}: ${ftpModels.ftpRecommended.value} W (חציון)`
      );

    return out.join("\n");
  }

  async _stageFtpIntro(userId, state) {
    state = await this._ensureStravaMetricsInState(userId, state);

    const ftpModels = state.data.ftpModels;
    const summary = this._formatFtpModels(ftpModels);

    state.stage = "ftp_choice";
    await this._saveState(userId, state);

    let rec = "";
    if (ftpModels && ftpModels.ftpRecommended && ftpModels.ftpRecommended.value) {
      rec = `לפי החישובים שלי, ה-FTP המומלץ הוא ${ftpModels.ftpRecommended.value} W.`;
    } else {
      rec = "לא הצלחתי לגזור ערך FTP חד-משמעי.";
    }

    return (
      summary +
      "\n\n" +
      rec +
      "\n\n" +
      "אם ה-FTP שלך דומה – תכתוב לי את הערך שאתה רוצה שנעבוד איתו (למשל 240)."
    );
  }

  async _stageFtpChoice(userId, text, state) {
    const t = (text || "").trim();
    const n = parseFloat(t.replace(/[^\d.,]/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 100 || n > 500) {
      return "תכתוב מספר FTP בוואטים (למשל 240).";
    }

    const finalFTP = Math.round(n);
    state.data.ftpFinal = finalFTP;
    state.data.ftpModels = state.data.ftpModels || {};
    state.data.ftpModels.ftpUserSelected = {
      key: "ftpUserSelected",
      value: finalFTP,
      label: "FTP chosen by user",
    };

    state.stage = "hr_collect";
    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);

    const { hrMaxCandidate } = this._extractHrCandidates(state);

    const out = [];
    if (hrMaxCandidate != null) {
      out.push(`לפי סטרבה, דופק מקס משוער: ${hrMaxCandidate} bpm.`);
      out.push('אם זה סביר – תכתוב "אישור". אם לא, כתוב את הדופק המקסימלי שלך.');
    } else {
      out.push("תכתוב את הדופק המקסימלי שלך (למשל 175).");
    }

    return out.join("\n\n");
  }

  _extractHrCandidates(state) {
    const hr = state.data.hr || {};
    let max = null;
    let thr = null;

    if (typeof hr.hrMax === "number") max = Math.round(hr.hrMax);
    if (typeof hr.hrThreshold === "number") {
      thr = Math.round(hr.hrThreshold);
    } else if (max != null) thr = Math.round(max * 0.9);

    return { hrMaxCandidate: max, hrThresholdCandidate: thr };
  }

  // ===== HR =====

  async _stageHrCollect(userId, text, state) {
    const t = (text || "").trim();
    const step = state.data.hrStep || "hrMax";
    const { hrMaxCandidate, hrThresholdCandidate } =
      this._extractHrCandidates(state);

    // HR MAX
    if (step === "hrMax") {
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
            "נמשיך לדופק סף.",
            `דופק סף משוער: ${thr} bpm.`,
            'אם זה סביר – תכתוב "אישור". אם לא, כתוב ערך אחר.',
          ].join("\n\n");
        }

        return "תכתוב דופק מקסימלי (למשל 175).";
      }

      const n = parseInt(t.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n) && n >= 100 && n <= 230) {
        state.data.hrMaxFinal = n;
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        const thr = Math.round(n * 0.9);
        return [
          "נמשיך לדופק סף.",
          `דופק סף משוער: ${thr} bpm.`,
          'אם זה סביר – תכתוב "אישור". אם לא, כתוב ערך אחר.',
        ].join("\n\n");
      }

      if (hrMaxCandidate != null) {
        return [
          "תכתוב דופק מקסימלי (למשל 175).",
          `לפי סטרבה כרגע: ${hrMaxCandidate} bpm.`,
        ].join("\n\n");
      }

      return "תכתוב דופק מקסימלי (למשל 175).";
    }

    // HR THRESHOLD
    if (step === "hrThreshold") {
      if (
        t === "אישור" ||
        t.toLowerCase() === "ok" ||
        t.toLowerCase() === "okay"
      ) {
        const max = state.data.hrMaxFinal || hrMaxCandidate;
        const thr =
          hrThresholdCandidate != null
            ? hrThresholdCandidate
            : Math.round(max * 0.9);

        state.data.hrThresholdFinal = thr;
        state.data.hrStep = "done";
        state.stage = "training_time";
        await this._saveState(userId, state);

        return await this._stageTrainingTime(userId, "", state);
      }

      const n = parseInt(t.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n) && n >= 90 && n <= 220) {
        state.data.hrThresholdFinal = n;
        state.data.hrStep = "done";
        state.stage = "training_time";
        await this._saveState(userId, state);

        return await this._stageTrainingTime(userId, "", state);
      }

      const max = state.data.hrMaxFinal || hrMaxCandidate || null;
      const thr =
        hrThresholdCandidate != null
          ? hrThresholdCandidate
          : Math.round(max * 0.9);

      return [
        `דופק סף משוער: ${thr} bpm.`,
        'אם זה סביר – תכתוב "אישור". אם לא, תכתוב ערך סף.',
      ].join("\n\n");
    }

    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);
    return await this._stageHrCollect(userId, text, state);
  }

  // ===== TRAINING TIME =====

  async _stageTrainingTime(userId, text, state) {
    state.data = state.data || {};
    const t = (text || "").trim();

    const ts = state.data.trainingSummary || null;
    let avg = null,
      min = null,
      max = null;

    if (ts && ts.avgDurationSec) {
      avg = Math.round(ts.avgDurationSec / 60);
      min = ts.minDurationSec ? Math.round(ts.minDurationSec / 60) : Math.round(avg * 0.7);
      max = ts.maxDurationSec ? Math.round(ts.maxDurationSec / 60) : Math.round(avg * 1.4);
    } else {
      min = 90;
      avg = 120;
      max = 180;
    }

    state.data.trainingTimeDefaults = {
      minMinutes: min,
      avgMinutes: avg,
      maxMinutes: max,
    };

    if (!t) {
      state.data.trainingTimeStep = "collect";
      state.stage = "training_time";
      await this._saveState(userId, state);

      return [
        "מצוין, יש לנו עכשיו גם דופק מקס וגם דופק סף.",
        "עכשיו נגדיר את משך האימון שלך.",
        "לפי סטרבה אני רואה:",
        `• קצר: ${min} דקות`,
        `• ממוצע: ${avg} דקות`,
        `• ארוך: ${max} דקות`,
        'אם זה מתאים — תכתוב "אישור".',
        "אם אתה מעדיף ערכים אחרים — תכתוב שלושה מספרים בסדר: קצר / ממוצע / ארוך.",
      ].join("\n\n");
    }

    if (
      t === "אישור" ||
      t.toLowerCase() === "ok" ||
      t.toLowerCase() === "okay"
    ) {
      const d = state.data.trainingTimeDefaults;
      state.data.trainingTime = {
        minMinutes: d.minMinutes,
        avgMinutes: d.avgMinutes,
        maxMinutes: d.maxMinutes,
      };
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";
      await this._saveState(userId, state);

      return [
        "מעולה, נשתמש בערכים:",
        `• קצר: ${d.minMinutes} דקות`,
        `• ממוצע: ${d.avgMinutes} דקות`,
        `• ארוך: ${d.maxMinutes} דקות`,
        "מה המטרה המרכזית שלך לתקופה הקרובה?",
      ].join("\n\n");
    }

    const nums = t
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));

    if (!nums.length) {
      return (
        "תכתוב שלושה מספרים לדקות קצר/ממוצע/ארוך, למשל: 90 120 180."
      );
    }

    let mm, am, xm;
    if (nums.length === 1) {
      am = nums[0];
      mm = Math.round(am * 0.7);
      xm = Math.round(am * 1.4);
    } else if (nums.length === 2) {
      mm = nums[0];
      xm = nums[1];
      am = Math.round((mm + xm) / 2);
    } else {
      mm = nums[0];
      am = nums[1];
      xm = nums[2];
    }

    const clamp = (x) => Math.max(30, Math.min(x, 360));
    mm = clamp(mm);
    am = clamp(am);
    xm = clamp(xm);

    if (am < mm) am = mm;
    if (xm < am) xm = am;

    state.data.trainingTime = {
      minMinutes: mm,
      avgMinutes: am,
      maxMinutes: xm,
    };
    state.data.trainingTimeStep = "done";
    state.stage = "goal_collect";
    await this._saveState(userId, state);

    return [
      "מעולה:",
      `• קצר: ${mm} דקות`,
      `• ממוצע: ${am} דקות`,
      `• ארוך: ${xm} דקות`,
      "מה המטרה המרכזית שלך לתקופה הקרובה?",
    ].join("\n\n");
  }

  // ===== GOAL =====

  async _stageGoalCollect(userId, text, state) {
    const t = (text || "").trim();
    if (!t) {
      return "תכתוב מטרה ברורה (למשל: גרן פונדו אילת או שיפור FTP).";
    }

    state.data.goal = t;
    state.stage = "done";
    await this._saveState(userId, state);

    return "סיימנו את האונבורדינג 🎉\nמכאן נתחיל לאמן אותך חכם.";
  }
}
