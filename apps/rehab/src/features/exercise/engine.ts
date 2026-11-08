export type ExerciseId = "seated-knee-extension" | "seated-knee-flexion-extension" | "straight-leg-raise" | "static-quads";
export type ExercisePhase = "await_start" | "armed" | "outbound" | "holding" | "returning" | "return_hold";
export type FeedbackCode = "HOLD_TOO_SHORT" | "EXTENSION_INCOMPLETE" | "MOVEMENT_TOO_FAST" | "KNEE_BENDING" |
  "TRACKING_LOST" | "TRACKING_RESTORED" | "REP_COMPLETED";
export interface EngineConfig {
  exerciseId: ExerciseId;
  startRangeDeg: [number, number];
  targetRangeDeg: [number, number];
  holdMs: number;
  flexionHoldMs?: number;
  minimumDwellMs?: number;
  hysteresisDeg?: number;
  maximumSampleGapMs?: number;
  minimumExcursionDeg?: number;
  minimumMovementMs?: number;
  allowedKneeRangeDeg?: [number, number];
}
export interface ExerciseObservation { atMs: number; valid: boolean; angleDeg: number | null; kneeAngleDeg?: number | null }
export interface AttemptOutcome {
  attemptId: string;
  movementComplete: boolean;
  qualifying: boolean;
  holdMs: number;
  flexionHoldMs: number;
  targetReached: boolean;
  rangeDegrees: number | null;
  kneeBent: boolean;
  invalidated: boolean;
  reason: string | null;
}
interface ActiveAttempt {
  attemptId: string;
  startedAtMs: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  targetReached: boolean;
  holdMs: number;
  flexionHoldMs: number;
  kneeBent: boolean;
  overshot: boolean;
  shortHold: boolean;
  holdCueEmitted: boolean;
}
export interface ExerciseState {
  phase: ExercisePhase;
  attemptedCycles: number;
  movementCycles: number;
  qualifyingReps: number;
  nextAttempt: number;
  activeAttempt: ActiveAttempt | null;
  currentHoldMs: number;
  conditionSinceMs: number | null;
  lastAtMs: number | null;
  lastAngleDeg: number | null;
  trackingAvailable: boolean;
}
export interface ExerciseAdvance { state: ExerciseState; attempt: AttemptOutcome | null; feedbackCodes: FeedbackCode[] }
export const DETECTOR_DEFAULTS = Object.freeze({ minimumDwellMs: 200, hysteresisDeg: 3,
  maximumSampleGapMs: 250, minimumExcursionDeg: 10 });
export function defaultEngineConfig(exerciseId: ExerciseId): EngineConfig {
  return { exerciseId, startRangeDeg: exerciseId === "straight-leg-raise" ? [0, 6] : [84, 96],
    targetRangeDeg: exerciseId === "straight-leg-raise" ? [24, 36] : [159, 180], holdMs: 5000,
    flexionHoldMs: exerciseId === "seated-knee-flexion-extension" ? 5000 : 0,
    allowedKneeRangeDeg: exerciseId === "straight-leg-raise" ? [155, 180] : undefined, ...DETECTOR_DEFAULTS };
}
export function createExerciseState(): ExerciseState {
  return { phase: "await_start", attemptedCycles: 0, movementCycles: 0, qualifyingReps: 0, nextAttempt: 1,
    activeAttempt: null, currentHoldMs: 0, conditionSinceMs: null, lastAtMs: null, lastAngleDeg: null, trackingAvailable: false };
}
const inRange = (value: number, range: [number, number]) => value >= range[0] && value <= range[1];
const midpoint = (range: [number, number]) => (range[0] + range[1]) / 2;
function outcome(attempt: ActiveAttempt, config: EngineConfig, invalidated: boolean, reason: string | null, endedAtMs: number): AttemptOutcome {
  const holdMet = attempt.holdMs >= config.holdMs;
  const flexionMet = config.exerciseId !== "seated-knee-flexion-extension" || attempt.flexionHoldMs >= (config.flexionHoldMs ?? config.holdMs);
  const movingMs = Math.max(0, endedAtMs - attempt.startedAtMs - attempt.holdMs - attempt.flexionHoldMs);
  const tooFast = config.minimumMovementMs !== undefined && movingMs < config.minimumMovementMs;
  const qualifying = !invalidated && attempt.targetReached && holdMet && flexionMet && !attempt.kneeBent && !attempt.overshot && !tooFast;
  return { attemptId: attempt.attemptId, movementComplete: !invalidated && attempt.targetReached, qualifying,
    holdMs: attempt.holdMs, flexionHoldMs: attempt.flexionHoldMs, targetReached: attempt.targetReached,
    rangeDegrees: attempt.maxAngleDeg - attempt.minAngleDeg, kneeBent: attempt.kneeBent, invalidated,
    reason: reason ?? (!attempt.targetReached ? "incomplete_target" : !holdMet || !flexionMet ? "short_hold" :
      attempt.kneeBent ? "knee_bending" : attempt.overshot ? "target_overshoot" : tooFast ? "movement_too_fast" : null) };
}
function finish(state: ExerciseState, config: EngineConfig, codes: FeedbackCode[]): ExerciseAdvance {
  const active = state.activeAttempt!;
  const attempt = outcome(active, config, false, null, state.lastAtMs!);
  const feedbackCodes = [...codes];
  if (!active.targetReached) feedbackCodes.push("EXTENSION_INCOMPLETE");
  if ((attempt.holdMs < config.holdMs || (config.exerciseId === "seated-knee-flexion-extension" &&
    attempt.flexionHoldMs < (config.flexionHoldMs ?? config.holdMs))) && active.targetReached && !active.holdCueEmitted)
    feedbackCodes.push("HOLD_TOO_SHORT");
  if (attempt.qualifying) feedbackCodes.push("REP_COMPLETED");
  if (attempt.reason === "movement_too_fast") feedbackCodes.push("MOVEMENT_TOO_FAST");
  return { state: { ...state, phase: state.lastAngleDeg !== null && inRange(state.lastAngleDeg, config.startRangeDeg) ? "armed" : "await_start",
    activeAttempt: null, currentHoldMs: 0, conditionSinceMs: null,
    attemptedCycles: state.attemptedCycles + 1, movementCycles: state.movementCycles + Number(attempt.movementComplete),
    qualifyingReps: state.qualifyingReps + Number(attempt.qualifying) }, attempt, feedbackCodes };
}
export function invalidateExercise(state: ExerciseState, reason: string, atMs: number): ExerciseAdvance {
  if (!Number.isFinite(atMs) || (state.lastAtMs !== null && atMs < state.lastAtMs)) return { state, attempt: null, feedbackCodes: [] };
  const active = state.activeAttempt;
  const attempt: AttemptOutcome | null = active ? { attemptId: active.attemptId, movementComplete: false, qualifying: false,
    holdMs: active.holdMs, flexionHoldMs: active.flexionHoldMs, targetReached: active.targetReached,
    rangeDegrees: active.maxAngleDeg - active.minAngleDeg, kneeBent: active.kneeBent, invalidated: true, reason } : null;
  const trackingLoss = reason === "tracking_lost" || reason === "sample_gap" || reason === "person_changed";
  return { state: { ...state, phase: "await_start", activeAttempt: null, conditionSinceMs: null, currentHoldMs: 0,
    attemptedCycles: state.attemptedCycles + Number(!!attempt), lastAtMs: atMs, lastAngleDeg: null, trackingAvailable: false },
    attempt, feedbackCodes: trackingLoss && state.trackingAvailable ? ["TRACKING_LOST"] : [] };
}

/** A pure, causal state machine. It never creates a repetition from missing frames. */
export function advanceExercise(previous: ExerciseState, observation: ExerciseObservation, config: EngineConfig): ExerciseAdvance {
  const { atMs, angleDeg } = observation;
  if (!Number.isFinite(atMs) || (previous.lastAtMs !== null && atMs <= previous.lastAtMs))
    return { state: previous, attempt: null, feedbackCodes: [] };
  if (config.exerciseId === "static-quads") return { state: previous, attempt: null, feedbackCodes: [] };
  if (!observation.valid || angleDeg === null || !Number.isFinite(angleDeg)) return invalidateExercise(previous, "tracking_lost", atMs);
  if (config.allowedKneeRangeDeg && (observation.kneeAngleDeg == null || !Number.isFinite(observation.kneeAngleDeg)))
    return invalidateExercise(previous, "tracking_lost", atMs);
  if (previous.lastAtMs !== null && atMs - previous.lastAtMs > (config.maximumSampleGapMs ?? DETECTOR_DEFAULTS.maximumSampleGapMs))
    return invalidateExercise(previous, "sample_gap", atMs);
  const dwell = config.minimumDwellMs ?? DETECTOR_DEFAULTS.minimumDwellMs;
  const hysteresis = config.hysteresisDeg ?? DETECTOR_DEFAULTS.hysteresisDeg;
  const minExcursion = config.minimumExcursionDeg ?? DETECTOR_DEFAULTS.minimumExcursionDeg;
  const direction = Math.sign(midpoint(config.targetRangeDeg) - midpoint(config.startRangeDeg));
  const atStart = inRange(angleDeg, config.startRangeDeg);
  const atTarget = inRange(angleDeg, config.targetRangeDeg);
  // Enter on the configured target, release only beyond its hysteresis band.
  // Small measurement noise must not prematurely terminate a continuous hold.
  const insideTargetRelease = inRange(angleDeg,[config.targetRangeDeg[0]-hysteresis,config.targetRangeDeg[1]+hysteresis]);
  // Dwell belongs to one region; a direct jump cannot inherit the other region's time.
  const previouslyAtStart = previous.trackingAvailable && previous.lastAngleDeg !== null && inRange(previous.lastAngleDeg, config.startRangeDeg);
  const previouslyAtTarget = previous.trackingAvailable && previous.lastAngleDeg !== null && inRange(previous.lastAngleDeg, config.targetRangeDeg);
  const dt = previous.lastAtMs === null ? 0 : atMs - previous.lastAtMs;
  const state: ExerciseState = { ...previous, activeAttempt: previous.activeAttempt ? { ...previous.activeAttempt } : null,
    lastAtMs: atMs, lastAngleDeg: angleDeg, trackingAvailable: true };
  const feedbackCodes: FeedbackCode[] = [];
  if (!previous.trackingAvailable) feedbackCodes.push("TRACKING_RESTORED");
  const active = state.activeAttempt;
  if (active) {
    active.minAngleDeg = Math.min(active.minAngleDeg, angleDeg);
    active.maxAngleDeg = Math.max(active.maxAngleDeg, angleDeg);
    if (config.allowedKneeRangeDeg && !inRange(observation.kneeAngleDeg!, config.allowedKneeRangeDeg) && !active.kneeBent) {
      active.kneeBent = true;
      feedbackCodes.push("KNEE_BENDING");
    }
    if ((direction > 0 && angleDeg > config.targetRangeDeg[1] + hysteresis) ||
      (direction < 0 && angleDeg < config.targetRangeDeg[0] - hysteresis)) active.overshot = true;
  }
  if (state.phase === "await_start") {
    state.conditionSinceMs = atStart ? (previouslyAtStart ? previous.conditionSinceMs ?? atMs : atMs) : null;
    if (state.conditionSinceMs !== null && atMs - state.conditionSinceMs >= dwell) {
      state.phase = "armed"; state.conditionSinceMs = null;
    }
  } else if (state.phase === "armed") {
    const departed = direction > 0 ? angleDeg > config.startRangeDeg[1] + hysteresis : angleDeg < config.startRangeDeg[0] - hysteresis;
    if (departed) {
      state.phase = "outbound";
      state.activeAttempt = { attemptId: `attempt-${state.nextAttempt}`, startedAtMs: atMs,
        minAngleDeg: Math.min(midpoint(config.startRangeDeg), angleDeg), maxAngleDeg: Math.max(midpoint(config.startRangeDeg), angleDeg),
        targetReached: false, holdMs: 0, flexionHoldMs: 0, kneeBent: false, overshot: false, shortHold: false, holdCueEmitted: false };
      state.nextAttempt += 1;
      state.conditionSinceMs = atTarget ? atMs : null;
      if (config.allowedKneeRangeDeg && observation.kneeAngleDeg != null && !inRange(observation.kneeAngleDeg, config.allowedKneeRangeDeg)) {
        state.activeAttempt.kneeBent = true; feedbackCodes.push("KNEE_BENDING");
      }
    }
  } else if (state.phase === "outbound") {
    if (atTarget) {
      state.conditionSinceMs = previouslyAtTarget ? previous.conditionSinceMs ?? atMs : atMs;
      if (atMs - state.conditionSinceMs >= dwell) {
        state.phase = "holding"; state.activeAttempt!.targetReached = true;
        state.activeAttempt!.holdMs = atMs - state.conditionSinceMs;
        state.currentHoldMs = state.activeAttempt!.holdMs; state.conditionSinceMs = null;
      }
    } else if (atStart) {
      state.conditionSinceMs = previouslyAtStart ? previous.conditionSinceMs ?? atMs : atMs;
      if (atMs - state.conditionSinceMs >= dwell) {
        if (state.activeAttempt!.maxAngleDeg - state.activeAttempt!.minAngleDeg >= minExcursion) return finish(state, config, feedbackCodes);
        state.phase = "armed"; state.activeAttempt = null; state.conditionSinceMs = null;
      }
    } else state.conditionSinceMs = null;
  } else if (state.phase === "holding") {
    if (insideTargetRelease) {
      state.activeAttempt!.holdMs += dt;
      state.currentHoldMs = state.activeAttempt!.holdMs;
    } else {
      state.phase = "returning"; state.conditionSinceMs = atStart ? atMs : null; state.currentHoldMs = 0;
      if (state.activeAttempt!.holdMs < config.holdMs) {
        state.activeAttempt!.shortHold = true; state.activeAttempt!.holdCueEmitted = true;
        feedbackCodes.push("HOLD_TOO_SHORT");
      }
    }
  } else if (state.phase === "returning") {
    state.conditionSinceMs = atStart ? (previouslyAtStart ? previous.conditionSinceMs ?? atMs : atMs) : null;
    if (state.conditionSinceMs !== null && atMs - state.conditionSinceMs >= dwell) {
      if (config.exerciseId === "seated-knee-flexion-extension") {
        state.phase = "return_hold";
        state.activeAttempt!.flexionHoldMs = atMs - state.conditionSinceMs;
        state.currentHoldMs = state.activeAttempt!.flexionHoldMs; state.conditionSinceMs = null;
        if (state.activeAttempt!.flexionHoldMs >= (config.flexionHoldMs ?? config.holdMs)) return finish(state, config, feedbackCodes);
      } else return finish(state, config, feedbackCodes);
    }
  } else if (state.phase === "return_hold") {
    if (atStart) {
      state.activeAttempt!.flexionHoldMs += dt;
      state.currentHoldMs = state.activeAttempt!.flexionHoldMs;
      if (state.activeAttempt!.flexionHoldMs >= (config.flexionHoldMs ?? config.holdMs)) return finish(state, config, feedbackCodes);
    } else {
      // Second hold ended before its duration. Finalize the observed incomplete cycle once.
      return finish(state, config, feedbackCodes);
    }
  }
  return { state, attempt: null, feedbackCodes };
}

/** Explicit patient confirmation after a guided timer, never camera-verified contraction. */
export function completeGuidedHold(state: ExerciseState, durationMs: number, confirmed: boolean, config: EngineConfig): ExerciseAdvance {
  if (config.exerciseId !== "static-quads" || !confirmed || !Number.isFinite(durationMs) || durationMs < 0)
    return { state, attempt: null, feedbackCodes: [] };
  const qualifying = durationMs >= config.holdMs;
  const attempt: AttemptOutcome = { attemptId: `attempt-${state.nextAttempt}`, movementComplete: true, qualifying,
    holdMs: durationMs, flexionHoldMs: 0, targetReached: true, rangeDegrees: null, kneeBent: false,
    invalidated: false, reason: qualifying ? null : "short_hold" };
  return { state: { ...state, nextAttempt: state.nextAttempt + 1, attemptedCycles: state.attemptedCycles + 1,
    movementCycles: state.movementCycles + 1, qualifyingReps: state.qualifyingReps + Number(qualifying) }, attempt,
    feedbackCodes: qualifying ? ["REP_COMPLETED"] : ["HOLD_TOO_SHORT"] };
}
