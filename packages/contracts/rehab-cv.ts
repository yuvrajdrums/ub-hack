import { z } from "zod";

export const CV_FEATURE_VERSION = "rehab-cv/1.0" as const;
export const CvExerciseIdSchema = z.enum(["seated-knee-extension", "seated-knee-flexion-extension", "straight-leg-raise", "static-quads"]);
export const CvEvidenceSchema = z.enum(["camera_estimated", "simulated", "patient_reported", "unavailable"]);
export const CvFeedbackCodeSchema = z.enum(["HOLD_TOO_SHORT", "EXTENSION_INCOMPLETE", "MOVEMENT_TOO_FAST", "KNEE_BENDING", "TRACKING_LOST", "TRACKING_RESTORED", "REP_COMPLETED", "SET_COMPLETED"]);
export type CvExerciseId = z.infer<typeof CvExerciseIdSchema>;
export type CvEvidence = z.infer<typeof CvEvidenceSchema>;
export type CvFeedbackCode = z.infer<typeof CvFeedbackCodeSchema>;
export type CvPlanExerciseAssignment = {
  exerciseId: CvExerciseId;
  label: string;
  side: "left" | "right";
  sourceRef: string;
  planId: string;
  planVersion: number;
};
export type CvPlanExerciseResolution = {
  assignment: CvPlanExerciseAssignment | null;
  reason:
    | "assigned"
    | "no_approved_plan"
    | "no_supported_exercise"
    | "multiple_exercises"
    | "missing_side"
    | "conflicting_sides";
  message: string;
};
const id = z.string().uuid();
const duration = z.number().finite().min(0).max(43_200_000);
const angle = z.number().finite().min(0).max(180);
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
  mode: "standalone_demo"|"connected_demo"|"authenticated";
  storageScope?:string;
  csrfToken: string;
  exercises: CvExerciseConfig[];
  planExercise?: CvPlanExerciseResolution;
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
  reason:z.enum(["tracking_lost","user_pause","short_hold","incomplete_target","knee_bending","target_overshoot","movement_too_fast"]).optional(),
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
  careReference?:CvCareReference;
  analysisMethod?:"gemini_landmark_analysis";
  measurementMethod?:"local_pose_engine";
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
  careReference?:CvCareReference;
  analysisMethod?:"gemini_landmark_analysis";
  measurementMethod?:"local_pose_engine";
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

/** Optional clinician-plan reference captured by Rehab, never accepted from browser input. */
export const CvCareReferenceSchema=z.object({patientId:z.string().min(1),planId:z.string().min(1),planVersion:z.number().int().positive()}).strict();
export type CvCareReference=z.infer<typeof CvCareReferenceSchema>;
export const CvConfigSchema=z.object({exerciseId:CvExerciseIdSchema,label:z.string().min(1),description:z.string(),configVersion:z.number().int().positive(),targetReps:z.number().int().positive(),targetHoldMs:duration,flexionHoldMs:duration,startAngleDeg:angle,targetAngleDeg:angle,configurationMode:z.literal("synthetic_demo"),cameraView:z.literal("side")}).strict();
export const CvFeedbackSchema=z.object({featureVersion:z.literal(CV_FEATURE_VERSION),eventId:id,sessionId:id,feedbackCode:CvFeedbackCodeSchema,attemptId:id.nullable(),sessionControlRevision:z.number().int().nonnegative(),textRevision:z.number().int().positive(),text:z.string().min(1).max(900),textSource:z.enum(["gemini_selected_approved_variant","deterministic_fallback"]),phraseId:z.string(),templateVersion:z.string(),generatedAtUtc:z.string().datetime(),expiresAtUtc:z.string().datetime().nullable(),evidence:CvEvidenceSchema,configurationMode:z.literal("synthetic_demo"),generationStatus:z.enum(["pending","complete"]),fallbackReason:z.string().nullable()}).strict();
export const CvReportSchema=z.object({featureVersion:z.literal(CV_FEATURE_VERSION),sessionId:id,exerciseId:CvExerciseIdSchema,side:z.enum(["left","right"]),configuration:CvConfigSchema,evidence:CvEvidenceSchema,configurationMode:z.literal("synthetic_demo"),startedAtUtc:z.string().datetime(),observedEndedAtUtc:z.string().datetime(),clockDiscrepancy:z.boolean(),completionStatus:z.enum(["completed","incomplete","cancelled","interrupted"]),terminationReason:z.enum(["finished","patient_stopped","discomfort_reported","tracking_lost","backgrounded","model_error","recovered_crash"]),timing:CvTimingSchema,timingQuality:z.enum(["complete","partial"]),attemptedCycles:z.number().int().nonnegative(),movementCycles:z.number().int().nonnegative(),completedReps:z.number().int().nonnegative(),targetReps:z.number().int().positive(),shortHolds:z.number().int().nonnegative(),rangeDegrees:angle.nullable(),trackingQuality:z.enum(["available","partial","unavailable","simulated","patient_reported"]),feedbackSummary:z.partialRecord(CvFeedbackCodeSchema,z.number().int().nonnegative()),performanceScore:z.null(),scoreReason:z.literal("not_clinically_validated"),careReference:CvCareReferenceSchema.optional(),analysisMethod:z.literal("gemini_landmark_analysis").optional(),measurementMethod:z.literal("local_pose_engine").optional()}).strict();
export const CvSessionSchema=z.object({featureVersion:z.literal(CV_FEATURE_VERSION),id,exerciseId:CvExerciseIdSchema,side:z.enum(["left","right"]),evidence:CvEvidenceSchema,configuration:CvConfigSchema,startedAtUtc:z.string().datetime(),serverReceivedAtUtc:z.string().datetime(),status:z.enum(["running","paused","finished"]),trackingValid:z.boolean(),sessionControlRevision:z.number().int().nonnegative(),acknowledgedSequence:z.number().int().nonnegative(),attemptedCycles:z.number().int().nonnegative(),movementCycles:z.number().int().nonnegative(),completedReps:z.number().int().nonnegative(),report:CvReportSchema.nullable(),careReference:CvCareReferenceSchema.optional(),analysisMethod:z.literal("gemini_landmark_analysis").optional(),measurementMethod:z.literal("local_pose_engine").optional()}).strict();

export { CvRepAnalysisSchema,CvRepAnalysisInputSchema,CvPoseFrameSchema,CvCalibrationAssistInputSchema,CvCalibrationAssistResponseSchema,type CvRepAnalysis,type CvRepAnalysisInput,type CvRepAnalysisResponse,type CvCalibrationAssistInput,type CvCalibrationAssistResponse } from "../yuvraj-integration/contracts";
