import test from "node:test";
import assert from "node:assert/strict";
import {
  angleAtJoint, imageAngle, measurePose, createAngleFilter, filterAngle,
  evaluateCalibration, deriveCalibration, createExerciseState, advanceExercise,
  invalidateExercise, defaultEngineConfig, completeGuidedHold,
  createTimingState, advanceTiming, timingSummary,
  type EngineConfig, type ExerciseState, type AttemptOutcome, type FeedbackCode, type PoseLandmark,
} from "../apps/rehab/src/features/exercise";

function trace(config: EngineConfig = defaultEngineConfig("seated-knee-extension")) {
  let state = createExerciseState(), atMs = -100;
  const outcomes: AttemptOutcome[] = [], codes: FeedbackCode[] = [];
  const sample = (angleDeg: number | null, valid = true, kneeAngleDeg = 175, deltaMs = 100) => {
    atMs += deltaMs;
    const result = advanceExercise(state, { atMs, angleDeg, valid, kneeAngleDeg }, config);
    state = result.state; if (result.attempt) outcomes.push(result.attempt); codes.push(...result.feedbackCodes);
    return result;
  };
  const hold = (angle: number, duration: number, kneeAngle = 175) => {
    sample(angle, true, kneeAngle);
    for (let elapsed = 100; elapsed <= duration; elapsed += 100) sample(angle, true, kneeAngle);
  };
  const start = (angle = 90) => { sample(angle); sample(angle); sample(angle); };
  const cycle = (holdMs = 5000, kneeAngle = 175) => {
    const isSlr = config.exerciseId === "straight-leg-raise";
    sample(isSlr ? 12 : 110, true, kneeAngle);
    sample(isSlr ? 20 : 140, true, kneeAngle);
    hold(isSlr ? 30 : 170, holdMs, kneeAngle);
    sample(isSlr ? 15 : 135, true, kneeAngle);
    sample(isSlr ? 0 : 90, true, kneeAngle);
    sample(isSlr ? 0 : 90, true, kneeAngle);
    sample(isSlr ? 0 : 90, true, kneeAngle);
  };
  return { sample, hold, start, cycle, outcomes, codes, state: () => state, at: () => atMs };
}

test("geometry rejects invalid vectors and preserves known 90/180 degree angles", () => {
  assert.equal(angleAtJoint({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90);
  assert.equal(angleAtJoint({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  assert.equal(angleAtJoint({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
  assert.equal(angleAtJoint({ x: NaN, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
  assert.equal(angleAtJoint({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 90);
});

test("image angles correct independent normalized x/y aspect ratios", () => {
  for (const [width, height] of [[640, 480], [1280, 720]]) {
    const point = (x: number, y: number) => ({ x: x / width, y: y / height });
    assert.ok(Math.abs(imageAngle(point(400, 100), point(300, 200), point(400, 300), width, height)! - 90) < 1e-9);
  }
  assert.equal(imageAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, 0, 720), null);
});

test("required-joint gating, anatomical side and person ambiguity cannot fabricate a measurement", () => {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  landmarks[11] = { x: .1, y: .5, visibility: 1 };
  landmarks[23] = { x: .3, y: .5, visibility: 1 };
  landmarks[25] = { x: .5, y: .5, visibility: 1 };
  landmarks[27] = { x: .7, y: .5, visibility: 1 };
  const measured = measurePose(landmarks, "left", 640, 480, { requireTorso: true });
  assert.equal(measured.valid, true); assert.equal(measured.kneeAngleDeg, 180); assert.equal(measured.elevationDeg, 0);
  const mirrored = landmarks.map(p => ({ ...p, x: 1 - p.x }));
  assert.equal(measurePose(mirrored, "left", 640, 480).kneeAngleDeg, 180);
  assert.equal(measurePose(landmarks, "right", 640, 480).valid, false);
  assert.equal(measurePose(landmarks, "left", 640, 480, { personCount: 2 }).reason, "person_ambiguous");
  landmarks[27].visibility = .2;
  assert.equal(measurePose(landmarks, "left", 640, 480).valid, false);
  assert.equal(measurePose(landmarks, "left", 640, 480).kneeAngleDeg, null);
});

test("calibration requires stable contiguous observations and separated reference postures", () => {
  const samples = Array.from({ length: 11 }, (_, i) => ({ atMs: i * 100, angleDeg: 90 + i % 2, valid: true }));
  assert.equal(evaluateCalibration(samples).ready, true);
  assert.equal(evaluateCalibration(samples.slice(0, 5)).ready, false);
  assert.equal(evaluateCalibration([...samples, { atMs: 1100, angleDeg: 90, valid: false }]).reason, "tracking_lost");
  assert.equal(evaluateCalibration([...samples, { atMs: 2000, angleDeg: 90, valid: true }]).ready, false);
  assert.equal(evaluateCalibration(samples.map((s, i) => ({ ...s, angleDeg: i * 5 }))).reason, "unstable");
  assert.equal(deriveCalibration(90, 100), null);
  assert.deepEqual(deriveCalibration(90, 170)?.startRangeDeg, [84, 96]);
});

test("smoothing resets after invalid data or a gap rather than inventing cross-gap motion", () => {
  let filter = filterAngle(createAngleFilter(), 90, 0);
  filter = filterAngle(filter, 100, 100);
  assert.ok(filter.value! > 90 && filter.value! < 100);
  assert.equal(filterAngle(filter, 10, 500).value, 10);
  assert.equal(filterAngle(filter, null, 200).value, null);
  assert.equal(filterAngle(filter, 0, 100), filter);
});

test("three continuous full cycles count exactly three accepted repetitions", () => {
  const t = trace(); t.start(); t.cycle(); t.cycle(); t.cycle();
  assert.equal(t.state().qualifyingReps, 3); assert.equal(t.state().movementCycles, 3); assert.equal(t.state().attemptedCycles, 3);
  assert.equal(t.outcomes.length, 3);
  assert.deepEqual(t.outcomes.map(o => o.holdMs), [5000, 5000, 5000]);
  assert.equal(t.codes.filter(c => c === "REP_COMPLETED").length, 3);
});

test("stationary jitter and duplicate or backwards timestamps never create repetitions", () => {
  const t = trace(); t.start();
  for (let i = 0; i < 100; i++) t.sample(i % 2 ? 98 : 90);
  const state = t.state();
  assert.equal(state.attemptedCycles, 0);
  assert.equal(advanceExercise(state, { atMs: t.at(), angleDeg: 170, valid: true }, defaultEngineConfig("seated-knee-extension")).state, state);
  assert.equal(advanceExercise(state, { atMs: 0, angleDeg: 170, valid: true }, defaultEngineConfig("seated-knee-extension")).state, state);
});

test("a meaningful sub-target excursion finalizes once without a false full cycle", () => {
  const t = trace(); t.start(); t.sample(110); t.sample(135); t.sample(90); t.sample(90); t.sample(90);
  assert.equal(t.outcomes.length, 1); assert.equal(t.outcomes[0].targetReached, false);
  assert.equal(t.outcomes[0].movementComplete, false); assert.equal(t.state().qualifyingReps, 0);
  assert.equal(t.codes.filter(c => c === "EXTENSION_INCOMPLETE").length, 1);
  for (let i = 0; i < 20; i++) t.sample(90);
  assert.equal(t.outcomes.length, 1);
});

test("direct jumps between start and target do not transfer dwell or inflate a hold", () => {
  const t = trace(); t.start(); t.sample(110); t.sample(90);
  t.sample(170, true, 175, 200);
  assert.equal(t.state().phase, "outbound"); assert.equal(t.state().currentHoldMs, 0);
  t.sample(170); assert.equal(t.state().phase, "outbound");
  t.sample(170); assert.equal(t.state().phase, "holding"); assert.equal(t.state().currentHoldMs, 200);
  const returning = trace(); returning.start(); returning.sample(110); returning.sample(170);
  returning.sample(90, true, 175, 200);
  assert.equal(returning.outcomes.length, 0);
  returning.sample(90); assert.equal(returning.outcomes.length, 0);
  returning.sample(90); assert.equal(returning.outcomes.length, 1);
  assert.equal(returning.outcomes[0].targetReached, false);
});

test("a 3.1 second hold yields one cue and a movement cycle but no qualifying rep", () => {
  const t = trace(); t.start(); t.cycle(3100);
  assert.equal(t.outcomes[0].holdMs, 3100);
  assert.equal(t.outcomes[0].movementComplete, true); assert.equal(t.outcomes[0].qualifying, false);
  assert.equal(t.state().movementCycles, 1); assert.equal(t.state().qualifyingReps, 0);
  assert.equal(t.codes.filter(c => c === "HOLD_TOO_SHORT").length, 1);
});

test("an exact-boundary hold qualifies and a long stationary hold never counts twice", () => {
  const exact = trace(); exact.start(); exact.cycle(5000); assert.equal(exact.state().qualifyingReps, 1);
  const long = trace(); long.start(); long.cycle(10000);
  assert.equal(long.state().qualifyingReps, 1); assert.equal(long.outcomes.length, 1);
});

test("pace feedback is disabled without a configured minimum and applies when configured", () => {
  const ordinary = trace(); ordinary.start(); ordinary.cycle();
  assert.equal(ordinary.codes.includes("MOVEMENT_TOO_FAST"), false);
  const paced = trace({ ...defaultEngineConfig("seated-knee-extension"), minimumMovementMs: 1000 });
  paced.start(); paced.cycle();
  assert.equal(paced.codes.filter(c => c === "MOVEMENT_TOO_FAST").length, 1);
  assert.equal(paced.outcomes[0].qualifying, false); assert.equal(paced.outcomes[0].movementComplete, true);
});

test("tracking loss, sample gaps and explicit pause invalidate a hold without short-hold judgment", () => {
  const t = trace(); t.start(); t.sample(120); t.hold(170, 1000); t.sample(null, false);
  assert.equal(t.outcomes.length, 1); assert.equal(t.outcomes[0].invalidated, true);
  assert.equal(t.state().qualifyingReps, 0); assert.equal(t.codes.includes("HOLD_TOO_SHORT"), false);
  t.start(); t.cycle(5000); assert.equal(t.state().qualifyingReps, 1);
  t.sample(120); t.hold(170, 1000); t.sample(170, true, 175, 500);
  assert.equal(t.outcomes.at(-1)?.reason, "sample_gap"); assert.equal(t.state().qualifyingReps, 1);
  const paused = invalidateExercise(t.state(), "user_pause", t.at() + 1);
  assert.equal(paused.feedbackCodes.includes("HOLD_TOO_SHORT"), false);
});

test("combined seated protocol requires the second flexion hold", () => {
  const config = defaultEngineConfig("seated-knee-flexion-extension");
  const t = trace(config); t.start(); t.cycle(5000);
  assert.equal(t.state().phase, "return_hold"); assert.equal(t.state().qualifyingReps, 0);
  for (let i = 0; i < 48; i++) t.sample(90);
  assert.equal(t.outcomes.length, 1); assert.equal(t.outcomes[0].flexionHoldMs, 5000); assert.equal(t.outcomes[0].qualifying, true);
  const short = trace(config); short.start(); short.cycle(5000); short.sample(110);
  assert.equal(short.outcomes[0].qualifying, false); assert.equal(short.outcomes[0].reason, "short_hold");
  assert.equal(short.state().phase, "await_start");
  short.hold(170, 5000); short.sample(90); short.sample(90); short.sample(90);
  assert.equal(short.state().qualifyingReps, 0);
});

test("straight-leg raise uses elevation and separately rejects knee-bending quality", () => {
  const config = defaultEngineConfig("straight-leg-raise");
  const good = trace(config); good.start(0); good.cycle(5000, 175); assert.equal(good.state().qualifyingReps, 1);
  const bent = trace(config); bent.start(0); bent.cycle(5000, 140);
  assert.equal(bent.outcomes[0].movementComplete, true); assert.equal(bent.outcomes[0].qualifying, false);
  assert.equal(bent.codes.filter(c => c === "KNEE_BENDING").length, 1);
  const missing = advanceExercise(createExerciseState(), { atMs: 0, valid: true, angleDeg: 0 }, config);
  assert.equal(missing.state.trackingAvailable, false);
});

test("static quads require explicit patient confirmation and never fabricate an angle", () => {
  const config = defaultEngineConfig("static-quads"), state = createExerciseState();
  assert.equal(advanceExercise(state, { atMs: 0, valid: true, angleDeg: 170 }, config).state.qualifyingReps, 0);
  assert.equal(completeGuidedHold(state, 5000, false, config).attempt, null);
  const result = completeGuidedHold(state, 5000, true, config);
  assert.equal(result.attempt?.rangeDegrees, null); assert.equal(result.state.qualifyingReps, 1);
});

test("timing reconciles 130 elapsed / 96 active with exclusive overlapping pause reasons", () => {
  let state = advanceTiming(createTimingState(0), 0, { trackingValid: true, ready: true });
  state = advanceTiming(state, 96000, { userPaused: true, trackingValid: false });
  state = advanceTiming(state, 110000, { userPaused: false, trackingValid: false });
  state = advanceTiming(state, 130000, { terminal: true, trackingValid: false });
  assert.deepEqual(timingSummary(state), { elapsedTimeMs: 130000, activeTimeMs: 96000, pausedTimeMs: 34000,
    userPausedTimeMs: 14000, trackingPausedTimeMs: 20000, otherPausedTimeMs: 0 });
  assert.equal(advanceTiming(state, 999999, { trackingValid: true }), state);
});

test("network readiness is other pause, duplicate/backward time is harmless and user pause wins", () => {
  let state = createTimingState(100);
  state = advanceTiming(state, 1100, { trackingValid: true, ready: true });
  assert.equal(state.otherPausedTimeMs, 1000);
  state = advanceTiming(state, 2100, { trackingValid: true, userPaused: true });
  state = advanceTiming(state, 3100, { trackingValid: false, userPaused: true });
  state = advanceTiming(state, 4100, { trackingValid: false, userPaused: false });
  assert.equal(state.userPausedTimeMs, 2000); assert.equal(state.activeTimeMs, 1000);
  assert.equal(advanceTiming(state, 0, { trackingValid: true }), state);
  assert.equal(state.elapsedTimeMs, state.activeTimeMs + state.pausedTimeMs);
});
