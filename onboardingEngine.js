// onboardingEngine.js

/**
 * מנוע אונבורדינג ל-LOEW
 *
 * FLOW רשמי:
 * 1) הודעת פתיחה קבועה למשתמש חדש
 * 2) אם יש סטרבה: אינג'סט + סיכום נפח (ללא FTP/דופק)
 * 3) השלמת נתונים אישיים חסרים: גיל, משקל, גובה
 * 4) FTP – הצגת שלושת החישובים + הסבר + אישור/שינוי
 * 5) דופק מקסימלי – הצגת ערך מסטרבה + אישור/שינוי
 * 6) דופק סף – חישוב ראשוני + אישור/שינוי
 * 7) משך אימון טיפוסי – min/avg/max מהנפח + אישור/שינוי
 * 8) מטרה – המשתמש מזין
 * 9) סיכום גדול + פרופיל רוכב + סיום אונבורדינג
 */

const OPENING_MESSAGE = `
נעים מאוד, אני LOEW — המאמן האישי שלך.
אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.

המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים לביצוע, שמתקדמים בקצב הנכון — בלי לשרוף אותך ובלי לפספס פוטנציאל.

בוא נתחיל בלהכיר אותך ואת הנתונים שלך.
`.trim();

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // עוזר קטן – מושך ומאחד state
  async _loadState(userId) {
    const onboardingStateRaw = await this.db.getOnboardingState(userId);

    const onboardingState =
      onboardingStateRaw || {
        stage: null,
        data: {},
      };

    const trainingParams = await this.db.getTrainingParams(userId);

    const data = onboardingState.data || {};
    if (!data.profile) data.profile = {};
    if (!data.ftpModels) data.ftpModels = {};
    if (!data.volume) data.volume = null;
    if (!data.trainingSummary) data.trainingSummary = null;
    if (typeof data.onboardingComplete !== "boolean") {
      data.onboardingComplete = false;
    }

    if (trainingParams) {
      const p = data.profile;

      p.age ??= trainingParams.age ?? null;

      // לא מאשרים משקל אוטומטית – שומרים כ-candidate מהסטרבה
      if (p.weight == null && trainingParams.weight != null) {
        p.weightFromStrava ??= trainingParams.weight;
      }

      p.height ??= trainingParams.height ?? null;
      p.ftp ??= trainingParams.ftp ?? null;
      p.hrMax ??= trainingParams.hr_max ?? null;
      p.hrThreshold ??= trainingParams.hr_threshold ?? null;
      p.minDuration ??= trainingParams.min_duration ?? null;
      p.typicalDuration ??= trainingParams.typical_duration ?? null;
      p.maxDuration ??= trainingParams.max_duration ?? null;
      p.goal ??= trainingParams.goal ?? null;

      // אם ה־DB כבר שמר מודלים של FTP בתוך training_params
      const fm = data.ftpModels;
      fm.ftpFrom20min ??= trainingParams.ftp_from_20min ?? null;
      fm.ftpFrom3minModel ??= trainingParams.ftp_from_3min ?? null;
      fm.ftpFromCP ??= trainingParams.ftp_from_cp ?? null;
      fm.ftpRecommended ??= trainingParams.ftp_recommended ?? null;
      fm.hrMaxCandidate ??= trainingParams.hr_max_candidate ?? null;
      fm.hrThresholdCandidate ??= trainingParams.hr_threshold_candidate ?? null;
      data.ftpModels = fm;
    }

    return {
      stage: onboardingState.stage,
      data,
    };
  }

  async _saveState(userId, state) {
    await this.db.saveOnboardingState(userId, state);

    // אם יש כבר פרופיל מלא יחסית – מעדכנים גם training_params
    const p = state.data.profile || {};
    const hasCore =
      p.ftp != null &&
      p.hrMax != null &&
      p.hrThreshold != null &&
      p.typicalDuration != null;

    if (hasCore) {
      await this.db.saveTrainingParams(userId, {
        age: p.age ?? null,
        weight: p.weight ?? null,
        height: p.height ?? null,
        ftp: p.ftp ?? null,
        hr_max: p.hrMax ?? null,
        hr_threshold: p.hrThreshold ?? null,
        min_duration: p.minDuration ?? null,
        typical_duration: p.typicalDuration ?? null,
        max_duration: p.maxDuration ?? null,
        goal: p.goal ?? null,
      });
    }
  }

  // עוזר: ניסיון להוציא מספר מהטקסט
  _extractNumber(text) {
    const m = String(text).match(/(\d+(\.\d+)?)/);
    if (!m) return null;
    return Number(m[1]);
  }

  _formatMinutes(sec) {
    if (sec == null) return "-";
    const mins = Math.round(sec / 60);
    return `${mins} דק'`;
  }

  /**
   * מוודא שיש לנו volume + trainingSummary + ftpModels מה-DB/Strava
   * אם יש פונקציה ייעודית כמו getStravaOnboardingSnapshot – נשתמש בה.
   * אחרת נ fallback ל-ingestAndComputeFromStrava (שכבר קיים אצלך ב-server.js).
   */
  async _ensureStravaMetrics(userId, state) {
    const d = state.data || {};

    const hasSummary =
      d.trainingSummary && typeof d.trainingSummary === "object";
    const hasVolume = d.volume && typeof d.volume === "object";

    if (hasSummary && hasVolume) {
      return state;
    }

    let metrics = null;
    try {
      if (this.db.getStravaOnboardingSnapshot &&
          typeof this.db.getStravaOnboardingSnapshot === "function") {
        metrics = await this.db.getStravaOnboardingSnapshot(userId);
      } else if (
        this.db.ingestAndComputeFromStrava &&
        typeof this.db.ingestAndComputeFromStrava === "function"
      ) {
        metrics = await this.db.ingestAndComputeFromStrava(userId);
      }
    } catch (err) {
      console.error("_ensureStravaMetrics error:", err);
      return state;
    }

    if (!metrics || typeof metrics !== "object") {
      return state;
    }

    if (metrics.trainingSummary && !d.trainingSummary) {
      d.trainingSummary = metrics.trainingSummary;
    }
    if (metrics.volume && !d.volume) {
      d.volume = metrics.volume;
    }
    if (metrics.ftpModels) {
      d.ftpModels = {
        ...(d.ftpModels || {}),
        ...metrics.ftpModels,
      };
    }

    state.data = d;
    await this._saveState(userId, state);
    return state;
  }

  /**
   * בונה טקסט סיכום Strava לפי trainingSummary ו-volume
   * בלי FTP/דופק – רק נפח.
   */
  _buildStravaSummary(state) {
    const ts = state.data.trainingSummary;
    const volume = state.data.volume;

    if (!ts || typeof ts !== "object") {
      return null;
    }
    if (!ts.rides_count || ts.rides_count <= 0) {
      return null;
    }

    const rides = ts.rides_count;
    const hours = ts.totalMovingTimeSec
      ? (ts.totalMovingTimeSec / 3600).toFixed(1)
      : null;
    const km = ts.totalDistanceKm
      ? ts.totalDistanceKm.toFixed(1)
      : null;
    const elevation = ts.totalElevationGainM
      ? Math.round(ts.totalElevationGainM)
      : null;
    const avgDurStr = ts.avgDurationSec
      ? this._formatMinutes(ts.avgDurationSec)
      : null;
    const offPct =
      ts.offroadPct != null ? Math.round(ts.offroadPct) : null;

    let msg = "לפני שנתחיל, הנה סיכום קצר של 90 הימים האחרונים לפי סטרבה:\n\n";
    msg += `• מספר רכיבות: ${rides}\n`;
    if (hours != null) {
      msg += `• זמן רכיבה מצטבר: ${hours} שעות\n`;
    }
    if (km != null) {
      msg += `• מרחק מצטבר: ${km} ק״מ\n`;
    }
    if (elevation != null) {
      msg += `• טיפוס מצטבר: כ-${elevation} מטר\n`;
    }
    if (avgDurStr != null) {
      msg += `• זמן רכיבה ממוצע: ${avgDurStr}\n`;
    }
    if (offPct != null) {
      msg += `• אחוז שטח משוער: כ-${offPct}%\n`;
    }

    if (volume && typeof volume === "object") {
      if (volume.minDurationSec || volume.avgDurationSec || volume.maxDurationSec) {
        msg += "\nמשכי אימון אופייניים מהנתונים:\n";
        if (volume.minDurationSec) {
          msg += `• קצר טיפוסי: ${this._formatMinutes(
            volume.minDurationSec
          )}\n`;
        }
        if (volume.avgDurationSec) {
          msg += `• ממוצע: ${this._formatMinutes(
            volume.avgDurationSec
          )}\n`;
        }
        if (volume.maxDurationSec) {
          msg += `• ארוך טיפוסי: ${this._formatMinutes(
            volume.maxDurationSec
          )}\n`;
        }
      }
    }

    msg +=
      "\nעכשיו בוא נשלים כמה נתונים אישיים שחסרים לי (גיל, משקל, גובה), כדי שאוכל להתאים אליך את האימונים בצורה מדויקת.";

    return msg;
  }

  // שלב נתונים אישיים – גיל, משקל, גובה
  async _stepPersonalDetails(userId, text, state) {
    const p = state.data.profile;
    const num = this._extractNumber(text);

    // ---- גיל ----
    if (!p.age) {
      if (!num) {
        return {
          reply:
            "כדי שנמשיך, תכתוב לי את הגיל שלך (מספר שנים, למשל 46).",
          onboarding: true,
        };
      }

      p.age = Math.round(num);
      state.data.profile = p;
      await this._saveState(userId, state);

      // האם יש לנו משקל מועמד מסטרבה?
      let weightCandidate = null;
      if (p.weightFromStrava != null) {
        const raw = p.weightFromStrava;
        weightCandidate =
          typeof raw === "number"
            ? Number(raw.toFixed(1))
            : Number(raw);
      } else {
        try {
          const params = await this.db.getTrainingParams(userId);
          if (params && params.weight != null) {
            const raw = params.weight;
            weightCandidate =
              typeof raw === "number"
                ? Number(raw.toFixed(1))
                : Number(raw);
            p.weightFromStrava = weightCandidate;
            state.data.profile = p;
            await this._saveState(userId, state);
          }
        } catch {
          // אם יש בעיה – פשוט נתעלם ונמשיך כרגיל
        }
      }

      if (weightCandidate != null) {
        return {
          reply:
            `רשמתי: גיל ${p.age}.\n` +
            `לפי הנתונים מסטרבה, המשקל שלך הוא בערך ${weightCandidate} ק״ג.\n` +
            `אם זה עדיין נכון, תכתוב לי את המשקל שלך כדי לאשר (למשל "${weightCandidate}"). ואם יש עדכון – תכתוב את המשקל המעודכן שלך בק״ג.`,
          onboarding: true,
        };
      }

      return {
        reply: `רשמתי: גיל ${p.age}.\nמה המשקל הנוכחי שלך בק״ג?`,
        onboarding: true,
      };
    }

    // ---- משקל ----
    if (!p.weight) {
      if (!num) {
        return {
          reply:
            "כדי שנמשיך, תכתוב לי את המשקל שלך בק״ג (למשל 67).",
          onboarding: true,
        };
      }
      const w =
        typeof num === "number" && num.toFixed
          ? Number(num.toFixed(1))
          : Number(num);
      p.weight = w;
      state.data.profile = p;
      await this._saveState(userId, state);
      return {
        reply: `רשמתי: משקל ${p.weight} ק״ג.\nמה הגובה שלך בס״מ?`,
        onboarding: true,
      };
    }

    // ---- גובה ----
    if (!p.height) {
      if (!num) {
        return {
          reply:
            "כדי שנמשיך, תכתוב לי את הגובה שלך בס״מ (למשל 178).",
          onboarding: true,
        };
      }
      p.height = Math.round(num);
      state.data.profile = p;
      state.stage = "ftp";
      await this._saveState(userId, state);

      // עוברים ל-FTP
      return await this._stepFtp(userId, "", state);
    }

    // אם כבר מילאנו הכול – ממשיכים ל-FTP
    state.stage = "ftp";
    await this._saveState(userId, state);
    return await this._stepFtp(userId, text, state);
  }

  // שלב FTP
  async _stepFtp(userId, text, state) {
    const p = state.data.profile;

    // ----- שליפת מודלים של FTP מה-DB + מה-state -----
    const trainingParams = await this.db.getTrainingParams(userId);
    const modelsFromState = state.data.ftpModels || {};

    const ftpFrom20min =
      modelsFromState.ftpFrom20min ??
      (trainingParams ? trainingParams.ftp_from_20min : null);

    const ftpFrom3min =
      modelsFromState.ftpFrom3minModel ??
      (trainingParams ? trainingParams.ftp_from_3min : null);

    const ftpFromCP =
      modelsFromState.ftpFromCP ??
      (trainingParams ? trainingParams.ftp_from_cp : null);

    const ftpRecommended =
      modelsFromState.ftpRecommended ??
      (trainingParams ? trainingParams.ftp_recommended : null);

    // מעדכן ב-state כדי שיהיה זמין גם לשלבים הבאים
    state.data.ftpModels = {
      ...modelsFromState,
      ftpFrom20min,
      ftpFrom3minModel: ftpFrom3min,
      ftpFromCP,
      ftpRecommended,
    };

    // ----- אם כבר יש FTP בפרופיל → ממשיכים לדופק מקסימלי -----
    if (p.ftp) {
      state.stage = "hr_max";
      await this._saveState(userId, state);
      return await this._stepHrMax(userId, text, state);
    }

    // מנסה להוציא מספר אם המשתמש כתב FTP ידנית
    const num = this._extractNumber(text);
    if (num) {
      p.ftp = Math.round(num);
      state.data.profile = p;
      state.stage = "hr_max";
      await this._saveState(userId, state);
      return await this._stepHrMax(userId, "", state);
    }

    // ----- מציג חישובים למשתמש -----
    const f20 =
      ftpFrom20min != null ? `${ftpFrom20min}W` : "אין מספיק נתונים";
    const f3 =
      ftpFrom3min != null ? `${ftpFrom3min}W` : "אין מספיק נתונים";
    const fcp =
      ftpFromCP != null ? `${ftpFromCP}W` : "אין מספיק נתונים";
    const frec =
      ftpRecommended != null ? `${ftpRecommended}W` : "אין מספיק נתונים";

    const msg =
      "עבור FTP חישבתי כמה מודלים שונים מהנתונים שלך (אם היו מספיק רכיבות עם וואטים):\n\n" +
      `• מודל 20 דקות: ${f20}\n` +
      `• מודל 3 דקות (Power Curve): ${f3}\n` +
      `• מודל קריטי (CP): ${fcp}\n\n` +
      `לפי כל אלו, ההמלצה שלי ל-FTP התחלתי היא: ${frec}.\n\n` +
      'אם הערך הזה נשמע לך הגיוני, תכתוב לי אותו (למשל "FTP 240"). אם אתה יודע ערך אחר שמתאים יותר למציאות – תכתוב אותו ואני אעדכן.';

    return { reply: msg, onboarding: true };
  }

  // שלב דופק מקסימלי
  async _stepHrMax(userId, text, state) {
    const params = await this.db.getTrainingParams(userId);
    const storedHrMax = params?.hr_max ?? null;
    const p = state.data.profile;
    const models = state.data.ftpModels || {};
    const num = this._extractNumber(text);

    if (!p.hrMax) {
      if (num) {
        p.hrMax = Math.round(num);
        state.data.profile = p;
        state.stage = "hr_threshold";
        await this._saveState(userId, state);
        return await this._stepHrThreshold(userId, "", state);
      }

      const candidate = models.hrMaxCandidate ?? storedHrMax ?? null;

      let base = "בוא נגדיר את הדופק המקסימלי שלך.\n";
      if (candidate) {
        base += `לפי הרכיבות בסטרבה, הערכה ראשונית לדופק מקסימלי היא בערך ${candidate}.\n`;
      }
      base +=
        "תכתוב לי מה אתה חושב שהדופק המקסימלי שלך (למשל 180). אם אתה לא בטוח, אפשר לאמץ את הערך המשוער מהנתונים.";

      return { reply: base, onboarding: true };
    }

    // אם כבר יש hrMax → ממשיכים לסף
    state.stage = "hr_threshold";
    await this._saveState(userId, state);
    return await this._stepHrThreshold(userId, text, state);
  }

  // שלב דופק סף
  async _stepHrThreshold(userId, text, state) {
    const p = state.data.profile;
    const models = state.data.ftpModels || {};
    const num = this._extractNumber(text);

    if (!p.hrThreshold) {
      if (num) {
        p.hrThreshold = Math.round(num);
        state.data.profile = p;
        state.stage = "training_duration";
        await this._saveState(userId, state);
        return await this._stepTrainingDuration(userId, "", state);
      }

      let candidate = null;
      if (models.hrThresholdCandidate) {
        candidate = models.hrThresholdCandidate;
      } else if (p.hrMax) {
        candidate = Math.round(p.hrMax * 0.9);
      }

      let base =
        "עכשיו נגדיר דופק סף (הדופק שבו אתה רוכב באיזור סף/זמן ממושך).\n";
      if (candidate) {
        base += `לפי הנתונים, הערכה ראשונית לדופק סף היא סביב ${candidate}.\n`;
      }
      base +=
        "תכתוב לי מה אתה חושב שהדופק סף שלך (למשל 165). אם אתה לא בטוח, אפשר לאשר את הערך המשוער.";

      return { reply: base, onboarding: true };
    }

    // אם כבר יש – ממשיכים למשך אימון
    state.stage = "training_duration";
    await this._saveState(userId, state);
    return await this._stepTrainingDuration(userId, text, state);
  }

  // שלב משכי אימון טיפוסיים
  async _stepTrainingDuration(userId, text, state) {
    const p = state.data.profile;
    const volume = state.data.volume;
    const num = this._extractNumber(text);

    // אם עדיין לא הגדרנו משכי אימון
    if (!p.minDuration || !p.typicalDuration || !p.maxDuration) {
      // אם המשתמש ענה במספר – נשתמש בו כ"טיפוסי" ונשען על הווליום לקצר/ארוך
      if (num) {
        const minutes = Math.round(num);
        const sec = minutes * 60;

        if (!p.typicalDuration) {
          p.typicalDuration = sec;
        }
        if (!p.minDuration) {
          p.minDuration =
            volume && volume.minDurationSec
              ? volume.minDurationSec
              : sec;
        }
        if (!p.maxDuration) {
          p.maxDuration =
            volume && volume.maxDurationSec
              ? volume.maxDurationSec
              : sec;
        }

        state.data.profile = p;
        state.stage = "goal";
        await this._saveState(userId, state);
        return await this._stepGoal(userId, "", state);
      }

      let base =
        "בוא נגדיר את משך האימון הרגיל שלך (או מה היית רוצה שיהיה).\n";

      if (volume && volume.ridesCount > 0) {
        base +=
          "לפי הרכיבות האחרונות שלך אני רואה בקירוב:\n" +
          `• קצר טיפוסי: ${this._formatMinutes(
            volume.minDurationSec
          )}\n` +
          `• ממוצע: ${this._formatMinutes(volume.avgDurationSec)}\n` +
          `• ארוך טיפוסי: ${this._formatMinutes(
            volume.maxDurationSec
          )}\n\n`;
      }

      base +=
        'תכתוב לי כמה דקות אתה רוצה שיהיה משך אימון "רגיל" שלך (למשל 90 או 120).';

      return { reply: base, onboarding: true };
    }

    // אם כבר הוגדר – ממשיכים למטרה
    state.stage = "goal";
    await this._saveState(userId, state);
    return await this._stepGoal(userId, text, state);
  }

  // שלב מטרה
  async _stepGoal(userId, text, state) {
    const p = state.data.profile;

    if (!p.goal) {
      const clean = text.trim();
      if (!clean) {
        return {
          reply:
            "מה המטרה העיקרית שלך בתקופה הקרובה? זה יכול להיות אירוע (למשל GF אילת), שיפור FTP, ירידה במשקל או כל דבר אחר.",
          onboarding: true,
        };
      }
      p.goal = clean;
      state.data.profile = p;
      state.stage = "summary";
      await this._saveState(userId, state);
      return await this._stepSummary(userId, "", state);
    }

    state.stage = "summary";
    await this._saveState(userId, state);
    return await this._stepSummary(userId, text, state);
  }

  // סיכום סופי
  async _stepSummary(userId, text, state) {
    const p = state.data.profile;

    state.data.onboardingComplete = true;
    state.stage = "summary_done";
    await this._saveState(userId, state);

    const ftpStr = p.ftp ? `${p.ftp}W` : "לא הוגדר";
    const hrMaxStr = p.hrMax ? `${p.hrMax}` : "לא הוגדר";
    const hrThStr = p.hrThreshold ? `${p.hrThreshold}` : "לא הוגדר";
    const minStr = this._formatMinutes(p.minDuration);
    const typStr = this._formatMinutes(p.typicalDuration);
    const maxStr = this._formatMinutes(p.maxDuration);
    const goalStr = p.goal || "לא הוגדרה מטרה מפורשת";

    const summary =
      "סיכום אונבורדינג ✅\n\n" +
      `• גיל: ${p.age ?? "-"}\n` +
      `• משקל: ${p.weight ?? "-"} ק״ג\n` +
      `• גובה: ${p.height ?? "-"} ס״מ\n\n` +
      `• FTP: ${ftpStr}\n` +
      `• דופק מקסימלי: ${hrMaxStr}\n` +
      `• דופק סף: ${hrThStr}\n\n` +
      `• משך אימון מינימלי: ${minStr}\n` +
      `• משך אימון רגיל: ${typStr}\n` +
      `• משך אימון ארוך: ${maxStr}\n\n` +
      `• מטרה: ${goalStr}\n\n` +
      "מכאן נוכל להתחיל לתכנן עבורך אימונים חכמים, הדרגתיים ומותאמים אישית.\n" +
      'בכל רגע תוכל לבקש לעדכן נתון (FTP, דופק, מטרה) או לשאול: "מה האימון שלי למחר?"';

    return { reply: summary, onboarding: true };
  }

  /**
   * API ראשי לצ'אט – זה מה שהשרת קורא בכל /api/loew/chat
   */
  async handleMessage(userId, text) {
    const cleanText = (text ?? "").toString().trim();

    // טוען את ה-state
    let state = await this._loadState(userId);

    // אם אין stage — משתמש חדש → הודעת פתיחה
    if (!state.stage) {
      state.stage = "opening";
      await this._saveState(userId, state);

      return {
        reply: OPENING_MESSAGE,
        onboarding: true,
      };
    }

    switch (state.stage) {
      case "opening": {
        // כאן נכנס FLOW רשמי של שלב 2 – סיכום סטרבה + מעבר לנתונים אישיים
        state = await this._ensureStravaMetrics(userId, state);
        const summaryText = this._buildStravaSummary(state);

        state.stage = "personal_details";
        await this._saveState(userId, state);

        // יוצרים שאלה ראשונה של נתונים אישיים (גיל)
        const personalStep = await this._stepPersonalDetails(
          userId,
          "",
          state
        );

        if (summaryText) {
          return {
            reply: summaryText + "\n\n" + personalStep.reply,
            onboarding: true,
          };
        }

        // אם אין לנו מספיק נתונים לסיכום – נדלג עליו
        return personalStep;
      }

      case "personal_details":
        return await this._stepPersonalDetails(userId, cleanText, state);

      case "ftp":
        return await this._stepFtp(userId, cleanText, state);

      case "hr_max":
        return await this._stepHrMax(userId, cleanText, state);

      case "hr_threshold":
        return await this._stepHrThreshold(userId, cleanText, state);

      case "training_duration":
        return await this._stepTrainingDuration(userId, cleanText, state);

      case "goal":
        return await this._stepGoal(userId, cleanText, state);

      case "summary":
        return await this._stepSummary(userId, cleanText, state);

      case "summary_done":
        return {
          reply:
            "האונבורדינג כבר הושלם. מעכשיו אתה יכול לשאול אותי על אימונים, עומסים, FTP, או פשוט: \"מה האימון שלי למחר?\"",
          onboarding: false,
        };

      default:
        return {
          reply:
            'אירעה שגיאה: שלב לא מוכר באונבורדינג. אפשר לכתוב לי "התחל אונבורדינג" כדי להתחיל מחדש.',
          onboarding: true,
        };
    }
  }

  /**
   * נקודת כניסה אחרי חיבור סטרבה (לא חובה, אבל שימושי):
   * אפשר לקרוא לזה מ-/exchange_token אחרי ingestAndComputeFromStrava.
   */
  async handleStravaConnected(userId) {
    try {
      if (
        this.db.ingestAndComputeFromStrava &&
        typeof this.db.ingestAndComputeFromStrava === "function"
      ) {
        await this.db.ingestAndComputeFromStrava(userId);
      }
    } catch (err) {
      console.error("handleStravaConnected error:", err);
    }

    let state = await this._loadState(userId);

    if (!state.stage) {
      state.stage = "opening";
    }

    await this._saveState(userId, state);

    return {
      reply:
        "סיימתי לייבא את הנתונים מסטרבה ולהכין עבורך נתוני בסיס.\n" +
        "בוא נמשיך ונשלים כמה נתונים אישיים בסיסיים (גיל, משקל, גובה).",
      onboarding: true,
    };
  }
}

/**
 * פונקציית מפעל נוחה לשרת
 */
export function createOnboardingEngine(dbImpl) {
  return new OnboardingEngine(dbImpl);
}
