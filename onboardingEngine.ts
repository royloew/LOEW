// onboardingEngine.js
// מנוע האונבורדינג של LOEW – לוגיקה בלבד, בלי Express / HTTP.

// ========== טיפוסים לוגיים (בתור הערת JSDoc) ==========

/**
 * @typedef {string} UserId
 */

/**
 * @typedef {Object} User
 * @property {UserId} id
 * @property {number} [age]
 * @property {number} [weightKg]
 * @property {number} [heightM]
 * @property {string} [gender]
 * @property {string} [nickname]
 */

/**
 * @typedef {Object} TrainingParams
 * @property {UserId} userId
 * @property {number} [hrMaxValue]
 * @property {'strava_auto'|'user_manual'|'age_formula'} [hrMaxSource]
 * @property {boolean} [hrMaxConfirmed]
 * @property {number} [hrThresholdValue]
 * @property {'strava_auto'|'user_manual'|'derived_from_hrmax'} [hrThresholdSource]
 * @property {boolean} [hrThresholdConfirmed]
 * @property {number} [ftpValue]
 * @property {'strava_auto'|'user_manual'} [ftpSource]
 * @property {number} [ftpModel20min]
 * @property {number} [ftpModelCp]
 * @property {number} [ftpModelPowerCurve]
 * @property {number} [ftpAutoRecommended]
 * @property {boolean} [ftpConfirmed]
 */

/**
 * @typedef {Object} WeeklyTemplate
 * @property {UserId} userId
 * @property {number} [targetRidesPerWeek]
 * @property {number[]|null} [preferredDays] // 0–6
 * @property {number} [standardRideDurationMin]
 */

/**
 * @typedef {Object} UserGoal
 * @property {string} [id]
 * @property {UserId} userId
 * @property {'event'|'ftp'|'weight'|'fitness_general'|'consistency'|'other'} goalType
 * @property {string} goalDescription
 * @property {number|null} [goalTargetValue]
 * @property {string|null} [goalDate] // ISO
 * @property {boolean} [archived]
 */

/**
 * @typedef {'INTRO'
 *  | 'STRAVA_ASK'
 *  | 'STRAVA_WAIT_DONE'
 *  | 'PROFILE_AGE'
 *  | 'PROFILE_WEIGHT'
 *  | 'PROFILE_HEIGHT'
 *  | 'PROFILE_GENDER'
 *  | 'PROFILE_NICKNAME'
 *  | 'HRMAX'
 *  | 'HRTHRESH'
 *  | 'FTP'
 *  | 'WEEKLY_RIDES_PER_WEEK'
 *  | 'WEEKLY_PREFERRED_DAYS'
 *  | 'WEEKLY_STD_DURATION'
 *  | 'GOAL_MAIN'
 *  | 'GOAL_DETAILS'
 *  | 'SUMMARY'
 * } OnboardingStep
 */

/**
 * @typedef {Object} UserOnboarding
 * @property {UserId} userId
 * @property {boolean} onboardingCompleted
 * @property {string} version
 * @property {OnboardingStep} currentStep
 * @property {Object<string, any>} [temp]
 */

/**
 * @typedef {Object} ChatResponse
 * @property {string} text
 * @property {boolean} [done]
 */

/**
 * @typedef {Object} OnboardingDB
 *
 * // Users
 * @property {(userId: UserId) => Promise<User>} getUser
 * @property {(user: User) => Promise<void>} saveUser
 *
 * // Training params
 * @property {(userId: UserId) => Promise<TrainingParams|null>} getTrainingParams
 * @property {(params: TrainingParams) => Promise<void>} saveTrainingParams
 *
 * // Weekly template
 * @property {(userId: UserId) => Promise<WeeklyTemplate|null>} getWeeklyTemplate
 * @property {(template: WeeklyTemplate) => Promise<void>} saveWeeklyTemplate
 *
 * // Goals
 * @property {(userId: UserId) => Promise<UserGoal|null>} getActiveGoal
 * @property {(goalId: string) => Promise<void>} archiveGoal
 * @property {(goal: UserGoal) => Promise<UserGoal>} createGoal // אפשר להשתמש כ-update אם יש goal.id
 *
 * // Onboarding state
 * @property {(userId: UserId) => Promise<UserOnboarding|null>} getOnboarding
 * @property {(ob: UserOnboarding) => Promise<void>} saveOnboarding
 *
 * // Strava helpers
 * @property {(userId: UserId) => Promise<boolean>} hasStravaConnection
 * @property {(userId: UserId) => Promise<{
 *    hrMaxCandidate?: number,
 *    hrThresholdCandidate?: number,
 *    ftp20?: number,
 *    ftpCp?: number,
 *    ftpPowerCurve?: number,
 *    ftpRecommended?: number
 * }>} computeHrAndFtpFromStrava
 */

const ONBOARDING_VERSION = "v1.0";

// ========== פונקציות עזר קטנות ==========

function parseNumber(text) {
  if (text == null) return null;
  const num = Number(
    String(text).replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1")
  );
  return Number.isNaN(num) ? null : num;
}

function normalizeYes(text) {
  const t = String(text).trim().toLowerCase();
  return ["כן", "מאשר", "נשמע טוב", "yes", "y"].some((x) => t.startsWith(x));
}

function normalizeNo(text) {
  const t = String(text).trim().toLowerCase();
  return ["לא", "no", "לא רוצה"].some((x) => t.startsWith(x));
}

const hebrewDayToIndex = {
  "ראשון": 0,
  "שני": 1,
  "שלישי": 2,
  "רביעי": 3,
  "חמישי": 4,
  "שישי": 5,
  "שבת": 6,
};

function parsePreferredDays(text) {
  const t = String(text).trim();
  if (!t || t === "אין") return null;
  const parts = t.split(/[,\s]+/).filter(Boolean);
  const indices = parts
    .map((p) => hebrewDayToIndex[p])
    .filter((n) => typeof n === "number");
  return indices.length ? indices : null;
}

// ========== המחלקה – מנוע אונבורדינג ==========

export class OnboardingEngine {
  /**
   * @param {OnboardingDB} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * צעד אחד של שיחה באונבורדינג
   * @param {UserId} userId
   * @param {string} message
   * @returns {Promise<ChatResponse>}
   */
  async handleMessage(userId, message) {
    let onboarding = await this.db.getOnboarding(userId);
    if (!onboarding) {
      onboarding = {
        userId,
        onboardingCompleted: false,
        version: ONBOARDING_VERSION,
        currentStep: "INTRO",
        temp: {},
      };
      await this.db.saveOnboarding(onboarding);
    }

    if (onboarding.onboardingCompleted) {
      return {
        text: 'האונבורדינג כבר הושלם. אפשר לשאול "מה האימון שלי היום?".',
        done: true,
      };
    }

    switch (onboarding.currentStep) {
      case "INTRO":
        return this.handleIntro(onboarding, message);
      case "STRAVA_ASK":
        return this.handleStravaAsk(onboarding, message);
      case "STRAVA_WAIT_DONE":
        return this.handleStravaWaitDone(onboarding, message);
      case "PROFILE_AGE":
      case "PROFILE_WEIGHT":
      case "PROFILE_HEIGHT":
      case "PROFILE_GENDER":
      case "PROFILE_NICKNAME":
        return this.handleProfile(onboarding, message);
      case "HRMAX":
        return this.handleHrMax(onboarding, message);
      case "HRTHRESH":
        return this.handleHrThreshold(onboarding, message);
      case "FTP":
        return this.handleFtp(onboarding, message);
      case "WEEKLY_RIDES_PER_WEEK":
      case "WEEKLY_PREFERRED_DAYS":
      case "WEEKLY_STD_DURATION":
        return this.handleWeekly(onboarding, message);
      case "GOAL_MAIN":
      case "GOAL_DETAILS":
        return this.handleGoal(onboarding, message);
      case "SUMMARY":
        return this.handleSummary(onboarding, message);
      default:
        return { text: "שגיאה בסטטוס האונבורדינג. נסה שוב." };
    }
  }

  /**
   * קריאה מה־Strava OAuth callback – אחרי חיבור
   * @param {UserId} userId
   */
  async handleStravaConnected(userId) {
    const onboarding = await this.db.getOnboarding(userId);
    if (!onboarding) return;

    const candidates = await this.db.computeHrAndFtpFromStrava(userId);
    let tp = await this.db.getTrainingParams(userId);
    if (!tp) tp = { userId };

    if (candidates.hrMaxCandidate) {
      tp.hrMaxValue = candidates.hrMaxCandidate;
      tp.hrMaxSource = "strava_auto";
    }

    if (candidates.hrThresholdCandidate) {
      tp.hrThresholdValue = candidates.hrThresholdCandidate;
      tp.hrThresholdSource = "strava_auto";
    }

    tp.ftpModel20min = candidates.ftp20 ?? tp.ftpModel20min;
    tp.ftpModelCp = candidates.ftpCp ?? tp.ftpModelCp;
    tp.ftpModelPowerCurve = candidates.ftpPowerCurve ?? tp.ftpModelPowerCurve;
    tp.ftpAutoRecommended =
      candidates.ftpRecommended ?? tp.ftpAutoRecommended;

    await this.db.saveTrainingParams(tp);

    onboarding.currentStep = "PROFILE_AGE";
    onboarding.temp = onboarding.temp || {};
    onboarding.temp.stravaLoaded = true;
    await this.db.saveOnboarding(onboarding);
  }

  // ========== שלב 1 – INTRO ==========

  async handleIntro(onboarding, _message) {
    onboarding.currentStep = "STRAVA_ASK";
    await this.db.saveOnboarding(onboarding);

    return {
      text:
        "אני LOEW. נתחיל מחיבור ל-Strava אם יש לך, כדי שאדע כמה שיותר עליך מהרכיבות האחרונות. יש לך חשבון Strava פעיל?",
    };
  }

  // ========== שלב 2 – STRAVA ==========

  async handleStravaAsk(onboarding, message) {
    const yes = normalizeYes(message);
    const no = normalizeNo(message);

    if (yes) {
      onboarding.currentStep = "STRAVA_WAIT_DONE";
      await this.db.saveOnboarding(onboarding);
      return {
        text:
          "מעולה. תתחבר עכשיו ל-Strava דרך הקישור באפליקציה. אחרי החיבור אני אטען את הרכיבות שלך מ־90 הימים האחרונים.",
      };
    }

    if (no) {
      onboarding.currentStep = "PROFILE_AGE";
      await this.db.saveOnboarding(onboarding);
      return { text: "הכל טוב, נתקדם ידנית. בן כמה אתה?" };
    }

    return { text: 'יש לך Strava? תענה "כן" או "לא".' };
  }

  async handleStravaWaitDone(onboarding, _message) {
    const connected = await this.db.hasStravaConnection(onboarding.userId);
    if (!connected) {
      return {
        text:
          'אני עדיין לא רואה חיבור פעיל ל-Strava. אחרי שתאשר את החיבור, נמשיך. אם אתה לא רוצה לחבר – תכתוב "לא".',
      };
    }

    onboarding.currentStep = "PROFILE_AGE";
    await this.db.saveOnboarding(onboarding);

    return {
      text: "התחברתי ל-Strava. נתחיל מכמה פרטים בסיסיים. בן כמה אתה?",
    };
  }

  // ========== שלב 3 – פרופיל בסיסי ==========

  async handleProfile(onboarding, message) {
    const user = await this.db.getUser(onboarding.userId);

    switch (onboarding.currentStep) {
      case "PROFILE_AGE": {
        const age = parseNumber(message);
        if (!age) return { text: "לא הצלחתי להבין. בן כמה אתה?" };

        user.age = age;
        await this.db.saveUser(user);

        onboarding.currentStep = "PROFILE_WEIGHT";
        await this.db.saveOnboarding(onboarding);
        return { text: "מעולה. מה המשקל שלך בק״ג?" };
      }

      case "PROFILE_WEIGHT": {
        const weight = parseNumber(message);
        if (!weight) return { text: "לא הצלחתי להבין. מה המשקל שלך בק״ג?" };

        user.weightKg = weight;
        await this.db.saveUser(user);

        onboarding.currentStep = "PROFILE_HEIGHT";
        await this.db.saveOnboarding(onboarding);
        return {
          text:
            'רוצה להוסיף גם גובה? אם כן – תכתוב במטרים (למשל 1.78). אם לא – תכתוב "דלג".',
        };
      }

      case "PROFILE_HEIGHT": {
        const txt = String(message).trim();
        if (txt !== "דלג") {
          const height = parseNumber(txt);
          if (!height)
            return {
              text:
                'לא הצלחתי להבין את הגובה. תכתוב במטרים (למשל 1.78) או "דלג".',
            };
          user.heightM = height;
          await this.db.saveUser(user);
        }
        onboarding.currentStep = "PROFILE_GENDER";
        await this.db.saveOnboarding(onboarding);
        return {
          text:
            'אם מתאים לך לציין מין – תכתוב "זכר", "נקבה" או אחר. אם לא – תכתוב "דלג".',
        };
      }

      case "PROFILE_GENDER": {
        const txt = String(message).trim();
        if (txt !== "דלג") {
          user.gender = txt;
          await this.db.saveUser(user);
        }
        onboarding.currentStep = "PROFILE_NICKNAME";
        await this.db.saveOnboarding(onboarding);
        return { text: "איך תרצה שאפנה אליך?" };
      }

      case "PROFILE_NICKNAME": {
        const nick = String(message).trim();
        if (nick) {
          user.nickname = nick;
          await this.db.saveUser(user);
        }

        onboarding.currentStep = "HRMAX";
        await this.db.saveOnboarding(onboarding);

        let tp = await this.db.getTrainingParams(user.id);
        if (!tp) tp = { userId: user.id };

        if (tp.hrMaxValue) {
          return {
            text: `ברכיבות האחרונות ראיתי דופק מקסימלי בסביבות ${tp.hrMaxValue}. זה נראה לך מספר הגיוני לדופק המקסימלי שלך? אם לא – תכתוב את הדופק המקסימלי הכי גבוה שאתה זוכר.`,
          };
        } else {
          return {
            text:
              "אין לי נתון מספיק טוב לדופק המקסימלי שלך. מה הדופק המקסימלי הכי גבוה שאתה זוכר שראית?",
          };
        }
      }
    }

    return { text: "שגיאה לוגית בפרופיל." };
  }

  // ========== שלב 5 – HRMAX ==========

  async handleHrMax(onboarding, message) {
    let tp = await this.db.getTrainingParams(onboarding.userId);
    if (!tp) tp = { userId: onboarding.userId };
    const user = await this.db.getUser(onboarding.userId);
    const txt = String(message).trim();

    if (!tp.hrMaxValue) {
      const num = parseNumber(txt);
      if (!num && txt !== "לא יודע") {
        return {
          text:
            'לא הצלחתי להבין. תכתוב את הדופק המקסימלי הכי גבוה שאתה זוכר, או "לא יודע".',
        };
      }

      if (txt === "לא יודע") {
        if (!user.age) {
          return {
            text:
              "אני צריך את הגיל שלך כדי להעריך דופק מקס. תכתוב לי את הגיל, ואז נחזור לזה.",
          };
        }
        const est = 220 - (user.age || 40);
        tp.hrMaxValue = est;
        tp.hrMaxSource = "age_formula";
        tp.hrMaxConfirmed = true;
        await this.db.saveTrainingParams(tp);

        onboarding.currentStep = "HRTHRESH";
        await this.db.saveOnboarding(onboarding);
        return {
          text: `לפי הגיל שלך, אני מציע להתחיל מ־${est} כדופק מקסימלי. נעבור עכשיו לדופק סף.`,
        };
      }

      const val = parseNumber(txt);
      tp.hrMaxValue = val;
      tp.hrMaxSource = "user_manual";
      tp.hrMaxConfirmed = true;
      await this.db.saveTrainingParams(tp);

      onboarding.currentStep = "HRTHRESH";
      await this.db.saveOnboarding(onboarding);

      const thr = await this.db.getTrainingParams(onboarding.userId);
      if (thr && thr.hrThresholdValue) {
        return {
          text: `מעולה. עכשיו לדופק סף. מהדאטה אני מעריך את דופק הסף שלך סביב ${thr.hrThresholdValue}. זה מסתדר לך? אם לא – תכתוב דופק סף אחר.`,
        };
      } else {
        return {
          text:
            'מעולה. עכשיו לדופק סף. אם אתה יודע – תכתוב מה לדעתך דופק הסף שלך. אם לא – תכתוב "לא יודע".',
        };
      }
    } else {
      const num = parseNumber(txt);

      if (normalizeYes(txt) && !num) {
        tp.hrMaxConfirmed = true;
        await this.db.saveTrainingParams(tp);
        onboarding.currentStep = "HRTHRESH";
        await this.db.saveOnboarding(onboarding);

        const thr = await this.db.getTrainingParams(onboarding.userId);
        if (thr && thr.hrThresholdValue) {
          return {
            text: `מעולה. עכשיו לדופק סף. מהדאטה אני מעריך את דופק הסף שלך סביב ${thr.hrThresholdValue}. זה מסתדר לך? אם לא – תכתוב דופק סף אחר.`,
          };
        } else {
          return {
            text:
              'מעולה. עכשיו לדופק סף. אם אתה יודע – תכתוב מה לדעתך דופק הסף שלך. אם לא – תכתוב "לא יודע".',
          };
        }
      }

      if (num) {
        tp.hrMaxValue = num;
        tp.hrMaxSource = "user_manual";
        tp.hrMaxConfirmed = true;
        await this.db.saveTrainingParams(tp);

        onboarding.currentStep = "HRTHRESH";
        await this.db.saveOnboarding(onboarding);

        const thr = await this.db.getTrainingParams(onboarding.userId);
        if (thr && thr.hrThresholdValue) {
          return {
            text: `מעולה. עכשיו לדופק סף. מהדאטה אני מעריך את דופק הסף שלך סביב ${thr.hrThresholdValue}. זה מסתדר לך? אם לא – תכתוב דופק סף אחר.`,
          };
        } else {
          return {
            text:
              'מעולה. עכשיו לדופק סף. אם אתה יודע – תכתוב מה לדעתך דופק הסף שלך. אם לא – תכתוב "לא יודע".',
          };
        }
      }

      return {
        text:
          'אם המספר שהצעתי לא נראה לך – תכתוב את הדופק המקסימלי שלך, או תכתוב "כן" אם הוא בסדר.',
      };
    }
  }

  // ========== שלב 5 – HRTHRESH ==========

  async handleHrThreshold(onboarding, message) {
    let tp = await this.db.getTrainingParams(onboarding.userId);
    if (!tp) tp = { userId: onboarding.userId };

    const hrMax = tp.hrMaxValue;
    const txt = String(message).trim();
    const num = parseNumber(txt);

    if (!tp.hrThresholdValue) {
      if (!num && txt !== "לא יודע") {
        return {
          text:
            'לא הצלחתי להבין. תכתוב דופק סף (חזק אבל אפשר להחזיק), או "לא יודע".',
        };
      }

      if (txt === "לא יודע") {
        if (!hrMax) {
          return {
            text:
              "אני צריך דופק מקסימלי כדי להעריך דופק סף. בוא נחזור רגע אחורה ונעדכן אותו.",
          };
        }
        const est = Math.round(hrMax * 0.85);
        tp.hrThresholdValue = est;
        tp.hrThresholdSource = "derived_from_hrmax";
        tp.hrThresholdConfirmed = true;
        await this.db.saveTrainingParams(tp);

        onboarding.currentStep = "FTP";
        await this.db.saveOnboarding(onboarding);
        return {
          text: `בשלב ראשון נעבוד עם דופק סף של ${est}. נעבור עכשיו ל־FTP.`,
        };
      }

      const val = parseNumber(txt);
      tp.hrThresholdValue = val;
      tp.hrThresholdSource = "user_manual";
      tp.hrThresholdConfirmed = true;
      await this.db.saveTrainingParams(tp);

      onboarding.currentStep = "FTP";
      await this.db.saveOnboarding(onboarding);
      return { text: `מעולה. דופק סף עודכן ל־${val}. עכשיו נעבור ל־FTP.` };
    } else {
      if (normalizeYes(txt) && !num) {
        tp.hrThresholdConfirmed = true;
        await this.db.saveTrainingParams(tp);

        onboarding.currentStep = "FTP";
        await this.db.saveOnboarding(onboarding);
        return { text: "מעולה. עכשיו נעבור ל־FTP." };
      }

      if (num) {
        tp.hrThresholdValue = num;
        tp.hrThresholdSource = "user_manual";
        tp.hrThresholdConfirmed = true;
        await this.db.saveTrainingParams(tp);

        onboarding.currentStep = "FTP";
        await this.db.saveOnboarding(onboarding);
        return {
          text: `מעולה. דופק סף עודכן ל־${num}. עכשיו נעבור ל־FTP.`,
        };
      }

      return {
        text:
          'אם המספר שהצעתי לא נשמע לך, תכתוב דופק סף אחר. אם מתאים – תכתוב "כן".',
      };
    }
  }

  // ========== שלב 6 – FTP ==========

  async handleFtp(onboarding, message) {
    let tp = await this.db.getTrainingParams(onboarding.userId);
    if (!tp) tp = { userId: onboarding.userId };

    const txt = String(message).trim();
    const num = parseNumber(txt);

    if (!onboarding.temp || !onboarding.temp.ftpPresented) {
      onboarding.temp = onboarding.temp || {};
      onboarding.temp.ftpPresented = true;
      await this.db.saveOnboarding(onboarding);

      const m20 = tp.ftpModel20min;
      const cp = tp.ftpModelCp;
      const pc = tp.ftpModelPowerCurve;
      const rec = tp.ftpAutoRecommended;

      return {
        text: `מהנתונים שלך חישבתי שלושה ערכים:
- 20 דקות: ${m20 ?? "-"}
- קטעים יציבים: ${cp ?? "-"}
- וואטים מקס בטווחים: ${pc ?? "-"}

אני מציע לעבוד עם ${rec ?? m20 ?? cp ?? pc ?? 200} FTP כערך התחלתי.
אם המספר הזה נראה לך – תכתוב "מאשר".
אם יש לך ערך אחר בראש – תכתוב אותו.`,
      };
    }

    if (normalizeYes(txt) && !num) {
      const final =
        tp.ftpAutoRecommended ??
        tp.ftpModel20min ??
        tp.ftpModelCp ??
        tp.ftpModelPowerCurve ??
        200;

      tp.ftpValue = final;
      tp.ftpSource = "strava_auto";
      tp.ftpConfirmed = true;
      await this.db.saveTrainingParams(tp);

      onboarding.currentStep = "WEEKLY_RIDES_PER_WEEK";
      await this.db.saveOnboarding(onboarding);

      return {
        text: `מעולה. FTP סופי לעבודה: ${final}.
כמה פעמים בשבוע אתה רוצה לרכוב?`,
      };
    }

    if (num) {
      tp.ftpValue = num;
      tp.ftpSource = "user_manual";
      tp.ftpConfirmed = true;
      await this.db.saveTrainingParams(tp);

      onboarding.currentStep = "WEEKLY_RIDES_PER_WEEK";
      await this.db.saveOnboarding(onboarding);

      return {
        text: `מעולה. FTP עודכן ל־${num}.
כמה פעמים בשבוע אתה רוצה לרכוב?`,
      };
    }

    return {
      text:
        'אם המספר שהצעתי מתאים – תכתוב "מאשר". אם לא – תכתוב את ה־FTP שאתה רוצה.',
    };
  }

  // ========== שלב 7 – שגרה שבועית ==========

  async handleWeekly(onboarding, message) {
    let template = await this.db.getWeeklyTemplate(onboarding.userId);
    if (!template) template = { userId: onboarding.userId };

    switch (onboarding.currentStep) {
      case "WEEKLY_RIDES_PER_WEEK": {
        const num = parseNumber(message);
        if (!num) {
          return { text: "כמה פעמים בשבוע אתה רוצה לרכב (מספר)?" };
        }
        template.targetRidesPerWeek = num;
        await this.db.saveWeeklyTemplate(template);

        onboarding.currentStep = "WEEKLY_PREFERRED_DAYS";
        await this.db.saveOnboarding(onboarding);

        return {
          text:
            'אם יש לך ימים קבועים שאתה בדרך כלל רוכב בהם – תכתוב אותם, למשל: "ראשון שלישי חמישי שבת". אם אין ימים קבועים, תכתוב "אין".',
        };
      }

      case "WEEKLY_PREFERRED_DAYS": {
        const txt = String(message).trim();
        if (txt === "אין") {
          template.preferredDays = null;
        } else {
          template.preferredDays = parsePreferredDays(txt);
        }
        await this.db.saveWeeklyTemplate(template);

        onboarding.currentStep = "WEEKLY_STD_DURATION";
        await this.db.saveOnboarding(onboarding);

        return {
          text:
            "מה הזמן הסטנדרטי שאתה רוצה שרכיבה תחשב כאימון? תכתוב בדקות, למשל 120.",
        };
      }

      case "WEEKLY_STD_DURATION": {
        const num = parseNumber(message);
        if (!num) {
          return {
            text:
              "לא הצלחתי להבין. תכתוב את משך הרכיבה הסטנדרטי בדקות, למשל 120.",
          };
        }
        template.standardRideDurationMin = num;
        await this.db.saveWeeklyTemplate(template);

        onboarding.currentStep = "GOAL_MAIN";
        await this.db.saveOnboarding(onboarding);

        return {
          text:
            "מה המטרה המרכזית שלך בתקופה הקרובה? תכתוב בקצרה – אירוע, שיפור FTP, ירידה במשקל, או משהו אחר.",
        };
      }
    }

    return { text: "שגיאה לוגית בשלב השגרה השבועית." };
  }

  // ========== שלב 8 – מטרה ==========

  async handleGoal(onboarding, message) {
    const txt = String(message).trim();

    if (onboarding.currentStep === "GOAL_MAIN") {
      let type = "other";
      if (txt.includes("אירוע") || txt.includes("גרן") || txt.includes("פונדו")) {
        type = "event";
      } else if (txt.toLowerCase().includes("ftp")) {
        type = "ftp";
      } else if (txt.includes("משקל")) {
        type = "weight";
      } else if (txt.includes("כושר")) {
        type = "fitness_general";
      }

      const existing = await this.db.getActiveGoal(onboarding.userId);
      if (existing && existing.id) {
        await this.db.archiveGoal(existing.id);
      }

      const goal = {
        userId: onboarding.userId,
        goalType: type,
        goalDescription: txt,
      };

      const created = await this.db.createGoal(goal);

      onboarding.temp = onboarding.temp || {};
      onboarding.temp.currentGoalId = created.id;
      onboarding.temp.goalType = type;
      onboarding.currentStep = "GOAL_DETAILS";
      await this.db.saveOnboarding(onboarding);

      if (type === "event") {
        return { text: "מה התאריך המדויק של האירוע?" };
      } else {
        return {
          text:
            'אם יש לך יעד מספרי או תאריך (וואטים, ק״ג, תאריך יעד) – תכתוב אותו. אם לא – תכתוב "אין".',
        };
      }
    }

    if (onboarding.currentStep === "GOAL_DETAILS") {
      const goalId = onboarding.temp && onboarding.temp.currentGoalId;
      if (!goalId) {
        onboarding.currentStep = "SUMMARY";
        await this.db.saveOnboarding(onboarding);
        return { text: "רשמתי את המטרה. נעבור לסיכום." };
      }

      const goal = await this.db.getActiveGoal(onboarding.userId);
      if (!goal) {
        onboarding.currentStep = "SUMMARY";
        await this.db.saveOnboarding(onboarding);
        return { text: "רשמתי את המטרה. נעבור לסיכום." };
      }

      const txtLower = txt.toLowerCase();
      if (txtLower === "אין") {
        onboarding.currentStep = "SUMMARY";
        await this.db.saveOnboarding(onboarding);
        return { text: "סבבה. נעבוד לפי המטרה הכללית. נעבור לסיכום." };
      }

      const val = parseNumber(txt);
      if (val) {
        goal.goalTargetValue = val;
      }

      // תאריך – אפשר להוסיף בעתיד parsing לתאריך
      await this.db.createGoal(goal); // או updateGoal במימוש שלך

      onboarding.currentStep = "SUMMARY";
      await this.db.saveOnboarding(onboarding);

      return { text: "מעולה. רשמתי את פרטי המטרה. נעבור לסיכום." };
    }

    return { text: "שגיאה לוגית בשלב המטרה." };
  }

  // ========== שלב 9 – סיכום ==========

  async handleSummary(onboarding, _message) {
    const user = await this.db.getUser(onboarding.userId);
    const tp =
      (await this.db.getTrainingParams(onboarding.userId)) || {
        userId: onboarding.userId,
      };
    const weekly =
      (await this.db.getWeeklyTemplate(onboarding.userId)) || {
        userId: onboarding.userId,
      };
    const goal = await this.db.getActiveGoal(onboarding.userId);

    onboarding.onboardingCompleted = true;
    onboarding.version = ONBOARDING_VERSION;
    await this.db.saveOnboarding(onboarding);

    const lines = [];
    lines.push("זה הפרופיל שלך כרגע:");
    if (user.age) lines.push(`- גיל: ${user.age}`);
    if (user.weightKg) lines.push(`- משקל: ${user.weightKg} ק״ג`);
    if (user.heightM) lines.push(`- גובה: ${user.heightM} מ׳`);
    if (tp.hrMaxValue) lines.push(`- דופק מקסימלי: ${tp.hrMaxValue}`);
    if (tp.hrThresholdValue) lines.push(`- דופק סף: ${tp.hrThresholdValue}`);
    if (tp.ftpValue) lines.push(`- FTP: ${tp.ftpValue}`);
    if (weekly.targetRidesPerWeek)
      lines.push(`- רכיבות בשבוע: ${weekly.targetRidesPerWeek}`);
    if (weekly.standardRideDurationMin)
      lines.push(
        `- זמן רכיבה סטנדרטי: ${weekly.standardRideDurationMin} דקות`
      );
    if (goal) {
      lines.push(
        `- מטרה: ${goal.goalDescription}${
          goal.goalTargetValue ? ` (יעד: ${goal.goalTargetValue})` : ""
        }`
      );
    }

    lines.push(
      "",
      'מכאן והלאה תוכל לשאול בכל בוקר: "מה האימון שלי היום?" ואני אתאים לך אימון לפי המצב והמטרה שלך.'
    );

    return { text: lines.join("\n"), done: true };
  }
}

