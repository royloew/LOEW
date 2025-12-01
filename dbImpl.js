// dbImpl.js
// מימוש זמני של OnboardingDB בזיכרון + חיבור אופציונלי ל-Strava snapshot

/**
 * יוצר אובייקט DB למנוע האונבורדינג.
 * @param {{ getStravaTokens: () => any, buildStravaSnapshot: (tokens:any) => Promise<any> }} deps
 */
export function createDbImpl({ getStravaTokens, buildStravaSnapshot }) {
  const memoryDB = {
    users: new Map(),          // userId -> user
    trainingParams: new Map(), // userId -> training params
    weeklyTemplates: new Map(),// userId -> weekly plan
    goals: new Map(),          // userId -> active goal
    onboarding: new Map(),     // userId -> onboarding state
  };

  return {
    // ---------- Users ----------
    async getUser(userId) {
      let u = memoryDB.users.get(userId);
      if (!u) {
        u = { id: userId };
        memoryDB.users.set(userId, u);
      }
      return u;
    },

    async saveUser(user) {
      const existing = memoryDB.users.get(user.id) || {};
      memoryDB.users.set(user.id, { ...existing, ...user });
    },

    // ---------- Training params ----------
    async getTrainingParams(userId) {
      return memoryDB.trainingParams.get(userId) || null;
    },

    async saveTrainingParams(params) {
      const existing = memoryDB.trainingParams.get(params.userId) || {};
      memoryDB.trainingParams.set(params.userId, { ...existing, ...params });
    },

    // ---------- Weekly template ----------
    async getWeeklyTemplate(userId) {
      return memoryDB.weeklyTemplates.get(userId) || null;
    },

    async saveWeeklyTemplate(template) {
      const existing = memoryDB.weeklyTemplates.get(template.userId) || {};
      memoryDB.weeklyTemplates.set(template.userId, { ...existing, ...template });
    },

    // ---------- Goals ----------
    async getActiveGoal(userId) {
      const g = memoryDB.goals.get(userId) || null;
      if (g && g.archived) return null;
      return g;
    },

    async archiveGoal(goalId) {
      for (const [uid, g] of memoryDB.goals.entries()) {
        if (g.id === goalId) {
          memoryDB.goals.set(uid, { ...g, archived: true });
          break;
        }
      }
    },

    async createGoal(goal) {
      const id = goal.id || `goal_${Date.now()}`;
      const g = { ...goal, id, archived: false };
      memoryDB.goals.set(goal.userId, g);
      return g;
    },

    // ---------- Onboarding state ----------
    async getOnboarding(userId) {
      return memoryDB.onboarding.get(userId) || null;
    },

    async saveOnboarding(ob) {
      const existing = memoryDB.onboarding.get(ob.userId) || {};
      memoryDB.onboarding.set(ob.userId, { ...existing, ...ob });
    },

    // ---------- Strava helpers ----------
    async hasStravaConnection(userId) {
      const tokens = getStravaTokens && getStravaTokens();
      return !!tokens;
    },

 async computeHrAndFtpFromStrava(userId) {
  const tokens = getStravaTokens && getStravaTokens();
  if (!tokens || !buildStravaSnapshot) return {};

  const snapshot = await buildStravaSnapshot(tokens);
  if (!snapshot) return {};

  const ftpModels = snapshot.ftp_models || {};
  const ts = snapshot.training_summary || {};

  return {
    hrMaxCandidate: snapshot.hr_max_from_data || null,
    hrThresholdCandidate: snapshot.hr_threshold_from_data || null,

    // שלושת המודלים
    ftp20: ftpModels.from_20min || null,
    ftpCp: ftpModels.from_8min || null,
    ftpPowerCurve: ftpModels.from_3min || null,

    // FTP שהוגדר בסטרבה
    ftpFromStrava: snapshot.ftp_from_strava || null,

    // המלצה משולבת
    ftpRecommended:
      snapshot.ftp_from_streams ||
      snapshot.ftp_from_strava ||
      ftpModels.from_20min ||
      ftpModels.from_8min ||
      null,

    userWeightKg: snapshot.user_from_strava?.weight_kg ?? null,

    trainingSummary: {
      avgHoursPerWeek: ts.avg_hours_per_week || null,
      rides_count: ts.rides_count || null,
    },
  };
}


  };
}

