export type TimingBucket = "active" | "paused_user" | "paused_tracking" | "paused_other" | "terminal";
export interface TimingReasons { userPaused?: boolean; trackingValid?: boolean; ready?: boolean; terminal?: boolean }
export interface TimingState {
  startedAtMs: number;
  lastAtMs: number;
  endedAtMs: number | null;
  bucket: TimingBucket;
  elapsedTimeMs: number;
  activeTimeMs: number;
  pausedTimeMs: number;
  userPausedTimeMs: number;
  trackingPausedTimeMs: number;
  otherPausedTimeMs: number;
}
export function createTimingState(startMs: number): TimingState {
  if (!Number.isFinite(startMs)) throw new Error("A finite monotonic start is required");
  return { startedAtMs: startMs, lastAtMs: startMs, endedAtMs: null, bucket: "paused_other",
    elapsedTimeMs: 0, activeTimeMs: 0, pausedTimeMs: 0, userPausedTimeMs: 0, trackingPausedTimeMs: 0, otherPausedTimeMs: 0 };
}
export function advanceTiming(state: TimingState, atMs: number, reasons: TimingReasons): TimingState {
  if (state.endedAtMs !== null || !Number.isFinite(atMs) || atMs < state.lastAtMs) return state;
  const next = { ...state };
  const delta = atMs - state.lastAtMs;
  if (state.bucket === "active") next.activeTimeMs += delta;
  else if (state.bucket === "paused_user") next.userPausedTimeMs += delta;
  else if (state.bucket === "paused_tracking") next.trackingPausedTimeMs += delta;
  else if (state.bucket === "paused_other") next.otherPausedTimeMs += delta;
  next.lastAtMs = atMs;
  next.elapsedTimeMs = atMs - state.startedAtMs;
  next.pausedTimeMs = next.userPausedTimeMs + next.trackingPausedTimeMs + next.otherPausedTimeMs;
  next.bucket = reasons.terminal ? "terminal" : reasons.userPaused ? "paused_user" :
    reasons.trackingValid === false ? "paused_tracking" : reasons.ready === false || reasons.trackingValid !== true ? "paused_other" : "active";
  if (reasons.terminal) next.endedAtMs = atMs;
  return next;
}
export function timingSummary(state: TimingState) {
  return { elapsedTimeMs: state.elapsedTimeMs, activeTimeMs: state.activeTimeMs, pausedTimeMs: state.pausedTimeMs,
    userPausedTimeMs: state.userPausedTimeMs, trackingPausedTimeMs: state.trackingPausedTimeMs, otherPausedTimeMs: state.otherPausedTimeMs };
}
