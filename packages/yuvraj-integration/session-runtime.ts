// Maintained runtime adaptation of the preserved 371198e session service.
// Local camera events own measurements; the archived original remains unchanged.
import { createLiveEngineConfig } from "../../apps/rehab/src/features/exercise/live";
import { randomUUID } from "node:crypto";
import {
  CV_FEATURE_VERSION,CvStartSchema,CvEventInputSchema,CvFinishSchema,CvGenerateSchema,
  type CvCalibrationAssistResponse,
  type CvRepAnalysis,type CvRepAnalysisResponse,
  type CvSession,type CvReport,type CvFeedbackText,type CvFeedbackCode,type CvEventResult,type CvChange,
} from "../contracts/rehab-cv";
import { JsonStore,DomainError,once,dataFile,type Receipt } from "../platform/json-store";
import { configFor,phraseVariants } from "../../references/yuvraj/camera-to-text-371198e/source/apps/rehab/src/server/cv/config";
import { geminiReadiness,selectPhrase } from "../../references/yuvraj/camera-to-text-371198e/source/apps/rehab/src/server/cv/gemini";

type StoredSession = CvSession & {
  owner:string;
  events:ReturnType<typeof CvEventInputSchema.parse>["event"][];
  feedback:CvFeedbackText[];
  changes:CvChange[];
  lastOffsetMs:number;
  lastTechniqueMs:number|null;
  lastCodeMs:Partial<Record<CvFeedbackCode,number>>;
  generationStarts:Record<string,string>;
  analysis:CvRepAnalysis|null;
  analysisBatchSequence:number;
};
export type CvStoreData = {sessions:StoredSession[];receipts:Record<string,Receipt>};
type Store = CvStoreData;
export interface CvStore {
  snapshot():Promise<CvStoreData>;
  // Callbacks must be side-effect free: durable adapters may retry on contention.
  update<R>(fn:(state:CvStoreData)=>R|Promise<R>):Promise<R>;
}
const feature={featureVersion:CV_FEATURE_VERSION};
const publicSession=(s:StoredSession):CvSession=>({
  ...feature,id:s.id,exerciseId:s.exerciseId,side:s.side,evidence:s.evidence,configuration:s.configuration,
  startedAtUtc:s.startedAtUtc,serverReceivedAtUtc:s.serverReceivedAtUtc,status:s.status,trackingValid:s.trackingValid,
  sessionControlRevision:s.sessionControlRevision,acknowledgedSequence:s.acknowledgedSequence,
  attemptedCycles:s.attemptedCycles,movementCycles:s.movementCycles,completedReps:s.completedReps,report:s.report,
  ...(s.measurementMethod ? {measurementMethod:s.measurementMethod} : {}),
});
function owned(s:Store,id:string,owner:string) {
  const session=s.sessions.find(v=>v.id===id && v.owner===owner);
  if(!session)throw new DomainError("NOT_FOUND","Session not found",404);
  return session;
}
function change(s:StoredSession,f:CvFeedbackText) {
  s.changes.push({cursor:(s.changes.at(-1)?.cursor || 0)+1,kind:"feedback",feedback:structuredClone(f)});
}
function feedback(s:StoredSession,code:CvFeedbackCode,now:Date,attemptId:string|null=null):CvFeedbackText|null {
  const technique=["HOLD_TOO_SHORT","EXTENSION_INCOMPLETE","MOVEMENT_TOO_FAST","KNEE_BENDING"].includes(code);
  if(technique && ((s.lastTechniqueMs!==null && s.lastOffsetMs-s.lastTechniqueMs<10000) || (s.lastCodeMs[code]!==undefined && s.lastOffsetMs-s.lastCodeMs[code]!<30000)))return null;
  if(technique)s.lastTechniqueMs=s.lastOffsetMs;
  s.lastCodeMs[code]=s.lastOffsetMs;
  const ready=geminiReadiness();
  const f:CvFeedbackText={
    ...feature,eventId:randomUUID(),sessionId:s.id,feedbackCode:code,attemptId,
    sessionControlRevision:s.sessionControlRevision,textRevision:1,
    text:phraseVariants(code,s.configuration,s.completedReps).primary,textSource:"deterministic_fallback",phraseId:"primary",
    templateVersion:"rehab-cues/1",generatedAtUtc:now.toISOString(),
    expiresAtUtc:new Date(now.getTime()+(code==="SET_COMPLETED"?60000:8000)).toISOString(),
    evidence:s.evidence,configurationMode:"synthetic_demo",generationStatus:ready.mode==="controlled" && ready.configured?"pending":"complete",
    fallbackReason:ready.mode!=="controlled"?"disabled":!ready.configured?"not_configured":null,
  };
  s.feedback.push(f);change(s,f);return structuredClone(f);
}
export function cvSessionRuntime(file=dataFile("rehab-cv"),options:{now?:()=>Date;fetcher?:typeof fetch;store?:CvStore}={}) {
  const db=options.store || new JsonStore<Store>(file,()=>({sessions:[],receipts:{}}));
  const now=options.now || (()=>new Date());
  const inFlight=new Map<string,Promise<CvFeedbackText>>();
  return {
    async calibrate(_owner:string,_raw:unknown):Promise<CvCalibrationAssistResponse> {
      throw new DomainError("MANUAL_CALIBRATION_REQUIRED","Capture references locally",409);
    },
    async start(owner:string,raw:unknown):Promise<CvSession> {
      const v=CvStartSchema.parse(raw);
      return db.update(store=>once(store.receipts,`${owner}:start:${v.requestId}`,v,()=>{
        const date=now();
        if(Math.abs(date.getTime()-Date.parse(v.startedAtUtc))>300000)throw new DomainError("CLOCK_SKEW","Start time differs from the server by more than five minutes",400);
        const config=configFor(v.exerciseId);
        if(v.evidence==="camera_estimated")config.configVersion=2;
        if(v.exerciseId==="static-quads" && !["patient_reported","simulated"].includes(v.evidence))throw new DomainError("EVIDENCE_MISMATCH","Static quads requires patient-reported or simulated evidence",400);
        if(v.exerciseId!=="static-quads" && v.evidence==="patient_reported")throw new DomainError("EVIDENCE_MISMATCH","Camera exercises require camera-estimated, simulated or unavailable evidence",400);
        if(v.calibration && v.exerciseId!=="static-quads") {
          try { createLiveEngineConfig(v.exerciseId,{startAngleDeg:v.calibration.startAngleDeg,targetAngleDeg:v.calibration.targetAngleDeg,holdMs:config.targetHoldMs,flexionHoldMs:config.flexionHoldMs}); } catch { throw new DomainError("CALIBRATION_INVALID","Capture separated comfortable start and target references",400); }
          config.startAngleDeg=v.calibration.startAngleDeg;config.targetAngleDeg=v.calibration.targetAngleDeg;
        }
        if(v.evidence==="camera_estimated" && !v.calibration)throw new DomainError("CALIBRATION_REQUIRED","Camera measurements need manually captured references",400);
        const session:StoredSession={...feature,id:randomUUID(),owner,exerciseId:v.exerciseId,side:v.side,evidence:v.evidence,configuration:config,
          ...(v.evidence==="camera_estimated"?{measurementMethod:"local_pose_engine" as const}:{}),
          startedAtUtc:v.startedAtUtc,serverReceivedAtUtc:date.toISOString(),status:"running",trackingValid:v.exerciseId==="static-quads",
          sessionControlRevision:0,acknowledgedSequence:0,attemptedCycles:0,movementCycles:0,completedReps:0,report:null,
          events:[],feedback:[],changes:[],lastOffsetMs:0,lastTechniqueMs:null,lastCodeMs:{},generationStarts:{},analysis:null,analysisBatchSequence:0};
        store.sessions.push(session);return publicSession(session);
      }));
    },
    async get(owner:string,id:string):Promise<CvSession> {return publicSession(owned(await db.snapshot(),id,owner));},
    async reports(owner:string):Promise<CvReport[]> {return (await db.snapshot()).sessions.filter(s=>s.owner===owner && s.report).map(s=>s.report!);},
    async analyze(owner:string,id:string,_raw:unknown):Promise<CvRepAnalysisResponse> {
      owned(await db.snapshot(),id,owner);
      throw new DomainError("LOCAL_MEASUREMENTS_ONLY","Gemini does not produce camera measurements",409);
    },
    async events(owner:string,id:string,raw:unknown):Promise<CvEventResult> {
      const v=CvEventInputSchema.parse(raw);
      return db.update(store=>once(store.receipts,`${owner}:event:${v.requestId}`,{id,...v},()=>{
        const s=owned(store,id,owner),e=v.event;
        if(s.status==="finished")throw new DomainError("SESSION_FINISHED","The session has already finished");
        if(s.events.length>=5000)throw new DomainError("SESSION_LIMIT","This demo session has reached its event limit",429);
        if(e.sequence!==s.acknowledgedSequence+1)throw new DomainError("SEQUENCE_GAP",`Expected measurement sequence ${s.acknowledgedSequence+1}`);
        if(e.observedOffsetMs<s.lastOffsetMs)throw new DomainError("TIME_ORDER","Measurement offsets must not move backwards",400);
        if(s.events.some(p=>p.eventId===e.eventId))throw new DomainError("EVENT_REUSED","Event ID already belongs to another request");
        const generated:CvFeedbackText[]=[];
        const emit=(code:CvFeedbackCode,attemptId:string|null=null)=>{const f=feedback(s,code,now(),attemptId);if(f)generated.push(f);};
        s.lastOffsetMs=e.observedOffsetMs;
        if(e.type==="attempt_finalized") {
          if(s.evidence==="camera_estimated" && s.measurementMethod!=="local_pose_engine")throw new DomainError("MEASUREMENT_METHOD_MISMATCH","Recover this older camera set before starting a local measurement set",409);
          if(s.events.some(p=>p.type==="attempt_finalized" && p.attemptId===e.attemptId))throw new DomainError("ATTEMPT_REUSED","Attempt already finalized");
          if(s.evidence==="unavailable")throw new DomainError("EVIDENCE_MISMATCH","Unavailable tracking cannot claim an attempt",400);
          if(s.status!=="running" && !e.invalidated)throw new DomainError("MEASUREMENT_PAUSED","A paused session cannot complete an attempt",400);
          if(s.evidence==="camera_estimated" && !s.trackingValid && !e.invalidated)throw new DomainError("TRACKING_UNAVAILABLE","A camera movement needs valid tracking",400);
          if(e.holdMs+(e.flexionHoldMs||0)>e.observedOffsetMs)throw new DomainError("IMPOSSIBLE_DURATION","Hold exceeds the observed session duration",400);
          if(e.movementComplete && (e.invalidated || !e.targetReached))throw new DomainError("MEASUREMENT_MISMATCH","A full movement must reach the target and return without invalidation",400);
          const previousAttempt=s.events.filter(event=>event.type==="attempt_finalized").at(-1);
          if(previousAttempt && e.holdMs+(e.flexionHoldMs||0)>e.observedOffsetMs-previousAttempt.observedOffsetMs+1)throw new DomainError("IMPOSSIBLE_DURATION","Hold durations overlap an earlier attempt",400);
          const qualifies=e.movementComplete && e.targetReached && !e.invalidated && !e.kneeBent && e.reason!=="target_overshoot" && e.reason!=="movement_too_fast" && e.holdMs>=s.configuration.targetHoldMs && (e.flexionHoldMs||0)>=s.configuration.flexionHoldMs;
          if(e.qualifying!==qualifies)throw new DomainError("MEASUREMENT_MISMATCH","Qualifying count does not match captured hold/target rules",400);
          s.attemptedCycles++;if(e.movementComplete)s.movementCycles++;if(qualifies)s.completedReps++;
          if(!e.invalidated) {
            if(e.kneeBent)emit("KNEE_BENDING",e.attemptId);
            else if(!e.targetReached)emit("EXTENSION_INCOMPLETE",e.attemptId);
            else if(e.holdMs<s.configuration.targetHoldMs || (e.flexionHoldMs||0)<s.configuration.flexionHoldMs)emit("HOLD_TOO_SHORT",e.attemptId);
            else if(e.reason==="movement_too_fast")emit("MOVEMENT_TOO_FAST",e.attemptId);
            else if(qualifies && (s.completedReps===1 || s.completedReps%5===0))emit("REP_COMPLETED",e.attemptId);
          }
        } else if(e.type==="tracking_changed") {
          if(s.trackingValid!==e.valid) {s.trackingValid=e.valid;s.sessionControlRevision++;emit(e.valid?"TRACKING_RESTORED":"TRACKING_LOST");}
        } else if(e.type==="session_state_changed") {
          s.status=e.action==="resume"?"running":"paused";s.sessionControlRevision++;
        } else if(e.type==="checkpoint") {
          if(Math.abs(e.timing.elapsedTimeMs-e.observedOffsetMs)>1)throw new DomainError("TIMING_MISMATCH","Checkpoint offset must equal its elapsed duration",400);
        }
        s.events.push(e);s.acknowledgedSequence=e.sequence;
        return {...feature,acknowledgedSequence:s.acknowledgedSequence,session:publicSession(s),feedback:generated};
      }));
    },
    async changes(owner:string,id:string,after=0) {
      if(!Number.isSafeInteger(after)||after<0)throw new DomainError("CURSOR_INVALID","Invalid feedback cursor",400);
      const s=owned(await db.snapshot(),id,owner);
      const changes=s.changes.filter(c=>c.cursor>after).slice(0,100);
      return {...feature,changes,nextCursor:changes.at(-1)?.cursor || after};
    },
    async finish(owner:string,id:string,raw:unknown):Promise<CvReport> {
      const v=CvFinishSchema.parse(raw);
      return db.update(store=>once(store.receipts,`${owner}:finish:${v.requestId}`,{id,...v},()=>{
        const s=owned(store,id,owner);
        if(s.report)throw new DomainError("ALREADY_FINISHED","Session already has an immutable report");
        if(s.acknowledgedSequence!==v.lastMeasurementSequence)throw new DomainError("MEASUREMENTS_PENDING",`Saved through sequence ${s.acknowledgedSequence}; reconcile pending measurements before Finish`);
        if(v.report.timing.elapsedTimeMs+1<s.lastOffsetMs)throw new DomainError("TIMING_MISMATCH","Final duration precedes accepted measurements",400);
        const attempts=s.events.filter(e=>e.type==="attempt_finalized");
        const ranges=attempts.flatMap(e=>e.rangeDegrees===null?[]:[e.rangeDegrees]);
        const localShortHolds=attempts.filter(e=>!e.invalidated && e.targetReached && (e.holdMs<s.configuration.targetHoldMs || (e.flexionHoldMs||0)<s.configuration.flexionHoldMs)).length;
        const localRange=ranges.length?Math.max(...ranges):null;
        const checkpoint=s.events.filter(e=>e.type==="checkpoint").at(-1);
        if(checkpoint && v.report.timing.activeTimeMs+1<checkpoint.timing.activeTimeMs)throw new DomainError("TIMING_MISMATCH","Active time cannot decrease below a saved checkpoint",400);
        const status=v.report.completionStatus==="completed" && s.completedReps<s.configuration.targetReps?"incomplete":v.report.completionStatus;
        const report:CvReport={...feature,sessionId:s.id,exerciseId:s.exerciseId,side:s.side,configuration:s.configuration,evidence:s.evidence,configurationMode:"synthetic_demo",
          startedAtUtc:s.startedAtUtc,observedEndedAtUtc:v.report.observedEndedAtUtc,clockDiscrepancy:Math.abs(Date.parse(v.report.observedEndedAtUtc)-Date.parse(s.startedAtUtc)-v.report.timing.elapsedTimeMs)>2000,
          completionStatus:status,terminationReason:v.report.terminationReason,timing:v.report.timing,timingQuality:v.report.timingQuality,
          attemptedCycles:s.attemptedCycles,movementCycles:s.movementCycles,completedReps:s.completedReps,targetReps:s.configuration.targetReps,
          shortHolds:s.measurementMethod==="local_pose_engine"?localShortHolds:s.analysis?.shortHolds??localShortHolds,
          rangeDegrees:s.measurementMethod==="local_pose_engine"?localRange:s.analysis?.rangeDegrees??localRange,
          trackingQuality:s.evidence==="simulated"?"simulated":s.evidence==="patient_reported"?"patient_reported":s.evidence==="unavailable" || (s.evidence==="camera_estimated" && (s.measurementMethod==="local_pose_engine" ? !s.events.some(e=>e.type==="tracking_changed" && e.valid) : !s.analysisBatchSequence))?"unavailable":(v.report.timingQuality==="partial" || s.events.some(e=>e.type==="tracking_changed" && !e.valid))?"partial":"available",
          feedbackSummary:s.feedback.reduce((out,f)=>({...out,[f.feedbackCode]:(out[f.feedbackCode]||0)+1}),{} as Partial<Record<CvFeedbackCode,number>>),
          ...(s.measurementMethod?{measurementMethod:s.measurementMethod}:{}),
          performanceScore:null,scoreReason:"not_clinically_validated"};
        s.report=report;s.status="finished";s.sessionControlRevision++;
        if(status==="completed")feedback(s,"SET_COMPLETED",now());
        return report;
      }));
    },
    async generate(owner:string,id:string,eventId:string,raw:unknown):Promise<CvFeedbackText> {
      const v=CvGenerateSchema.parse(raw);
      const key=`${owner}:${id}:${eventId}`;
      const fingerprint=JSON.stringify({id,eventId});
      const receiptKey=`${owner}:generate:${v.requestId}`;
      const previous=(await db.snapshot()).receipts[receiptKey];
      if(previous && previous.fingerprint!==fingerprint)throw new DomainError("CONFLICT","Request ID reused with different input");
      if(previous)return previous.result as CvFeedbackText;
      const existing=inFlight.get(key);if(existing)return existing;
      const work=(async()=>{
        const prepared=await db.update(store=>{
          const s=owned(store,id,owner),f=s.feedback.find(f=>f.eventId===eventId);
          if(!f)throw new DomainError("NOT_FOUND","Feedback event not found",404);
          if(f.generationStatus==="complete")return {done:structuredClone(f),wait:false,variants:{} as Record<string,string>,code:f.feedbackCode};
          // The persisted lease coordinates different Worker requests/isolates.
          if(s.generationStarts[eventId] && Date.parse(s.generationStarts[eventId])+6000>now().getTime())
            return {done:null,wait:true,variants:{} as Record<string,string>,code:f.feedbackCode};
          let reason:string|null=null;
          if((s.status!=="running" && f.feedbackCode!=="SET_COMPLETED") || f.sessionControlRevision!==s.sessionControlRevision)reason="inactive_session";
          else if(f.expiresAtUtc && Date.parse(f.expiresAtUtc)<=now().getTime())reason="expired";
          else if(s.feedback.some(other=>other.eventId!==eventId && other.generationStatus==="pending" && s.generationStarts[other.eventId] && Date.parse(s.generationStarts[other.eventId])+6000>now().getTime()))reason="generation_busy";
          else if(Object.keys(s.generationStarts).length>=30)reason="session_quota";
          else if(s.generationStarts[eventId])reason="interrupted_generation";
          if(reason) {f.generationStatus="complete";f.fallbackReason=reason;f.textRevision++;change(s,f);return {done:structuredClone(f),wait:false,variants:{} as Record<string,string>,code:f.feedbackCode};}
          s.generationStarts[eventId]=now().toISOString();
          return {done:null,wait:false,variants:phraseVariants(f.feedbackCode,s.configuration,s.completedReps),code:f.feedbackCode};
        });
        let answer=prepared.done;
        if(prepared.wait) {
          const deadline=Date.now()+6500;
          while(Date.now()<deadline) {
            const f=owned(await db.snapshot(),id,owner).feedback.find(f=>f.eventId===eventId)!;
            if(f.generationStatus==="complete") {answer=structuredClone(f);break;}
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          if(!answer)answer=await db.update(store=>{
            const s=owned(store,id,owner),f=s.feedback.find(f=>f.eventId===eventId)!;
            if(f.generationStatus!=="complete") {f.generationStatus="complete";f.fallbackReason="interrupted_generation";f.textRevision++;change(s,f);}
            return structuredClone(f);
          });
        }
        if(!answer) {
          const generation=await selectPhrase(prepared.code,prepared.variants,options.fetcher);
          answer=await db.update(store=>{
            const s=owned(store,id,owner),f=s.feedback.find(f=>f.eventId===eventId)!;
            if(f.generationStatus==="complete")return structuredClone(f);
            const valid=(s.status==="running" || f.feedbackCode==="SET_COMPLETED") && f.sessionControlRevision===s.sessionControlRevision && (!f.expiresAtUtc || Date.parse(f.expiresAtUtc)>now().getTime());
            f.generationStatus="complete";f.textRevision++;f.generatedAtUtc=now().toISOString();
            if(valid) {f.phraseId=generation.phraseId;f.text=prepared.variants[generation.phraseId];f.textSource=generation.source;f.fallbackReason=generation.fallbackReason;}
            else f.fallbackReason="stale_result";
            change(s,f);return structuredClone(f);
          });
        }
        await db.update(store=>{store.receipts[receiptKey]={fingerprint,result:answer};});
        return answer!;
      })();
      inFlight.set(key,work);
      try{return await work;}finally{inFlight.delete(key);}
    },
  };
}
