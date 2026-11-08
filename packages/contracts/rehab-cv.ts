import { z } from "zod";

export const CV_FEATURE_VERSION = "rehab-cv/1.0" as const;
export const CvExerciseIdSchema = z.enum(["seated-knee-extension", "seated-knee-flexion-extension", "straight-leg-raise", "static-quads"]);
export const CvEvidenceSchema = z.enum(["camera_estimated", "simulated", "patient_reported", "unavailable"]);
export const CvFeedbackCodeSchema = z.enum(["HOLD_TOO_SHORT", "EXTENSION_INCOMPLETE", "MOVEMENT_TOO_FAST", "KNEE_BENDING", "TRACKING_LOST", "TRACKING_RESTORED", "REP_COMPLETED", "SET_COMPLETED"]);
export type CvExerciseId = z.infer<typeof CvExerciseIdSchema>;
export type CvEvidence = z.infer<typeof CvEvidenceSchema>;
export type CvFeedbackCode = z.infer<typeof CvFeedbackCodeSchema>;
const id = z.string().uuid();
const duration = z.number().finite().min(0).max(43_200_000);
const angle = z.number().finite().min(0).max(180);
const landmarkScalar=z.number().finite().min(-5).max(5);
export const CvRepAnalysisSchema=z.object({
  attemptedCycles:z.number().int().min(0).max(100000),
  movementCycles:z.number().int().min(0).max(100000),
  completedReps:z.number().int().min(0).max(100000),
  shortHolds:z.number().int().min(0).max(100000),
  phase:z.enum(["await_start","armed","outbound","holding","returning","return_hold","uncertain"]),
  currentHoldMs:duration,
  confidence:z.number().finite().min(0).max(1),
  cue:z.string().max(180),
  workingMemory:z.string().max(1200),
  rangeDegrees:angle.nullable(),
}).strict().superRefine((v,ctx)=>{
  if(v.movementCycles>v.attemptedCycles)ctx.addIssue({code:"custom",message:"Completed movements cannot exceed attempted cycles"});
  if(v.completedReps>v.movementCycles)ctx.addIssue({code:"custom",message:"Qualifying repetitions cannot exceed completed movements"});
  if(v.shortHolds>v.attemptedCycles)ctx.addIssue({code:"custom",message:"Short holds cannot exceed attempted cycles"});
});
export type CvRepAnalysis=z.infer<typeof CvRepAnalysisSchema>;
export const CvPoseFrameSchema=z.object({
  offsetMs:duration,
  personCount:z.number().int().min(0).max(10),
  // Compact tuples preserve each model landmark as [x, y, z, visibility, presence].
  landmarks:z.array(z.tuple([landmarkScalar,landmarkScalar,landmarkScalar,landmarkScalar.nullable(),landmarkScalar.nullable()])).length(33),
}).strict();
export const CvRepAnalysisInputSchema=z.object({
  requestId:id,
  batchSequence:z.number().int().min(1).max(100000),
  frames:z.array(CvPoseFrameSchema).min(1).max(8),
}).strict();
export type CvRepAnalysisInput=z.infer<typeof CvRepAnalysisInputSchema>;
export interface CvRepAnalysisResponse { batchSequence:number; analysis:CvRepAnalysis; session:CvSession }
export const CvCalibrationAssistInputSchema=z.object({
  requestId:id,
  exerciseId:CvExerciseIdSchema.exclude(["static-quads"]),
  side:z.enum(["left","right"]),
  requestedPosition:z.enum(["rest","comfortable_target","auto"]),
  previous:z.object({
    detectedPosition:z.enum(["rest","comfortable_target","transition","uncertain"]),
    workingMemory:z.string().max(1200),
    startAngleDeg:angle.nullable(),
    targetAngleDeg:angle.nullable(),
  }).strict().nullable().optional(),
  frames:z.array(CvPoseFrameSchema).min(3).max(8).superRefine((frames,ctx)=>{
    for(let i=1;i<frames.length;i++)if(frames[i].offsetMs<=frames[i-1].offsetMs)ctx.addIssue({code:"custom",message:"Calibration frames must be timestamped in increasing order",path:[i,"offsetMs"]});
    if(frames.length>1 && frames.at(-1)!.offsetMs-frames[0].offsetMs<500)ctx.addIssue({code:"custom",message:"Calibration evidence must span at least half a second",path:["frames"]});
  }),
}).strict();
export type CvCalibrationAssistInput=z.infer<typeof CvCalibrationAssistInputSchema>;
export const CvCalibrationAssistResponseSchema=z.object({
  detectedPosition:z.enum(["rest","comfortable_target","transition","uncertain"]),
  accepted:z.boolean(),
  angleDeg:angle.nullable(),
  confidence:z.number().finite().min(0).max(1),
  stable:z.boolean(),
  cue:z.string().max(180),
  workingMemory:z.string().max(1200),
}).strict();
export type CvCalibrationAssistResponse=z.infer<typeof CvCalibrationAssistResponseSchema>;
export const CvCalibrationSchema = z.object({ startAngleDeg: angle, targetAngleDeg: angle }).strict();
export type CvCalibration = z.infer<typeof CvCalibrationSchema>;

export interface CvExerciseConfig {
  exerciseId: CvExerciseId;
  label: string;
  description: string;
  configVersion: number;
  targetReps: number;
  targetHoldMs: number;
  flexionHoldMs: number;
  startAngleDeg: number;
  targetAngleDeg: number;
  configurationMode: "synthetic_demo";
  cameraView: "side";
}
export interface CvContext {
  featureVersion: typeof CV_FEATURE_VERSION;
  mode: "standalone_demo";
  csrfToken: string;
  exercises: CvExerciseConfig[];
  gemini: { mode: "off" | "controlled"; configured: boolean; model: string | null };
}
export const CvStartSchema = z.object({
  requestId: id,
  exerciseId: CvExerciseIdSchema,
  side: z.enum(["left", "right"]),
  startedAtUtc: z.string().datetime(),
  evidence: CvEvidenceSchema,
  calibration: CvCalibrationSchema.optional(),
}).strict();
export type CvStartInput = z.infer<typeof CvStartSchema>;

export const CvTimingSchema = z.object({
  elapsedTimeMs: duration,
  activeTimeMs: duration,
  pausedTimeMs: duration,
  userPausedTimeMs: duration,
  trackingPausedTimeMs: duration,
  otherPausedTimeMs: duration,
  guidedTimerMs: duration.optional(),
}).strict().superRefine((v,ctx) => {
  if (Math.abs(v.elapsedTimeMs-v.activeTimeMs-v.pausedTimeMs)>1 || Math.abs(v.pausedTimeMs-v.userPausedTimeMs-v.trackingPausedTimeMs-v.otherPausedTimeMs)>1)
    ctx.addIssue({code:"custom",message:"Timing buckets must reconcile"});
});
export type CvTiming = z.infer<typeof CvTimingSchema>;
const candidateBase = {eventId:id,sequence:z.number().int().min(1).max(100000),observedOffsetMs:duration};
export const CvAttemptSchema = z.object({
  ...candidateBase,
  type:z.literal("attempt_finalized"),
  attemptId:id,
  movementComplete:z.boolean(),
  qualifying:z.boolean(),
  holdMs:duration,
  flexionHoldMs:duration.optional(),
  targetReached:z.boolean(),
  rangeDegrees:angle.nullable(),
  kneeBent:z.boolean().optional(),
  invalidated:z.boolean().optional(),
  reason:z.enum(["tracking_lost","user_pause","short_hold","incomplete_target","knee_bending","target_overshoot"]).optional(),
}).strict();
export const CvEventCandidateSchema = z.discriminatedUnion("type",[
  CvAttemptSchema,
  z.object({...candidateBase,type:z.literal("tracking_changed"),valid:z.boolean()}).strict(),
  z.object({...candidateBase,type:z.literal("session_state_changed"),action:z.enum(["pause","resume","interrupt"])}).strict(),
  z.object({...candidateBase,type:z.literal("checkpoint"),timing:CvTimingSchema}).strict(),
]);
export type CvEventCandidate = z.infer<typeof CvEventCandidateSchema>;
export type CvAttemptEvent = z.infer<typeof CvAttemptSchema>;
export const CvEventInputSchema = z.object({requestId:id,event:CvEventCandidateSchema}).strict();
export type CvEventInput = z.infer<typeof CvEventInputSchema>;
export const CvGenerateSchema = z.object({requestId:id}).strict();
export const CvFinishSchema = z.object({
  requestId:id,
  lastMeasurementSequence:z.number().int().nonnegative().max(100000),
  report:z.object({
    observedEndedAtUtc:z.string().datetime(),
    completionStatus:z.enum(["completed","incomplete","cancelled","interrupted"]),
    terminationReason:z.enum(["finished","patient_stopped","discomfort_reported","tracking_lost","backgrounded","model_error","recovered_crash"]),
    timing:CvTimingSchema,
    timingQuality:z.enum(["complete","partial"]).default("complete"),
  }).strict(),
}).strict();
export type CvFinishInput = z.infer<typeof CvFinishSchema>;

export interface CvFeedbackText {
  featureVersion:typeof CV_FEATURE_VERSION;
  eventId:string;
  sessionId:string;
  feedbackCode:CvFeedbackCode;
  attemptId:string|null;
  sessionControlRevision:number;
  textRevision:number;
  text:string;
  textSource:"gemini_selected_approved_variant"|"deterministic_fallback";
  phraseId:string;
  templateVersion:string;
  generatedAtUtc:string;
  expiresAtUtc:string|null;
  evidence:CvEvidence;
  configurationMode:"synthetic_demo";
  generationStatus:"pending"|"complete";
  fallbackReason:string|null;
}
export interface CvChange { cursor:number; kind:"feedback"; feedback:CvFeedbackText }
export interface CvChanges { featureVersion:typeof CV_FEATURE_VERSION; changes:CvChange[]; nextCursor:number }
export interface CvReport {
  featureVersion:typeof CV_FEATURE_VERSION;
  sessionId:string;
  exerciseId:CvExerciseId;
  side:"left"|"right";
  configuration:CvExerciseConfig;
  evidence:CvEvidence;
  configurationMode:"synthetic_demo";
  startedAtUtc:string;
  observedEndedAtUtc:string;
  clockDiscrepancy:boolean;
  completionStatus:"completed"|"incomplete"|"cancelled"|"interrupted";
  terminationReason:CvFinishInput["report"]["terminationReason"];
  timing:CvTiming;
  timingQuality:"complete"|"partial";
  attemptedCycles:number;
  movementCycles:number;
  completedReps:number;
  targetReps:number;
  shortHolds:number;
  rangeDegrees:number|null;
  trackingQuality:"available"|"partial"|"unavailable"|"simulated"|"patient_reported";
  feedbackSummary:Partial<Record<CvFeedbackCode,number>>;
  performanceScore:null;
  scoreReason:"not_clinically_validated";
}
export interface CvSession {
  featureVersion:typeof CV_FEATURE_VERSION;
  id:string;
  exerciseId:CvExerciseId;
  side:"left"|"right";
  evidence:CvEvidence;
  configuration:CvExerciseConfig;
  startedAtUtc:string;
  serverReceivedAtUtc:string;
  status:"running"|"paused"|"finished";
  trackingValid:boolean;
  sessionControlRevision:number;
  acknowledgedSequence:number;
  attemptedCycles:number;
  movementCycles:number;
  completedReps:number;
  report:CvReport|null;
}
export interface CvEventResult {
  featureVersion:typeof CV_FEATURE_VERSION;
  acknowledgedSequence:number;
  session:CvSession;
  feedback:CvFeedbackText[];
}
