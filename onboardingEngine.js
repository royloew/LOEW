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

  // 🔹 תפריט ברירת מחדל אחרי אונבורדינג
  _postOnboardingMenu() {
    return (
      "האונבורדינג שלך הושלם בהצלחה!\n" +
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

    // ===== STAGE: INTRO =====

  async _stageIntro(userId, text, state) {
    state.data = state.data || {};

    const firstVisit = !state.data.introShown;
    const t = (text || "").trim();

    // פעם ראשונה תמיד נציג את הודעת הפתיחה, בלי קשר למה הגיע מהצ'אט ("היי" אוטומטי וכו')
    if (firstVisit) {
      state.data.introShown = true;
      await this._saveState(userId, state);

      return {
        reply:
          "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
          "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n" +
          "כדי להתחיל, אני צריך להתחבר ל-Strava שלך ולנתח את הרכיבות האחרונות.\n" +
          "כשתאשר את החיבור, אייבא את הנתונים ואציג לך סיכום קצר של נפח האימונים שלך.",
        onboarding: true,
      };
    }

    // מפה זו כבר לא הפעם הראשונה ב-intro:
    // אם אין טקסט – אפשר בעדינות להזכיר מה צריך לעשות
    if (!t) {
      return {
        reply:
          "כדי להמשיך, תאשר את החיבור לסטרבה מהלינק למעלה.\n" +
          "אחרי החיבור אייבא את הרכיבות האחרונות שלך ונמשיך לנתונים האישיים.",
        onboarding: true,
      };
    }

    // אם יש טקסט (פעם שנייה ואילך) – עוברים לשלב הבא: strava_wait
    state.stage = "strava_wait";
    await this._saveState(userId, state);

    return {
      reply:
        "מעולה. ברגע שתאשר את החיבור לסטרבה, אייבא את הרכיבות שלך ואציג לך סיכום קצר.\n" +
        "אחרי זה נעבור לנתונים האישיים, FTP, דופק, משכי אימון ומטרה.",
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

    if (ts && ts.rides_count > 0) {
      const hours = (ts.totalMovingTimeSec / 3600).toFixed(1);
      const km = ts.totalDistanceKm.toFixed(1);
      const elevation = Math.round(ts.totalElevationGainM);
      const avgMin = Math.round(ts.avgDurationSec / 60);
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct * 100) : null;

      let profileLine = `ב-90 הימים האחרונים רכבת ${ts.rides_count} פעמים, `;
      profileLine += `סה\"כ ~${hours} שעות ו-${km} ק\"מ עם ${elevation} מטר טיפוס. `;
      profileLine += `משך רכיבה ממוצע ~${avgMin} דקות.`;
      if (offPct != null) {
        profileLine += ` כ-${offPct}% מהרכיבות היו שטח (off-road).`;
      }

      let volLine = "";
      if (volume && volume.weeksCount > 0) {
        const wHours = volume.weeklyHoursAvg.toFixed(1);
        const wRides = volume.weeklyRidesAvg.toFixed(1);
        volLine =
          `\n\nבממוצע שבועי זה יוצא ~${wHours} שעות ו-${wRides} רכיבות לשבוע ` +
          `(על בסיס ${volume.weeksCount} שבועות אחרונים).`;
      }

      state.stage = "personal_details";
      await this._saveState(userId, state);

      return {
        reply:
          "סיימתי לייבא נתונים מסטרבה ✅\n\n" +
          profileLine +
          volLine +
          "\n\nעכשיו נעבור לנתונים האישיים שלך — משקל, גובה וגיל.",
        onboarding: true,
      };
    }

    state.stage = "personal_details";
    await this._saveState(userId, state);

    return {
      reply:
        "לא מצאתי מספיק רכיבות מ-90 הימים האחרונים כדי להציג סיכום נפח.\n" +
        "בוא נעבור לנתונים האישיים שלך.",
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
            `בסטרבה מופיע ${weightFromStrava} ק\"ג.\n` +
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
            `מעולה, אשתמש במשקל ${weightFromStrava} ק\"ג.\n\n` +
            'מה הגובה שלך בס"מ?',
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
        reply:
          `תודה, עדכנתי משקל ${state.data.personal.weight} ק\"ג.\n\n` +
          'מה הגובה שלך בס"מ?',
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
        reply: `מעולה, עדכנתי גובה ${h} ס\"מ.\n\nבן כמה אתה?`,
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

      return {
        reply:
          `מעולה, עדכנתי גיל ${age}.\n\n` +
          "עכשיו נעבור לשלב FTP — הסמן המרכזי לעומס ולרמת הקושי באימונים שלך.",
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
            candidates.sort((a, b) => a - b)[Math.floor(candidates.length / 2)]
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

    return {
      reply:
        `מעולה, נגדיר כרגע FTP של ${parsed}W.\n\n` +
        "עכשיו נעבור לדופק — דופק מקסימלי ודופק סף.",
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

        return {
          reply:
            `מעולה, נשתמש בדופק מקסימלי ${hrMaxCandidate} bpm.\n\n` +
            "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'.",
          onboarding: true,
        };
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

      return {
        reply:
          `תודה, עדכנתי דופק מקסימלי ${parsed} bpm.\n\n` +
          "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'.",
        onboarding: true,
      };
    }

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
    const t = (text || "").trim();

    if (!t) {
      return {
        reply: "מה המטרה המרכזית שלך לתקופה הקרובה?",
        onboarding: true,
      };
    }

    state.data.goal = t;
    state.stage = "done";
    await this._saveState(userId, state);

    // הודעת סיום אונבורדינג – משתמש חדש
    return {
      reply: this._postOnboardingMenu(),
      onboarding: true,
    };
  }
}
