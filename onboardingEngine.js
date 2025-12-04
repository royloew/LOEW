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

      const fm = data.ftpModels;
      fm.ftpFrom20min ??= trainingParams.ftp_from_20min ?? null;
      fm.ftpFrom3minModel ??= trainingParams.ftp_from_3min ?? null;
      fm.ftpFromCP ??= trainingParams.ftp_from_cp ?? null;
      fm.ftpRecommended ??= trainingParams.ftp_recommended ?? null;
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
        ftp_from_20min: state.data.ftpModels?.ftpFrom20min ?? null,
        ftp_from_3min: state.data.ftpModels?.ftpFrom3minModel ?? null,
        ftp_from_cp: state.data.ftpModels?.ftpFromCP ?? null,
        ftp_recommended: state.data.ftpModels?.ftpRecommended ?? null,
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
      if (
        this.db.getStravaOnboardingSnapshot &&
        typeof this.db.getStravaOnboardingSnapshot === "function"
      ) {
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
    const km = ts.totalDistanceKm ? ts.totalDistanceKm.toFixed(1) : null;
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
      if (
        volume.minDurationSec ||
        volume.avgDurationSec ||
        volume.maxDurationSec
      ) {
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
          typeof raw === "number" ? Number(raw.toFixed(1)) : Number(raw);
      } else {
        try {
          const params = await this.db.getTrainingParams(userId);
          if (params && params.weight != null) {
            const raw = params.weight;
            weightCandidate =
              typeof raw === "number" ? Number(raw.toFixed(1)) : Number(raw);
            p.weightFromStrava = weightCandidate;
            state.data.profile = p;
            await this._saveState(userId, state);
          }
        } catch {
          // מתעלמים משגיאה
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
            "מעולה. עכשיו תכתוב לי את הגובה שלך בס״מ (למשל 180).",
          onboarding: true,
        };
      }
      p.height = Math.round(num);
      state.data.profile = p;
      await this._saveState(userId, state);

      // אחרי שסיימנו נתונים אישיים עוברים ל-FTP
      state.stage = "ftp_intro";
      await this._saveState(userId, state);

      return {
        reply:
          `רשמתי: גובה ${p.height} ס״מ.\n\n` +
          "עכשיו נעבור ל-FTP – הסף האנאירובי שלך באופניים. אני אציג לך כמה חישובים מהנתונים בסטרבה, ואתה תאשר או תתקן.",
        onboarding: true,
      };
    }

    // אם כבר יש הכל – ממשיכים ל-FTP
    state.stage = "ftp_intro";
    await this._saveState(userId, state);
    return {
      reply:
        "כבר יש לי את הנתונים הבסיסיים שלך (גיל, משקל, גובה).\nנעבור לחישוב ואישור FTP.",
      onboarding: true,
    };
  }

  // שלב FTP – הצגת שלושת החישובים + אישור
  async _stepFTP(userId, text, state) {
    const p = state.data.profile;
    const fm = state.data.ftpModels || {};
    const num = this._extractNumber(text);

    if (state.stage === "ftp_intro") {
      // מוודא שיש לנו מודלים
      const metrics = await this.db.getStravaOnboardingSnapshot(userId);
      if (metrics && metrics.ftpModels) {
        state.data.ftpModels = {
          ...state.data.ftpModels,
          ...metrics.ftpModels,
        };
        await this._saveState(userId, state);
      }

      const f20 = state.data.ftpModels?.ftpFrom20min || null;
      const f3 = state.data.ftpModels?.ftpFrom3minModel || null;
      const fcp = state.data.ftpModels?.ftpFromCP || null;
      const frec = state.data.ftpModels?.ftpRecommended || null;

      if (!f20 && !f3 && !fcp && !frec) {
        state.stage = "ftp_manual";
        await this._saveState(userId, state);
        return {
          reply:
            "לא מצאתי מספיק רכיבות עם וואטים בסטרבה כדי להעריך FTP בצורה אוטומטית.\nתכתוב לי מה אתה חושב שה-FTP שלך (למשל 240).",
          onboarding: true,
        };
      }

      let msg =
        "עבור FTP חישבתי כמה מודלים שונים מהנתונים שלך (אם היו מספיק רכיבות עם וואטים):\n\n";
      if (f20) msg += `• מודל 20 דקות: ${f20}W\n`;
      if (f3) msg += `• מודל 3 דקות (Power Curve): ${f3}W\n`;
      if (fcp) msg += `• מודל קריטי (CP): ${fcp}W\n`;

      if (frec) {
        msg +=
          `\nלפי כל אלו, ההמלצה שלי ל-FTP התחלתי היא: ${frec}W.\n\n` +
          'אם הערך הזה נשמע לך הגיוני, תכתוב לי אותו (למשל "FTP 240"). אם אתה יודע ערך אחר שמתאים יותר למציאות – תכתוב אותו ואני אעדכן.';
      } else {
        msg +=
          "\nאם אחד הערכים האלו נראה לך נכון, תכתוב לי אותו (למשל \"FTP 240\"). אם אתה יודע ערך אחר שמתאים יותר למציאות – תכתוב אותו ואני אעדכן.";
      }

      state.stage = "ftp_value";
      await this._saveState(userId, state);

      return {
        reply: msg,
        onboarding: true,
      };
    }

    // ftp_value / ftp_manual – מצפה למספר
    if (!num) {
      return {
        reply:
          "כדי שאדע לעבוד, תכתוב לי מספר ל-FTP שלך בוואט (למשל 240).",
        onboarding: true,
      };
    }

    p.ftp = Math.round(num);
    state.data.profile = p;
    state.stage = "hr_max";
    await this._saveState(userId, state);

    return {
      reply:
        `רשמתי: FTP ${p.ftp}W.\n\n` +
        "עכשיו נגדיר את הדופק המקסימלי שלך.\nתכתוב לי מה אתה חושב שהדופק המקסימלי שלך (למשל 180). אם אתה לא בטוח, אפשר לאמץ את הערך המשוער מהנתונים.",
      onboarding: true,
    };
  }

  // שלב דופק מקסימלי + דופק סף
  async _stepHeartRate(userId, text, state) {
    const p = state.data.profile;
    const num = this._extractNumber(text);

    if (state.stage === "hr_max") {
      if (!num) {
        return {
          reply:
            "תכתוב לי מה אתה חושב שהדופק המקסימלי שלך (למשל 180).",
          onboarding: true,
        };
      }
      p.hrMax = Math.round(num);
      state.data.profile = p;
      state.stage = "hr_threshold";
      await this._saveState(userId, state);

      const suggested = Math.round(p.hrMax * 0.9);
      return {
        reply:
          `רשמתי: דופק מקסימלי ${p.hrMax}.\n` +
          `לפי זה, דופק הסף (threshold) המשוער הוא בערך ${suggested}.\n` +
          'אם זה נשמע לך נכון, תכתוב לי אותו (למשל "165"). אם לא – תכתוב את הערך שאתה חושב שמתאים.',
        onboarding: true,
      };
    }

    // hr_threshold
    if (!num) {
      return {
        reply:
          "תכתוב לי את הדופק בסף (threshold) שלך – למשל 165.",
        onboarding: true,
      };
    }

    p.hrThreshold = Math.round(num);
    state.data.profile = p;
    state.stage = "duration_intro";
    await this._saveState(userId, state);

    // עוברים למשך אימון טיפוסי
    return await this._stepTrainingDuration(userId, null, state, true);
  }

  // משך אימון טיפוסי – משתמש ב-volume (min/avg/max שונים)
  async _stepTrainingDuration(userId, text, state, firstTime = false) {
    const p = state.data.profile;
    const volume = state.data.volume;
    const num = text != null ? this._extractNumber(text) : null;

    if (p.typicalDuration && !firstTime && num == null) {
      // כבר הגדרנו – לא צריך שוב
      state.stage = "goal";
      await this._saveState(userId, state);
      return {
        reply:
          "כבר יש לי משך אימון טיפוסי עבורך. נעבור עכשיו להגדרת המטרה שלך.",
        onboarding: true,
      };
    }

    if (num == null) {
      let suggestionStr = "";
      if (volume) {
        const minStr = volume.minDurationSec
          ? this._formatMinutes(volume.minDurationSec)
          : null;
        const avgStr = volume.avgDurationSec
          ? this._formatMinutes(volume.avgDurationSec)
          : null;
        const maxStr = volume.maxDurationSec
          ? this._formatMinutes(volume.maxDurationSec)
          : null;

        if (minStr || avgStr || maxStr) {
          suggestionStr = "\n\nלפי הנתונים שלך, בערך:\n";
          if (minStr) suggestionStr += `• קצר טיפוסי: ${minStr}\n`;
          if (avgStr) suggestionStr += `• ממוצע: ${avgStr}\n`;
          if (maxStr) suggestionStr += `• ארוך טיפוסי: ${maxStr}\n`;
        }
      }

      return {
        reply:
          "בוא נגדיר את משך האימון ה'רגיל' שלך.\n" +
          "תכתוב לי כמה דקות אתה רוצה שיהיה משך אימון מינימלי 'רגיל' (למשל 90 או 120)." +
          suggestionStr,
        onboarding: true,
      };
    }

    // כאן num != null – זה משך האימון המינימלי הרגיל בדקות
    const minMinutes = Math.round(num);
    p.minDuration = minMinutes * 60;

    // אם יש נתוני volume – נשתמש בהם לשאר; אחרת נשמור הכל כ-min
    if (volume) {
      p.typicalDuration =
        volume.avgDurationSec != null
          ? Math.round(volume.avgDurationSec)
          : p.minDuration;
      p.maxDuration =
        volume.maxDurationSec != null
          ? Math.round(volume.maxDurationSec)
          : p.typicalDuration;
    } else {
      p.typicalDuration = p.minDuration;
      p.maxDuration = p.minDuration;
    }

    state.data.profile = p;
    state.stage = "goal";
    await this._saveState(userId, state);

    return {
      reply:
        `רשמתי: משך אימון מינימלי רגיל כ-${minMinutes} דקות.\n` +
        "עכשיו נגדיר את המטרה שלך – תכתוב לי מה המטרה העיקרית שלך בתקופה הקרובה (אירוע, עליית FTP, ירידה במשקל, וכו').",
      onboarding: true,
    };
  }

  // מטרה
  async _stepGoal(userId, text, state) {
    const p = state.data.profile;
    const t = (text || "").trim();

    if (!t) {
      return {
        reply:
          "תכתוב לי במילים שלך מה המטרה העיקרית שלך בתקופה הקרובה.\n" +
          "למשל: \"להתכונן לגרן פונדו אילת\", \"להעלות FTP ל-270W\", \"להיכנס לכושר אחרי פציעה\".",
        onboarding: true,
      };
    }

    p.goal = t;
    state.data.profile = p;
    state.data.onboardingComplete = true;
    state.stage = "summary";
    await this._saveState(userId, state);

    const minutes = (sec) =>
      sec != null ? Math.round(sec / 60) + " דק'" : "-";

    const summary =
      "מעולה, יש לי את כל מה שאני צריך כדי להתחיל לעבוד בשבילך.\n\n" +
      "הנה סיכום הפרופיל שלך:\n\n" +
      `• גיל: ${p.age ?? "-"}\n` +
      `• משקל: ${p.weight ?? "-"} ק״ג\n` +
      `• גובה: ${p.height ?? "-"} ס״מ\n` +
      `• FTP: ${p.ftp ?? "-"}W\n` +
      `• דופק מקסימלי: ${p.hrMax ?? "-"}\n` +
      `• דופק סף: ${p.hrThreshold ?? "-"}\n` +
      `• משך אימון מינימלי: ${minutes(p.minDuration)}\n` +
      `• משך אימון טיפוסי: ${minutes(p.typicalDuration)}\n` +
      `• משך אימון ארוך: ${minutes(p.maxDuration)}\n` +
      `• מטרה: ${p.goal || "-"}\n\n` +
      "מכאן נוכל להתחיל לבנות אימונים חכמים שמתאימים בדיוק אליך. בכל רגע תוכל לשאול אותי על אימונים, עומסים, התאוששות וכל מה שמעניין אותך.";

    return {
      reply: summary,
      onboarding: true,
    };
  }

  // ===== MAIN HANDLE =====

  async handleMessage(userId, text) {
    let state = await this._loadState(userId);

    // אם סיימנו אונבורדינג – מתנהגים כצ'אט רגיל
    if (state.data.onboardingComplete) {
      // פה בעתיד אפשר להעביר ל"מאמן" הרגיל
      return {
        reply:
          "האונבורדינג שלך כבר הושלם. כרגע החלק של המאמן הרגיל עדיין בפיתוח, אבל אתה יכול לשאול אותי כל שאלה על אימונים ואני אנסה לעזור 🙂",
        onboarding: false,
      };
    }

    // שלב ראשון – stage ריק
    if (!state.stage) {
      state.stage = "intro";
      await this._saveState(userId, state);

      // ננסה להביא נתוני סטרבה לתוך state (trainingSummary + volume)
      state = await this._ensureStravaMetrics(userId, state);
      const summary = this._buildStravaSummary(state);

      if (!summary) {
        // אין מספיק רכיבות – נשארים עם הודעת פתיחה ומיד עוברים לנתונים אישיים
        state.stage = "personal_details";
        await this._saveState(userId, state);
        return {
          reply:
            OPENING_MESSAGE +
            "\n\nלא מצאתי מספיק רכיבות מ־90 הימים האחרונים כדי להציג סיכום נפח.\nבוא נעבור לנתונים האישיים שלך.",
          onboarding: true,
        };
      }

      state.stage = "personal_details";
      await this._saveState(userId, state);

      return {
        reply: OPENING_MESSAGE + "\n\n" + summary,
        onboarding: true,
      };
    }

    // ממשיכים לפי stage
    if (state.stage === "personal_details") {
      return await this._stepPersonalDetails(userId, text, state);
    }

    if (state.stage === "ftp_intro" || state.stage === "ftp_value" || state.stage === "ftp_manual") {
      return await this._stepFTP(userId, text, state);
    }

    if (state.stage === "hr_max" || state.stage === "hr_threshold") {
      return await this._stepHeartRate(userId, text, state);
    }

    if (state.stage === "duration_intro") {
      return await this._stepTrainingDuration(userId, text, state, false);
    }

    if (state.stage === "goal") {
      return await this._stepGoal(userId, text, state);
    }

    if (state.stage === "summary") {
      return {
        reply:
          "האונבורדינג שלך הושלם. אם תרצה לשנות נתון (FTP, דופק, משך אימון, מטרה) פשוט תכתוב לי מה לעדכן.",
        onboarding: true,
      };
    }

    // fallback
    return {
      reply:
        "אני באמצע תהליך אונבורדינג אבל איבדתי קצת כיוון 😅\n" +
        "בוא נתחיל שוב מהתחלה – תכתוב לי כל דבר ואני אתחיל מחדש.",
      onboarding: true,
    };
  }
}
