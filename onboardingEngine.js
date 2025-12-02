// onboardingEngine.js
// מנוע האונבורדינג של LOEW – לפי ה-FLOW הרשמי ששמרנו בזיכרון

export class OnboardingEngine {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  // ---------- עוזרים בסיסיים ----------

  async _loadState(userId) {
    const existing = await this.db.getOnboarding(userId);
    if (existing && existing.userId === userId) {
      // לוודא שיש שדות בסיסיים
      return {
        userId,
        stage: existing.stage || "intro",
        stravaConnected: !!existing.stravaConnected,
        stravaMetrics: existing.stravaMetrics || null,
        answers: existing.answers || {},
        onboardingCompleted: !!existing.onboardingCompleted,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: existing.updatedAt || new Date().toISOString(),
      };
    }

    const nowIso = new Date().toISOString();
    return {
      userId,
      stage: "intro",
      stravaConnected: false,
      stravaMetrics: null,
      answers: {},
      onboardingCompleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  async _saveState(state) {
    const nowIso = new Date().toISOString();
    if (!state.userId) throw new Error("_saveState: state.userId is required");
    if (!state.createdAt) state.createdAt = nowIso;
    state.updatedAt = nowIso;
    await this.db.saveOnboarding(state);
  }

  async _ensureTrainingParams(userId) {
    let tp = await this.db.getTrainingParams(userId);
    const nowIso = new Date().toISOString();

    if (!tp) {
      tp = {
        userId,
        age: null,
        weight_kg: null,
        height_cm: null,
        ftp: null,
        hr_max: null,
        hr_threshold: null,
        min_ride_minutes: null,
        avg_ride_minutes: null,
        max_ride_minutes: null,
        goal: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    } else {
      tp = {
        ...tp,
        userId: tp.userId || userId,
      };
      if (!tp.createdAt) tp.createdAt = tp.created_at || nowIso;
    }

    tp.updatedAt = nowIso;
    await this.db.saveTrainingParams(tp);
    return tp;
  }

  _normalizeText(text) {
    return (text || "").toString().trim();
  }

  _isYes(text) {
    const t = this._normalizeText(text).toLowerCase();
    if (!t) return false;
    return /^(כן|בטח|ברור|סבבה|מאשר|מאשרת|יאללה|אוקי|אוקיי|ok|okay)\b/u.test(t);
  }

  _isNo(text) {
    const t = this._normalizeText(text).toLowerCase();
    if (!t) return false;
    return /^(לא|ממש לא|no|לא תודה|אין)$/u.test(t);
  }

  _extractInt(text, min = null, max = null) {
    const m = this._normalizeText(text).match(/(\d{1,3})/u);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) return null;
    if (min != null && n < min) return null;
    if (max != null && n > max) return null;
    return n;
  }

  // ---------- נקודת כניסה מהצ'אט ----------

  async handleMessage(userId, userTextRaw) {
    const state = await this._loadState(userId);
    const userText = this._normalizeText(userTextRaw);

    if (state.onboardingCompleted) {
      return {
        text:
          "האונבורדינג כבר הושלם. אם תרצה לעדכן גיל/משקל/FTP/דופק או מטרה – תגיד לי מה אתה רוצה לשנות.",
        done: true,
      };
    }

    switch (state.stage) {
      case "intro":
        return this._handleIntro(state);

      case "ask_strava_connect":
      case "wait_for_strava":
      case "strava_summary":
        return this._handleStravaFlow(state, userText);

      case "ask_age":
        return this._handleAge(state, userText);

      case "ask_weight":
        return this._handleWeight(state, userText);

      case "ftp_confirm":
        return this._handleFtp(state, userText);

      case "hr_confirm":
        return this._handleHr(state, userText);

      case "ask_time_min":
      case "ask_time_avg":
      case "ask_time_max":
        return this._handleTimeFlow(state, userText);

      case "ask_goal":
      case "goal_confirm":
        return this._handleGoal(state, userText);

      case "done":
        return {
          text:
            "האונבורדינג שלך כבר הושלם. עכשיו אפשר להתחיל לעבוד – למשל: \"מה האימון המומלץ שלי למחר?\"",
          done: true,
        };

      default:
        console.warn("Unknown onboarding stage:", state.stage);
        state.stage = "intro";
        await this._saveState(state);
        return this._handleIntro(state);
    }
  }

  // ---------- שלב 1: הודעת פתיחה ----------

  async _handleIntro(state) {
    state.stage = "ask_strava_connect";
    await this._saveState(state);

    const text = [
      "נעים מאוד, אני LOEW — המאמן האישי שלך.",
      "",
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.",
      "",
      "המטרה שלי: לבנות עבורך אימונים חכמים, פשוטים לביצוע ועם מינימום בלאגן — כדי שתדע בדיוק מה כדאי לעשות בכל יום.",
      "",
      "נתחיל מחיבור ל-Strava, כדי שאוכל ללמוד מהרכיבות האחרונות שלך.",
      "יש לך חשבון Strava שאתה מתעד בו את רוב הרכיבות שלך?",
    ].join("\n");

    return { text, done: false };
  }

  // ---------- שלב 2: חיבור לסטרבה + סיכום ווליום ----------

  async _handleStravaFlow(state, userText) {
    const userId = state.userId;

    // אם כבר יש stravaConnected, לא צריך לבקש שוב – ישר לסיכום
    if (state.stravaConnected && state.stage !== "strava_summary") {
      state.stage = "strava_summary";
      await this._saveState(state);
    }

    if (state.stage === "ask_strava_connect") {
      const lower = userText.toLowerCase();

      if (!userText) {
        return {
          text:
            "יש לך חשבון Strava שאתה מתעד בו את הרכיבות שלך? אם כן, תכתוב משהו כמו \"כן, תחבר אותי לסטרבה\". אם אין – תכתוב שאין לך ונמשיך בלי סטרבה.",
          done: false,
        };
      }

      if (this._isNo(lower) || /אין|בלי סטרבה/u.test(lower)) {
        state.stravaConnected = false;
        state.stage = "ask_age";
        await this._saveState(state);

        return {
          text:
            "סבבה, נתקדם בלי חיבור לסטרבה.\nנתחיל מפרטים אישיים.\nבן כמה אתה?",
          done: false,
        };
      }

      if (/strava|סטרבה/u.test(lower) || this._isYes(lower)) {
        state.stage = "wait_for_strava";
        await this._saveState(state);

        return {
          text:
            "מצוין. תאשר את החיבור ל-Strava בחלון שנפתח.\nאחרי שהחיבור יושלם ואייבא את הנתונים, נחזור לכאן ונמשיך.",
          done: false,
        };
      }

      return {
        text:
          "רק כדי לוודא שהבנתי – יש לך חשבון Strava? אם כן, תכתוב \"כן, תחבר אותי לסטרבה\". אם אין – תכתוב שאין לך סטרבה.",
        done: false,
      };
    }

    if (state.stage === "wait_for_strava") {
      if (!state.stravaConnected) {
        return {
          text:
            "אני עדיין מחכה לאישור החיבור ל-Strava.\nאחרי שתאשר בחלון שנפתח, תחזור לכאן ונמשיך.",
          done: false,
        };
      }
      // כבר מחובר → נעבור לסיכום
      state.stage = "strava_summary";
      await this._saveState(state);
    }

    if (state.stage === "strava_summary") {
      let metrics = state.stravaMetrics;
      try {
        if (!metrics && this.db.computeHrAndFtpFromStrava) {
          metrics = await this.db.computeHrAndFtpFromStrava(userId);
          state.stravaMetrics = metrics || null;
          await this._saveState(state);
        }
      } catch (err) {
        console.error("Error getting Strava metrics:", err);
      }

      let volumeLines = [];
      let numActivities = null;

      if (metrics && metrics.trainingSummary) {
        const ts = metrics.trainingSummary;
        numActivities = ts.numActivities ?? ts.numRides ?? null;
        if (numActivities != null) {
          volumeLines.push(`ייבאתי כ-${numActivities} רכיבות אחרונות שלך מסטרבה.`);
        }
        if (ts.avgHoursPerWeek != null) {
          volumeLines.push(
            `זמן אימון ממוצע בשבוע: ~${ts.avgHoursPerWeek.toFixed(1)} שעות.`
          );
        }
        if (ts.ridesPerWeek != null) {
          volumeLines.push(
            `מספר רכיבות ממוצע בשבוע: ~${ts.ridesPerWeek.toFixed(1)} רכיבות.`
          );
        }
      }

      // נתוני משך אימון (min/avg/max) מתוך פונקציית סטטיסטיקה נפרדת
      let timeLines = [];
      try {
        if (this.db.getRideDurationStats) {
          const stats = await this.db.getRideDurationStats(userId);
          if (stats) {
            const minM = stats.minCandidateMinutes || stats.minDurationMinutes;
            const avgM = stats.avgMinutes || stats.avgDurationMinutes;
            const maxM = stats.maxCandidateMinutes || stats.maxDurationMinutes;
            if (minM != null)
              timeLines.push(`משך רכיבה קצר טיפוסי: ~${Math.round(minM)} דקות.`);
            if (avgM != null)
              timeLines.push(`משך רכיבה ממוצע: ~${Math.round(avgM)} דקות.`);
            if (maxM != null)
              timeLines.push(`משך רכיבה ארוכה טיפוסית: ~${Math.round(maxM)} דקות.`);
            // נשמור להצעות בהמשך
            state.answers.timeFromStrava = {
              min: minM || null,
              avg: avgM || null,
              max: maxM || null,
            };
            await this._saveState(state);
          }
        }
      } catch (err) {
        console.error("getRideDurationStats error:", err);
      }

      const lines = [];
      lines.push("סיימתי לייבא את הנתונים מסטרבה ולנתח את הנפח שלך.");
      if (volumeLines.length > 0) {
        lines.push("");
        lines.push(...volumeLines);
      }
      if (timeLines.length > 0) {
        lines.push("");
        lines.push(...timeLines);
      }
      lines.push("");
      lines.push(
        "עכשיו נעבור לפרטים האישיים שלך, כדי לדייק את ההמלצות. נתחיל מהגיל."
      );
      lines.push("בן כמה אתה?");

      state.stage = "ask_age";
      await this._saveState(state);

      return { text: lines.join("\n"), done: false };
    }

    return {
      text: "בוא נתחיל מחיבור לסטרבה או נמשיך בלעדיה. יש לך חשבון Strava?",
      done: false,
    };
  }

  // ---------- שלב 3: גיל ----------

  async _handleAge(state, userText) {
    const userId = state.userId;
    const age = this._extractInt(userText, 10, 90);

    if (age == null) {
      return {
        text: 'בשביל שנוכל להתקדם אני צריך את הגיל שלך כמספר (למשל 46). בן כמה אתה?',
        done: false,
      };
    }

    const tp = await this._ensureTrainingParams(userId);
    tp.age = age;
    await this.db.saveTrainingParams(tp);

    state.answers.age = age;
    state.stage = "ask_weight";
    await this._saveState(state);

    const lines = [];
    lines.push(`מעולה, רשמתי גיל ${age}.`);

    // אם יש לנו משקל מסטרבה – נציע אותו
    const stravaWeight = state.stravaMetrics?.userWeightKg ?? null;
    if (stravaWeight != null) {
      lines.push(
        `בסטרבה רשום שהמשקל שלך הוא בערך ${Math.round(
          stravaWeight
        )} ק"ג.\nזה עדיין נכון? אם כן תכתוב "כן" / "אוקי", ואם לא – תכתוב את המשקל העדכני שלך.`
      );
    } else {
      lines.push('מה המשקל הנוכחי שלך בק"ג? (למשל 67)');
    }

    return { text: lines.join("\n"), done: false };
  }

  // ---------- שלב 4: משקל ----------

  async _handleWeight(state, userText) {
    const userId = state.userId;
    const tp = await this._ensureTrainingParams(userId);
    const stravaWeight = state.stravaMetrics?.userWeightKg ?? null;

    let weight = null;

    if (this._isYes(userText) && stravaWeight != null) {
      weight = Math.round(stravaWeight);
    } else {
      weight = this._extractInt(userText, 30, 200);
    }

    if (weight == null) {
      const base =
        stravaWeight != null
          ? `בסטרבה רשום שהמשקל שלך הוא בערך ${Math.round(
              stravaWeight
            )} ק"ג.\nבשביל שנוכל להתקדם אני צריך מספר עדכני בקילוגרמים. תכתוב "כן" / "אוקי" אם זה נכון, או תכתוב מספר אחר (למשל 67).`
          : 'בשביל שנוכל להתקדם אני צריך את המשקל שלך בק"ג כמספר (למשל 67). מה המשקל הנוכחי שלך?';

      return {
        text: base,
        done: false,
      };
    }

    tp.weight_kg = weight;
    await this.db.saveTrainingParams(tp);

    state.answers.weight_kg = weight;
    state.stage = "ftp_confirm";
    await this._saveState(state);

    const lines = [];
    lines.push(`מצוין, רשמתי משקל ${weight} ק"ג.`);

    const metrics = state.stravaMetrics;
    const ftpModels = metrics?.ftpModels || null;

    if (metrics && ftpModels) {
      const {
        ftp20,
        ftpPowerCurve,
        ftpCp,
        ftpFromStrava,
        ftpRecommended,
      } = ftpModels;

      lines.push("");
      lines.push("עכשיו נדבר על FTP (הסף האירובי שלך). חישבתי עבורך כמה מודלים שונים מהנתונים שלך בסטרבה:");

      if (ftp20 != null) {
        lines.push(
          `• FTP ממאמץ 20 דקות – מבוסס על שלושת המאמצים הטובים ביותר שלך ל-20 דק׳. יצא בערך ${Math.round(
            ftp20
          )}W.`
        );
      }
      if (ftpPowerCurve != null) {
        lines.push(
          `• FTP מעקומת כוח – מבוסס על עקומת הביצועים שלך לאורך חלונות זמן שונים. יצא בערך ${Math.round(
            ftpPowerCurve
          )}W.`
        );
      }
      if (ftpCp != null) {
        lines.push(
          `• מודל CP – חישוב שמבוסס על שילוב של מאמצים קצרים וארוכים. יצא בערך ${Math.round(
            ftpCp
          )}W.`
        );
      }
      if (ftpFromStrava != null) {
        lines.push(
          `• FTP שמוגדר כרגע בסטרבה: ${Math.round(ftpFromStrava)}W.`
        );
      }

      const suggested =
        ftpRecommended ??
        ftp20 ??
        ftpPowerCurve ??
        ftpCp ??
        ftpFromStrava ??
        null;

      if (suggested != null) {
        lines.push("");
        lines.push(
          `לפי כל המודלים האלו, ההמלצה שלי כרגע היא FTP ≈ ${Math.round(
            suggested
          )}W.`
        );
        // נשמור את ההצעה ב-answers לטובת השלב הבא
        state.answers.ftpSuggested = Math.round(suggested);
        await this._saveState(state);
        lines.push(
          'אם זה נשמע לך הגיוני, תכתוב "כן" / "אוקי" ואגדיר את הערך הזה כ-FTP שלך.\nאם אתה מעדיף ערך אחר – תכתוב את ה-FTP שאתה רוצה בוואטים (למשל 240).'
        );
      } else {
        lines.push("");
        lines.push(
          "לא הצלחתי לגזור המלצה חד-משמעית ל-FTP מהנתונים, אז נעזר בקלט שלך."
        );
        lines.push(
          'אם אתה יודע את ה-FTP שלך, תכתוב אותו כמספר בוואטים (למשל 240). אם אתה לא יודע, תכתוב "לא יודע" ונעבוד בהתחלה בלי FTP מדויק.'
        );
      }
    } else {
      lines.push("");
      lines.push(
        'עכשיו נדבר על FTP. אם אתה יודע את ה-FTP הנוכחי שלך, תכתוב אותו כמספר בוואטים (למשל 240). אם אתה לא יודע, תכתוב "לא יודע".'
      );
    }

    return { text: lines.join("\n"), done: false };
  }

  // ---------- שלב 5: FTP ----------

  async _handleFtp(state, userText) {
    const userId = state.userId;
    const tp = await this._ensureTrainingParams(userId);

    const text = this._normalizeText(userText);

    if (/לא יודע|אין לי מושג/u.test(text)) {
      // נסמן כ"לא מוגדר" ונמשיך
      tp.ftp = null;
      await this.db.saveTrainingParams(tp);
      state.answers.ftp = null;
      state.stage = "hr_confirm";
      await this._saveState(state);

      const msg =
        "אין בעיה, נתחיל בלי FTP מדויק ונעדכן את זה בהמשך כשיהיו לנו עוד נתונים או מבחן.\n" +
        "עכשיו נעבור לדופק המקסימלי.\n" +
        "מה הדופק המקסימלי הגבוה ביותר שאתה זוכר שראית ברכיבה או במאמץ?";

      return { text: msg, done: false };
    }

    let ftpValue = null;
    if (this._isYes(text) && state.answers.ftpSuggested != null) {
      ftpValue = state.answers.ftpSuggested;
    } else {
      ftpValue = this._extractInt(text, 100, 500);
    }

    if (ftpValue == null) {
      const suggested = state.answers.ftpSuggested;
      if (suggested != null) {
        return {
          text:
            `בשביל להגדיר FTP אני צריך או אישור ל-${suggested}W (תכתוב "כן" / "אוקי"), או שתכתוב מספר אחר בוואטים (למשל 240).` +
            '\nאם אתה לא יודע בכלל, תכתוב "לא יודע".',
          done: false,
        };
      }
      return {
        text:
          "בשביל להגדיר FTP אני צריך מספר בוואטים (למשל 240), או שתכתוב \"לא יודע\" אם אין לך מושג.",
        done: false,
      };
    }

    tp.ftp = ftpValue;
    await this.db.saveTrainingParams(tp);
    state.answers.ftp = ftpValue;
    state.stage = "hr_confirm";
    await this._saveState(state);

    const msg =
      `סגור, הגדרתי FTP = ${ftpValue}W.\n` +
      "עכשיו נעבור לדופק מקסימלי.\n" +
      "מה הדופק המקסימלי הגבוה ביותר שאתה זוכר שראית ברכיבה או במאמץ?";

    return { text: msg, done: false };
  }

  // ---------- שלב 6: דופק מקסימלי ----------

  async _handleHr(state, userText) {
    const userId = state.userId;
    const tp = await this._ensureTrainingParams(userId);

    const text = this._normalizeText(userText);

    const metrics = state.stravaMetrics;
    const hrModels = metrics?.hrModels || null;

    // אם אין עדיין הסבר – ניתן אחד קצר על סמך סטרבה לפני הוולידציה
    if (!text) {
      const lines = [];
      if (hrModels?.hrMaxCandidate != null) {
        lines.push(
          `מהנתונים של סטרבה ראיתי שהדופק המקסימלי הגבוה ביותר שלך ברכיבות האחרונות הוא באזור ${hrModels.hrMaxCandidate} פעימות לדקה.`
        );
      }
      lines.push(
        "מה הדופק המקסימלי הגבוה ביותר שאתה זוכר שראית במאמץ? תכתוב מספר (למשל 180), או \"לא יודע\" אם אין לך מושג."
      );
      return { text: lines.join("\n"), done: false };
    }

    if (/לא יודע|אין לי מושג/u.test(text)) {
      const candidate = hrModels?.hrMaxCandidate ?? null;
      if (candidate != null) {
        tp.hr_max = candidate;
        await this.db.saveTrainingParams(tp);
        state.answers.hr_max = candidate;
        state.stage = "ask_time_min";
        await this._saveState(state);

        const msg =
          `לפי הנתונים של סטרבה אשתמש בדופק מקסימלי משוער של ${candidate} פעימות לדקה.\n` +
          "עכשיו נעבור לזמני אימון.\n" +
          "נתחיל מזמן אימון קצר טיפוסי. לפי הרכיבות שלך אני רואה משך קצר באזור מסוים, אבל חשוב לי לשמוע ממך.";

        return { text: msg, done: false };
      }

      tp.hr_max = null;
      await this.db.saveTrainingParams(tp);
      state.answers.hr_max = null;
      state.stage = "ask_time_min";
      await this._saveState(state);

      return {
        text:
          "בסדר, נתחיל בלי דופק מקסימלי מדויק ונעדכן בהמשך כשיהיו נתונים.\nעכשיו נעבור לזמני אימון. נתחיל מזמן אימון קצר טיפוסי.",
        done: false,
      };
    }

    const hrMax = this._extractInt(text, 100, 230);
    if (hrMax == null) {
      const lines = [];
      if (hrModels?.hrMaxCandidate != null) {
        lines.push(
          `מהנתונים של סטרבה אני מעריך שהדופק המקסימלי שלך הוא בערך ${hrModels.hrMaxCandidate} פעימות לדקה.`
        );
      }
      lines.push(
        "בשביל להגדיר אזורי דופק אני צריך מספר. תכתוב את הדופק הכי גבוה שאתה זוכר (למשל 180), או \"לא יודע\" אם אין לך מושג."
      );
      return { text: lines.join("\n"), done: false };
    }

    tp.hr_max = hrMax;
    await this.db.saveTrainingParams(tp);
    state.answers.hr_max = hrMax;
    state.stage = "ask_time_min";
    await this._saveState(state);

    const msg =
      `מצוין, רשמתי דופק מקסימלי ${hrMax}.\n` +
      "עכשיו נעבור לזמני אימון – קצר, ממוצע וארוך – כדי שאוכל לתכנן אימונים שמתאימים לזמן שיש לך.";

    return { text: msg, done: false };
  }

  // ---------- שלב 7: זמן אימון (min / avg / max) ----------

  async _handleTimeFlow(state, userText) {
    const userId = state.userId;
    const tp = await this._ensureTrainingParams(userId);

    const fromStrava = state.answers.timeFromStrava || {};
    const minStrava = fromStrava.min || null;
    const avgStrava = fromStrava.avg || null;
    const maxStrava = fromStrava.max || null;

    if (state.stage === "ask_time_min") {
      if (!userText) {
        const base = [];
        if (minStrava != null) {
          base.push(
            `לפי הרכיבות שלך בסטרבה אני רואה שמשך רכיבה קצר טיפוסי הוא בערך ${Math.round(
              minStrava
            )} דקות.`
          );
        }
        base.push(
          "מה בעיניך משך אימון קצר \"רגיל\" שתרצה שניקח בחשבון? תכתוב מספר בדקות (למשל 60 או 90)."
        );
        return { text: base.join("\n"), done: false };
      }

      const minutes = this._extractInt(userText, 20, 400);
      if (minutes == null) {
        return {
          text:
            "אני צריך מספר בדקות למשך אימון קצר טיפוסי (למשל 60 או 90). תכתוב בבקשה מספר.",
          done: false,
        };
      }

      tp.min_ride_minutes = minutes;
      await this.db.saveTrainingParams(tp);
      state.answers.min_ride_minutes = minutes;
      state.stage = "ask_time_avg";
      await this._saveState(state);

      const lines = [];
      lines.push(`סגרנו, משך אימון קצר טיפוסי: ${minutes} דקות.`);

      if (avgStrava != null) {
        lines.push("");
        lines.push(
          `לפי סטרבה, משך הרכיבה הממוצע שלך הוא בערך ${Math.round(
            avgStrava
          )} דקות.`
        );
      }
      lines.push(
        "מה בעיניך משך אימון \"רגיל\" ממוצע שתרצה שנעבוד לפיו? תכתוב מספר בדקות (למשל 90 או 120)."
      );

      return { text: lines.join("\n"), done: false };
    }

    if (state.stage === "ask_time_avg") {
      const minutes = this._extractInt(userText, 20, 400);
      if (minutes == null) {
        return {
          text:
            "אני צריך מספר בדקות למשך אימון ממוצע רגיל (למשל 90 או 120). תכתוב בבקשה מספר.",
          done: false,
        };
      }

      tp.avg_ride_minutes = minutes;
      await this.db.saveTrainingParams(tp);
      state.answers.avg_ride_minutes = minutes;
      state.stage = "ask_time_max";
      await this._saveState(state);

      const lines = [];
      lines.push(`מעולה, משך אימון ממוצע רגיל: ${minutes} דקות.`);

      if (maxStrava != null) {
        lines.push("");
        lines.push(
          `ולפי סטרבה, משך רכיבה ארוכה טיפוסית הוא בערך ${Math.round(
            maxStrava
          )} דקות.`
        );
      }
      lines.push(
        "כמה זמן בעיניך מוגדר כ\"אימון ארוך\" שלך? תכתוב מספר בדקות (למשל 150 או 180)."
      );

      return { text: lines.join("\n"), done: false };
    }

    if (state.stage === "ask_time_max") {
      const minutes = this._extractInt(userText, 20, 600);
      if (minutes == null) {
        return {
          text:
            "אני צריך מספר בדקות למשך אימון ארוך טיפוסי (למשל 150 או 180). תכתוב בבקשה מספר.",
          done: false,
        };
      }

      tp.max_ride_minutes = minutes;
      await this.db.saveTrainingParams(tp);
      state.answers.max_ride_minutes = minutes;
      state.stage = "ask_goal";
      await this._saveState(state);

      const msg =
        `נהדר, משך אימון ארוך טיפוסי: ${minutes} דקות.\n` +
        "נשאר לנו שלב אחרון – להבין מה המטרה העיקרית שלך כרגע באימונים.";

      return { text: msg, done: false };
    }

    return {
      text:
        "בוא נגדיר את משך האימון הרגיל שלך בדקות (קצר, ממוצע וארוך), כדי שאוכל לתכנן אימונים שמתאימים לזמן שיש לך.",
      done: false,
    };
  }

  // ---------- שלב 8: מטרה ----------

  async _handleGoal(state, userText) {
    const userId = state.userId;
    const tp = await this._ensureTrainingParams(userId);

    if (state.stage === "ask_goal") {
      if (!userText || userText.length < 3) {
        return {
          text:
            "תכתוב במשפט חופשי מה המטרה העיקרית שלך כרגע באימונים (למשל: \"גרן פונדו אילת בדצמבר\", \"שיפור FTP ל-270W\", \"ירידה של 5 ק\"ג\" וכו').",
          done: false,
        };
      }

      state.answers.goal = userText;
      state.stage = "goal_confirm";
      await this._saveState(state);

      return {
        text: `אם אני מסכם במילים שלך, המטרה שלך כרגע היא:\n\n"${userText}"\n\nזה נשמע מדויק? אם כן תכתוב "כן" / "אוקי". אם לא – תכתוב ניסוח אחר.`,
        done: false,
      };
    }

    // goal_confirm
    if (this._isYes(userText)) {
      const goal = state.answers.goal;
      tp.goal = goal;
      await this.db.saveTrainingParams(tp);

      // סיכום גדול
      const a = state.answers;
      const lines = [];
      lines.push("מעולה, סיימנו את האונבורדינג הראשוני שלך. הנה סיכום הנתונים:");

      if (a.age != null) lines.push(`• גיל: ${a.age}`);
      if (a.weight_kg != null) lines.push(`• משקל: ${a.weight_kg} ק"ג`);
      if (a.ftp != null)
        lines.push(`• FTP: ${a.ftp}W`);
      else
        lines.push("• FTP: עדיין לא הוגדר, נעדכן לפי נתונים בהמשך.");

      if (a.hr_max != null)
        lines.push(`• דופק מקסימלי: ${a.hr_max} פעימות לדקה`);
      else
        lines.push("• דופק מקסימלי: עדיין לא הוגדר.");

      if (a.min_ride_minutes != null)
        lines.push(`• משך אימון קצר טיפוסי: ${a.min_ride_minutes} דקות`);
      if (a.avg_ride_minutes != null)
        lines.push(`• משך אימון ממוצע רגיל: ${a.avg_ride_minutes} דקות`);
      if (a.max_ride_minutes != null)
        lines.push(`• משך אימון ארוך טיפוסי: ${a.max_ride_minutes} דקות`);

      if (goal)
        lines.push(`• מטרה נוכחית: ${goal}`);

      lines.push("");
      lines.push(
        "מהנקודה הזו יש לי כבר פרופיל די טוב שלך כרוכב, ואני יכול להתחיל לבנות עבורך אימונים ותוכנית אימונים."
      );
      lines.push(
        "כדי להתחיל, אתה יכול לשאול למשל:\n" +
          "• \"מה האימון המומלץ שלי למחר?\"\n" +
          "• \"תן לי תוכנית שבועית בסיסית.\"\n" +
          "• \"איך נראית התקופה האחרונה שלי מבחינת עומס?\""
      );

      state.onboardingCompleted = true;
      state.stage = "done";
      await this._saveState(state);

      return { text: lines.join("\n"), done: true };
    }

    // אם המשתמש כתב משהו אחר – נעדכן כמטרה חדשה ונבקש שוב אישור
    state.answers.goal = userText;
    await this._saveState(state);

    return {
      text: `אוקיי, נעדכן את המטרה שלך ל:\n\n"${userText}"\n\nאם זה מדויק, תכתוב "כן" / "אוקי". אם תרצה לשנות שוב – תכתוב ניסוח אחר.`,
      done: false,
    };
  }

  // ---------- נקרא מהשרת אחרי חיבור סטרבה ----------

  async handleStravaConnected(userId) {
    const state = await this._loadState(userId);
    state.stravaConnected = true;

    try {
      if (this.db.computeHrAndFtpFromStrava) {
        const metrics = await this.db.computeHrAndFtpFromStrava(userId);
        state.stravaMetrics = metrics || null;
      }
    } catch (err) {
      console.error("handleStravaConnected: computeHrAndFtpFromStrava error:", err);
    }

    // אחרי חיבור סטרבה, השלב הבא יהיה strava_summary
    state.stage = "strava_summary";
    await this._saveState(state);
  }
}
