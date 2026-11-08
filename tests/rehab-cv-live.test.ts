import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_DETECTOR, createLiveEngineConfig, liveFrameIsStale,
  advanceExercise, createExerciseState, defaultEngineConfig,
  createAngleFilter, filterAngle, evaluateCalibration, measurePose,
  type EngineConfig, type AttemptOutcome, type FeedbackCode, type PoseLandmark,
} from "../apps/rehab/src/features/exercise";

const liveConfig = () => createLiveEngineConfig("seated-knee-extension", {
  startAngleDeg: 90, targetAngleDeg: 170, holdMs: 5000, flexionHoldMs: 0,
});

/** Synthetic image landmarks with a known pixel-space knee angle, not a fixture shortcut around geometry. */
function kneePose(angleDeg: number, width = 1280, height = 720): PoseLandmark[] {
  const points: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: .1, y: .1, visibility: 0 }));
  const normalized = (x: number, y: number): PoseLandmark => ({ x: x / width, y: y / height, visibility: 1, presence: 1 });
  points[11] = normalized(400, 100);
  points[23] = normalized(400, 200);
  points[25] = normalized(500, 300);
  const direction = (-135 + angleDeg) * Math.PI / 180;
  points[27] = normalized(500 + 140 * Math.cos(direction), 300 + 140 * Math.sin(direction));
  return points;
}

function liveTrace(options: { config?: EngineConfig; cadenceMs?: number; filtered?: boolean; landmarks?: boolean } = {}) {
  const config = options.config ?? liveConfig();
  const cadence = options.cadenceMs ?? 100;
  let atMs = -cadence;
  let state = createExerciseState();
  let filter = createAngleFilter();
  const outcomes: AttemptOutcome[] = [];
  const codes: FeedbackCode[] = [];
  const sample = (rawAngleDeg: number, valid = true, deltaMs = cadence) => {
    atMs += deltaMs;
    let measuredAngle: number | null = rawAngleDeg;
    let kneeAngle: number | null = 175;
    if (options.landmarks) {
      const points = kneePose(rawAngleDeg);
      if (!valid) points[27].visibility = .1;
      const measurement = measurePose(points, "left", 1280, 720, { personCount: 1 });
      valid = measurement.valid;
      measuredAngle = measurement.kneeAngleDeg;
      kneeAngle = measurement.kneeAngleDeg;
    }
    if (options.filtered !== false) {
      filter = filterAngle(filter, valid ? measuredAngle : null, atMs, {
        alpha: LIVE_DETECTOR.filterAlpha,
        medianWindow: LIVE_DETECTOR.medianWindow,
        maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs,
      });
      measuredAngle = filter.value;
    }
    const result = advanceExercise(state, { atMs, angleDeg: measuredAngle, kneeAngleDeg: kneeAngle, valid }, config);
    state = result.state;
    if (result.attempt) outcomes.push(result.attempt);
    codes.push(...result.feedbackCodes);
    return result;
  };
  const constant = (angle: number, durationMs: number) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += cadence) sample(angle);
  };
  const ramp = (start: number, target: number, durationMs: number) => {
    for (let elapsed = cadence; elapsed <= durationMs; elapsed += cadence)
      sample(start + (target - start) * elapsed / durationMs);
  };
  const cycle = (restMs = 200, peakDeg = 170) => {
    ramp(90, peakDeg, 1000);
    constant(peakDeg, 6000);
    ramp(peakDeg, 90, 1000);
    constant(90, restMs);
  };
  return { sample, constant, ramp, cycle, outcomes, codes, state: () => state };
}

test("live filtering counts three natural cycles with rapid 200ms returns instead of sticking in returning", () => {
  const t = liveTrace();
  t.constant(90, 1000);
  t.cycle(); t.cycle(); t.cycle();
  assert.equal(t.state().movementCycles, 3);
  assert.equal(t.state().qualifyingReps, 3);
  assert.equal(t.outcomes.length, 3);
  assert.ok(t.outcomes.every(attempt => attempt.qualifying && !attempt.invalidated));
});

for (const cadenceMs of [300, 500]) {
  test(`live counting tolerates valid ${cadenceMs}ms inference cadence without manufacturing tracking loss`, () => {
    const t = liveTrace({ cadenceMs });
    t.constant(90, 1500);
    t.cycle(2000); t.cycle(2000);
    assert.equal(t.state().movementCycles, 2);
    assert.equal(t.state().qualifyingReps, 2);
    assert.equal(t.outcomes.filter(attempt => attempt.invalidated).length, 0);
    assert.equal(t.codes.includes("TRACKING_LOST"), false);
  });
}

test("slow valid cadence does not change the strict legacy fixture policy", () => {
  const t = liveTrace({ config: defaultEngineConfig("seated-knee-extension"), cadenceMs: 300, filtered: false });
  t.constant(90, 1500);
  t.cycle(2000);
  assert.equal(t.state().movementCycles, 0);
  assert.equal(t.state().phase, "await_start");
});

test("an actual invalid camera observation still aborts a partial hold and never becomes a short-hold judgment", () => {
  const t = liveTrace({ cadenceMs: 300 });
  t.constant(90, 1500);
  t.ramp(90, 170, 1200);
  t.constant(170, 1800);
  assert.equal(t.state().phase, "holding");
  const lost = t.sample(170, false);
  assert.equal(lost.attempt?.invalidated, true);
  assert.equal(lost.attempt?.reason, "tracking_lost");
  assert.equal(t.state().qualifyingReps, 0);
  assert.equal(t.codes.includes("HOLD_TOO_SHORT"), false);
  t.constant(170, 6000);
  t.constant(90, 2000);
  assert.equal(t.state().movementCycles, 0, "an interrupted fragment cannot be resumed as a complete cycle");
  t.cycle(2000);
  assert.equal(t.state().qualifyingReps, 1);
});

test("a genuine gap beyond the live budget aborts instead of completing an unseen hold", () => {
  const t = liveTrace();
  t.constant(90, 1000);
  t.ramp(90, 170, 1000);
  t.constant(170, 1500);
  const lost = t.sample(170, true, LIVE_DETECTOR.maximumSampleGapMs + 1);
  assert.equal(lost.attempt?.invalidated, true);
  assert.equal(lost.attempt?.reason, "sample_gap");
  assert.equal(t.state().qualifyingReps, 0);
  assert.equal(t.codes.includes("HOLD_TOO_SHORT"), false);
});

test("watchdog freshness is measured from receipt so a 350ms inference is not stale immediately", () => {
  const capturedAtMs = 1000;
  const receivedAtMs = capturedAtMs + 350;
  assert.equal(liveFrameIsStale(receivedAtMs, receivedAtMs), false);
  assert.equal(liveFrameIsStale(receivedAtMs, receivedAtMs + 500), false);
  assert.equal(liveFrameIsStale(receivedAtMs, receivedAtMs + 751), true);
});

test("live seated target remains attainable when the observed leg extends beyond its captured minimum reference", () => {
  const t = liveTrace();
  t.constant(90, 1000);
  t.cycle(400, 179);
  assert.equal(t.state().qualifyingReps, 1);
  assert.equal(t.outcomes[0].reason, null);
});

test("target entry remains strict while bounded release jitter does not split a qualifying hold", () => {
  const t = liveTrace({ filtered: false });
  t.constant(90, 1000);
  t.sample(110); t.sample(140);
  t.constant(163, 1000); // Just below strict entry [164,180].
  assert.equal(t.state().phase, "outbound");
  assert.equal(t.state().activeAttempt?.targetReached, false);
  t.constant(170, 2000);
  assert.equal(t.state().phase, "holding");
  t.sample(163); // Outside strict target, but within the 3° release hysteresis [161,180].
  assert.equal(t.state().phase, "holding");
  assert.equal(t.codes.includes("HOLD_TOO_SHORT"), false);
  t.constant(170, 4000);
  t.sample(135); t.constant(90, 400);
  assert.equal(t.state().qualifyingReps, 1);
  assert.equal(t.outcomes.length, 1);
});

test("a true target release still ends a short hold once and cannot combine later fragments", () => {
  const t = liveTrace({ filtered: false });
  t.constant(90, 1000);
  t.sample(110); t.sample(140);
  t.constant(170, 1500);
  t.sample(160); // Below release threshold, unlike 163° jitter.
  assert.equal(t.state().phase, "returning");
  assert.equal(t.codes.filter(code => code === "HOLD_TOO_SHORT").length, 1);
  t.constant(170, 6000);
  t.sample(135); t.constant(90, 400);
  assert.equal(t.outcomes.length, 1);
  assert.equal(t.outcomes[0].qualifying, false);
  assert.ok(t.outcomes[0].holdMs < 5000);
  assert.equal(t.codes.filter(code => code === "HOLD_TOO_SHORT").length, 1);
});

test("stable one-second calibration accepts slow live observations using the same gap policy", () => {
  const samples = [0, 500, 1000].map(atMs => ({ atMs, angleDeg: 90, valid: true }));
  assert.equal(evaluateCalibration(samples).ready, false, "strict legacy calibration still rejects sparse samples");
  const result = evaluateCalibration(samples, { maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs });
  assert.equal(result.ready, true);
  assert.equal(result.angleDeg, 90);
  const interrupted = evaluateCalibration([...samples, { atMs: 1500, angleDeg: 90, valid: false }], {
    maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs,
  });
  assert.equal(interrupted.ready, false);
});

test("pixel-space pose landmarks pass through measurement and live filtering into real cycle semantics", () => {
  const t = liveTrace({ landmarks: true });
  t.constant(90, 1000);
  t.cycle(); t.cycle(); t.cycle();
  assert.equal(t.state().movementCycles, 3);
  assert.equal(t.state().qualifyingReps, 3);
  assert.equal(t.outcomes.length, 3);
  assert.ok(t.outcomes.every(attempt => attempt.rangeDegrees !== null && attempt.rangeDegrees > 60));
  assert.equal(t.codes.includes("TRACKING_LOST"), false);
});
