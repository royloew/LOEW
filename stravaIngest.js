// stravaIngest.js
// שירות אינג'סט בסיסי לסטרבה:
// - מושך פעילות + סטרימים
// - מחשב power curve לחלונות זמן מוגדרים
// - מחזיר את הנתונים לשימוש בצד השרת (אפשר לשמור ל-DB במקום אחר)

import { StravaClient } from "./stravaClient.js";

// חלונות זמן לשיאי וואטים (בשניות): 1, 3, 5, 8, 20 דקות
export const POWER_WINDOWS_S = [60, 180, 300, 480, 1200];

export class StravaIngestService {
  /**
   * @param {StravaClient} stravaClient
   */
  constructor(stravaClient) {
    this.stravaClient = stravaClient;
  }

  /**
   * מושך פעילות וזרמים מסטרבה ומחשב עקומות כוח.
   * כרגע לא שומר ל-DB – אלא מחזיר את הנתונים למי שקרא לפונקציה.
   *
   * @param {string} userId
   * @param {number|string} activityId
   * @returns {Promise<{activity:any, streams:any, powerCurves:Array}>}
   */
  async ingestActivity(userId, activityId) {
    if (!userId) {
      throw new Error("ingestActivity: userId is required");
    }
    if (!activityId) {
      throw new Error("ingestActivity: activityId is required");
    }

    console.log(
      `StravaIngestService: ingesting activity ${activityId} for user ${userId}`
    );

    // 1. להביא פעילות
    const activityPromise = this.stravaClient.getActivity(userId, activityId);

    // 2. להביא סטרימים בסיסיים (time, watts, heartrate, distance)
    const streamsPromise = this.stravaClient.getStreams(userId, activityId, [
      "time",
      "watts",
      "heartrate",
      "distance",
    ]);

    const [activity, streams] = await Promise.all([
      activityPromise,
      streamsPromise,
    ]);

    // 3. מחשבים power curve
    const powerCurves = computePowerCurvePoints(streams, POWER_WINDOWS_S);

    console.log(
      `StravaIngestService: computed ${powerCurves.length} power curve points for activity ${activityId}`
    );

    return {
      activity,
      streams,
      powerCurves,
    };
  }
}

/**
 * מחשב נקודות עקומת כוח לחלונות זמן שונים מתוך סטרימים של סטרבה.
 *
 * @param {{watts?:{data:number[]}, heartrate?:{data:number[]}, time?:{data:number[]}}} streams
 * @param {number[]} windowsSec
 * @returns {Array<{window_s:number, best_power:number, best_hr:number|null, start_offset_s:number}>}
 */
export function computePowerCurvePoints(streams, windowsSec) {
  const watts = streams?.watts?.data || [];
  const hr = streams?.heartrate?.data || [];
  const timeStream = streams?.time?.data || null;

  if (!Array.isArray(watts) || watts.length === 0) {
    console.log("computePowerCurvePoints: no watts data, skipping");
    return [];
  }

  // נניח דגימה של 1Hz אם אין time מפורש
  const dt = 1;
  const res = [];

  for (const window_s of windowsSec) {
    const windowSamples = Math.round(window_s / dt);
    if (windowSamples <= 1 || windowSamples > watts.length) {
      continue;
    }

    let bestAvg = -Infinity;
    let bestHrAvg = null;
    let bestIdx = 0;

    let sumP = 0;
    let sumHr = 0;

    for (let i = 0; i < watts.length; i++) {
      const p = watts[i] ?? 0;
      sumP += p;

      const hrVal = hr[i];
      if (typeof hrVal === "number") {
        sumHr += hrVal;
      }

      if (i >= windowSamples) {
        const oldP = watts[i - windowSamples] ?? 0;
        sumP -= oldP;

        const oldHr = hr[i - windowSamples];
        if (typeof oldHr === "number") {
          sumHr -= oldHr;
        }
      }

      if (i + 1 >= windowSamples) {
        const avgP = sumP / windowSamples;
        if (avgP > bestAvg) {
          bestAvg = avgP;
          bestIdx = i - windowSamples + 1;
          bestHrAvg =
            hr.length > 0 ? sumHr / windowSamples : null;
        }
      }
    }

    if (!Number.isFinite(bestAvg) || bestAvg <= 0) {
      continue;
    }

    let startOffset_s;
    if (Array.isArray(timeStream) && timeStream.length > bestIdx) {
      startOffset_s = timeStream[bestIdx];
    } else {
      startOffset_s = bestIdx * dt;
    }

    res.push({
      window_s,
      best_power: bestAvg,
      best_hr: bestHrAvg,
      start_offset_s,
    });
  }

  return res;
}
