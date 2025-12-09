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

    // אם כבר סיימנו אונבורדינג – לא חוזרים פנימה לתהליך,
    // אבל כן מאפשרים לעדכן משקל / FTP / דופק / מטרה בכל רגע.
    if (state && state.stage === "done") {
      const reply = await this._handlePostOnboardingUpdate(userId, text, state);
      return {
        reply,
        onboarding: false,
      };
    }

    // אין state שמור – בוטסטרפ מסטרבה
    if (!state || !state.stage) {
      state = {
        stage: "intro",
        data: {},
      };
      await this._saveState(userId, state);
      return {
        reply: this._openingMessage(),
        onboarding: true,
      };
    }

    let reply;
    switch (state.stage) {
      case "intro":
        reply = await this._stageIntro(userId, text, state);
        break;

      case "strava_wait":
        reply = await this._stageStravaWait(userId, text, state);
        break;

      case "strava_summary":
        reply = await this._stageStravaSummary(userId, text, state);
        break;

      case "personal_details":
        reply = await this._stagePersonalDetails(userId, text, state);
        break;

      case "ftp_models":
        reply = await this._stageFtpModels(userId, text, state);
        break;

      case "hr_intro":
        reply = await this._stageHrIntro(userId, text, state);
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

      case "done":
        // למקרה שה-State נשמר עם "done" אבל לא עבר דרך התנאי למעלה
        reply = await this._handlePostOnboardingUpdate(userId, text, state);
        return { reply, onboarding: false };

      default:
        // חשוב: לא מאפסים state ולא חוזרים שוב לסיכום סטרבה,
        // כדי שלא יווצר לופ במשקל/סיכום.
        console.warn(
          "OnboardingEngine.handleMessage: unknown stage",
          state.stage
        );
        return {
          reply:
            "משהו לא היה ברור בתהליך האונבורדינג. תנסה לענות שוב בתשובה קצרה ופשוטה (מספר או מילה אחת), ונמשיך מאותו שלב.",
          onboarding: true,
        };
    }

    return { reply, onboarding: true };
  }

  // ===== DB + MEMORY HELPERS =====

  async _loadState(userId) {
    // 1) ניסיון לקרוא מה-DB
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

    // 2) fallback – זיכרון בלבד
    if (this._memStates.has(userId)) {
      return this._memStates.get(userId);
    }

    // 3) אין state
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

  async _updateTrainingParamsFromState(userId, state) {
    if (!this.db || typeof this.db.saveTrainingParams !== "function") return;

    try {
      let existing = {};
      if (typeof this.db.getTrainingParams === "function") {
        existing = (await this.db.getTrainingParams(userId)) || {};
      }

      const d = state.data || {};
      const ftpFinal = d.ftpFinal;
      const hrBlock = d.hr || {};
      const hrMaxFinal = hrBlock.hrMaxFinal;
      const hrThresholdFinal = hrBlock.hrThresholdFinal;

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

  // ===== POST-ONBOARDING UPDATES =====

  async _handlePostOnboardingUpdate(userId, text, state) {
    const t = (text || "").trim();

    // אם המשתמש לא כתב כלום – מסך בית אחרי אונבורדינג
    if (!t) {
      return (
       "האונבורדינג שלך הושלם בהצלחה!\n" +
  "במה אני יכול לעזור לך?\n\n" +
  "דוגמאות שכיחות\n" +
  "טיפול בנתונים:\n" +
  '"עדכן מסטרבה"\n' +
  '"הפרופיל שלי"\n' +
  "עדכון הנתונים שלי:\n" +
  '"המשקל שלי עכשיו 72", "FTP 250", "דופק מקסימלי 178", "דופק סף 160"\n' +
  "ניתוח נתונים:\n" +
  '"נתח את האימון האחרון שלי", "נתח לי אימון מתאריך yyyy-mm-dd"'
      );
    }

    // 1) סיכום פרופיל
    if (/הפרופיל שלי|מה ההגדרות שלי|סיכום נתונים|סיכום פרופיל/.test(t)) {
      return this._buildCurrentProfileSummaryFromState(state);
    }

    // מבטיחים שיש אובייקטים פנימיים
    state.data = state.data || {};
    state.data.personal = state.data.personal || {};
    state.data.hr = state.data.hr || {};
    state.data.trainingTime = state.data.trainingTime || {};

    // 2) עדכון משקל
    const weightMatch = t.match(
      /(משקל|שוקל|קילו|ק\"ג|ק״ג)[^0-9]*([0-9]{2,3}(?:[.,][0-9])?)/
    );
    if (weightMatch) {
      const raw = weightMatch[2].replace(",", ".");
      const num = parseFloat(raw);
      if (Number.isFinite(num) && num > 30 && num < 200) {
        const weight = Math.round(num * 10) / 10;
        state.data.personal.weight = weight;
        await this._saveState(userId, state);

        const summary = this._buildCurrentProfileSummaryFromState(state);
        return `עדכנתי משקל ל-${weight} ק״ג.\n\n${summary}`;
      }
      return "לא הצלחתי להבין את המשקל שכתבת. תכתוב מספר בק\"ג (למשל 72.5).";
    }

    // 3) עדכון FTP
    // דוגמאות: "FTP 250", "עדכן FTP ל 245"
    const ftpMatch = t.match(/ftp[^0-9]*([0-9]{2,3})/i);
    if (ftpMatch) {
      const ftp = parseInt(ftpMatch[1], 10);
      if (!Number.isFinite(ftp) || ftp < 80 || ftp > 500) {
        return "כדי שאוכל לעבוד עם FTP מדויק – תכתוב מספר בוואטים (למשל 240).";
      }

      state.data.ftpFinal = ftp;
      state.data.ftpModels = state.data.ftpModels || {};
      state.data.ftpModels.ftpUserSelected = {
        key: "ftpUserSelected",
        value: ftp,
        label: "FTP chosen by user (post-onboarding)",
      };

      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      const summary = this._buildCurrentProfileSummaryFromState(state);
      return `עדכנתי FTP ל-${ftp}W.\n\n${summary}`;
    }

    // 4) עדכון דופק מקסימלי
    const hrMaxMatch = t.match(
      /(דופק\s*מקס(?:ימלי)?|מקסימום)[^0-9]*([0-9]{2,3})/
    );
    if (hrMaxMatch) {
      const hrMax = parseInt(hrMaxMatch[2], 10);
      if (!Number.isFinite(hrMax) || hrMax < 100 || hrMax > 230) {
        return "תכתוב דופק מקסימלי במספרים בין 120 ל-220 (למשל 175).";
      }

      state.data.hr.hrMaxUser = hrMax;
      state.data.hr.hrMaxFinal = hrMax;

      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      const summary = this._buildCurrentProfileSummaryFromState(state);
      return `עדכנתי דופק מקסימלי ל-${hrMax} bpm.\n\n${summary}`;
    }

    // 5) עדכון דופק סף
    const hrThMatch = t.match(/דופק\s*סף[^0-9]*([0-9]{2,3})/);
    if (hrThMatch) {
      const hrTh = parseInt(hrThMatch[1], 10);
      if (!Number.isFinite(hrTh) || hrTh < 80 || hrTh > 220) {
        return "תכתוב דופק סף במספרים בין 120 ל-200 (למשל 160).";
      }

      state.data.hr.hrThresholdUser = hrTh;
      state.data.hr.hrThresholdFinal = hrTh;

      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      const summary = this._buildCurrentProfileSummaryFromState(state);
      return `עדכנתי דופק סף ל-${hrTh} bpm.\n\n${summary}`;
    }

    // 6) עדכון מטרה
    // דוגמאות: "המטרה שלי עכשיו היא ...", "המטרה העיקרית: ..."
    const goalMatch = t.match(
      /המטרה(?: העיקרית)?(?: שלי)?(?: עכשיו)?[:\- ]*(.+)/
    );
    if (goalMatch && goalMatch[1]) {
      const goalText = goalMatch[1].trim();
      if (goalText) {
        state.data.goal = goalText;
        await this._saveState(userId, state);

        const summary = this._buildCurrentProfileSummaryFromState(state);
        return `עדכנתי מטרה חדשה:\n"${goalText}".\n\n${summary}`;
      }
    }

    // 7) לא זוהתה פקודה – תשובת ברירת מחדל (אותו מסך בית כמו ב-!t)
    return (
      "האונבורדינג שלך הושלם בהצלחה!\n" +
      "במה אני יכול לעזור לך?\n\n" +
      "דוגמאות שכיחות\n" +
      "טיפול בנתונים:\n" +
      '"עדכן מסטרבה"\n' +
      '"הפרופיל שלי"\n' +
      "עדכון הנתונים שלי:\n" +
      '"המשקל שלי עכשיו 72", "FTP 250", "דופק מקסימלי 178", "דופק סף 160"\n' +
      "ניתוח נתונים:\n" +
      '"נתח את האימון האחרון שלי", "נתח לי אימון מתאריך yyyy-mm-dd"'
    );
  }

  _buildCurrentProfileSummaryFromState(state) {
    state = state || {};
    const data = state.data || {};
    const personal = data.personal || {};
    const hr = data.hr || {};
    const tt = data.trainingTime || {};

    const lines = [];
    lines.push("זה הפרופיל הנוכחי שלך:");

    if (personal.weight != null) {
      lines.push(`• משקל: ${personal.weight} ק״ג`);
    }
    if (personal.height != null) {
      lines.push(`• גובה: ${personal.height} ס״מ`);
    }
    if (personal.age != null) {
      lines.push(`• גיל: ${personal.age}`);
    }

    if (data.ftpFinal != null) {
      lines.push(`• FTP: ${data.ftpFinal}W`);
    }

    if (hr.hrMaxFinal != null) {
      lines.push(`• דופק מקסימלי: ${hr.hrMaxFinal} bpm`);
    } else if (hr.hrMax != null) {
      lines.push(`• דופק מקסימלי (מהמודלים): ${hr.hrMax} bpm`);
    }

    if (hr.hrThresholdFinal != null) {
      lines.push(`• דופק סף: ${hr.hrThresholdFinal} bpm`);
    } else if (hr.hrThreshold != null) {
      lines.push(`• דופק סף (מהמודלים): ${hr.hrThreshold} bpm`);
    }

    if (
      tt.minMinutes != null &&
      tt.avgMinutes != null &&
      tt.maxMinutes != null
    ) {
      lines.push(
        `• משכי אימון טיפוסיים: קצר ${tt.minMinutes} דק׳ / ממוצע ${tt.avgMinutes} דק׳ / ארוך ${tt.maxMinutes} דק׳`
      );
    }

    if (data.goal) {
      lines.push(`• מטרה: ${data.goal}`);
    }

    if (lines.length === 1) {
      // רק הכותרת – אין נתונים
      return (
        "כרגע אין לי כמעט נתונים בפרופיל שלך.\n" +
        'אפשר להתחיל מלהגדיר משקל, FTP, דופק ומטרה (לדוגמה: "המשקל שלי עכשיו 72", "FTP 240", "דופק מקסימלי 176", "המטרה שלי עכשיו היא גרן פונדו אילת").'
      );
    }

    return lines.join("\n");
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

    // כבר יש לנו הכל – לא קוראים שוב ל-DB
    if (hasTS && hasHr && Object.keys(currentFtpModels).length > 0) {
      return state;
    }

    try {
      if (this.db && typeof this.db.getStravaSnapshot === "function") {
        const snap = await this.db.getStravaSnapshot(userId);
        if (snap) {
          state.data.trainingSummary = snap.trainingSummary || null;
          state.data.volume = snap.volume || null;
          state.data.ftpModels = snap.ftpModels || {};
          state.data.hr = snap.hr || state.data.hr || {};
          state.data.personal = {
            ...state.data.personal,
            ...snap.personal,
          };
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

  // ===== OPENING MESSAGE =====

  _openingMessage() {
    return (
      "נעים מאוד, אני LOEW — המאמן האישי שלך.\n" +
      "אני מבסס את כל ההמלצות על ידע מקצועי, מתודולוגיות אימון מהטופ העולמי וניתוח פרסונלי של הנתונים שלך — כולל שינה, תחושה, עומס, בריאות, תזונה וכל מה שמשפיע על הביצועים שלך.\n" +
      "המטרה שלי: לבנות עבורך אימונים חכמים, אפקטיביים ויציבים לאורך זמן — כדי שתוכל להתאמן חזק ולהישאר בריא.\n\n" +
      "כדי להתחיל, אני צריך להתחבר ל- Strava שלך כדי לנתח את הרכיבות האחרונות שלך.\n" +
      "תלחץ על הלינק לחיבור סטרבה שקיבלת, וברגע שאסיים לייבא נתונים — נמשיך."
    );
  }

  // ===== STAGE: INTRO =====

  async _stageIntro(userId, text, state) {
    if (!text) {
      return this._openingMessage();
    }

    state.stage = "strava_wait";
    await this._saveState(userId, state);

    return (
      "מעולה.\n" +
      "ברגע שתאשר את החיבור לסטרבה, אייבא את הרכיבות שלך ואציג לך סיכום קצר.\n" +
      "אחרי הייבוא נמשיך לנתונים האישיים שלך, FTP, דופק, משכי אימון ומטרה."
    );
  }

  // ===== STAGE: STRAVA WAIT =====

  async _stageStravaWait(userId, text, state) {
    if (!state.data.snapshotAvailable) {
      return (
        "אני עדיין מחכה לאישור חיבור לסטרבה וייבוא הנתונים.\n" +
        "ברגע שהייבוא יסתיים, נמשיך הלאה."
      );
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
      const avgStr = this._formatMinutes(ts.avgDurationSec);
      const offPct =
        ts.offroadPct != null ? Math.round(ts.offroadPct * 100) : null;

      let profileLine = `ב-90 הימים האחרונים רכבת ${ts.rides_count} פעמים, `;
      profileLine += `סה\"כ ~${hours} שעות ו-${km} ק\"מ עם ${elevation} מטר טיפוס. `;
      profileLine += `משך רכיבה ממוצע ~${avgStr}.`;
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

      return (
        "סיימתי לייבא נתונים מסטרבה ✅\n\n" +
        profileLine +
        volLine +
        "\n\n" +
        "עכשיו נעבור לנתונים האישיים שלך — משקל, גובה וגיל."
      );
    }

    state.stage = "personal_details";
    await this._saveState(userId, state);
    return (
      "לא מצאתי מספיק רכיבות מ-90 הימים האחרונים כדי להציג סיכום נפח.\n" +
      "בוא נעבור לנתונים האישיים שלך."
    );
  }

  _formatMinutes(sec) {
    if (!sec || sec <= 0) return "—";
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} דק׳`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (mm === 0) return `${h} ש׳`;
    return `${h}:${mm.toString().padStart(2, "0")} ש׳`;
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

        return (
          "נעבור עכשיו לנתונים האישיים שלך.\n" +
          "נתחיל ממשקל — זה עוזר לי לחשב עומס ואימונים בצורה מדויקת יותר.\n\n" +
          line
        );
      }

      if (t === "אישור" && weightFromStrava != null) {
        state.data.personal.weight = weightFromStrava;
        state.data.personalStep = "height";
        await this._saveState(userId, state);
        return (
          `מעולה, אשתמש במשקל ${weightFromStrava} ק\"ג.\n\n` +
          'מה הגובה שלך בס"מ?'
        );
      }

      const parsed = parseFloat(t.replace(",", "."));
      if (Number.isNaN(parsed) || parsed < 30 || parsed > 200) {
        return (
          "לא הצלחתי להבין את המשקל שכתבת.\n" +
          'תכתוב מספר בק"ג (למשל 72 או 72.5).'
        );
      }

      state.data.personal.weight = Math.round(parsed * 10) / 10;
      state.data.personalStep = "height";
      await this._saveState(userId, state);

      return (
        `תודה, עדכנתי משקל ${state.data.personal.weight} ק\"ג.\n\n` +
        'מה הגובה שלך בס"מ?'
      );
    }

    // גובה
    if (step === "height") {
      if (!t) {
        return 'מה הגובה שלך בס"מ (למשל 178)?';
      }

      const h = parseInt(t, 10);
      if (Number.isNaN(h) || h < 120 || h > 230) {
        return (
          "לא הצלחתי להבין את הגובה שכתבת.\n" +
          'תכתוב גובה בס"מ (למשל 178).'
        );
      }

      state.data.personal.height = h;
      state.data.personalStep = "age";
      await this._saveState(userId, state);

      return `מעולה, עדכנתי גובה ${h} ס\"מ.\n\nבן כמה אתה?`;
    }

    // גיל
    if (step === "age") {
      if (!t) {
        return "בן כמה אתה?";
      }

      const age = parseInt(t, 10);
      if (Number.isNaN(age) || age < 10 || age > 90) {
        return (
          "לא הצלחתי להבין את הגיל שכתבת.\n" +
          "תכתוב גיל במספרים (למשל 46)."
        );
      }

      state.data.personal.age = age;
      state.data.personalStep = "done";
      state.stage = "ftp_models";

      await this._saveState(userId, state);

      return (
        `מעולה, עדכנתי גיל ${age}.\n\n` +
        "עכשיו נעבור לשלב FTP — הסמן המרכזי לעומס ולרמת הקושי באימונים שלך."
      );
    }

    return "משהו לא היה ברור בנתונים האישיים, ננסה שוב.";
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

      return lines.join("\n");
    }

    const parsed = parseInt(text, 10);
    if (Number.isNaN(parsed) || parsed < 80 || parsed > 500) {
      return (
        "כדי שאוכל לעבוד עם FTP מדויק — תכתוב מספר בוואטים, למשל 240.\n" +
        "אם אתה לא בטוח, אפשר לבחור ערך בין המודלים שהצגתי."
      );
    }

    state.data.ftpFinal = parsed;
    state.stage = "hr_intro";

    await this._updateTrainingParamsFromState(userId, state);
    await this._saveState(userId, state);

    return (
      `מעולה, נגדיר כרגע FTP של ${parsed}W.\n\n` +
      "עכשיו נעבור לדופק — דופק מקסימלי ודופק סף."
    );
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

    return (
      lines.join("\n") +
      "\n\n" +
      "נתחיל מדופק מקסימלי — מה הדופק המקסימלי הכי גבוה שאתה זוכר שראית (למשל 178)?"
    );
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
          return (
            `בסטרבה אני רואה דופק מקסימלי של בערך ${hrMaxCandidate} bpm.\n` +
            'אם זה נראה לך נכון, תכתוב "אישור". אם לא — תכתוב את הדופק המקסימלי הכי גבוה שאתה זוכר (למשל 178).'
          );
        }
        return "מה הדופק המקסימלי הכי גבוה שאתה זוכר שראית (למשל 178)?";
      }

      if (t === "אישור" && hrMaxCandidate != null) {
        hr.hrMaxUser = hrMaxCandidate;
        hr.hrMaxFinal = hrMaxCandidate;
        state.data.hrStep = "hrThreshold";
        await this._saveState(userId, state);

        return (
          `מעולה, נשתמש בדופק מקסימלי ${hrMaxCandidate} bpm.\n\n` +
          "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'."
        );
      }

      const parsed = parseInt(t, 10);
      if (Number.isNaN(parsed) || parsed < 120 || parsed > 230) {
        return (
          "לא הצלחתי להבין את הדופק שכתבת.\n" +
          "תכתוב דופק מקסימלי במספרים (למשל 178)."
        );
      }

      hr.hrMaxUser = parsed;
      hr.hrMaxFinal = parsed;
      state.data.hrStep = "hrThreshold";
      await this._saveState(userId, state);

      return (
        `תודה, עדכנתי דופק מקסימלי ${parsed} bpm.\n\n` +
        "עכשיו נעבור לדופק סף — אם אתה יודע אותו, תכתוב לי (למשל 160). אם אתה לא יודע, תכתוב 'לא יודע'."
      );
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
          return (
            "לא הצלחתי להבין את הדופק שכתבת.\n" +
            `אם זה נשמע הגיוני, אפשר גם לאשר את הערך שמצאתי: ${hrThresholdCandidate} bpm.\n` +
            'תכתוב את הדופק סף שלך במספרים (למשל 160), או "אישור".'
          );
        }
        return (
          "לא הצלחתי להבין את הדופק שכתבת.\n" +
          "תכתוב דופק סף במספרים (למשל 160)."
        );
      }

      state.data.hr.hrThresholdUser = parsed;
      state.data.hr.hrThresholdFinal = parsed;
      state.stage = "training_time";
      state.data.trainingTimeStep = "fromStrava";

      await this._updateTrainingParamsFromState(userId, state);
      await this._saveState(userId, state);

      return await this._stageTrainingTime(userId, "", state);
    }

    return "משהו לא היה ברור בשלב הדופק, ננסה שוב.";
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

        return line;
      }

      state.data.trainingTimeStep = "manual";
      await this._saveState(userId, state);

      return (
        "לא מצאתי מספיק נתונים על משך האימונים שלך מסטרבה.\n" +
        "תכתוב בבקשה שלושה מספרים בדקות: משך אימון קצר / ממוצע / ארוך (למשל 90/120/180)."
      );
    }

    if (step === "confirm") {
      if (!t) {
        return (
          'אם משכי האימון שהצגתי נראים לך סבירים — תכתוב "אישור".\n' +
          "אם אתה מעדיף להגדיר מחדש — תכתוב שלושה מספרים: קצר/ממוצע/ארוך בדקות (למשל 90/120/180)."
        );
      }

      if (t === "אישור") {
        state.data.trainingTimeStep = "done";
        state.stage = "goal_collect";
        await this._saveState(userId, state);

        return (
          "מעולה.\n" +
          "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך — תחרות, אירוע, ירידה במשקל או משהו אחר."
        );
      }

      const parsed = this._parseThreeDurations(t);
      if (!parsed) {
        return (
          "לא הצלחתי להבין את משכי האימון שכתבת.\n" +
          "תכתוב שלושה מספרים בדקות, מופרדים בפסיק או / (למשל 90/120/180)."
        );
      }

      tt.minMinutes = parsed.min;
      tt.avgMinutes = parsed.avg;
      tt.maxMinutes = parsed.max;
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";

      await this._saveState(userId, state);

      return (
        `עדכנתי משכי אימון: קצר ${parsed.min} דק׳ / ממוצע ${parsed.avg} דק׳ / ארוך ${parsed.max} דק׳.\n\n` +
        "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך."
      );
    }

    if (step === "manual") {
      const parsed = this._parseThreeDurations(t);
      if (!parsed) {
        return (
          "לא הצלחתי להבין את משכי האימון שכתבת.\n" +
          "תכתוב שלושה מספרים בדקות, מופרדים בפסיק או / (למשל 90/120/180)."
        );
      }

      tt.minMinutes = parsed.min;
      tt.avgMinutes = parsed.avg;
      tt.maxMinutes = parsed.max;
      state.data.trainingTimeStep = "done";
      state.stage = "goal_collect";

      await this._saveState(userId, state);

      return (
        `מעולה, עדכנתי משכי אימון: קצר ${parsed.min} דק׳ / ממוצע ${parsed.avg} דק׳ / ארוך ${parsed.max} דק׳.\n\n` +
        "עכשיו נשאר לנו רק להגדיר את המטרה המרכזית שלך."
      );
    }

    return "משהו לא היה ברור בשלב משך האימונים, ננסה שוב.";
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
      return "מה המטרה המרכזית שלך לתקופה הקרובה?";
    }

    state.data.goal = t;
    state.stage = "done";
    await this._saveState(userId, state);

    // הודעת סיום אונבורדינג = מסך בית
    return (
      "האונבורדינג שלך הושלם בהצלחה!\n" +
      "במה אני יכול לעזור לך?\n\n" +
      "דוגמאות שכיחות\n" +
      "טיפול בנתונים:\n" +
      '"עדכן מסטרבה"\n' +
      '"הפרופיל שלי"\n' +
      "עדכון הנתונים שלי:\n" +
      '"המשקל שלי עכשיו 72", "FTP 250", "דופק מקסימלי 178", "דופק סף 160"\n' +
      "ניתוח נתונים:\n" +
      '"נתח את האימון האחרון שלי", "נתח לי אימון מתאריך yyyy-mm-dd"'
    );
  }
}
