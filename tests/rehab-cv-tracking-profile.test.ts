import test from "node:test";
import assert from "node:assert/strict";
import { continuityAnchor, exerciseTrackingProfile } from "../apps/rehab/src/features/camera/tracking-profile";
import { measurePose, type PoseLandmark } from "../apps/rehab/src/features/exercise/geometry";

function legOnly(side: "left" | "right" = "left"): PoseLandmark[] {
  const points: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0, presence: 0 }));
  const offset = side === "left" ? 0 : 1;
  points[23 + offset] = { x: 0.5, y: 0.3, visibility: 0.99, presence: 0.99 };
  points[25 + offset] = { x: 0.5, y: 0.5, visibility: 0.99, presence: 0.99 };
  points[27 + offset] = { x: 0.65, y: 0.5, visibility: 0.99, presence: 0.99 };
  return points;
}

test("both seated protocols measure the selected leg without upper-body or opposite-leg landmarks", () => {
  for (const id of ["seated-knee-extension", "seated-knee-flexion-extension"] as const) {
    const profile = exerciseTrackingProfile(id, "left");
    assert.deepEqual(profile.requiredJoints, [23, 25, 27]);
    assert.deepEqual(profile.connections, [[23, 25], [25, 27]]);
    assert.equal(profile.requireTorso, false);
    assert.equal(profile.requiresPose, true);
    assert.match(profile.framingInstruction, /upper body and opposite leg are not required/);
    const measurement = measurePose(legOnly(), "left", 640, 480, { ...profile, personCount: 1 });
    assert.equal(measurement.valid, true);
    assert.equal(measurement.kneeAngleDeg, 90);
    assert.equal(measurement.elevationDeg, null);
  }
});

test("straight-leg raise requires the selected shoulder for its torso-relative measurement", () => {
  const profile = exerciseTrackingProfile("straight-leg-raise", "left");
  assert.deepEqual(profile.requiredJoints, [23, 25, 27, 11]);
  assert.deepEqual(profile.connections, [[11, 23], [23, 25], [25, 27]]);
  assert.equal(profile.requireTorso, true);
  const missing = measurePose(legOnly(), "left", 640, 480, { ...profile, personCount: 1 });
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, "torso_unavailable");
  const visible = legOnly();
  visible[11] = { x: 0.5, y: 0.1, visibility: 0.99, presence: 0.99 };
  assert.equal(measurePose(visible, "left", 640, 480, { ...profile, personCount: 1 }).valid, true);
});

test("right-side profiles reference only the selected right joints", () => {
  const seated = exerciseTrackingProfile("seated-knee-extension", "right");
  assert.deepEqual(seated.requiredJoints, [24, 26, 28]);
  assert.deepEqual(seated.connections, [[24, 26], [26, 28]]);
  assert.equal(measurePose(legOnly("right"), "right", 640, 480, { ...seated, personCount: 1 }).valid, true);
  const slr = exerciseTrackingProfile("straight-leg-raise", "right");
  assert.deepEqual(slr.requiredJoints, [24, 26, 28, 12]);
  assert.deepEqual(slr.connections, [[12, 24], [24, 26], [26, 28]]);
});

test("profiles preserve multiple-pose ambiguity detection and disable unused segmentation masks", () => {
  for (const id of ["seated-knee-extension", "seated-knee-flexion-extension", "straight-leg-raise", "static-quads"] as const) {
    const profile = exerciseTrackingProfile(id, "left");
    assert.deepEqual(profile.modelOptions, {
      numPoses: 2,
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      outputSegmentationMasks: false,
    });
    assert.equal(profile.minimumVisibility, 0.6);
    assert.equal(profile.minimumPresence, 0.6);
  }
});

test("continuity needs only selected hip/knee quality, not shoulders, other leg or ankle", () => {
  const points = legOnly();
  points[27] = { x: 0, y: 0, visibility: 0, presence: 0 };
  const profile = exerciseTrackingProfile("seated-knee-extension", "left");
  const anchor = continuityAnchor(points, profile);
  assert.ok(anchor);
  assert.equal(anchor.x, 0.5);
  assert.equal(anchor.y, 0.3);
  assert.ok(Math.abs(anchor.scale - 0.2) < 1e-12);
  assert.equal(continuityAnchor(points, exerciseTrackingProfile("seated-knee-extension", "right")), null);
  assert.ok(continuityAnchor(points, exerciseTrackingProfile("straight-leg-raise", "left")));
});

test("continuity rejects invalid selected joints and degenerate geometry", () => {
  const profile = exerciseTrackingProfile("seated-knee-extension", "left");
  const lowVisibility = legOnly(); lowVisibility[23].visibility = 0.5;
  assert.equal(continuityAnchor(lowVisibility, profile), null);
  const lowPresence = legOnly(); lowPresence[25].presence = 0.5;
  assert.equal(continuityAnchor(lowPresence, profile), null);
  const outOfFrame = legOnly(); outOfFrame[23].x = -0.1;
  assert.equal(continuityAnchor(outOfFrame, profile), null);
  const invalid = legOnly(); invalid[25].y = NaN;
  assert.equal(continuityAnchor(invalid, profile), null);
  const zeroLength = legOnly(); zeroLength[25] = { ...zeroLength[23] };
  assert.equal(continuityAnchor(zeroLength, profile), null);
});

test("guided static quads has no pose prerequisites or camera connections", () => {
  const profile = exerciseTrackingProfile("static-quads", "left");
  assert.equal(profile.requiresPose, false);
  assert.equal(profile.requireTorso, false);
  assert.deepEqual(profile.requiredJoints, []);
  assert.deepEqual(profile.connections, []);
  assert.equal(continuityAnchor(legOnly(), profile), null);
  assert.match(profile.framingInstruction, /No camera tracking is required/);
});
