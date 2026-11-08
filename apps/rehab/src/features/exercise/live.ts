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
  // A seated extension reference is a comfortable minimum, not a narrow band
  // that rejects a fully straight knee. 180° is the geometry's upper bound.
  if(ranges && (exerciseId==="seated-knee-extension" || exerciseId==="seated-knee-flexion-extension"))
    config.targetRangeDeg=[ranges.targetRangeDeg[0],180];
  return config;
}
