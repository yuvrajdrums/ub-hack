export type Side = "left" | "right";
export interface Point2 { x: number; y: number }
export interface Point3 extends Point2 { z: number }
export interface PoseLandmark extends Point2 {
  z?: number;
  visibility?: number;
  presence?: number;
}

/** Internal angle at B, in degrees. All points must use the same units. */
export function angleAtJoint(a: Point2 | Point3, b: Point2 | Point3, c: Point2 | Point3): number | null {
  const dimensions = "z" in a && "z" in b && "z" in c ? 3 : 2;
  const u = [a.x - b.x, a.y - b.y, dimensions === 3 ? (a as Point3).z - (b as Point3).z : 0];
  const v = [c.x - b.x, c.y - b.y, dimensions === 3 ? (c as Point3).z - (b as Point3).z : 0];
  if (![...u, ...v].every(Number.isFinite)) return null;
  const denominator = Math.hypot(...u) * Math.hypot(...v);
  if (denominator < 1e-8 || !Number.isFinite(denominator)) return null;
  const dot = u.reduce((sum, x, i) => sum + x * v[i], 0);
  return Math.acos(Math.max(-1, Math.min(1, dot / denominator))) * 180 / Math.PI;
}

export function imageAngle(a: Point2, b: Point2, c: Point2, width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const pixel = (p: Point2) => ({ x: p.x * width, y: p.y * height });
  return angleAtJoint(pixel(a), pixel(b), pixel(c));
}

export interface PoseMeasurement {
  valid: boolean;
  kneeAngleDeg: number | null;
  elevationDeg: number | null;
  confidence: number;
  reason: string | null;
}
export interface MeasurementOptions {
  minimumVisibility?: number;
  minimumPresence?: number;
  requireTorso?: boolean;
  personCount?: number;
}

export function measurePose(
  landmarks: readonly PoseLandmark[], side: Side, width: number, height: number,
  options: MeasurementOptions = {},
): PoseMeasurement {
  const unavailable = (reason: string, confidence = 0): PoseMeasurement =>
    ({ valid: false, kneeAngleDeg: null, elevationDeg: null, confidence, reason });
  if (options.personCount !== undefined && options.personCount !== 1) return unavailable("person_ambiguous");
  const offset = side === "left" ? 0 : 1;
  const hip = landmarks[23 + offset], knee = landmarks[25 + offset], ankle = landmarks[27 + offset];
  const shoulder = landmarks[11 + offset];
  const minVisibility = options.minimumVisibility ?? 0.6;
  const minPresence = options.minimumPresence ?? 0.6;
  const available = (p: PoseLandmark | undefined): p is PoseLandmark => !!p &&
    Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
    Number.isFinite(p.visibility) && p.visibility! >= minVisibility &&
    (p.presence === undefined || (Number.isFinite(p.presence) && p.presence >= minPresence));
  const required = options.requireTorso ? [hip, knee, ankle, shoulder] : [hip, knee, ankle];
  const confidence = required.reduce((value, p) => Math.min(value, p?.visibility ?? 0, p?.presence ?? 1), 1);
  if (!available(hip) || !available(knee) || !available(ankle)) return unavailable("required_joint_unavailable", confidence);
  if (options.requireTorso && !available(shoulder)) return unavailable("torso_unavailable", confidence);
  const kneeAngleDeg = imageAngle(hip, knee, ankle, width, height);
  if (kneeAngleDeg === null) return unavailable("degenerate_geometry", confidence);
  const hipAngle = available(shoulder) ? imageAngle(shoulder, hip, knee, width, height) : null;
  // Relative to the estimated torso: a collinear supine torso/thigh is 0° elevation.
  const elevationDeg = hipAngle === null ? null : 180 - hipAngle;
  if (options.requireTorso && elevationDeg === null) return unavailable("degenerate_torso", confidence);
  return { valid: true, kneeAngleDeg, elevationDeg, confidence, reason: null };
}

export interface AngleFilterState { window: number[]; value: number | null; atMs: number | null }
export const createAngleFilter = (): AngleFilterState => ({ window: [], value: null, atMs: null });
/** Causal three-sample median + EMA; invalid/gapped data resets rather than bridges a trajectory. */
export function filterAngle(state: AngleFilterState, angle: number | null, atMs: number,
  options: { alpha?: number; maximumSampleGapMs?: number; medianWindow?:1|3 } = {}): AngleFilterState {
  if (!Number.isFinite(atMs) || angle === null || !Number.isFinite(angle)) return createAngleFilter();
  if (state.atMs !== null && atMs <= state.atMs) return state;
  const reset = state.atMs === null || atMs - state.atMs > (options.maximumSampleGapMs ?? 250);
  const window = [...(reset ? [] : state.window), angle].slice(-(options.medianWindow??3));
  const ordered = [...window].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  const alpha = Math.max(0, Math.min(1, options.alpha ?? 0.35));
  return { window, value: reset || state.value === null ? median : alpha * median + (1 - alpha) * state.value, atMs };
}
