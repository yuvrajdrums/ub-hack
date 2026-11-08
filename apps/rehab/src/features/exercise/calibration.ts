export interface CalibrationSample { atMs: number; angleDeg: number; valid: boolean }
export interface CalibrationResult {
  ready: boolean;
  angleDeg: number | null;
  durationMs: number;
  spreadDeg: number;
  reason: "collecting" | "unstable" | "tracking_lost" | "ready";
}

export function evaluateCalibration(samples: readonly CalibrationSample[], options: {
  stableMs?: number; maximumSpreadDeg?: number; maximumSampleGapMs?: number;
} = {}): CalibrationResult {
  const stableMs = options.stableMs ?? 1000;
  if (!samples.length) return { ready: false, angleDeg: null, durationMs: 0, spreadDeg: 0, reason: "collecting" };
  const last = samples[samples.length - 1];
  if (!last.valid || !Number.isFinite(last.angleDeg) || !Number.isFinite(last.atMs))
    return { ready: false, angleDeg: null, durationMs: 0, spreadDeg: 0, reason: "tracking_lost" };
  const recent: CalibrationSample[] = [];
  let next = last.atMs;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (!sample.valid || !Number.isFinite(sample.angleDeg) || !Number.isFinite(sample.atMs) ||
      sample.atMs > next || next - sample.atMs > (options.maximumSampleGapMs ?? 250)) break;
    recent.unshift(sample);
    next = sample.atMs;
    if (last.atMs - sample.atMs >= stableMs) break;
  }
  const durationMs = last.atMs - recent[0].atMs;
  const values = recent.map(s => s.angleDeg).sort((a, b) => a - b);
  const spreadDeg = values[values.length - 1] - values[0];
  const stable = spreadDeg <= (options.maximumSpreadDeg ?? 5);
  const ready = stable && recent.length >= 3 && durationMs >= stableMs;
  return { ready, angleDeg: ready ? values[Math.floor(values.length / 2)] : null, durationMs, spreadDeg,
    reason: !stable ? "unstable" : ready ? "ready" : "collecting" };
}

export interface CalibrationRanges {
  startAngleDeg: number;
  targetAngleDeg: number;
  startRangeDeg: [number, number];
  targetRangeDeg: [number, number];
}

/** Demonstration references only. Does not prescribe a clinical range. */
export function deriveCalibration(startAngleDeg: number, targetAngleDeg: number,
  options: { toleranceDeg?: number; targetApproachToleranceDeg?: number; targetPastToleranceDeg?: number; minimumSeparationDeg?: number } = {}): CalibrationRanges | null {
  const tolerance = options.toleranceDeg ?? 6;
  const approach = options.targetApproachToleranceDeg ?? 15;
  const past = options.targetPastToleranceDeg ?? 30;
  const separation = options.minimumSeparationDeg ?? 15;
  if (![startAngleDeg, targetAngleDeg, tolerance, approach, past, separation].every(Number.isFinite) || tolerance <= 0 || approach <= 0 || past <= 0 || separation <= 0 ||
    startAngleDeg < 0 || startAngleDeg > 180 || targetAngleDeg < 0 || targetAngleDeg > 180 ||
    Math.abs(targetAngleDeg - startAngleDeg) < Math.max(separation, tolerance * 2 + 1)) return null;
  const range = (value: number): [number, number] => [Math.max(0, value - tolerance), Math.min(180, value + tolerance)];
  const startRangeDeg = range(startAngleDeg);
  // Leave more than the engine's 3° release hysteresis between the two regions.
  const targetRangeDeg: [number, number] = targetAngleDeg > startAngleDeg
    ? [Math.max(0, targetAngleDeg - approach, startRangeDeg[1] + 4), Math.min(180, targetAngleDeg + past)]
    : [Math.max(0, targetAngleDeg - past), Math.min(180, targetAngleDeg + approach, startRangeDeg[0] - 4)];
  if (targetRangeDeg[0] >= targetRangeDeg[1] || targetAngleDeg < targetRangeDeg[0] || targetAngleDeg > targetRangeDeg[1]) return null;
  return { startAngleDeg, targetAngleDeg, startRangeDeg, targetRangeDeg };
}
