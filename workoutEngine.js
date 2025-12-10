// workoutEngine.js
// מנוע ניתוח אימון אחרון + Execution Score + המלצה לאימון הבא
// חשוב: הקובץ לא משנה כלום באונבורדינג, ולא כותב ל-DB.
// הוא רק משתמש ב-dbImpl שקיים (בדיוק כמו onboardingEngine).

export class WorkoutEngine {
  /**
   * @param {object} dbImpl - אובייקט ה-DB כמו שמוזן ל-OnboardingEngine
   * options:
   *   logger: פונקציית לוג (console.log by default)
   */
  constructor(dbImpl, options = {}) {
    this.db = dbImpl;
    this.log = options.logger || console.log;
  }

  /**
   * הפונקציה המרכזית לשימוש מהשרת:
   * מחזירה:
   * {
   *   lastWorkout: { ...metrics },
   *   execution: { score, components },
   *   nextWorkout: { type, durationMin, powerTarget, hrTarget, notes }
   * }
   */
  async analyzeAndSuggest(userId) {
    this._assertUserId(userId);

    // 1. fetch training params
    const trainingParams = await this._fetchTrainingParams(userId);

    // 2. fetch last ride + streams
    const { activity, streams } = await this._fetchLastWorkoutWithStreams(userId);
    if (!activity || !streams) {
      return {
        lastWorkout: null,
        execution: null,
        nextWorkout: null,
        warning: "לא נמצא אימון אחרון עם נתוני STREAMS מתאימים.",
      };
    }

    // 3. compute metrics
    const metrics = this._computeWorkoutMetrics(activity, streams, trainingParams);

    // 4. execution score
    const execution = this._computeExecutionScore(metrics, trainingParams);

    // 5. weekly summary (עומס שבועי בסיסי)
    const weeklySummary = await this._fetchWeeklySummary(userId, trainingParams);

    // 6. suggestion for next workout
    const nextWorkout = await this._suggestNextWorkout(
      userId,
      metrics,
      trainingParams,
      weeklySummary
    );

    return {
      lastWorkout: metrics,
      execution,
      nextWorkout,
    };
  }

  // -------------------------
  //  HELPERS – DATA FETCH
  // -------------------------

  _assertUserId(userId) {
    if (!userId || typeof userId !== "string") {
      throw new Error("WorkoutEngine: userId is required and must be a string");
    }
  }

  async _fetchTrainingParams(userId) {
    if (!this.db || typeof this.db.getTrainingParams !== "function") {
      throw new Error(
        "WorkoutEngine: dbImpl.getTrainingParams(userId) is required but not implemented"
      );
    }
    const params = await this.db.getTrainingParams(userId);
    return params || {};
  }

  /**
   * פונקציה זו מניחה שקיים ב-dbImpl אחד מהבאים:
   * - getLastRideWithStreams(userId)
   *   שמחזיר { activity, streams }
   *
   * אם אין – אפשר לממש מאוחר יותר בתוך dbSqlite.js:
   *   - לבחור את האימון האחרון מה-strava_activities
   *   - למשוך מה-strava_streams את המערכים time/watts/heartrate וכו'
   */
  async _fetchLastWorkoutWithStreams(userId) {
    if (this.db && typeof this.db.getLastRideWithStreams === "function") {
      const result = await this.db.getLastRideWithStreams(userId);
      return result || { activity: null, streams: null };
    }

    // Fallback – אין מימוש ב-DB
    this.log(
      "[WorkoutEngine] dbImpl.getLastRideWithStreams not implemented – returning empty result"
    );
    return { activity: null, streams: null };
  }

  /**
   * מביא תקציר נפח/עומס לשבוע אחרון (או חלון דומה).
   * מניח פונקציה dbImpl.getRecentVolumeSummary(userId, days)
   * שמחזירה למשל:
   * {
   *   days: 7,
   *   totalDurationSec: ...,
   *   ridesCount: ...,
   *   avgDailyDurationSec: ...
   * }
   */
  async _fetchWeeklySummary(userId, trainingParams) {
    const windowDays = trainingParams?.metrics_window_days || 7;

    if (this.db && typeof this.db.getRecentVolumeSummary === "function") {
      const summary = await this.db.getRecentVolumeSummary(userId, windowDays);
      return summary || { days: windowDays, totalDurationSec: 0, ridesCount: 0 };
    }

    // Fallback – אין מימוש
    this.log(
      "[WorkoutEngine] dbImpl.getRecentVolumeSummary not implemented – using fallback summary"
    );
    return { days: windowDays, totalDurationSec: 0, ridesCount: 0 };
  }

  // -------------------------
  //  CORE METRICS
  // -------------------------

  /**
   * חישוב מדדי אימון על בסיס activity + streams + trainingParams
   */
  _computeWorkoutMetrics(activity, streams, trainingParams) {
    if (!streams || !Array.isArray(streams.time) || streams.time.length === 0) {
      throw new Error("WorkoutEngine: missing or invalid streams.time");
    }

    const { time, watts, heartrate } = streams;

    const durationSec = this._computeDurationSecFromActivityOrStreams(activity, time);
    const ftp = this._getFtpFromParams(trainingParams);
    const hrThreshold = this._getHrThresholdFromParams(trainingParams);

    const avgPower = this._safeAverage(watts);
    const avgHR = this._safeAverage(heartrate);

    const intensityFactor = ftp && avgPower != null ? avgPower / ftp : null;
    const zones = this._computeZones(time, watts, heartrate, ftp, hrThreshold);

    const decouplingPct = this._computeDecoupling(watts, heartrate);

    const rideType = this._classifyRideType({
      durationSec,
      intensityFactor,
      zones,
      decouplingPct,
    });

    return {
      activityId: activity?.id || activity?.activity_id || null,
      startDate: activity?.start_date || null,
      durationSec,
      distanceKm: activity?.distance_km ?? null,
      elevationGainM: activity?.elevation_gain_m ?? null,

      avgPower,
      avgHR,
      ftpUsed: ftp || null,
      hrThresholdUsed: hrThreshold || null,
      intensityFactor,

      zones, // { z1Sec, z2Sec, z3Sec, z4Sec, z5Sec }
      decouplingPct,
      rideType,
    };
  }

  _computeDurationSecFromActivityOrStreams(activity, timeArr) {
    if (activity && typeof activity.moving_time_sec === "number") {
      return activity.moving_time_sec;
    }
    if (timeArr && timeArr.length > 0) {
      // בהנחה שזה מצטבר בשניות
      return timeArr[timeArr.length - 1] - timeArr[0];
    }
    return null;
  }

  _getFtpFromParams(params) {
    if (!params) return null;
    // עדיפות ל-ftp_recommended אם קיים, אחרת ftp / ftp20.
    return (
      params.ftp_recommended ||
      params.ftp ||
      params.ftp20 ||
      params.ftp_from_cp ||
      params.ftp_from_3min ||
      null
    );
  }

  _getHrThresholdFromParams(params) {
    if (!params) return null;
    if (params.hr_threshold) return params.hr_threshold;
    if (params.hr_max) return Math.round(params.hr_max * 0.9);
    return null;
  }

  _safeAverage(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const sum = arr.reduce((s, v) => (typeof v === "number" ? s + v : s), 0);
    const count = arr.filter((v) => typeof v === "number").length;
    return count > 0 ? sum / count : null;
  }

  _computeZones(timeArr, wattsArr, hrArr, ftp, hrThreshold) {
    const zones = {
      z1Sec: 0,
      z2Sec: 0,
      z3Sec: 0,
      z4Sec: 0,
      z5Sec: 0,
    };

    if (!timeArr || timeArr.length < 2) {
      return zones;
    }

    // נשתמש בהפרשים בין נקודות זמן כדי להעריך משך בכל דגימה.
    for (let i = 1; i < timeArr.length; i++) {
      const dt = timeArr[i] - timeArr[i - 1];
      if (dt <= 0) continue;

      let zoneIndex = null;

      if (ftp && Array.isArray(wattsArr) && typeof wattsArr[i] === "number") {
        const rel = wattsArr[i] / ftp;
        // אזורים לפי אחוז FTP – אפשר לכוונן בשלב מאוחר יותר
        if (rel < 0.55) zoneIndex = 1; // Z1
        else if (rel < 0.75) zoneIndex = 2; // Z2
        else if (rel < 0.9) zoneIndex = 3; // Z3 (Tempo)
        else if (rel < 1.05) zoneIndex = 4; // Z4 (Threshold)
        else zoneIndex = 5; // Z5+
      } else if (
        hrThreshold &&
        Array.isArray(hrArr) &&
        typeof hrArr[i] === "number"
      ) {
        const relHR = hrArr[i] / hrThreshold;
        if (relHR < 0.75) zoneIndex = 1;
        else if (relHR < 0.9) zoneIndex = 2;
        else if (relHR < 1.0) zoneIndex = 3;
        else if (relHR < 1.05) zoneIndex = 4;
        else zoneIndex = 5;
      }

      if (zoneIndex === 1) zones.z1Sec += dt;
      else if (zoneIndex === 2) zones.z2Sec += dt;
      else if (zoneIndex === 3) zones.z3Sec += dt;
      else if (zoneIndex === 4) zones.z4Sec += dt;
      else if (zoneIndex === 5) zones.z5Sec += dt;
    }

    return zones;
  }

  /**
   * Decoupling – השוואת יחס HR/Power בחצי הראשון מול החצי השני
   * מחזיר אחוז (יכול להיות null אם אין מספיק דאטה)
   */
  _computeDecoupling(wattsArr, hrArr) {
    if (
      !Array.isArray(wattsArr) ||
      !Array.isArray(hrArr) ||
      wattsArr.length < 20 ||
      hrArr.length < 20
    ) {
      return null;
    }

    const n = Math.min(wattsArr.length, hrArr.length);
    const half = Math.floor(n / 2);

    const first = this._avgRatio(wattsArr, hrArr, 0, half);
    const second = this._avgRatio(wattsArr, hrArr, half, n);

    if (!first || !second || first <= 0) return null;

    const drift = (second - first) / first; // יחס
    return drift * 100; // אחוז
  }

  _avgRatio(wattsArr, hrArr, start, end) {
    let sumRatio = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const w = wattsArr[i];
      const h = hrArr[i];
      if (typeof w === "number" && w > 0 && typeof h === "number" && h > 0) {
        sumRatio += h / w;
        count++;
      }
    }
    return count > 0 ? sumRatio / count : null;
  }

  _classifyRideType({ durationSec, intensityFactor, zones, decouplingPct }) {
    if (!durationSec) return "unknown";

    const totalSec =
      (zones?.z1Sec || 0) +
      (zones?.z2Sec || 0) +
      (zones?.z3Sec || 0) +
      (zones?.z4Sec || 0) +
      (zones?.z5Sec || 0);

    const fracZ2 = totalSec > 0 ? (zones.z2Sec || 0) / totalSec : 0;
    const fracHigh = totalSec > 0 ? (zones.z4Sec || 0) / totalSec : 0;

    if (!intensityFactor) {
      // fallback לפי זמן
      if (durationSec < 2700) return "recovery"; // <45min
      if (durationSec < 5400) return "endurance"; // 45–90
      return "endurance_long";
    }

    // דוגמה פשוטה – נחדד בעתיד
    if (intensityFactor < 0.65) {
      return "recovery";
    }
    if (intensityFactor < 0.8 && fracHigh < 0.05) {
      return "endurance";
    }
    if (intensityFactor < 0.9) {
      return "tempo";
    }
    if (intensityFactor <= 1.05 || fracHigh > 0.15) {
      return "sweetspot_or_threshold";
    }
    return "intensity";
  }

  // -------------------------
  //  EXECUTION SCORE
  // -------------------------

  _computeExecutionScore(metrics, trainingParams) {
    if (!metrics || !metrics.durationSec) {
      return {
        score: null,
        components: {
          durationScore: null,
          intensityScore: null,
          decouplingScore: null,
          purityScore: null,
        },
      };
    }

    const base = 100;
    let penaltyDuration = 0;
    let penaltyIntensity = 0;
    let penaltyDecoupling = 0;
    let penaltyPurity = 0;

    const { durationSec, intensityFactor, zones, decouplingPct, rideType } = metrics;
    const avgDurationSec = trainingParams?.avg_duration_sec || null;

    // 1) זמן: אם יש avg_duration_sec נעניש על סטייה גדולה
    if (avgDurationSec) {
      const ratio = durationSec / avgDurationSec;
      if (ratio < 0.7 || ratio > 1.3) {
        // סטייה משמעותית
        penaltyDuration = 10;
      } else if (ratio < 0.85 || ratio > 1.15) {
        penaltyDuration = 5;
      }
    }

    // 2) עצימות: בהתאם ל-rideType
    if (intensityFactor != null) {
      let targetIFMin = 0.5;
      let targetIFMax = 0.75;

      if (rideType === "recovery") {
        targetIFMin = 0.45;
        targetIFMax = 0.65;
      } else if (rideType === "endurance" || rideType === "endurance_long") {
        targetIFMin = 0.6;
        targetIFMax = 0.8;
      } else if (rideType === "tempo") {
        targetIFMin = 0.75;
        targetIFMax = 0.9;
      } else if (rideType === "sweetspot_or_threshold") {
        targetIFMin = 0.85;
        targetIFMax = 1.05;
      } else if (rideType === "intensity") {
        targetIFMin = 0.9;
        targetIFMax = 1.2;
      }

      if (intensityFactor < targetIFMin || intensityFactor > targetIFMax) {
        penaltyIntensity = 10;
      } else {
        // בתוך טווח – אין עונש
        penaltyIntensity = 0;
      }
    }

    // 3) Decoupling – אם יש
    if (decouplingPct != null) {
      const absDrift = Math.abs(decouplingPct);
      if (absDrift > 7) {
        penaltyDecoupling = 10;
      } else if (absDrift > 4) {
        penaltyDecoupling = 5;
      }
    }

    // 4) "ניקיון אזורי" – במיוחד לרכיבת Endurance
    if (zones) {
      const totalSec =
        (zones.z1Sec || 0) +
        (zones.z2Sec || 0) +
        (zones.z3Sec || 0) +
        (zones.z4Sec || 0) +
        (zones.z5Sec || 0);
      const fracHigh = totalSec > 0 ? (zones.z4Sec || 0) / totalSec : 0;

      if (rideType === "endurance" || rideType === "endurance_long") {
        if (fracHigh > 0.1) {
          penaltyPurity = 10;
        } else if (fracHigh > 0.05) {
          penaltyPurity = 5;
        }
      }
    }

    const penalties = penaltyDuration + penaltyIntensity + penaltyDecoupling + penaltyPurity;
    const score = Math.max(0, base - penalties);

    return {
      score,
      components: {
        durationScore: Math.max(0, 100 - penaltyDuration),
        intensityScore: Math.max(0, 100 - penaltyIntensity),
        decouplingScore: Math.max(0, 100 - penaltyDecoupling),
        purityScore: Math.max(0, 100 - penaltyPurity),
      },
    };
  }

  // -------------------------
  //  NEXT WORKOUT SUGGESTION
  // -------------------------

  async _suggestNextWorkout(userId, metrics, trainingParams, weeklySummary) {
    if (!metrics || !metrics.durationSec) {
      return null;
    }

    const ftp = this._getFtpFromParams(trainingParams);
    const hrThreshold = this._getHrThresholdFromParams(trainingParams);

    const avgDurationSec = trainingParams?.avg_duration_sec || metrics.durationSec;
    const minDurationSec =
      trainingParams?.min_duration_sec || Math.max(3600, avgDurationSec * 0.7);
    const maxDurationSec =
      trainingParams?.max_duration_sec || Math.max(avgDurationSec * 1.3, 5400);

    const weeklyHours =
      weeklySummary && weeklySummary.totalDurationSec
        ? weeklySummary.totalDurationSec / 3600
        : 0;

    const targetWeeklyHours = trainingParams?.weekly_hours_target || weeklyHours;

    const lastType = metrics.rideType;
    const decoupling = metrics.decouplingPct;

    // החלטת בסיס: קל / בינוני / עצים / מנוחה
    let type = "endurance";
    let durationMinRange = [Math.round(minDurationSec / 60), Math.round(avgDurationSec / 60)];
    let powerTarget = null;
    let hrTarget = null;
    let notes = "";

    const highVolume =
      targetWeeklyHours && weeklyHours > 1.2 * targetWeeklyHours; // עומס גבוה מהרגיל

    const lastWasHard =
      lastType === "sweetspot_or_threshold" ||
      lastType === "intensity" ||
      (metrics.intensityFactor && metrics.intensityFactor > 0.9);

    const poorDecoupling = decoupling != null && decoupling > 7;

    if (highVolume) {
      // עומס גבוה – עדיף שחרור
      type = "recovery";
      durationMinRange = [45, Math.round(minDurationSec / 60)];
      notes =
        "השבוע שלך עמוס יחסית. כדאי לרכב רכיבה קלה להתאוששות, לשמור נפח בינוני ולהוריד עצימות.";
    } else if (lastWasHard || poorDecoupling) {
      // אתמול היה קשה / דריפט גבוה – היום קל
      type = "recovery";
      durationMinRange = [45, Math.round(minDurationSec / 60)];
      notes =
        "האימון האחרון היה עצים או עם דריפט גבוה. מומלצת רכיבת התאוששות קצרה וקלה כדי לאפשר הסתגלות.";
    } else if (lastType === "endurance" || lastType === "endurance_long") {
      // אתמול היה נפח אירובי טוב – אפשר מחר איכות
      type = "tempo";
      durationMinRange = [Math.round(avgDurationSec / 60), Math.round(maxDurationSec / 60)];
      notes =
        "האימון האחרון היה אירובי יציב. אפשר להכניס מחר אימון איכות מתון (Tempo/SST) בהתאם להרגשה.";
    } else {
      // ברירת מחדל – עוד Endurance מבוקר
      type = "endurance";
      durationMinRange = [Math.round(minDurationSec / 60), Math.round(avgDurationSec / 60)];
      notes =
        "כבר יש שילוב סביר של עצימות ונפח. עוד רכיבת Endurance מבוקרת תשרת את היעד האירובי שלך.";
    }

    // טווחי וואטים ודופק לפי סוג
    if (ftp) {
      if (type === "recovery") {
        powerTarget = [Math.round(ftp * 0.45), Math.round(ftp * 0.6)];
      } else if (type === "endurance") {
        powerTarget = [Math.round(ftp * 0.6), Math.round(ftp * 0.75)];
      } else if (type === "tempo") {
        powerTarget = [Math.round(ftp * 0.75), Math.round(ftp * 0.9)];
      } else if (type === "sweetspot") {
        powerTarget = [Math.round(ftp * 0.85), Math.round(ftp * 1.0)];
      }
    }

    if (hrThreshold) {
      if (type === "recovery") {
        hrTarget = [
          Math.round(hrThreshold * 0.6),
          Math.round(hrThreshold * 0.75),
        ];
      } else if (type === "endurance") {
        hrTarget = [
          Math.round(hrThreshold * 0.7),
          Math.round(hrThreshold * 0.85),
        ];
      } else if (type === "tempo") {
        hrTarget = [
          Math.round(hrThreshold * 0.8),
          Math.round(hrThreshold * 0.92),
        ];
      } else if (type === "sweetspot") {
        hrTarget = [
          Math.round(hrThreshold * 0.88),
          Math.round(hrThreshold * 0.96),
        ];
      }
    }

    return {
      type,
      durationMin: durationMinRange,
      powerTarget,
      hrTarget,
      notes,
    };
  }
}
