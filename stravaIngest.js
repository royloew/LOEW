// stravaIngest.js
import { StravaClient } from "./stravaClient.js";
import { db } from "./dbSqlite.js"; // איך שאתה מייצא שם

const POWER_WINDOWS_S = [60, 180, 300, 1200]; // 1, 3, 5, 20 דקות

export class StravaIngestService {
  constructor(stravaClient) {
    this.stravaClient = stravaClient;
  }

  async ingestActivity(userId, activityId) {
    // 1. להביא פעילות + streams מהסטרבה
    const [activity, streams] = await Promise.all([
      this.stravaClient.getActivity(userId, activityId),
      this.stravaClient.getStreams(userId, activityId, [
        "time",
        "watts",
        "heartrate",
        "distance",
      ]),
    ]);

    // 2. לבנות Summary בסיסי
    const summary = this._buildSummaryFromActivity(activity, streams);

    // 3. לחשב Power Curve נקודתית (לחלונות שבחרנו)
    const curvePoints = this._computePowerCurvePoints(streams, POWER_WINDOWS_S);

    // 4. לשמור ב-3 הטבלאות
    db.saveStravaActivitySummary(userId, summary);
    db.saveStravaStreams(userId, activityId, streams);
    db.savePowerCurves(userId, activityId, curvePoints);

    return { summary, curvePoints };
  }

  _buildSummaryFromActivity(activity, streams) {
    const watts = streams.watts?.data || [];
    const hr = streams.heartrate?.data || [];

    const avgPower =
      watts.length > 0
        ? watts.reduce((a, b) => a + b, 0) / watts.length
        : null;
    const maxPower = watts.length > 0 ? Math.max(...watts) : null;

    const avgHr = hr.length > 0 ? hr.reduce((a, b) => a + b, 0) / hr.length : null;
    const maxHr = hr.length > 0 ? Math.max(...hr) : null;

    // TSS/NP/IF – כעת פשוט placeholders, אפשר לשפר בהמשך
    // (לחישוב אמיתי צריך FTP ו-zone model)
    const np = avgPower ?? null;
    const intensityFactor = null;
    const tss = null;

    return {
      user_id: null, // יוזר יתווסף ב-run של db
      activity_id: String(activity.id),
      name: activity.name,
      type: activity.type,
      start_date: activity.start_date, // ISO
      distance_m: activity.distance,
      moving_time_s: activity.moving_time,
      elapsed_time_s: activity.elapsed_time,
      avg_power: avgPower,
      max_power: maxPower,
      avg_hr: avgHr,
      max_hr: maxHr,
      tss,
      np,
      intensity_factor: intensityFactor,
      is_commute: activity.commute ? 1 : 0,
      is_race: activity.race ? 1 : 0,
      raw_json: activity, // נשמר כ-JSON מלא
    };
  }

  _computePowerCurvePoints(streams, windowsSec) {
    const watts = streams.watts?.data || [];
    const hr = streams.heartrate?.data || [];
    const time = streams.time?.data || null;

    if (watts.length === 0) return [];

    // מניחים דגימה בקצב קבוע (בערך 1Hz).
    // אם יש time stream, אפשר לחשב פרק זמן מדויק יותר, אבל נשאיר פשוט.
    const dt = 1; // שניות

    const res = [];

    for (const window_s of windowsSec) {
      const windowSamples = Math.round(window_s / dt);
      if (windowSamples <= 0 || windowSamples > watts.length) continue;

      let bestAvg = 0;
      let bestIdx = 0;

      // ממוצע נע – O(N)
      let windowSum = watts.slice(0, windowSamples).reduce((a, b) => a + b, 0);
      bestAvg = windowSum / windowSamples;

      for (let i = windowSamples; i < watts.length; i++) {
        windowSum += watts[i] - watts[i - windowSamples];
        const avg = windowSum / windowSamples;
        if (avg > bestAvg) {
          bestAvg = avg;
          bestIdx = i - windowSamples + 1;
        }
      }

      let hrAvg = null;
      if (hr.length === watts.length) {
        const slice = hr.slice(bestIdx, bestIdx + windowSamples);
        hrAvg = slice.reduce((a, b) => a + b, 0) / slice.length;
      }

      const startOffset_s = time?.[bestIdx] ?? bestIdx * dt;

      res.push({
        window_s,
        best_power: bestAvg,
        best_hr: hrAvg,
        start_offset_s,
      });
    }

    return res;
  }
}

