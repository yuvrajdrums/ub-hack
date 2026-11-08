import type { CvExerciseConfig, CvExerciseId, CvFeedbackCode } from "../../../../../packages/contracts/rehab-cv";

export const CV_CONFIGS: CvExerciseConfig[] = [
  {exerciseId:"seated-knee-extension",label:"Seated knee extension",description:"Side view. Demonstration references only: straighten, hold, then return.",configVersion:1,targetReps:10,targetHoldMs:5000,flexionHoldMs:0,startAngleDeg:90,targetAngleDeg:165,configurationMode:"synthetic_demo",cameraView:"side"},
  {exerciseId:"seated-knee-flexion-extension",label:"Seated flexion and extension",description:"Side view. Hold both the straightened and bent reference positions.",configVersion:1,targetReps:10,targetHoldMs:5000,flexionHoldMs:5000,startAngleDeg:90,targetAngleDeg:165,configurationMode:"synthetic_demo",cameraView:"side"},
  {exerciseId:"straight-leg-raise",label:"Straight-leg raise",description:"Side view with torso visible. Follow the calibrated thigh-elevation reference; exact lift distance is not measured.",configVersion:1,targetReps:10,targetHoldMs:5000,flexionHoldMs:0,startAngleDeg:0,targetAngleDeg:30,configurationMode:"synthetic_demo",cameraView:"side"},
  {exerciseId:"static-quads",label:"Guided static quads",description:"Guided hold with your confirmation. The camera cannot verify muscle contraction.",configVersion:1,targetReps:10,targetHoldMs:5000,flexionHoldMs:0,startAngleDeg:180,targetAngleDeg:180,configurationMode:"synthetic_demo",cameraView:"side"},
];
export function configFor(id:CvExerciseId) { return structuredClone(CV_CONFIGS.find(v=>v.exerciseId===id)!); }
export function phraseVariants(code:CvFeedbackCode,config:CvExerciseConfig,reps:number):Record<string,string> {
  const seconds = config.targetHoldMs / 1000;
  const variants:Record<CvFeedbackCode,[string,string]> = {
    HOLD_TOO_SHORT:[`Try holding the position for the full ${seconds} seconds shown in this demonstration.`,`On the next movement, aim for the ${seconds}-second demonstration hold.`],
    EXTENSION_INCOMPLETE:["Follow the calibrated target shown for this demonstration without forcing the movement.","Try the comfortable target position you calibrated for this demonstration."],
    MOVEMENT_TOO_FAST:["Try following the configured demonstration pace.","Take your time and follow the pace shown for this demonstration."],
    KNEE_BENDING:["Try keeping your knee within the calibrated straight-leg position.","Keep an eye on your knee position as you follow this demonstration."],
    TRACKING_LOST:["I cannot see your leg clearly. Please adjust the camera.","Please reposition so the camera can see your working leg."],
    TRACKING_RESTORED:["Tracking is ready again.","Your working leg is visible again."],
    REP_COMPLETED:[`You have completed ${reps} qualifying repetition${reps===1?"":"s"}.`,`${reps} repetition${reps===1?" has":"s have"} met the demonstration targets.`],
    SET_COMPLETED:["Your set is saved and its summary is ready.","Your completed demonstration set has been saved."],
  };
  return {primary:variants[code][0],gentle:variants[code][1]};
}

