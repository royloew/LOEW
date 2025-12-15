// intentRouter.js (ESM)
// Deterministic Hebrew intent detection.
// Later you can plug an LLM classifier behind the same interface.

export const INTENTS = Object.freeze({
  ANALYZE_LAST_WORKOUT: "analyze_last_workout",
  ANALYZE_WORKOUT_BY_DATE: "analyze_workout_by_date",
  WORKOUT_CHAT: "workout_chat",
  PLAN_CHAT: "plan_chat",
  PLAN_WEEK: "plan_week",
  PLAN_MONTH: "plan_month",
  DAILY_RECO: "daily_reco",
  REFRESH_STRAVA: "refresh_strava",
  MY_PROFILE: "my_profile",
  UPDATE_METRIC: "update_metric",
  UNKNOWN: "unknown",
});

export function detectIntent(textRaw) {
  const text = normalize(textRaw);
  if (!text) return { intent: INTENTS.UNKNOWN, entities: {}, confidence: 0.0 };

  if (matchAny(text, ["עדכן מסטרבה", "עדכן לי מסטרבה", "תעדכן מסטרבה", "רענן מסטרבה"])) {
    return { intent: INTENTS.REFRESH_STRAVA, entities: {}, confidence: 0.95 };
  }

  if (matchAny(text, ["הפרופיל שלי", "תראה לי את הפרופיל שלי", "פרופיל שלי", "הנתונים שלי"])) {
    return { intent: INTENTS.MY_PROFILE, entities: {}, confidence: 0.9 };
  }

  const date = extractISODate(text);
  if (date && (text.includes("נתח") || text.includes("ניתוח")) && (text.includes("מתאריך") || text.includes("בתאריך"))) {
    return { intent: INTENTS.ANALYZE_WORKOUT_BY_DATE, entities: { date }, confidence: 0.92 };
  }

  if (matchAny(text, ["נתח את האימון האחרון שלי", "נתח לי אימון אחרון", "נתח אימון אחרון", "ניתוח אימון אחרון", "האימון האחרון שלי"])) {
    return { intent: INTENTS.ANALYZE_LAST_WORKOUT, entities: {}, confidence: 0.92 };
  }

  if (matchAny(text, ["האימון שלי היום", "המלץ לי על אימון היום", "אימון להיום"])) {
    return { intent: INTENTS.DAILY_RECO, entities: {}, confidence: 0.88 };
  }

  const metricUpdate = parseMetricUpdate(textRaw);
  if (metricUpdate) {
    return { intent: INTENTS.UPDATE_METRIC, entities: metricUpdate, confidence: 0.9 };
  }

  if (text.includes("נתח") && text.includes("אימון")) {
    return { intent: INTENTS.WORKOUT_CHAT, entities: {}, confidence: 0.6 };
  }

  return { intent: INTENTS.UNKNOWN, entities: {}, confidence: 0.2 };
}

function normalize(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function matchAny(text, phrases) {
  return phrases.some((p) => text.includes(normalize(p)));
}

function extractISODate(text) {
  const m = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  return m ? m[0] : null;
}

function parseMetricUpdate(textRaw) {
  const t = String(textRaw ?? "");

  // weight
  let m = t.match(/(?:המשקל שלי עכשיו|המשקל שלי|משקל)\D*(\d{2,3}(?:\.\d)?)\b/i);
  if (m) return { metric: "weight", value: Number(m[1]) };

  // ftp
  m = t.match(/\bftp\b\D*(\d{2,4})\b/i);
  if (m) return { metric: "ftp", value: Number(m[1]) };

  // hr max
  m = t.match(/(?:דופק\s*(?:מקסימלי|מקס|max))\D*(\d{2,3})\b/i);
  if (m) return { metric: "hr_max", value: Number(m[1]) };

  // hr threshold
  m = t.match(/(?:דופק\s*סף)\D*(\d{2,3})\b/i);
  if (m) return { metric: "hr_threshold", value: Number(m[1]) };

  return null;
}
