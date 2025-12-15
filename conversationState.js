// conversationState.js (ESM)
// Conversation state with DB-first storage.
// If dbImpl doesn't expose sqlGet/sqlRun/sqlAll, falls back to in-memory storage (safe, non-breaking).

export const MODES = Object.freeze({
  GENERAL: "general_chat",
  ONBOARDING: "onboarding",
  WORKOUT: "workout_chat",
  PLAN: "plan_chat",
});

const mem = new Map(); // userId -> state

function hasSql(dbImpl) {
  return (
    dbImpl &&
    typeof dbImpl.sqlGet === "function" &&
    typeof dbImpl.sqlRun === "function" &&
    typeof dbImpl.sqlAll === "function"
  );
}

export async function ensureConversationStateTable(dbImpl) {
  if (!hasSql(dbImpl)) return; // in-memory fallback
  await dbImpl.sqlRun(`
    CREATE TABLE IF NOT EXISTS conversation_state (
      user_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      anchor_activity_id TEXT,
      anchor_plan_id TEXT,
      last_intent TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
}

export async function getConversationState(dbImpl, userId) {
  if (!userId) userId = "roy";

  if (!hasSql(dbImpl)) {
    return (
      mem.get(userId) || {
        userId,
        mode: MODES.GENERAL,
        anchorActivityId: null,
        anchorPlanId: null,
        lastIntent: null,
        updatedAt: null,
      }
    );
  }

  const row = await dbImpl.sqlGet(
    `SELECT user_id, mode, anchor_activity_id, anchor_plan_id, last_intent, updated_at
     FROM conversation_state WHERE user_id = ?`,
    [userId]
  );

  if (!row) {
    return {
      userId,
      mode: MODES.GENERAL,
      anchorActivityId: null,
      anchorPlanId: null,
      lastIntent: null,
      updatedAt: null,
    };
  }

  return {
    userId: row.user_id,
    mode: row.mode,
    anchorActivityId: row.anchor_activity_id ?? null,
    anchorPlanId: row.anchor_plan_id ?? null,
    lastIntent: row.last_intent ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function setConversationState(dbImpl, userId, patch) {
  const prev = await getConversationState(dbImpl, userId);
  const next = {
    userId,
    mode: patch.mode ?? prev.mode ?? MODES.GENERAL,
    anchorActivityId:
      patch.anchorActivityId !== undefined
        ? patch.anchorActivityId
        : prev.anchorActivityId,
    anchorPlanId:
      patch.anchorPlanId !== undefined ? patch.anchorPlanId : prev.anchorPlanId,
    lastIntent:
      patch.lastIntent !== undefined ? patch.lastIntent : prev.lastIntent,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  if (!hasSql(dbImpl)) {
    mem.set(userId, next);
    return next;
  }

  await dbImpl.sqlRun(
    `INSERT INTO conversation_state (user_id, mode, anchor_activity_id, anchor_plan_id, last_intent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       mode=excluded.mode,
       anchor_activity_id=excluded.anchor_activity_id,
       anchor_plan_id=excluded.anchor_plan_id,
       last_intent=excluded.last_intent,
       updated_at=excluded.updated_at`,
    [
      next.userId,
      next.mode,
      next.anchorActivityId,
      next.anchorPlanId,
      next.lastIntent,
      next.updatedAt,
    ]
  );

  return next;
}
