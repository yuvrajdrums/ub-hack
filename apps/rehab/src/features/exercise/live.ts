import { deriveCalibration } from "./calibration";
import { defaultEngineConfig, type EngineConfig, type ExerciseId } from "./engine";

// Live phone inference can take 300–500 ms. One consistent, bounded policy is
// used by calibration, filtering, counting and the last-delivery watchdog.
// Invalid landmarks still invalidate immediately; gaps above this bound reset.
export const LIVE_DETECTOR = Object.freeze({
  maximumSampleGapMs: 750,
  filterAlpha: 0.65,
  medianWindow: 1 as const,
});

export function liveFrameIsStale(lastReceivedAtMs:number,nowMs:number):boolean {
  return !Number.isFinite(lastReceivedAtMs) || nowMs-lastReceivedAtMs>LIVE_DETECTOR.maximumSampleGapMs;
}

export function createLiveEngineConfig(exerciseId:ExerciseId,options:{
  startAngleDeg:number;targetAngleDeg:number;holdMs:number;flexionHoldMs:number;
}):EngineConfig {
  const ranges=deriveCalibration(options.startAngleDeg,options.targetAngleDeg);
  if(!ranges && exerciseId!=="static-quads")throw new Error("Capture separated start and target references first.");
  const config:EngineConfig={...defaultEngineConfig(exerciseId),
    holdMs:options.holdMs,flexionHoldMs:options.flexionHoldMs,
    maximumSampleGapMs:LIVE_DETECTOR.maximumSampleGapMs,
    ...(ranges?{startRangeDeg:ranges.startRangeDeg,targetRangeDeg:ranges.targetRangeDeg}:{}),
  };
  // deriveCalibration applies direction-aware -15°/+30° target tolerances,
  // with a physical 0°–180° cap and a non-overlapping start region.
  return config;
}
