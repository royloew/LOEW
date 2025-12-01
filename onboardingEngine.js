// onboardingEngine.js
// מנוע אונבורדינג טהור ל-LOEW – בלי HTTP, בלי OpenAI.
// עובד מול dbImpl שמספק גישה ל-DB ונתוני סטרבה.

export class OnboardingEngine {
  /**
   * db צריך לממש:
   * getUser, saveUser
   * getTrainingParams, saveTrainingParams
   * getWeeklyTemplate, saveWeeklyTemplate
   * getActiveGoal, createGoal, archiveGoal
   * getOnboarding, saveOnboarding
   * hasStravaConnection, computeHrAndFtpFromStrava
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * קריאה מהשרת כשמתבצע חיבור לסטרבה (אחרי /exchange_token)
   */
  async handleStravaConnected(userId) {
    // נוודא שיש רשומת אונבורדינג
    let onboarding = await this.db.getOnboarding(userId);
    if (!onboarding) {
      onboarding = {
        userId,
        currentStep: "STRAVA_ASK",
        onboardingCompleted: false,
        stravaConnected: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    onboarding.stravaConnected = true;
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    // למשוך נתוני סטרבה ולהכניס כ"קנדידטים" ל-DB
    try {
      const metrics = await this.db.computeHrAndFtpFromStrava(userId);
      if (!metrics) return;

      // פרמטרי אימון
      let params = (await this.db.getTrainingParams(userId)) || { userId };

      if (metrics.hrMaxCandidate != null) {
        params.hrMaxCandidate = metrics.hrMaxCandidate;
      }
      if (metrics.hrThresholdCandidate != null) {
        params.hrThresholdCandidate = metrics.hrThresholdCandidate;
      }
      if (metrics.ftp20 != null) {
        params.ftpFrom20min = metrics.ftp20;
      }
      if (metrics.ftpCp != null) {
        params.ftpFrom8min = metrics.ftpCp; // מודל CP (3+20 דקות)
      }
      if (metrics.ftpPowerCurve != null) {
        params.ftpFrom3min = metrics.ftpPowerCurve; // Power Curve מ-3 דקות
      }
      if (metrics.ftpFromStrava != null) {
        params.ftpFromStrava = metrics.ftpFromStrava;
      }
      if (metrics.ftpRecommended != null) {
        params.ftpRecommended = metrics.ftpRecommended;
      }

      await this.db.saveTrainingParams(params);

      // משקל מהסטרבה (אם קיים)
      if (metrics.userWeightKg != null) {
        let user = (await this.db.getUser(userId)) || { id: userId };
        user.weight_kg = metrics.userWeightKg;
        await this.db.saveUser(user);
      }

      // נפח שבועי מהסטרבה
      if (metrics.trainingSummary && metrics.trainingSummary.avgHoursPerWeek) {
        let weekly =
          (await this.db.getWeeklyTemplate(userId)) || { userId };
        weekly.stravaAvgHoursPerWeek =
          metrics.trainingSummary.avgHoursPerWeek || null;
        weekly.stravaRidesCount90d =
          metrics.trainingSummary.rides_count || null;
        await this.db.saveWeeklyTemplate(weekly);
      }
    } catch (err) {
      console.error("handleStravaConnected metrics error:", err);
    }
  }

  /**
   * נקודת הכניסה העיקרית – טיפול בהודעת משתמש אחת.
   */
  async handleMessage(userId, message) {
    let onboarding = await this.db.getOnboarding(userId);
    if (!onboarding) {
      onboarding = {
        userId,
        currentStep: "STRAVA_ASK",
        onboardingCompleted: false,
        stravaConnected: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.db.saveOnboarding(onboarding);
    }

    if (onboarding.onboardingCompleted) {
      return {
        text:
          "האונבורדינג כבר הושלם. תכתוב לי פשוט מה בא לך – למשל 'מה האימון שלי היום?'.",
        done: true,
      };
    }

    const step = onboarding.currentStep || "STRAVA_ASK";
    const txt = String(message || "").trim();

    switch (step) {
      case "STRAVA_ASK":
        return await this._handleStravaAsk(onboarding, txt);
      case "STRAVA_WAIT":
        return await this._handleStravaWait(onboarding, txt);
      case "PROFILE_AGE":
        return await this._handleProfileAge(onboarding, txt);
      case "PROFILE_HEIGHT":
        return await this._handleProfileHeight(onboarding, txt);
      case "PROFILE_WEIGHT":
        return await this._handleProfileWeight(onboarding, txt);
      case "WEEKLY_RIDES":
        return await this._handleWeeklyRides(onboarding, txt);
      case "RIDE_DURATION":
        return await this._handleRideDuration(onboarding, txt);
      case "HR_MAX":
        return await this._handleHrMax(onboarding, txt);
      case "HR_THRESHOLD":
        return await this._handleHrThreshold(onboarding, txt);
      case "FTP_MAIN":
        return await this._handleFtp(onboarding, txt);
      case "GOAL_MAIN":
        return await this._handleGoalMain(onboarding, txt);
      default:
        onboarding.currentStep = "PROFILE_AGE";
        onboarding.updatedAt = new Date().toISOString();
        await this.db.saveOnboarding(onboarding);
        return { text: "נתחיל מהבסיס. בן כמה אתה?" };
    }
  }

  // ==========================
  //  STRAVA – זרימה עם __STRAVA_CONNECT__
  // ==========================

  async _handleStravaAsk(onboarding, message) {
    const userId = onboarding.userId;

    // אם כבר יש חיבור סטרבה – מדלגים ישר לגיל
    try {
      const hasConn = await this.db.hasStravaConnection(userId);
      if (hasConn || onboarding.stravaConnected) {
        onboarding.currentStep = "PROFILE_AGE";
        onboarding.updatedAt = new Date().toISOString();
        await this.db.saveOnboarding(onboarding);

        return {
          text:
            "כבר חיברנו את סטרבה וקלטתי את הנתונים שלך.\n" +
            "עכשיו בוא נתחיל מהבסיס.\nבן כמה אתה?",
        };
      }
    } catch (err) {
      console.error("STRAVA_ASK hasStravaConnection error:", err);
    }

    // הודעה ראשונה בלי טקסט מהמשתמש
    if (!message) {
      return {
        text:
          "היי, אני LOEW, המאמן האישי שלך לאופניים.\n" +
          "יש לך חשבון Strava פעיל שתרצה לחבר?",
      };
    }

    // המשתמש ענה "כן" -> סיגנל לפרונט לעשות redirect ל-Strava
    if (isYes(message)) {
      onboarding.currentStep = "STRAVA_WAIT";
      onboarding.updatedAt = new Date().toISOString();
      await this.db.saveOnboarding(onboarding);

      return {
        text: "__STRAVA_CONNECT__",
      };
    }

    // המשתמש לא רוצה סטרבה
    if (isNo(message)) {
      onboarding.currentStep = "PROFILE_AGE";
      onboarding.updatedAt = new Date().toISOString();
      await this.db.saveOnboarding(onboarding);
      return { text: "סבבה, נוכל לעבוד גם בלי סטרבה. בן כמה אתה?" };
    }

    // תשובה לא ברורה
    return {
      text: "לא בטוח שהבנתי. יש לך סטרבה שתרצה לחבר? תענה כן או לא.",
    };
  }

  async _handleStravaWait(onboarding, message) {
    const userId = onboarding.userId;

    // אם בינתיים השרת כבר יודע על חיבור סטרבה – נתקדם
    try {
      const hasConn = await this.db.hasStravaConnection(userId);
      if (hasConn || onboarding.stravaConnected) {
        await this.handleStravaConnected(userId);

        onboarding.currentStep = "PROFILE_AGE";
        onboarding.updatedAt = new Date().toISOString();
        await this.db.saveOnboarding(onboarding);

        return {
          text:
            "קיבלתי את הנתונים מסטרבה. עכשיו בוא נגדיר כמה דברים בסיסיים.\n" +
            "בן כמה אתה?",
        };
      }
    } catch (err) {
      console.error("STRAVA_WAIT hasStravaConnection error:", err);
    }

    // אם המשתמש כתב "דלג" או "לא" – ממשיכים בלי סטרבה
    if (isNo(message) || (message && message.includes("דלג"))) {
      onboarding.currentStep = "PROFILE_AGE";
      onboarding.updatedAt = new Date().toISOString();
      await this.db.saveOnboarding(onboarding);
      return { text: "סבבה, נמשיך בלי סטרבה. בן כמה אתה?" };
    }

    // אם הוא כתב שוב "כן" – רק מרגיעים
    if (isYes(message)) {
      return {
        text:
          "אם כבר אישרת לסטרבה, חכה כמה שניות וכתוב לי שוב.\n" +
          "אם לא מסתדר, תמיד אפשר לכתוב 'דלג' ונמשיך בלי סטרבה.",
      };
    }

    // עדיין מחכה לחיבור
    return {
      text:
        "אני עדיין לא רואה חיבור פעיל לסטרבה.\n" +
        "אם חיברת כבר – חכה כמה שניות ותכתוב לי שוב, או תכתוב 'דלג' ונמשיך בלי סטרבה.",
    };
  }

  // ==========================
  //  PROFILE: גיל, גובה, משקל
  // ==========================

  async _handleProfileAge(onboarding, message) {
    const userId = onboarding.userId;
    let user = (await this.db.getUser(userId)) || { id: userId };

    if (!message) {
      return { text: "בן כמה אתה?" };
    }

    const age = parseIntFromText(message);
    if (!age || age < 10 || age > 90) {
      return { text: "לא הצלחתי להבין. תכתוב גיל במספרים (למשל 46)." };
    }

    user.age = age;
    await this.db.saveUser(user);

    // אם אין לנו גובה – נעבור לשלב גובה
    if (user.height_cm == null) {
      onboarding.currentStep = "PROFILE_HEIGHT";
      onboarding.updatedAt = new Date().toISOString();
      await this.db.saveOnboarding(onboarding);

      return {
        text:
          `רשמתי: גיל ${age}.\n` +
          "מה הגובה שלך בסנטימטרים? (למשל 178)",
      };
    }

    // אם יש כבר גובה – נתקדם למשקל
    onboarding.currentStep = "PROFILE_WEIGHT";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    if (user.weight_kg != null) {
      return {
        text:
          `רשמתי: גיל ${age}.\n` +
          `המשקל האחרון שאני רואה הוא ${user.weight_kg} ק\"ג.\n` +
          "אם זה נכון תכתוב 'כן'. אם לא – תכתוב את המשקל שלך בקילוגרמים.",
      };
    }

    return {
      text: "רשמתי. מה המשקל שלך בקילוגרמים?",
    };
  }

  async _handleProfileHeight(onboarding, message) {
    const userId = onboarding.userId;
    let user = (await this.db.getUser(userId)) || { id: userId };

    if (!message) {
      if (user.height_cm != null) {
        return {
          text:
            `הגובה האחרון שאני רואה הוא ${user.height_cm} ס\"מ.\n` +
            "אם זה נכון תכתוב 'כן'. אם לא – תכתוב את הגובה שלך בסנטימטרים.",
        };
      }
      return {
        text: "מה הגובה שלך בסנטימטרים? (למשל 178)",
      };
    }

    const txt = message.trim();

    if (isYes(txt) && user.height_cm != null) {
      // מאשר את הגובה הקיים
    } else {
      const h = parseIntFromText(txt);
      if (!h || h < 120 || h > 230) {
        return {
          text:
            "לא הצלחתי להבין את הגובה. תכתוב מספר בסנטימטרים בין 120 ל-230 (למשל 178).",
        };
      }
      user.height_cm = h;
    }

    await this.db.saveUser(user);

    onboarding.currentStep = "PROFILE_WEIGHT";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    if (user.weight_kg != null) {
      return {
        text:
          `רשמתי: גובה ${user.height_cm} ס\"מ.\n` +
          `המשקל האחרון שאני רואה הוא ${user.weight_kg} ק\"ג.\n` +
          "אם זה נכון תכתוב 'כן'. אם לא – תכתוב את המשקל שלך בקילוגרמים.",
      };
    }

    return {
      text: "רשמתי. מה המשקל שלך בקילוגרמים?",
    };
  }

  async _handleProfileWeight(onboarding, message) {
    const userId = onboarding.userId;
    let user = (await this.db.getUser(userId)) || { id: userId };

    if (!message) {
      if (user.weight_kg != null) {
        return {
          text:
            `המשקל האחרון שאני רואה הוא ${user.weight_kg} ק\"ג.\n` +
            "אם זה נכון תכתוב 'כן'. אם לא – תכתוב את המשקל שלך בקילוגרמים.",
        };
      }
      return { text: "מה המשקל שלך בקילוגרמים?" };
    }

    const txt = message.trim();

    if (isYes(txt) && user.weight_kg != null) {
      // מאשר את המשקל הקיים
    } else {
      const w = parseIntFromText(txt);
      if (!w || w < 30 || w > 200) {
        return {
          text:
            "לא הצלחתי להבין את המשקל. תכתוב מספר בקילוגרמים (למשל 67).",
        };
      }
      user.weight_kg = w;
    }

    await this.db.saveUser(user);

    onboarding.currentStep = "WEEKLY_RIDES";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    return {
      text: "כמה רכיבות בשבוע אתה רוצה בדרך כלל? תכתוב מספר (למשל 4).",
    };
  }

  // ==========================
  //  WEEKLY TEMPLATE
  // ==========================

  async _handleWeeklyRides(onboarding, message) {
    const userId = onboarding.userId;
    let weekly =
      (await this.db.getWeeklyTemplate(userId)) || { userId, ridesPerWeek: null };

    if (!message) {
      return {
        text: "כמה רכיבות בשבוע תרצה בדרך כלל? תכתוב מספר (למשל 4).",
      };
    }

    const rides = parseIntFromText(message);
    if (!rides || rides < 1 || rides > 12) {
      return {
        text: "תכתוב מספר רכיבות בשבוע בין 1 ל-12 (למשל 4).",
      };
    }

    weekly.ridesPerWeek = rides;
    await this.db.saveWeeklyTemplate(weekly);

    onboarding.currentStep = "RIDE_DURATION";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    let hint = "";
    if (weekly.stravaAvgHoursPerWeek && weekly.ridesPerWeek) {
      const approxMinutes = Math.round(
        (weekly.stravaAvgHoursPerWeek * 60) / weekly.ridesPerWeek
      );
      hint =
        `\nלפי סטרבה אתה עושה בערך ${weekly.stravaAvgHoursPerWeek.toFixed(
          1
        )} ש\"ש, שזה בערך ${approxMinutes} דק' לרכיבה.`;
    }

    return {
      text:
        "כמה זמן בדרך כלל נמשכת רכיבה סטנדרטית בשבילך (בדקות)?" + hint,
    };
  }

  async _handleRideDuration(onboarding, message) {
    const userId = onboarding.userId;
    let weekly =
      (await this.db.getWeeklyTemplate(userId)) || { userId, ridesPerWeek: 3 };

    if (!message) {
      return {
        text: "כמה דקות בדרך כלל נמשכת רכיבה סטנדרטית בשבילך?",
      };
    }

    const minutes = parseIntFromText(message);
    if (!minutes || minutes < 20 || minutes > 400) {
      return {
        text:
          "בוא נלך על טווח הגיוני. תכתוב משך בדקות, בין 20 ל-400 (למשל 90).",
      };
    }

    weekly.defaultRideMinutes = minutes;
    await this.db.saveWeeklyTemplate(weekly);

    onboarding.currentStep = "HR_MAX";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    const params =
      (await this.db.getTrainingParams(userId)) || { userId: userId };
    let baseQuestion =
      "אם אתה יודע מה הדופק המקסימלי שלך (HRmax), תכתוב אותו במספרים.\n" +
      "אם אתה לא בטוח – תכתוב מספר שנראה לך הגיוני כשאתה במאמץ מקסימלי.";

    if (params.hrMaxCandidate) {
      baseQuestion =
        `מהדאטה נראה שהדופק המקסימלי שלך סביב ${params.hrMaxCandidate} bpm.\n` +
        "אם זה נכון תכתוב את המספר, ואם לא – תכתוב ערך אחר שמתאים לך.";
    }

    return {
      text: baseQuestion,
    };
  }

  // ==========================
  //  HR MAX / THRESHOLD
  // ==========================

  async _handleHrMax(onboarding, message) {
    const userId = onboarding.userId;
    let params =
      (await this.db.getTrainingParams(userId)) || { userId: userId };

    if (!message) {
      let base =
        "אם אתה יודע מה הדופק המקסימלי שלך (HRmax), תכתוב אותו במספרים.";
      if (params.hrMaxCandidate) {
        base =
          `מהדאטה נראה שהדופק המקסימלי שלך סביב ${params.hrMaxCandidate} bpm.\n` +
          "אם זה נכון תכתוב את המספר, ואם לא – תכתוב ערך אחר.";
      }
      return { text: base };
    }

    const hr = parseIntFromText(message);
    if (!hr || hr < 120 || hr > 220) {
      return {
        text:
          "לא הצלחתי להבין. תכתוב דופק מקסימלי במספרים, משהו בין 120 ל-220.",
      };
    }

    params.hrMax = hr;
    await this.db.saveTrainingParams(params);

    onboarding.currentStep = "HR_THRESHOLD";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    let suggestion = params.hrThresholdCandidate;
    if (!suggestion && params.hrMax) {
      suggestion = Math.round(params.hrMax * 0.9);
    }

    let question =
      "עכשיו דופק סף (Threshold) – דופק שאתה יכול להחזיק בערך שעה במאמץ קשה.\n" +
      "תכתוב את הדופק הזה במספרים.";
    if (suggestion) {
      question =
        `נראה מהדאטה שדופק הסף שלך סביב ${suggestion} bpm.\n` +
        "אם זה מרגיש נכון – תכתוב את המספר (או תתקן למספר שיותר מתאים לך).";
    }

    return { text: question };
  }

  async _handleHrThreshold(onboarding, message) {
    const userId = onboarding.userId;
    let params =
      (await this.db.getTrainingParams(userId)) || { userId: userId };

    if (!message) {
      let suggestion = params.hrThresholdCandidate;
      if (!suggestion && params.hrMax) {
        suggestion = Math.round(params.hrMax * 0.9);
      }
      if (suggestion) {
        return {
          text:
            `נראה שדופק הסף שלך סביב ${suggestion} bpm.\n` +
            "אם זה מרגיש נכון – תכתוב את המספר, ואם לא תכתוב ערך אחר.",
        };
      }
      return {
        text:
          "תכתוב דופק סף (Threshold) – דופק שאתה יכול להחזיק בערך שעה במאמץ קשה.",
      };
    }

    const hr = parseIntFromText(message);
    if (!hr || hr < 100 || hr > 220) {
      return {
        text:
          "לא הצלחתי להבין. תכתוב דופק סף במספרים, משהו בין 100 ל-220.",
      };
    }

    params.hrThreshold = hr;
    await this.db.saveTrainingParams(params);

    onboarding.currentStep = "FTP_MAIN";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    // שאלה על FTP – כולל המודלים והערכים מסטרבה (אם קיימים)
    const lines = [];
    if (params.ftpFrom20min != null) {
      lines.push(`- FTP לפי 20 דק׳: ${params.ftpFrom20min}W`);
    }
    if (params.ftpFrom8min != null) {
      lines.push(
        `- FTP לפי מודל CP (3+20 דק׳): ${params.ftpFrom8min}W`
      );
    }
    if (params.ftpFrom3min != null) {
      lines.push(
        `- FTP לפי Power Curve (מאמצי 3 דק׳): ${params.ftpFrom3min}W`
      );
    }
    if (params.ftpFromStrava != null) {
      lines.push(`- FTP שהוגדר בסטרבה: ${params.ftpFromStrava}W`);
    }
    if (params.ftpRecommended != null) {
      lines.push(`- FTP מומלץ משולב: ${params.ftpRecommended}W`);
    }

    let questionFtp = "";
    if (lines.length > 0) {
      questionFtp =
        "לפי הנתונים מסטרבה יש לי כמה הערכות ל-FTP שלך:\n" +
        lines.join("\n") +
        "\n\nתכתוב מספר בוואטים שתרצה שנגדיר כ-FTP התחלתי.";
    } else {
      questionFtp =
        "אם אתה יודע את ה-FTP שלך, תכתוב אותו בוואטים.\n" +
        "אם לא – תכתוב מספר שנוח לך להתחיל ממנו, ונתאים אותו בהמשך.";
    }

    return { text: questionFtp };
  }

  // ==========================
  //  FTP
  // ==========================

  async _handleFtp(onboarding, message) {
    const userId = onboarding.userId;
    let params =
      (await this.db.getTrainingParams(userId)) || { userId: userId };

    if (!message) {
      return {
        text:
          "תכתוב מספר בוואטים שיהיה ה-FTP ההתחלתי שלך. אם אתה לא בטוח – תבחר ערך שנראה לך קרוב.",
      };
    }

    const ftpVal = parseIntFromText(message);
    if (!ftpVal || ftpVal < 80 || ftpVal > 500) {
      return {
        text:
          "בוא נבחר ערך FTP הגיוני. תכתוב מספר בוואטים בין 80 ל-500 (למשל 240).",
      };
    }

    params.ftp = ftpVal;
    await this.db.saveTrainingParams(params);

    onboarding.currentStep = "GOAL_MAIN";
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    return {
      text:
        `מעולה, נגדיר FTP התחלתי של ${params.ftp}W.\n` +
        "עכשיו תכתוב במשפט אחד מה המטרה שלך (אירוע, FTP, משקל וכו').",
    };
  }

  // ==========================
  //  GOAL MAIN + סיכום DB + ניתוח רוכב
  // ==========================

  async _handleGoalMain(onboarding, message) {
    const userId = onboarding.userId;
    const txt = String(message || "").trim();

    if (!txt) {
      return {
        text:
          "תכתוב במשפט אחד מה המטרה שלך: אירוע, FTP יעד, ירידה במשקל, או שילוב.",
      };
    }

    // אם יש מטרה פעילה – נסגור אותה
    const existingGoal = await this.db.getActiveGoal(userId);
    if (existingGoal && existingGoal.id) {
      await this.db.archiveGoal(existingGoal.id);
    }

    // יצירת מטרה חדשה ושמירה ב־DB
    const newGoal = await this.db.createGoal({
      userId,
      type: "text",
      description: txt,
    });

    // סימון שהאונבורדינג הושלם ושמירת סטטוס ב־DB
    onboarding.currentStep = "DONE";
    onboarding.onboardingCompleted = true;
    onboarding.updatedAt = new Date().toISOString();
    await this.db.saveOnboarding(onboarding);

    // סיכום קצר מבוסס DB
    const user = (await this.db.getUser(userId)) || {};
    const params = (await this.db.getTrainingParams(userId)) || {};
    const weekly = (await this.db.getWeeklyTemplate(userId)) || {};
    const goal = (await this.db.getActiveGoal(userId)) || newGoal;

    const ageVal = user.age != null ? user.age : null;
    const age = ageVal != null ? ageVal : "-";
    const weightKg = user.weight_kg != null ? user.weight_kg : null;
    const weight =
      weightKg != null ? `${weightKg} ק"ג` : "-";
    const heightCm = user.height_cm != null ? user.height_cm : null;
    const height =
      heightCm != null ? `${heightCm} ס"מ` : "-";
    const gender = user.gender || null;

    const ridesPerWeekNum =
      weekly.ridesPerWeek != null ? weekly.ridesPerWeek : null;
    const ridesPerWeek =
      ridesPerWeekNum != null ? ridesPerWeekNum : "-";
    const rideMinutesNum =
      weekly.defaultRideMinutes != null ? weekly.defaultRideMinutes : null;
    const rideMinutes =
      rideMinutesNum != null ? `${rideMinutesNum} דק׳` : "-";
    const stravaHoursNum =
      weekly.stravaAvgHoursPerWeek != null
        ? weekly.stravaAvgHoursPerWeek
        : null;
    const stravaHours =
      stravaHoursNum != null
        ? `${stravaHoursNum.toFixed(1)} ש"ש`
        : "-";

    const hrMaxVal =
      params.hrMax != null ? params.hrMax : null;
    const hrMax =
      hrMaxVal != null ? `${hrMaxVal} bpm` : "-";
    const hrThVal =
      params.hrThreshold != null ? params.hrThreshold : null;
    const hrTh =
      hrThVal != null ? `${hrThVal} bpm` : "-";
    const ftpVal =
      params.ftp != null ? params.ftp : null;
    const ftp =
      ftpVal != null ? `${ftpVal} W` : "-";

    const goalDesc = goal?.description || txt;

    let ftpPerKg = null;
    if (ftpVal != null && weightKg != null && weightKg > 0) {
      ftpPerKg = ftpVal / weightKg;
    }

    let estHoursPerWeek = null;
    if (stravaHoursNum != null) {
      estHoursPerWeek = stravaHoursNum;
    } else if (ridesPerWeekNum != null && rideMinutesNum != null) {
      estHoursPerWeek = (ridesPerWeekNum * rideMinutesNum) / 60;
    }

    // BMI (רק למידע)
    let bmiText = "";
    if (weightKg != null && heightCm != null && heightCm > 0) {
      const hM = heightCm / 100;
      const bmi = weightKg / (hM * hM);
      bmiText = `- BMI משוער: ${bmi.toFixed(1)} (רק מידע כללי, בלי שיפוט)\n`;
    }

    let riderAnalysisText = "";
    if (ftpPerKg && ageVal) {
      const rel = classifyRiderRelative(ageVal, gender, ftpPerKg);
      if (rel) {
        const baseGroup =
          gender && String(gender).toLowerCase().startsWith("נ")
            ? "נשים"
            : gender && String(gender).toLowerCase().startsWith("ז")
            ? "גברים"
            : "רוכבים חובבים";
        riderAnalysisText =
          "ניתוח כרוכב:\n" +
          `- FTP לק״ג (משוער): ${ftpPerKg.toFixed(2)} W/kg\n` +
          `- ביחס ל${baseGroup} בגילך: ${rel.level} (${rel.percentRange}).\n`;
      }
    }

    let potentialText = "";
    if (ftpPerKg && ageVal) {
      const pot = estimateFtpPotential(
        ageVal,
        ftpPerKg,
        estHoursPerWeek || undefined
      );
      if (pot) {
        potentialText =
          `- פוטנציאל פיזיולוגי (עם אימון עקבי): אפשר לכוון בטווח הארוך ל-~${pot.potentialLow.toFixed(
            2
          )}–${pot.potentialHigh.toFixed(2)} W/kg.\n` +
          "  זה לא הבטחה, אבל זה טווח הגיוני עבורך לפי הגיל, הנתונים והנפח שלך.\n";
      }
    }

    const summary =
      "מעולה. יש לי עכשיו תמונה טובה עליך – פרופיל, נפח ופרמטרי אימון.\n\n" +
      "פרופיל:\n" +
      `- גיל: ${age}\n` +
      `- גובה: ${height}\n` +
      `- משקל: ${weight}\n` +
      (bmiText ? bmiText + "\n" : "\n") +
      "נפח ותבנית אימונים:\n" +
      `- רכיבות בשבוע: ${ridesPerWeek}\n` +
      `- משך רכיבה סטנדרטי: ${rideMinutes}\n` +
      `- נפח ממוצע מסטרבה (אם קיים): ${stravaHours}\n\n` +
      "פרמטרי אימון:\n" +
      `- דופק מקסימלי (HRmax): ${hrMax}\n` +
      `- דופק סף (Threshold): ${hrTh}\n` +
      `- FTP התחלתי: ${ftp}\n\n` +
      (riderAnalysisText ? riderAnalysisText + "\n" : "") +
      (potentialText ? potentialText + "\n" : "") +
      "מטרה:\n" +
      `- ${goalDesc}\n\n` +
      'מעכשיו מספיק שתכתוב לי "מה האימון שלי היום?" ונבנה אימון לפי הנתונים האלה.';

    return {
      text: summary,
      done: true,
    };
  }
}

// ==========================
//  HELPERS
// ==========================

function isYes(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  const yesWords = [
    "כן",
    "כמובן",
    "ברור",
    "יאללה",
    "מאשר",
    "go",
    "סבבה",
    "בטח",
    "יש",
    "בוודאי",
    "כןן",
    "כן כן",
    "y",
    "yes",
    "ok",
    "okay",
  ];
  return yesWords.some((w) => t.includes(w));
}

function isNo(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  const noWords = ["לא", "ממש לא", "בלי", "עזוב", "לא צריך", "no", "nah"];
  return noWords.some((w) => t.startsWith(w));
}

function parseIntFromText(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,4})/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function classifyRiderRelative(age, gender, ftpPerKg) {
  if (!age || !ftpPerKg) return null;

  // התאמה קלה לנשים – בדרך כלל FTP נמוך מעט באותן רמות כושר
  let adjFtp = ftpPerKg;
  if (gender && String(gender).toLowerCase().startsWith("נ")) {
    adjFtp = ftpPerKg + 0.4;
  }

  let level = "";
  let percentRange = "";

  if (adjFtp < 2.0) {
    level = "מתחת לממוצע לרוכבים חובבים בגילך";
    percentRange = "כנראה בחצי התחתון (0–40%)";
  } else if (adjFtp < 2.5) {
    level = "סביב הממוצע לרוכבים חובבים בגילך";
    percentRange = "סביב האמצע (40–60%)";
  } else if (adjFtp < 3.0) {
    level = "מעל הממוצע – בסיס סיבולת טוב";
    percentRange = "בערך טופ 40–25%";
  } else if (adjFtp < 3.5) {
    level = "רוכב חובב חזק";
    percentRange = "בערך טופ 25–15%";
  } else if (adjFtp < 4.0) {
    level = "רמה גבוהה מאוד לחובב בגילך";
    percentRange = "בערך טופ 15–5%";
  } else {
    level = "רמה תחרותית לכל דבר";
    percentRange = "בערך טופ 5% ומעלה";
  }

  return { level, percentRange };
}

function estimateFtpPotential(age, ftpPerKg, hoursPerWeek) {
  if (!ftpPerKg || !age) return null;

  let h = hoursPerWeek || 4;
  if (h < 2) h = 2;
  if (h > 12) h = 12;

  // פקטור שיפור לפי בסיס + נפח
  let baseImprove;
  if (ftpPerKg < 2.5) {
    baseImprove = 0.25; // הרבה אוויר להשתפר
  } else if (ftpPerKg < 3.2) {
    baseImprove = 0.18;
  } else if (ftpPerKg < 3.8) {
    baseImprove = 0.12;
  } else {
    baseImprove = 0.08; // כבר חזק – שיפור איטי יותר
  }

  // התאמה לנפח (יותר שעות -> יותר פוטנציאל)
  const volumeFactor = 0.7 + (h - 4) * 0.05; // בין ~0.4 ל~1.3
  let improveFactor = baseImprove * volumeFactor;

  // התאמה לגיל (מעל 50 קצת פחות פוטנציאל)
  if (age > 50 && age <= 60) improveFactor *= 0.85;
  if (age > 60) improveFactor *= 0.7;

  const targetLow = ftpPerKg * (1 + improveFactor * 0.6);
  const targetHigh = ftpPerKg * (1 + improveFactor);

  return {
    potentialLow: targetLow,
    potentialHigh: targetHigh,
  };
}
