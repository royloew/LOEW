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
    const onboardingState = await this.db.getOnboardingState(userId);
    const trainingParams = await this.db.getTrainingParams(userId);

    const data = onboardingState.data || {};

    if (!data.profile) data.profile = {};
    if (!data.ftpModels) data.ftpModels = {};
    if (!data.volume) data.volume = null;
    if (typeof data.onboardingComplete !== "boolean") {
      data.onboardingComplete = false;
    }

    // משיכת נתונים קיימים מפרמטרים – כדי לא לאבד
    if (trainingParams) {
      data.profile.age ??= trainingParams.age ?? null;
      data.profile.weight ??= trainingParams.weight ?? null;
      data.profile.height ??= trainingParams.height ?? null;
      data.profile.ftp ??= trainingParams.ftp ?? null;
      data.profile.hrMax ??= trainingParams.hr_max ?? null;
      data.profile.hrThreshold ??= trainingParams.hr_threshold ?? null;
      data.profile.minDuration ??= trainingParams.min_duration ?? null;
      data.profile.typicalDuration ??= trainingParams.typical_duration ?? null;
      data.profile.maxDuration ??= trainingParams.max_duration ?? null;
      data.profile.goal ??= trainingParams.goal ?? null;
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

  async _ensureStravaMetrics(userId, state) {
    // אם כבר יש volume + מודלים של FTP/דופק – לא צריך שוב
    if (state.data.volume && state.data.ftpModels && state.data.ftpModels.ftpRecommended) {
      return state;
    }

    // מנסה להביא מה-DB אם כבר קיימות פעילויות
    const volumeFromDb = await this.db.getVolumeSummaryFromDb(userId);
    if (volumeFromDb) {
      state.data.volume = volumeFromDb;
      // אין לנו כאן ftpModels, נשאיר null – נטפל מאוחר יותר אם צריך
      return state;
    }

    // אחרת – מבצע אינג'סט מסטרבה
    const metrics = await this.db.ingestAndComputeFromStrava(userId);
    if (!metrics) {
      // אין סטרבה או כשל – ממשיכים בלי
      return state;
    }

    state.data.volume = metrics.volumeSummary || null;
    state.data.ftpModels = {
      ftpFrom20min: metrics.ftpFrom20min ?? null,
      ftpFrom3minModel: metrics.ftpFrom3minModel ?? null,
      ftpFromCP: metrics.ftpFromCP ?? null,
      ftpRecommended: metrics.ftpRecommended ?? null,
      hrMaxCandidate: metrics.hrMaxCandidate ?? null,
      hrThresholdCandidate: metrics.hrThresholdCandidate ?? null,
    };

    return state;
  }

  // ===== MAIN PUBLIC METHOD =====
  async handleMessage(userId, message) {
    let state = await this._loadState(userId);
    const text = message.trim();

    // אם האונבורדינג כבר הושלם – מצב צ'אט רגיל
    if (state.data.onboardingComplete) {
      return this._handleRegularChat(userId, text, state);
    }

    // אם אין stage – זו הודעה ראשונה → הודעת פתיחה
        // אם אין stage – זו הודעה ראשונה
    if (!state.stage) {
      // בודק אם כבר יש לנו נתוני סטרבה ב-DB (כלומר חזרנו מחיבור סטרבה)
      const volumeFromDb = await this.db.getVolumeSummaryFromDb(userId);

      if (volumeFromDb) {
        // יש כבר נפח מסטרבה → מדלגים על הסבר הפתיחה ועוברים ישר לסיכום + גיל
        state.data.volume = volumeFromDb;
        state.stage = "opening_done";
        await this._saveState(userId, state);
        return await this._stepAfterStravaSummary(userId, text, state);
      }

      // אין סטרבה / אין נפח → זה באמת משתמש חדש לגמרי → הודעת פתיחה מלאה
      state.stage = "opening_done";
      await this._saveState(userId, state);
      const reply =
        OPENING_MESSAGE +
        "\n\n" +
        "יש לך כבר חשבון Strava מחובר? אם כן, תתחבר דרך הקישור בפרונט ואז נחזור לפה ונמשיך עם הנתונים שלך.";
      return { reply, onboarding: true };
    }


    // משלב זה – אנחנו בתוך FLOW של אונבורדינג
    switch (state.stage) {
      case "opening_done":
        return await this._stepAfterStravaSummary(userId, text, state);
      case "after_strava_summary":
        return await this._stepPersonalDetails(userId, text, state);
      case "personal_details":
        return await this._stepPersonalDetails(userId, text, state);
      case "ftp":
        return await this._stepFtp(userId, text, state);
      case "hr_max":
        return await this._stepHrMax(userId, text, state);
      case "hr_threshold":
        return await this._stepHrThreshold(userId, text, state);
      case "training_duration":
        return await this._stepTrainingDuration(userId, text, state);
      case "goal":
        return await this._stepGoal(userId, text, state);
      case "summary":
        return await this._stepSummary(userId, text, state);
      default:
        // fallback בטוח
        state.stage = "opening_done";
        await this._saveState(userId, state);
        return {
          reply:
            "היה לי בלבול קטן בסטייט, חזרתי שלב אחד אחורה. נמשיך מהיכן שהפסקנו.",
          onboarding: true,
        };
    }
  }

  // ===== REGULAR CHAT (אחרי אונבורדינג) =====
  async _handleRegularChat(userId, text, state) {
    // כאן אפשר בעתיד להוסיף לוגיקה מתקדמת של אימונים.
    // כרגע – תשובה בסיסית לפי context.
    const params = await this.db.getTrainingParams(userId);
    let profileLine = "";
    if (params) {
      const ftp = params.ftp ? `${params.ftp}W` : "אין FTP מוגדר עדיין";
      const hr = params.hr_threshold
        ? `${params.hr_threshold} דופק סף`
        : "אין דופק סף מוגדר עדיין";
      profileLine = `\n\nבינתיים אני מכיר אותך ככה: FTP ~ ${ftp}, ${hr}.`;
    }

    const reply =
      "האונבורדינג שלנו כבר הושלם ✅\n" +
      "אתה יכול לשאול אותי:\n" +
      "• מה האימון שלי למחר?\n" +
      "• תנתח לי את האימון האחרון.\n" +
      "• מה העומס השבועי שלי?\n" +
      "• איך לעדכן FTP או מטרה.\n" +
      profileLine;

    return { reply, onboarding: false };
  }

  // ===== FLOW STEPS =====

  // אחרי שחזרנו מסטרבה (או אין סטרבה) – סיכום נפח קצר
  async _stepAfterStravaSummary(userId, text, state) {
    // מוודא שיש לנו נפח ונתוני קנדידט של FTP/HR אם אפשר
    state = await this._ensureStravaMetrics(userId, state);

    const volume = state.data.volume;
    let summary = "";

    if (volume && volume.ridesCount > 0) {
      summary +=
        `אני רואה לפי סטרבה שב־~90 הימים האחרונים:\n` +
        `• מספר רכיבות: ${volume.ridesCount}\n` +
        `• משך רכיבה קצר טיפוסי: ${this._formatMinutes(
          volume.minDurationSec
        )}\n` +
        `• משך ממוצע: ${this._formatMinutes(volume.avgDurationSec)}\n` +
        `• משך ארוך טיפוסי: ${this._formatMinutes(volume.maxDurationSec)}\n\n`;
    } else {
      summary +=
        "לא מצאתי מספיק רכיבות בסטרבה כדי להעריך את הנפח שלך.\nנמשיך לבנות פרופיל רוכב ידני לפי מה שתספר לי.\n\n";
    }

    summary +=
      "בוא נשלים עכשיו כמה נתונים אישיים בסיסיים: גיל, משקל וגובה.\n" +
      "נתחיל מהגיל שלך (בשנים):";

    state.stage = "personal_details";
    await this._saveState(userId, state);

    return { reply: summary, onboarding: true };
  }

  // שלב נתונים אישיים – גיל, משקל, גובה
  async _stepPersonalDetails(userId, text, state) {
    const p = state.data.profile;

    const num = this._extractNumber(text);

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

      // מנסה להביא משקל שהגיע מסטרבה (אם נשמר ב-training_params)
      let weightFromDb = null;
      try {
        const params = await this.db.getTrainingParams(userId);
        if (params && params.weight != null) {
          weightFromDb = Number(params.weight.toFixed(1));
        }
      } catch (err) {
        // אם יש בעיה – פשוט נתעלם ונמשיך כרגיל
      }

      if (weightFromDb != null) {
        return {
          reply:
            `רשמתי: גיל ${p.age}.\n` +
            `לפי הנתונים מסטרבה, המשקל שלך הוא בערך ${weightFromDb} ק״ג.\n` +
            `אם זה עדיין נכון, תכתוב לי את המשקל שלך כדי לאשר (למשל "${weightFromDb}"). ואם יש עדכון – תכתוב את המשקל המעודכן שלך בק״ג.`,
          onboarding: true,
        };
      }

      // אין לנו משקל מסטרבה → שאלה רגילה כמו קודם
      return {
        reply: `רשמתי: גיל ${p.age}.\nמה המשקל הנוכחי שלך בק״ג?`,
        onboarding: true,
      };
    }

      p.age = Math.round(num);
      state.data.profile = p;
      await this._saveState(userId, state);
      return {
        reply: `רשמתי: גיל ${p.age}.\nמה המשקל הנוכחי שלך בק״ג?`,
        onboarding: true,
      };
    }

    if (!p.weight) {
      if (!num) {
        return {
          reply:
            "כדי שנמשיך, תכתוב לי את המשקל שלך בק״ג (למשל 67).",
          onboarding: true,
        };
      }
      p.weight = Number(num.toFixed(1));
      state.data.profile = p;
      await this._saveState(userId, state);
      return {
        reply: `רשמתי: משקל ${p.weight} ק״ג.\nמה הגובה שלך בס״מ?`,
        onboarding: true,
      };
    }

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
      state.stage = "after_strava_summary"; // נעבור ל-FTP בשלב הבא
      await this._saveState(userId, state);

      // עכשיו נתקדם ל-FTP
      return await this._stepFtp(userId, "", state);
    }

    // אם כבר מילאנו הכול ונפלנו לכאן – ממשיכים ל-FTP
    state.stage = "ftp";
    await this._saveState(userId, state);
    return await this._stepFtp(userId, text, state);
  }

  // שלב FTP
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

      const candidate = models.hrMaxCandidate;
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

      let base = "עכשיו נגדיר דופק סף (הדופק שבו אתה רוכב באיזור סף/זמן ממושך).\n";
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

    if (!p.minDuration || !p.typicalDuration || !p.maxDuration) {
      // אם המשתמש ענה במספר – נשתמש בו כטיפוסי
      if (num) {
        const minutes = Math.round(num);
        const sec = minutes * 60;
        if (!p.typicalDuration) p.typicalDuration = sec;
        if (!p.minDuration) p.minDuration = sec;
        if (!p.maxDuration) p.maxDuration = sec;
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
          `• קצר טיפוסי: ${this._formatMinutes(volume.minDurationSec)}\n` +
          `• ממוצע: ${this._formatMinutes(volume.avgDurationSec)}\n` +
          `• ארוך טיפוסי: ${this._formatMinutes(volume.maxDurationSec)}\n\n`;
      }

      base +=
        "תכתוב לי כמה דקות אתה רוצה שיהיה משך אימון \"רגיל\" שלך (למשל 90 או 120).";

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
      "בכל רגע תוכל לבקש לעדכן נתון (FTP, דופק, מטרה) או לשאול: \"מה האימון שלי למחר?\"";

    return { reply: summary, onboarding: true };
  }
}
