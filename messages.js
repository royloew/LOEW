// messages.js
export const MSG = {
  // Profile
  NO_PROFILE_DATA:
    'אין לי עדיין נתונים שמורים בפרופיל. נסה: "עדכן מסטרבה" או עדכן ידנית (למשל: "המשקל שלי עכשיו 72").',
  PROFILE_HEADER: "📊 הפרופיל שלי",

  // Post-onboarding: Strava
  POST_NO_STRAVA_CONNECTION:
    'אין לי כרגע חיבור פעיל לסטרבה במערכת. תתחבר לסטרבה ואז נסה שוב.',
  POST_STRAVA_UPDATED_AND_PROFILE_HINT:
    'עדכנתי נתונים מסטרבה ✅\nאפשר לכתוב עכשיו "הפרופיל שלי" כדי לראות את הנתונים האחרונים.',

  // Post-onboarding: manual updates
  POST_WEIGHT_UPDATED: (w) => `עודכן ✅ משקל נוכחי: ${w} ק"ג`,
  POST_FTP_UPDATED: (ftp) => `עודכן ✅ FTP: ${ftp}W`,
  POST_HR_MAX_UPDATED: (hr) => `עודכן ✅ דופק מקסימלי: ${hr} bpm`,
  POST_HR_THR_UPDATED: (hr) => `עודכן ✅ דופק סף: ${hr} bpm`,
  POST_VO2_UPDATED: (vo2) => `עודכן ✅ VO2max: ${vo2} ml/kg/min`,

  // Formats
  WEIGHT_FORMAT: 'כדי לעדכן משקל, כתוב למשל: "המשקל שלי עכשיו 72.5".',
  FTP_FORMAT: 'כדי לעדכן FTP, כתוב למשל: "FTP 250".',
  HR_MAX_FORMAT: 'כדי לעדכן דופק מקסימלי, כתוב למשל: "דופק מקסימלי 178".',
  HR_THR_FORMAT: 'כדי לעדכן דופק סף, כתוב למשל: "דופק סף 160".',

  // Goals - weight
  GOAL_WEIGHT_EXAMPLE: '"לרדת ל 68 תוך 8 שבועות".',
  GOAL_WEIGHT_HELP:
    'כדי שאבין את מטרת הירידה במשקל, תכתוב יעד + זמן. לדוגמה: "לרדת ל 68 תוך 8 שבועות".',
  GOAL_WEIGHT_ASK_TARGET:
    'סגור. לאיזה משקל יעד היית רוצה להגיע? (בק״ג, למשל 68)',
  GOAL_WEIGHT_TARGET_FORMAT:
    'לא הצלחתי להבין את יעד המשקל. תכתוב מספר בק״ג (למשל 68 או 72.5).',
  GOAL_WEIGHT_ASK_TIMELINE: (targetKg) =>
    `מעולה. יעד: ${targetKg} ק״ג.\nתוך כמה זמן היית רוצה להגיע לזה? (למשל: 8 שבועות / 3 חודשים)`,
  GOAL_WEIGHT_TIMELINE_FORMAT:
    'לא הצלחתי להבין את משך הזמן. תכתוב למשל "8 שבועות" או "3 חודשים".',
  GOAL_WEIGHT_DONE: (targetKg, weeks) =>
    `מעולה ✅\nיעד משקל: ${targetKg} ק״ג\nטווח זמן: ${weeks} שבועות\n\nסיימנו אונבורדינג 🎉`,
  GOAL_WEIGHT_UPDATED: (parts) =>
    `עודכן ✅ מטרה לירידה במשקל\n${(parts || []).join("\n")}`,

  // Goals - FTP (future)
  GOAL_FTP_NOT_SUPPORTED_YET:
    'מטרת FTP עדיין לא נתמכת בצורה מלאה ב-MVP. שמרתי את המטרה ונרחיב בהמשך.',
};
