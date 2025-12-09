// workoutEngine.js

import db from "./dbSqlite.js";

// Core functions
export async function getLastRideWithStreams(userId) { ... }
export function computeWorkoutMetrics(activity, streams, trainingParams) { ... }
export function computeExecutionScore(metrics, trainingParams) { ... }
export async function suggestNextWorkout(
  userId,
  metrics,
  trainingParams,
  weeklySummary
) { ... }

// Main orchestration – one call to rule them all
export async function analyzeAndSuggest(userId) {
  const trainingParams = await db.getTrainingParams(userId);
  const weeklySummary = await db.getWeeklySummary(userId);

  const { activity, streams } = await getLastRideWithStreams(userId);

  const metrics = computeWorkoutMetrics(activity, streams, trainingParams);

  const execution = computeExecutionScore(metrics, trainingParams);

  const suggestion = await suggestNextWorkout(
    userId,
    metrics,
    trainingParams,
    weeklySummary
  );

  return {
    lastWorkout: metrics,
    execution,
    nextWorkout: suggestion,
  };
}
