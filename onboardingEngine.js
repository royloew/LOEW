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

    // אם כבר סיימנו אונבורדינג – לא חוזרים פנימה לתהליך
    if (state && state.stage === "done") {
      return {
        reply: this._postOnboardingMenu(),
        onboarding: false,
      };
    }

    // אין state שמור – בוטסטרפ מסטרבה
    if (!state || !state.stage) {
      state = await this._bootstrapStateFromStrava(userId);
      await this._saveState(userId, state);
    }

    if (state.stage === "intro") {
      return await this._stageIntro(userId, text, state);
    }

    if (state.stage === "strava_wait") {
      return await this._stageStravaWait(userId, text, state);
    }

    if (state.stage === "strava_summary") {
      return await this._stageStravaSummary(userId, text, state);
    }

    if (state.stage === "personal_details") {
      return await this._stagePersonalDetails(userId, text, state);
    }

    if (state.stage === "ftp_models") {
      return await this._stageFtpModels(userId, text, state);
    }

    if (state.stage === "hr_intro") {
      return await this._stageHrIntro(userId, text, state);
    }

    if (state.stage === "hr_collect") {
      return await this._stageHrCollect(userId, text, state);
    }

    if (state.stage === "training_time") {
      return await this._stageTrainingTime(userId, text, state);
    }

    if (state.stage === "goal_collect") {
      return await this._stageGoalCollect(userId, text, state);
    }

    // לא אמור להגיע לכאן, אבל אם כן – הודעת fallback
    return {
      reply:
        "משהו לא היה ברור בתהליך האונבורדינג. תנסה לענות שוב בתשובה קצרה ופשוטה (מספר או מילה אחת), ונמשיך מאותו שלב.",
      onboarding: true,
    };
  }

  // ===== helpers לזיכרון / DB =====

  async _loadState(userId) {
    // 1) ניסיון דרך ה-DB
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
    if (mem) return mem;

    // 3) אין state בכלל
    return null;
  }

  async _saveState(userId, state) {
    this._memStates.set(userId, state);

    if (this.db && typeof this.db.saveOnboardingState === "function") {
      try {
        await this.db.saveOnboardingState(userId, {
          stage: state.stage,
          data: state.data || {},
        });
      } catch (e) {
        console.error("OnboardingEngine._saveState DB error:", e);
      }
    }
  }

  async _bootstrapStateFromStrava(userId) {
    const base = {
      stage: "intro",
      data: {
        snapshotAvailable: false,
        trainingSummary: null,
        volume: null,
        ftpModels: {},
        hr: {
          hrMax: null,
          hrThreshold: null,
        },
        personal: {},
      },
    };

    if (
      !this.db ||
      typeof this.db.getStravaSnapshot !== "function" ||
      typeof this.db.getTrainingParams !== "function"
    ) {
      return base;
    }

    try {
      const snap = await this.db.getStravaSnapshot(userId);
      if (snap) {
        base.data.snapshotAvailable = !!snap.snapshotAvailable;
        base.data.trainingSummary = snap.trainingSummary || null;
        base.data.volume = snap.volume || null;
        base.data.ftpModels = snap.ftpModels || {};
        base.data.hr = snap.hr || base.data.hr;
        base.data.personal = snap.personal || base.data.personal;
      }

      const tp = await this.db.getTrainingParams(userId);
      if (tp) {
        base.data.ftpFinal = tp.ftp ?? null;
        base.data.hr = base.data.hr || {};
        base.data.hr.hrMaxFinal = tp.hrMax ?? null;
        base.data.hr.hrThresholdFinal = tp.hrThreshold ?? null;
      }
    } catch (e) {
      console.error("OnboardingEngine._bootstrapStateFromStrava error:", e);
    }

    return base;
  }

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
        ftp: ftpFinal != null ? ftpFinal : existing.ftp ?? null,
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

  // 🔹 תפריט ברירת מחדל אחרי אונבורדינג
  _postOnboardingMenu() {
    return (
      "במה אני יכול לעזור לך?\n" +
      "שים לב לדוגמאות לשאלות שאתה יכול לשאול אותי\n\n" +
      "טיפול בנתונים:\n" +
      "• \"עדכן מסטרבה\"\n" +
      "• \"הפרופיל שלי\"\n\n" +
      "עדכון הנתונים שלי:\n" +
      "• \"המשקל שלי עכשיו 72\"\n" +
      "• \"FTP 250\"\n" +
      "• \"דופק מקסימלי 178\"\n" +
      "• \"דופק סף 160\"\n\n" +
      "ניתוח נתונים:\n" +
      "• \"נתח את האימון האחרון שלי\"\n" +
      "• \"נתח לי אימון מתאריך yyyy-mm-dd\""
    );
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

    if (hasTS && hasHr && hasPersonal && hasFtp) {
      return state;
    }

    try {
      if (this.db && typeof this.db.getStravaSnapshot === "function") {
        const snap = await this.db.getStravaSnapshot(userId);
        if (snap) {
          state.data.trainingSummary =
            snap.trainingSummary || state.data.trainingSummary || null;
          state.data.volume = snap.volume || state.data.volume || null;
          state.data.ftpModels =
            snap.ftpModels || state.data.ftpModels || {};
          state.data.hr = snap.hr || state.data.hr || {};
          state.data.personal =
            snap.personal || state.data.personal || {};
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

  // ===== STAGE: INTRO =====

  async _stageIntro(userId, text, state) {
    if (!text) {
      return {
        reply:
          "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
          "כדי להתחיל לעבוד יחד, נחבר את סטרבה שלך (אם יש) ונעבור תהליך קצר של אונבורדינג.",
        onboarding: true,
      };
    }

    state.stage = "strava_wait";
    await this._saveState(userId, state);

    return {
      reply:
        "מעולה. ברגע שתאשר את החיבור לסטרבה, אייבא את הנתונים שלך ונמשיך לנתונים האישיים.",
      onboarding: true,
    };
  }

  // ===== STAGE: STRAVA WAIT =====

  async _stageStravaWait(userId, text, state) {
    if (!state.data.snapshotAvailable) {
      return {
        reply:
          "אני עדיין מחכה לאישור חיבור לסטרבה וייבוא הנתונים.\n" +
          "ברגע שהייבוא יסתיים, נמשיך הלאה.",
        onboarding: true,
      };
    }

    state.stage = "strava_summary";
    await this._saveState(userId, state);

    return await this._stageStravaSummary(userId, "", state);
  }

  // ===== STAGE: STRAVA SUMMARY =====

  async _stageStravaSummary(userId, text, state) {
    state = await this._ensureStravaMetricsInState(userId, state);
    const ts = state.data.trainingSummary;
    const volume = state.data.volume;

    // personal data from Strava (weight etc.)
    const personal = state.data.personal || {};
    const weightFromStrava =
      personal && personal.weightFromStrava != null
        ? personal.weightFromStrava
        : null;

    // יש מספיק רכיבות לסיכום
    if (ts && ts.rides_count > 0) {
      const hoursRaw = ts.totalMovingTimeSec / 3600;
      const kmRaw = ts.totalDistanceKm;
      const elevationRaw = ts.totalElevationGainM;
      const avgMin = Math.round(ts.avgDurationSec / 60);
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct * 100) : null;

      const hours = this._formatNumber(hoursRaw, 1);
      const km = this._formatNumber(kmRaw, 1);
      const elevation = this._formatNumber(elevationRaw, 0);
      const ridesCount = this._formatNumber(ts.rides_count, 0);

      const lines = [];

      lines.push("סיימתי לייבא נתונים מסטרבה ✅");
      lines.push("");
      lines.push("סיכום 90 הימים האחרונים:");
      lines.push(`• מספר רכיבות: ${ridesCount}`);
      lines.push(`• זמן רכיבה מצטבר: ~${hours} שעות`);
      lines.push(`• מרחק מצטבר: ${km} ק\"מ`);
      lines.push(`• טיפוס מצטבר: ${elevation} מ׳`);
      lines.push(`• משך רכיבה ממוצע: ~${avgMin} דקות`);
      if (offPct != null) {
        lines.push(`• שטח (off-road): ~${offPct}% מהרכיבות`);
      }

      if (volume && volume.weeksCount > 0) {
        const wHours = this._formatNumber(volume.weeklyHoursAvg, 1);
        const wRides = this._formatNumber(volume.weeklyRidesAvg, 1);
        const weeksCount = this._formatNumber(volume.weeksCount, 0);
        lines.push("");
        lines.push("סיכום שבועי:");
        lines.push(`• שעות בשבוע (ממוצע): ~${wHours} שעות`);
        lines.push(`• רכיבות בשבוע (ממוצע): ~${wRides} רכיבות`);
        lines.push(`• מספר שבועות שנבדקו: ${weeksCount}`);
      }

      lines.push("");
      lines.push("עכשיו נעבור לנתונים האישיים שלך.");

      const summaryText = lines.join("\n");

      // השלב הבא: נתונים אישיים → משקל
      state.stage = "personal_details";
      state.data.personal = personal;
      state.data.personalStep = "weight";
      await this._saveState(userId, state);

      // בועה 2 – שאלת משקל
      let weightQuestion =
        "נתחיל ממשקל — זה עוזר לי לחשב עומס ואימונים בצורה מדויקת יותר.\n\n";

      if (weightFromStrava != null) {
        const wStr = this._formatNumber(weightFromStrava, 1);
        weightQuestion +=
          `בסטרבה מופיע ${wStr} ק\"ג.\n` +
          'אם זה נכון, תכתוב "אישור".\n' +
          "אם תרצה לעדכן – תכתוב את המשקל הנוכחי שלך (למשל 72.5).";
      } else {
        weightQuestion += 'כמה אתה שוקל כרגע בק"ג (למשל 72.5)?';
      }

      return {
        reply: summaryText,
        followups: [weightQuestion],
        onboarding: true,
      };
    }

    // אין מספיק נתונים לסיכום נפח – עדיין נעבור לנתונים אישיים + משקל
    state.stage = "personal_details";
    state.data.personal = state.data.personal || {};
    state.data.personalStep = "weight";
    await this._saveState(userId, state);

    const summaryText =
      "לא מצאתי מספיק רכיבות מ-90 הימים האחרונים כדי להציג סיכום נפח.\n" +
      "בוא נעבור לנתונים האישיים שלך.";

    const weightQuestion =
      "נתחיל ממשקל — זה עוזר לי לחשב עומס ואימונים בצורה מדויקת יותר.\n\n" +
      'כמה אתה שוקל כרגע בק"ג (למשל 72.5)?';

    return {
      reply: summaryText,
      followups: [weightQuestion],
      onboarding: true,
    };
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

      if (!t) {
        state.data.personalStep = "weight";
        await this._saveState(userId, state);

        let line = "";
        if (weightFromStrava != null) {
          line =
            `בסטרבה מופיע ${weightFromStrava} ק"ג.\n` +
            'אם זה נכון, תכתוב "אישור".\n' +
            "אם תרצה לעדכן – תכתוב את המשקל הנוכחי שלך (למשל 72.5).";
        } else {
          line = 'נתחיל ממשקל — כמה אתה שוקל בק"ג (למשל 72.5)?';
        }

        return {
          reply:
            "נעבור עכשיו לנתונים האישיים שלך.\n" +
            "נתחיל ממשקל — זה עוזר לי לחשב עומס ואימונים בצורה מדויקת יותר.\n\n" +
            line,
          onboarding: true,
        };
      }

      if (t === "אישור" && weightFromStrava != null) {
        state.data.personal.weight = weightFromStrava;
        state.data.personalStep = "height";
        await this._saveState(userId, state);

        return {
          reply:
            `מעולה, אשתמש במשקל ${this._formatNumber(
              weightFromStrava,
              1
            )} ק\"ג.\n\n` + 'מה הגובה שלך בס"מ?',
          onboarding: true,
        };
      }

      const parsed = parseFloat(t.replace(",", "."));
      if (Number.isNaN(parsed) || parsed < 30 || parsed > 200) {
        return {
          reply:
            "לא הצלחתי להבין את המשקל שכתבת.\n" +
            'תכתוב מספר בק"ג (למשל 72 או 72.5).',
          onboarding: true,
        };
      }

      state.data.personal.weight = Math.round(parsed * 10) / 10;
      state.data.personalStep = "height";
      await this._saveState(userId, state);

      return {
        reply: 'מה הגובה שלך בס"מ?',
        onboarding: true,
      };
    }

    // גובה
    if (step === "height") {
      if (!t) {
        return {
          reply: 'מה הגובה שלך בס"מ (למשל 178)?',
          onboarding: true,
        };
      }

      const h = parseInt(t, 10);
      if (Number.isNaN(h) || h < 120 || h > 230) {
        return {
          reply:
            "לא הצלחתי להבין את הגובה שכתבת.\n" +
            'תכתוב גובה בס"מ (למשל 178).',
          onboarding: true,
        };
      }

      state.data.personal.height = h;
      state.data.personalStep = "age";
      await this._saveState(userId, state);

      return {
        reply: "בן כמה אתה?",
        onboarding: true,
      };
    }

    // גיל
    if (step === "age") {
      if (!t) {
        return {
          reply: "בן כמה אתה?",
          onboarding: true,
        };
      }

      const age = parseInt(t, 10);
      if (Number.isNaN(age) || age < 10 || age > 90) {
        return {
          reply:
            "לא הצלחתי להבין את הגיל שכתבת.\n" +
            "תכתוב גיל במספרים (למשל 46).",
          onboarding: true,
        };
      }

      state.data.personal.age = age;
      state.data.personalStep = "done";
      state.stage = "ftp_models";
      await this._saveState(userId, state);

      const ftpIntro = await this._stageFtpModels(userId, "", state);

      const prefix =
        "עכשיו נעבור לשלב FTP — הסמן המרכזי לעומס ולרמת הקושי באימונים שלך.\n\n";

      return {
        reply: prefix + (ftpIntro && ftpIntro.reply ? ftpIntro.reply : ""),
        onboarding: true,
      };
    }

    return {
      reply: "משהו לא היה ברור בנתונים האישיים, ננסה שוב.",
      onboarding: true,
    };
  }

  // ===== FTP MODELS =====

  async _stageFtpModels(userId, text, state) {
    state.data.ftpModels = state.data.ftpModels || {};
    const models = state.data.ftpModels;

    const candidates = [];
    if (models.ftp20 && typeof models.ftp20.value === "number") {
      candidates.push(models.ftp20.value);
    }
    if (
      models.ftpFrom3min &&
      typeof models.ftpFrom3min.value === "number"
    ) {
      candidates.push(models.ftpFrom3min.value);
    }
    if (models.ftpFromCP && typeof models.ftpFromCP.value === "number") {
      candidates.push(models.ftpFromCP.value);
    }

    const recommendFtp =
      candidates.length > 0
        ? Math.round(
            candidates.sort((a, b) => a - b)[
              Math.floor(candidates.length / 2)
            ]
          )
        : null;

    if (!text) {
      const lines = [];
      lines.push("בניתי עבורך כמה מודלים של FTP מתוך הרכיבות האחרונות שלך:");

      if (models.ftp20) {
        lines.push(
          `• ${models.ftp20.label}: ${models.ftp20.value}W (20 דקות * 0.95)`
        );
      }
      if (models.ftpFrom3min) {
        lines.push(
          `• ${models.ftpFrom3min.label}: ${models.ftpFrom3min.value}W (מודל שמבוסס על מאמץ של ~3 דקות)`
        );
      }
      if (models.ftpFromCP) {
        lines.push(
          `• ${models.ftpFromCP.label}: ${models.ftpFromCP.value}W (Critical Power משולב)`
        );
      }

      if (recommendFtp != null) {
        lines.push(
          `\nלפי כל המודלים האלו, אני ממליץ להתחיל מ-FTP של כ-${recommendFtp}W.`
        );
      }

      lines.push(
        "\nאם זה נראה לך סביר, תכתוב: מספר ה-FTP שבו אתה רוצה להשתמש (למשל 240)."
      );
      lines.push("אם אתה מעדיף ערך אחר – פשוט תכתוב אותו במספרים.");

      return {
        reply: lines.join("\n"),
        onboarding: true,
      };
    }

    const parsed = parseInt(text, 10);
    if (Number.isNaN(parsed) || parsed < 80 || parsed > 500) {
      return {
        reply:
          "כדי שאוכל לעבוד עם FTP מדויק — תכתוב מספר בוואטים, למשל 240.\n" +
          "אם אתה לא בטוח, אפשר לבחור ערך בין המודלים שהצגתי.",
        onboarding: true,
      };
    }

    state.data.ftpFinal = parsed;
    state.stage = "hr_intro";
    await this._updateTrainingParamsFromState(userId, state);
    await this._saveState(userId, state);

    const hrIntro = await this._stageHrIntro(userId, "", state);

    const prefix =
      `נגדיר כרגע FTP של ${parsed}W.\n\n` +
      "עכשיו נעבור לדופק — דופק מקסימלי ודופק סף.\n\n";

    return {
      reply: prefix + (hrIntro && hrIntro.reply ? hrIntro.reply : ""),
      onboarding: true,
    };
  }

  // ===== HR STAGES =====

  async _stageHrIntro(userId, text, state) {
    state.data.hr = state.data.hr || {};
    const hr = state.data.hr;

    const lines = [];
    lines.push("בוא נתאים גם את הדופק שלך.");

    if (typeof hr.hrMax === "number") {
      lines.push(`• דופק מקסימלי מוערך מהנתונים: ~${hr.hrMax} bpm.`);
    }
    if (typeof hr.hrThreshold === "number") {
      lines.push(`• דופק סף מוערך: ~${hr.hrThreshold} bpm.`);
    }

    lines.push(
      "\nנעבור עכשיו לעדכן את הערכים האלו ידנית כדי לוודא שהם מדויקים."
    );

    state.stage = "hr_collect";
    state.data.hrStep = "hrMax";
    await this._saveState(userId, state);

    return {
      reply:
        lines.join("\n") +
        "\n\n" +
        "נתחיל מדופק מקסימלי — מה הדופק המקסימלי הכי גבוה שאתה זוכר שראית (למשל 178)?",
      onboarding: true,
    };
  }

  async _stageHrCollect(userId, text, state) {
    state.data.hr = state.data.hr || {};
    const hr = state.data.hr;
    const step = state.data.hrStep || "hrMax";
    const t = (text || "").trim();

    const hrMaxCandidate =
      typeof hr.hrMax === "number" ? hr.hrMax : null;
    const hrThresholdCandidate =
      typeof hr.hrThreshold === "number" ? hr.hrThreshold : null;

    // שלב 1: דופק מקסימלי
    if (step === "hrMax") {
      if (!t) {
        if (hrMaxCandidate != null) {
          return {
            reply:
              `בסטרבה אני רואה דופק מקסימלי של בערך ${hrMaxCandidate} bpm.\n` +
              'אם זה נראה לך נכון, תכתוב "אישור". אם לא — תכתוב את הדופק המקסימלי הכי גבוה שאתה זוכר (למשל 178).',
            onboarding: true,
          };
        }

        return {
          reply:
            "מה הדופק המקסימלי הכי גבוה שאתה זוכר שראית (למשל 178)?",
          onboarding: true,
        };
      }

      if (t === "אישור" && hrMaxCandidate != null) {
        hr.hrMaxUser = hrMaxCandidate;
        hr.hrMaxFinal = hrMaxCandidate;
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        return await this._stageHrCollect(userId, "", state);
      }

      const parsed = parseInt(t, 10);
      if (Number.isNaN(parsed) || parsed < 120 || parsed > 230) {
        return {
          reply:
            "לא הצלחתי להבין את הדופק שכתבת.\n" +
            "תכתוב דופק מקסימלי במספרים (למשל 178).",
          onboarding: true,
        };
      }

      hr.hrMaxUser = parsed;
      hr.hrMaxFinal = parsed;
      state.data.hrStep = "hrThreshold";
      await this._saveState(userId, state);

      return await this._stageHrCollect(userId, "", state);
    }

    // שלב 2: דופק סף
    if (step === "hrThreshold") {
      if (!t) {
        if (hrThresholdCandidate != null) {
          return {
            reply:
              `בסטרבה אני רואה דופק סף של בערך ${hrThresholdCandidate} bpm.\n` +
              'אם זה נשמע לך נכון, תכתוב "אישור".\n' +
              "אם לא — תכתוב את דופק הסף שלך (למשל 160), או 'לא יודע' אם אתה לא בטוח.",
            onboarding: true,
          };
        }

        return {
          reply:
            "אם אתה יודע מהו דופק הסף שלך, תכתוב אותו במספרים (למשל 160).\n" +
            "אם אתה לא יודע, תכתוב 'לא יודע'.",
          onboarding: true,
        };
      }

      if (t === "לא יודע" || t === "לא יודעת") {
        state.data.hr.hrThresholdUser = null;
        if (hrThresholdCandidate != null) {
          state.data.hr.hrThresholdFinal = hrThresholdCandidate;
        }
        state.stage = "training_time";
        state.data.trainingTimeStep = "fromStrava";
        await this._updateTrainingParamsFromState(userId, state);
        await this._saveState(userId, state);

        return await this._stageTrainingTime(userId, "", state);
      }

      if (t === "אישור" && hrThresholdCandidate != null) {
        state.data.hr.hrThresholdUser = hrThresholdCandidate;
        state.data.hr.hrThresholdFinal = hrThresholdCandidate;
        state.stage = "training_time";
        state.data.trainingTimeStep = "fromStrava";
        await this._updateTrainingParamsFromState(userId, state);
        await this._saveState(userId, state);

        return await this._stageTrainingTime(userId, "", state);
      }

      const parsed = parseInt(t, 10);
      if (Number.isNaN(parsed) || parsed < 80 || parsed > 220) {
        if (hrThresholdCandidate != null) {
          return {
            reply:
              "לא הצלחתי להבין את הדופק שכתבת.\n" +
              `אם זה נשמע הגיוני, אפשר גם לאשר את הערך שמצאתי: ${hrThresholdCandidate} bpm.\n` +
              'תכתוב את הדופק סף שלך במספרים (למשל 160), או "אישור".',
            onboarding: true,
          };
        }
        return {
          reply:
            "לא הצלחתי להבין את הדופק שכתבת.\n" +
            "תכתוב דופק סף במספרים (למשל 160).",
          onboarding: true,
        };
      }

      state.data.hr.hrThresholdUser = parsed;
      state.data.hr.hrThresholdFinal = parsed;
      state.stage = "training_time";
      state.data.trainingTimeStep = "fromStrava";
      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      return await this._stageTrainingTime(userId, "", state);
    }

    return {
      reply: "משהו לא היה ברור בשלב הדופק, ננסה שוב.",
      onboarding: true,
    };
  }

  // ===== TRAINING TIME =====

  async _stageTrainingTime(userId, text, state) {
    state.data.trainingTime = state.data.trainingTime || {};
    const tt = state.data.trainingTime;
    let step = state.data.trainingTimeStep || "fromStrava";
    const t = (text || "").trim();

    if (step === "fromStrava") {
      const ts = state.data.trainingSummary;
      let line = "";

      if (ts && ts.avgDurationSec != null) {
        const avgMin = Math.round(ts.avgDurationSec / 60);
        const minMin = ts.minDurationSec
          ? Math.round(ts.minDurationSec / 60)
          : null;
        const maxMin = ts.maxDurationSec
          ? Math.round(ts.maxDurationSec / 60)
          : null;

        tt.avgMinutes = avgMin;
        tt.minMinutes = minMin || avgMin;
        tt.maxMinutes = maxMin || avgMin;

        state.data.trainingTimeStep = "confirm";
        await this._saveState(userId, state);

        line =
          `לפי סטרבה, משך רכיבה ממוצע אצלך הוא בערך ${avgMin} דקות.\n` +
          `הקצרות באזור ${tt.minMinutes} דק׳ והארוכות באזור ${tt.maxMinutes} דק׳.\n\n` +
          'אם זה נשמע לך נכון, תכתוב "אישור".\n' +
          "אם אתה מעדיף להגדיר מחדש — תכתוב שלושה מספרים: קצר/ממוצע/ארוך בדקות (למשל 90/120/180).";

        return {
          reply: line,
          onboarding: true,
        };
      }

      state.data.trainingTimeStep = "manual";
      await this._saveState(userId, state);

      return {
        reply:
          "לא מצאתי מספיק נתונים על משך האימונים שלך מסטרבה.\n" +
          "תכתוב בבקשה שלושה מספרים בדקות: משך אימון קצר / ממוצע / ארוך (למשל 90/120/180).",
        onboarding: true,
      };
    }

    if (step === "confirm") {
      if (!t) {
        return {
          reply:
            'אם משכי האימון שהצגתי נראים לך סבירים — תכתוב "אישור".\n' +
            "אם אתה מעדיף להגדיר מחדש — תכתוב שלושה מספרים: קצר/ממוצע/ארוך בדקות (למשל 90/120/180).",
          onboarding: true,
        };
      }

      if (t === "אישור") {
        state.data.trainingTimeStep = "done";
        state.stage = "goal_collect";
        await this._saveState(userId, state);

        return {
          reply:
            "מעולה.\n" +
            "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך — תחרות, אירוע, ירידה במשקל או משהו אחר.",
          onboarding: true,
        };
      }

      const parsed = this._parseThreeDurations(t);
      if (!parsed) {
        return {
          reply:
            "לא הצלחתי להבין את משכי האימון שכתבת.\n" +
            "תכתוב שלושה מספרים בדקות, מופרדים בפסיק או / (למשל 90/120/180).",
          onboarding: true,
        };
      }

      tt.minMinutes = parsed.min;
      tt.avgMinutes = parsed.avg;
      tt.maxMinutes = parsed.max;
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";
      await this._saveState(userId, state);

      return {
        reply:
          `עדכנתי משכי אימון: קצר ${parsed.min} דק׳ / ממוצע ${parsed.avg} דק׳ / ארוך ${parsed.max} דק׳.\n\n` +
          "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך.",
        onboarding: true,
      };
    }

    if (step === "manual") {
      const parsed = this._parseThreeDurations(t);
      if (!parsed) {
        return {
          reply:
            "לא הצלחתי להבין את משכי האימון שכתבת.\n" +
            "תכתוב שלושה מספרים בדקות, מופרדים בפסיק או / (למשל 90/120/180).",
          onboarding: true,
        };
      }

      tt.minMinutes = parsed.min;
      tt.avgMinutes = parsed.avg;
      tt.maxMinutes = parsed.max;
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";
      await this._saveState(userId, state);

      return {
        reply:
          `מעולה, עדכנתי משכי אימון: קצר ${parsed.min} דק׳ / ממוצע ${parsed.avg} דק׳ / ארוך ${parsed.max} דק׳.\n\n` +
          "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך.",
        onboarding: true,
      };
    }

    return {
      reply: "משהו לא היה ברור בשלב משך האימונים, ננסה שוב.",
      onboarding: true,
    };
  }

  _formatNumber(num, fractionDigits = 0) {
    if (typeof num !== "number" || !isFinite(num)) {
      return String(num);
    }
    try {
      return num.toLocaleString("he-IL", {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
    } catch (e) {
      return num.toFixed(fractionDigits);
    }
  }

  _parseThreeDurations(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d,\/ ]/g, "");
    const parts = cleaned
      .split(/[,/ ]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (parts.length < 3) return null;

    const nums = parts.slice(0, 3).map((p) => parseInt(p, 10));
    if (nums.some((n) => Number.isNaN(n) || n <= 0 || n > 600)) {
      return null;
    }

    const [min, avg, max] = nums;
    if (!(min <= avg && avg <= max)) {
      return null;
    }

    return { min, avg, max };
  }

  // ===== GOAL COLLECT =====

  async _stageGoalCollect(userId, text, state) {
    const goalText = text.trim();

    const db = await this._getDb();
    await db.updateGoal(userId, goalText);

    const ts = state.data.trainingSummary;
    const volume = state.data.volume;
    const ftpModels = state.data.ftpModels || {};
    const personal = state.data.personal || {};
    const hr = state.data.hr || {};
    const trainingTime = state.data.trainingTime || {};

    const lines = [];

    lines.push("סיכום פרופיל הרוכב שלך:");
    lines.push("");

    if (personal.age) lines.push(`• גיל: ${personal.age}`);
    if (personal.weightKg) lines.push(`• משקל: ${personal.weightKg} ק״ג`);
    if (personal.heightCm) lines.push(`• גובה: ${personal.heightCm} ס״מ`);

    lines.push("");

    if (ftpModels.ftpRecommended) {
      lines.push(
        `• FTP מומלץ: ${ftpModels.ftpRecommended.value}W (Recommended FTP)`
      );
    }

    if (hr.hrMax || hr.hrThreshold) {
      lines.push("• דופק:");
      if (hr.hrMax) {
        lines.push(`  - דופק מקסימלי משוער: ${hr.hrMax} bpm`);
      }
      if (hr.hrThreshold) {
        lines.push(`  - דופק סף משוער: ${hr.hrThreshold} bpm`);
      }
    }

    lines.push("");

    if (
      trainingTime.minMinutes ||
      trainingTime.avgMinutes ||
      trainingTime.maxMinutes
    ) {
      lines.push("• זמני אימון טיפוסיים:");
      if (trainingTime.minMinutes) {
        lines.push(`  - קצר: ~${trainingTime.minMinutes} דק׳`);
      }
      if (trainingTime.avgMinutes) {
        lines.push(`  - ממוצע: ~${trainingTime.avgMinutes} דק׳`);
      }
      if (trainingTime.maxMinutes) {
        lines.push(`  - ארוך: ~${trainingTime.maxMinutes} דק׳`);
      }
    }

    lines.push("");
    lines.push(`מטרה שהגדרת: "${goalText}"`);

    const profileText = lines.join("\n");

    state.stage = "done";
    await this._saveState(userId, state);

    return {
      reply: profileText,
      onboarding: false,
      followups: [
        "האונבורדינג שלך הושלם בהצלחה!\n\n" + this._postOnboardingMenu(),
      ],
    };
  }

  // helper פנימי ל-DB
  async _getDb() {
    if (!this.db) {
      throw new Error("DB not configured in OnboardingEngine");
    }
    return this.db;
  }
}
