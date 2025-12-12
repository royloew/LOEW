// onboardingEngine.js

export default class OnboardingEngine {
  constructor(dbImpl, options = {}) {
    this.db = dbImpl;

    // אופציונלי: הזרקת extractor LLM
    this._llmExtractWeightGoal = options.llmExtractWeightGoal || null;
  }

  // =========================================================
  // ENTRY POINT
  // =========================================================
  async handleMessage(userId, text) {
    const state = await this._loadOrInitState(userId);
    const msg = (text || "").trim();

    // -------- ROUTER --------
    if (state.stage === "intro") {
      return await this._stageIntro(userId, msg, state);
    }

    if (state.stage === "personal_details") {
      return await this._stagePersonalDetails(userId, msg, state);
    }

    if (state.stage === "training_time") {
      return await this._stageTrainingTime(userId, msg, state);
    }

    // ===== WEIGHT GOAL STAGES =====
    if (state.stage === "goal_weight_target") {
      return await this._stageGoalWeightTarget(userId, msg, state);
    }

    if (state.stage === "goal_weight_timeline") {
      return await this._stageGoalWeightTimeline(userId, msg, state);
    }

    // ===== ORIGINAL GOAL COLLECT =====
    if (state.stage === "goal_collect") {
      return await this._stageGoalCollect(userId, msg, state);
    }

    // DONE → רגיל
    return {
      reply: "האונבורדינג הושלם. אפשר להתחיל לעבוד 💪",
      onboarding: false,
    };
  }

  // =========================================================
  // STATE
  // =========================================================
  async _loadOrInitState(userId) {
    const existing = await this.db.getOnboardingState(userId);
    if (existing) return existing;

    const state = {
      userId,
      stage: "intro",
      data: {
        personal: {},
      },
    };
    await this.db.saveOnboardingState(userId, state);
    return state;
  }

  async _saveState(userId, state) {
    await this.db.saveOnboardingState(userId, state);
  }

  // =========================================================
  // INTRO
  // =========================================================
  async _stageIntro(userId, text, state) {
    state.stage = "personal_details";
    state.data.personalStep = "weight";
    await this._saveState(userId, state);

    return {
      reply:
        "נתחיל בכמה פרטים אישיים.\n" +
        "מה המשקל הנוכחי שלך בק״ג? (למשל 72)",
      onboarding: true,
    };
  }

  // =========================================================
  // PERSONAL DETAILS (FIXED)
  // =========================================================
  async _stagePersonalDetails(userId, text, state) {
    const step = state.data.personalStep || "weight";
    const t = text.trim();

    // ----- WEIGHT -----
    if (step === "weight") {
      if (t === "אישור") {
        const w = state.data.personal.weightKg;
        state.data.personal.weight = w;
        state.data.personal.weightKg = w;

        state.data.personalStep = "height";
        await this._saveState(userId, state);

        return {
          reply: "מעולה. מה הגובה שלך בס״מ? (למשל 178)",
          onboarding: true,
        };
      }

      const parsed = parseFloat(t.replace(",", "."));
      if (Number.isNaN(parsed) || parsed < 30 || parsed > 200) {
        return {
          reply: "לא הצלחתי להבין. תכתוב משקל בק״ג (למשל 72 או 72.5).",
          onboarding: true,
        };
      }

      state.data.personal.weight = parsed;
      state.data.personal.weightKg = parsed;

      state.data.personalStep = "height";
      await this._saveState(userId, state);

      return {
        reply: "תודה. מה הגובה שלך בס״מ?",
        onboarding: true,
      };
    }

    // ----- HEIGHT -----
    if (step === "height") {
      const h = parseInt(t, 10);
      if (Number.isNaN(h) || h < 120 || h > 230) {
        return {
          reply: "תכתוב גובה בס״מ (למשל 178).",
          onboarding: true,
        };
      }

      state.data.personal.height = h;
      state.data.personal.heightCm = h;

      state.stage = "training_time";
      await this._saveState(userId, state);

      return {
        reply:
          "מעולה.\n" +
          "מה משך רכיבה טיפוסי אצלך?\n" +
          "אם תרצה, תכתוב: קצר/ממוצע/ארוך בדקות (למשל 90/120/180)\n" +
          "או פשוט \"אישור\".",
        onboarding: true,
      };
    }
  }

  // =========================================================
  // TRAINING TIME (UNCHANGED)
  // =========================================================
  async _stageTrainingTime(userId, text, state) {
    state.stage = "goal_collect";
    await this._saveState(userId, state);

    return {
      reply:
        "מעולה.\n" +
        "עכשיו נשאר לנו להגדיר את המטרה המרכזית שלך.\n" +
        "למשל: ירידה במשקל / תחרות / התחזקות.",
      onboarding: true,
    };
  }

  // =========================================================
  // GOAL COLLECT (ROUTER → WEIGHT ONLY)
  // =========================================================
  async _stageGoalCollect(userId, text, state) {
    const goalText = text;

    // שומר כמו היום
    await this.db.updateGoal(userId, goalText);

    // ===== WEIGHT GOAL MVP =====
    state.data.goal = {
      type: "weight",
      rawText: goalText,
    };

    const currentWeight =
      state.data.personal.weightKg || state.data.personal.weight || null;

    const extracted = await this._extractWeightGoal(goalText, currentWeight);

    if (extracted.targetKg != null) {
      state.data.goal.targetKg = extracted.targetKg;
    }

    if (extracted.timeframeWeeks != null) {
      state.data.goal.timeframeWeeks = extracted.timeframeWeeks;
    }

    if (state.data.goal.targetKg == null) {
      state.stage = "goal_weight_target";
      await this._saveState(userId, state);

      return {
        reply: "לאיזה משקל יעד היית רוצה להגיע? (בק״ג, למשל 68)",
        onboarding: true,
      };
    }

    if (state.data.goal.timeframeWeeks == null) {
      state.stage = "goal_weight_timeline";
      await this._saveState(userId, state);

      return {
        reply:
          `יעד: ${state.data.goal.targetKg} ק״ג.\n` +
          "תוך כמה זמן היית רוצה להגיע לזה? (למשל: 8 שבועות / 3 חודשים)",
        onboarding: true,
      };
    }

    // יש הכול → סיום רגיל
    state.stage = "done";
    await this._saveState(userId, state);

    return {
      reply: "מעולה. סיימנו את האונבורדינג 🎉",
      onboarding: true,
    };
  }

  // =========================================================
  // WEIGHT GOAL STAGES
  // =========================================================
  async _stageGoalWeightTarget(userId, text, state) {
    const parsed = parseFloat(text.replace(",", "."));
    if (Number.isNaN(parsed) || parsed < 30 || parsed > 200) {
      return {
        reply: "תכתוב משקל יעד בק״ג (למשל 68 או 68.5).",
        onboarding: true,
      };
    }

    state.data.goal.targetKg = Math.round(parsed * 10) / 10;
    state.stage = "goal_weight_timeline";
    await this._saveState(userId, state);

    return {
      reply:
        `מעולה. יעד: ${state.data.goal.targetKg} ק״ג.\n` +
        "תוך כמה זמן היית רוצה להגיע לזה?",
      onboarding: true,
    };
  }

  async _stageGoalWeightTimeline(userId, text, state) {
    const extracted = await this._extractWeightGoal(text, null);
    const weeks = extracted.timeframeWeeks;

    if (!weeks || weeks < 1 || weeks > 260) {
      return {
        reply:
          "לא הצלחתי להבין את הזמן.\n" +
          "תכתוב למשל: 8 שבועות / 12 שבועות / 3 חודשים.",
        onboarding: true,
      };
    }

    state.data.goal.timeframeWeeks = weeks;

    const current =
      state.data.personal.weightKg || state.data.personal.weight;
    const target = state.data.goal.targetKg;

    let verdict = "";
    if (current && target && current > target) {
      const rate = (current - target) / weeks;
      if (rate > 0.9) verdict = "⚠️ קצב מאוד אגרסיבי";
      else if (rate > 0.6) verdict = "מאתגר אבל אפשרי";
      else verdict = "ריאלי ובריא";

      verdict =
        `\nבדיקת היתכנות:\n` +
        `• קצב ירידה: ~${rate.toFixed(2)} ק״ג לשבוע → ${verdict}`;
    }

    state.stage = "done";
    await this._saveState(userId, state);

    return {
      reply: `סגור.${verdict}\n\nסיימנו אונבורדינג 🎉`,
      onboarding: true,
    };
  }

  // =========================================================
  // EXTRACTOR (LLM + FALLBACK)
  // =========================================================
  async _extractWeightGoal(text, currentWeightKg) {
    const fallback = this._extractWeightGoalFallback(text);
    if (fallback.targetKg != null || fallback.timeframeWeeks != null) {
      return fallback;
    }

    if (this._llmExtractWeightGoal) {
      try {
        const llm = await this._llmExtractWeightGoal(text, currentWeightKg);
        if (llm) return llm;
      } catch (e) {
        console.error("LLM extractor failed", e);
      }
    }

    return { targetKg: null, timeframeWeeks: null };
  }

  _extractWeightGoalFallback(text) {
    const t = (text || "").trim();

    let targetKg = null;
    const mKg = t.match(/(\d{2,3}(?:[.,]\d)?)/);
    if (mKg) {
      const v = parseFloat(mKg[1].replace(",", "."));
      if (v >= 30 && v <= 200) targetKg = v;
    }

    let timeframeWeeks = null;
    const mW = t.match(/(\d+)\s*שבוע/);
    const mM = t.match(/(\d+)\s*חודש/);
    if (mW) timeframeWeeks = parseInt(mW[1], 10);
    else if (mM) timeframeWeeks = parseInt(mM[1], 10) * 4;

    return { targetKg, timeframeWeeks };
  }
}
