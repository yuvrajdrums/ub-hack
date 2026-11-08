"use client";

import { useEffect, useRef, useState } from "react";
import type { CvCalibrationAssistInput, CvCalibrationAssistResponse, CvChanges, CvContext, CvExerciseConfig, CvExerciseId, CvFeedbackText, CvFinishInput, CvRepAnalysis, CvRepAnalysisInput, CvRepAnalysisResponse, CvReport, CvSession, CvTiming } from "../../../../packages/contracts/rehab-cv";
import { usePoseCamera, type CameraFrame } from "@/features/camera/use-pose-camera";
import { exerciseTrackingProfile } from "@/features/camera/tracking-profile";
import { POSE_MODELS, poseModelFor, type PoseModelId } from "@/features/camera/pose-models";
import { advanceExercise, advanceTiming, completeGuidedHold, createAngleFilter, createExerciseState, createTimingState, createLiveEngineConfig, LIVE_DETECTOR, liveFrameIsStale, deriveCalibration, filterAngle, invalidateExercise, measurePose, timingSummary, type AttemptOutcome, type EngineConfig, type ExerciseState, type TimingState } from "@/features/exercise";
import { cvApi, readRecovery, SessionTransport, type MeasurementBody, type Recovery } from "@/features/feedback/session-client";
import styles from "./cv.module.css";

type Run = {
  transport: SessionTransport; config: EngineConfig; engine: ExerciseState; timing: TimingState;
  start: number; paused: boolean; terminal: boolean; finishing: boolean; tracking: boolean;
  simulated:boolean; poseFrames:CvRepAnalysisInput["frames"]; lastPoseFrameAt:number; analysisBatchSequence:number; analysisAt:number; analysisPromise:Promise<void>|null;
  frameAt: number; checkpointAt: number; guidedAt: number | null; guidedMs: number;
  cursor: number; polling: boolean; pollAt:number; attempts: Map<string,string>; feedbackRanks: Map<string,number>;
  shownRank: number; finishReport: CvFinishInput["report"] | null;
};
const empty = {valid:false,angle:null as number|null,knee:null as number|null,confidence:0,inferenceMs:0,reason:null as string|null};
const messageFor: Record<string,string> = {
  HOLD_TOO_SHORT:"Try holding the position for the full demonstration duration.",
  EXTENSION_INCOMPLETE:"Follow your comfortable calibrated target without forcing the movement.",
  KNEE_BENDING:"Keep an eye on your knee position during the leg raise.",
  TRACKING_LOST:"I cannot see your working leg clearly. Please reposition.",
  TRACKING_RESTORED:"Tracking is ready. Return to your starting position.",
  REP_COMPLETED:"That movement met the demonstration targets.",
  MOVEMENT_TOO_FAST:"Follow the configured demonstration pace.",
};
const clock = (ms:number) => `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}`;
const seconds = (ms:number) => (ms/1000).toFixed(1);
const median = (values:number[]) => {const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
type CalibrationPose = "rest"|"comfortable_target";
type CalibrationCandidate = {position:CalibrationPose;angles:number[];confidences:number[];firstAt:number;lastAt:number};

export default function Rehab() {
  const [context,setContext] = useState<CvContext|null>(null);
  const [exercise,setExercise] = useState<CvExerciseId>("seated-knee-extension");
  const [side,setSide] = useState<"left"|"right">("left");
  const [poseModel,setPoseModel] = useState<PoseModelId>("lite");
  const [calibration,setCalibration] = useState<{start:number|null;target:number|null}>({start:null,target:null});
  const [calibrationSource,setCalibrationSource] = useState<{start:"Gemini"|"Manual"|null;target:"Gemini"|"Manual"|null}>({start:null,target:null});
  const [calibrationBusy,setCalibrationBusy] = useState<"auto"|null>(null);
  const [calibrationConsensus,setCalibrationConsensus] = useState<{position:CalibrationPose;count:number}|null>(null);
  const [measurement,setMeasurement] = useState(empty);
  const [session,setSession] = useState<CvSession|null>(null);
  const [engine,setEngine] = useState(createExerciseState);
  const [timing,setTiming] = useState<CvTiming>({elapsedTimeMs:0,activeTimeMs:0,pausedTimeMs:0,userPausedTimeMs:0,trackingPausedTimeMs:0,otherPausedTimeMs:0});
  const [feedback,setFeedback] = useState<CvFeedbackText|null>(null);
  const [repAnalysis,setRepAnalysis] = useState<CvRepAnalysis|null>(null);
  const [caption,setCaption] = useState("Enable the camera. Gemini will find your comfortable resting and end positions automatically.");
  const [notice,setNotice] = useState("Loading your standalone demonstration…");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [paused,setPaused] = useState(false);
  const [trace,setTrace] = useState(false);
  const [guided,setGuided] = useState(false);
  const [reports,setReports] = useState<CvReport[]>([]);
  const [recovery,setRecovery] = useState<Recovery|null>(null);
  const [lastReport,setLastReport] = useState<CvReport|null>(null);
  const [attemptNote,setAttemptNote] = useState("");
  const run = useRef<Run|null>(null);
  const filter = useRef(createAngleFilter());
  const lastFrameAt = useRef(-Infinity);
  const calibrationPoseFrames = useRef<CvCalibrationAssistInput["frames"]>([]);
  const calibrationPoseBaseAt = useRef(0);
  const calibrationPoseLastAt = useRef(-Infinity);
  const calibrationAutoBusy = useRef(false);
  const calibrationAutoAt = useRef(-Infinity);
  const calibrationGeneration = useRef(0);
  const calibrationMemory = useRef<CvCalibrationAssistResponse|null>(null);
  const calibrationCandidate = useRef<CalibrationCandidate|null>(null);
  const selected = useRef({exercise,side}); selected.current={exercise,side};
  const traceTimer = useRef<ReturnType<typeof setInterval>|null>(null);
  const finishAction = useRef<(status?:CvFinishInput["report"]["completionStatus"],reason?:CvFinishInput["report"]["terminationReason"])=>Promise<void>>(async()=>{});
  const mounted = useRef(true);
  const displayedFeedback = useRef<CvFeedbackText|null>(null);
  const configuration = context?.exercises.find(v=>v.exerciseId===exercise);
  const staticQuads = exercise==="static-quads";
  const trackingProfile=exerciseTrackingProfile(exercise,side);

  function acceptFeedback(value:CvFeedbackText) {
    const r=run.current;
    if(!r || r.terminal || r.paused || value.sessionId!==r.transport.session.id) return;
    if(value.expiresAtUtc && Date.parse(value.expiresAtUtc)<Date.now()) return;
    if(value.feedbackCode==="TRACKING_LOST" && r.tracking) return;
    if(value.feedbackCode==="TRACKING_RESTORED" && !r.tracking) return;
    if(!r.feedbackRanks.has(value.eventId)) r.feedbackRanks.set(value.eventId,r.feedbackRanks.size+1);
    const rank=r.feedbackRanks.get(value.eventId)!;
    if(rank<r.shownRank) return;
    if(displayedFeedback.current?.eventId===value.eventId && displayedFeedback.current.textRevision>value.textRevision)return;
    displayedFeedback.current=value;
    r.shownRank=rank; setFeedback(previous=>previous?.eventId===value.eventId && previous.textRevision>value.textRevision?previous:value);
    setCaption(value.text);
  }
  function tick(r:Run,now:number,terminal=false) {
    r.timing=advanceTiming(r.timing,now,{terminal,userPaused:r.paused,trackingValid:r.transport.session.exerciseId!=="static-quads" && r.tracking,ready:true});
    const summary={...timingSummary(r.timing),...(r.transport.session.exerciseId==="static-quads"?{guidedTimerMs:r.guidedMs+(r.guidedAt===null?0:Math.max(0,now-r.guidedAt))}:{})};
    r.transport.rememberTiming(summary); setTiming(summary); return summary;
  }
  function enqueue(r:Run,body:MeasurementBody,now:number) {
    const summary=tick(r,now); r.transport.rememberTiming(summary);
    r.transport.enqueue(body,summary.elapsedTimeMs);
  }
  function saveAttempt(r:Run,outcome:AttemptOutcome,now:number) {
    if(!outcome.invalidated)setAttemptNote(outcome.qualifying?"Last movement met the hold and return targets.":outcome.reason==="short_hold"?"Last movement counted; its hold was shorter than the demo target.":outcome.reason==="incomplete_target"?"Last movement did not reach the captured target.":outcome.reason==="target_overshoot"?"Last movement went beyond the captured target range. Review your references.":outcome.reason==="knee_bending"?"Last movement counted; the knee-straightness target was not met.":"Last movement did not meet all demonstration targets.");
    let id=r.attempts.get(outcome.attemptId);
    if(!id){id=crypto.randomUUID();r.attempts.set(outcome.attemptId,id);}
    const {reason,...metrics}=outcome;
    const allowed=["tracking_lost","user_pause","short_hold","incomplete_target","knee_bending","target_overshoot"];
    enqueue(r,{type:"attempt_finalized",...metrics,attemptId:id,...(reason?{reason:(allowed.includes(reason)?reason:"tracking_lost") as "tracking_lost"}: {})},now);
  }
  function observe(angle:number|null,knee:number|null,valid:boolean,now:number,receivedAtMs=now) {
    const r=run.current;if(!r || r.terminal)return;
    r.frameAt=receivedAtMs;
    if(r.tracking!==valid){r.tracking=valid;enqueue(r,{type:"tracking_changed",valid},now);}
    tick(r,now);
    if(r.paused || r.transport.session.exerciseId==="static-quads" || !r.simulated)return;
    const result=advanceExercise(r.engine,{atMs:now-r.start,valid,angleDeg:angle,kneeAngleDeg:knee},r.config);
    r.engine=result.state;setEngine(result.state);
    if(result.attempt)saveAttempt(r,result.attempt,now);
    if(result.feedbackCodes.length){const code=result.feedbackCodes.find(c=>c!=="TRACKING_RESTORED")??result.feedbackCodes[0];setCaption(messageFor[code]??"Keep following your comfortable reference positions.");}
  }
  function onFrame(frame:CameraFrame) {
    const choice=selected.current;
    const profile=exerciseTrackingProfile(choice.exercise,choice.side);
    const measured=measurePose(frame.landmarks,choice.side,frame.width,frame.height,{requireTorso:profile.requireTorso,minimumVisibility:profile.minimumVisibility,minimumPresence:profile.minimumPresence,personCount:frame.personCount});
    lastFrameAt.current=frame.receivedAtMs;
    const valid=measured.valid && frame.inferenceMs<=LIVE_DETECTOR.maximumSampleGapMs;
    const raw=choice.exercise==="straight-leg-raise"?measured.elevationDeg:measured.kneeAngleDeg;
    filter.current=filterAngle(filter.current,valid?raw:null,frame.timestampMs,{alpha:LIVE_DETECTOR.filterAlpha,medianWindow:LIVE_DETECTOR.medianWindow,maximumSampleGapMs:LIVE_DETECTOR.maximumSampleGapMs});
    const angle=filter.current.value;
    setMeasurement({valid,angle,knee:measured.kneeAngleDeg,confidence:measured.confidence,inferenceMs:frame.inferenceMs,reason:frame.inferenceMs>LIVE_DETECTOR.maximumSampleGapMs?"processing_slow":measured.reason});
    observe(angle,measured.kneeAngleDeg,valid,frame.timestampMs,frame.receivedAtMs);
    const active=run.current;
    if(!active&&valid&&angle!==null&&frame.timestampMs-calibrationPoseLastAt.current>=300){
      if(calibrationPoseFrames.current.length&&frame.timestampMs-calibrationPoseLastAt.current>700)calibrationPoseFrames.current=[];
      if(!calibrationPoseFrames.current.length)calibrationPoseBaseAt.current=frame.timestampMs;
      calibrationPoseLastAt.current=frame.timestampMs;
      const landmarks=frame.landmarks.map(point=>[point.x,point.y,point.z,point.visibility??null,point.presence??null]) as CvCalibrationAssistInput["frames"][number]["landmarks"];
      calibrationPoseFrames.current=[...calibrationPoseFrames.current,{offsetMs:Math.max(0,frame.timestampMs-calibrationPoseBaseAt.current),personCount:frame.personCount,landmarks}].slice(-8);
    }
    if(active&&!active.simulated&&!active.paused&&!active.terminal&&!active.finishing&&active.transport.session.evidence==="camera_estimated"&&frame.timestampMs-active.lastPoseFrameAt>=350&&frame.landmarks.length===33){
      active.lastPoseFrameAt=frame.timestampMs;
      const landmarks=frame.landmarks.map(point=>[point.x,point.y,point.z,point.visibility??null,point.presence??null]) as CvRepAnalysisInput["frames"][number]["landmarks"];
      active.poseFrames.push({offsetMs:Math.max(0,frame.timestampMs-active.start),personCount:frame.personCount,landmarks});
    }
  }
  const camera=usePoseCamera(trackingProfile,onFrame,(reason)=>{
    setMeasurement(empty);resetCalibration();filter.current=createAngleFilter();
    setNotice(reason);
    if(run.current&&!run.current.terminal)void finishAction.current("interrupted",reason.includes("hidden")?"backgrounded":reason.includes("model")?"model_error":"tracking_lost");
  },poseModel);

  async function analyzePendingPose(r:Run,flush=false):Promise<void>{
    if(r.analysisPromise){if(flush)await r.analysisPromise;else return;}
    if(!context||!r.poseFrames.length||(!flush&&r.poseFrames.length<3))return;
    const frames=r.poseFrames.splice(0,8),batchSequence=r.analysisBatchSequence+1;
    const work=(async()=>{
      try{
        const result=await cvApi<CvRepAnalysisResponse>(`/sessions/${r.transport.session.id}/analyze`,{requestId:crypto.randomUUID(),batchSequence,frames},context.csrfToken);
        r.analysisBatchSequence=result.batchSequence;setRepAnalysis(result.analysis);setSession(result.session);
        if(result.analysis.cue)setCaption(result.analysis.cue);
        setNotice(`Gemini analysis · ${Math.round(result.analysis.confidence*100)}% confidence`);
        setError("");
      }catch(e){
        setError(e instanceof Error?e.message:"Gemini could not analyze this pose batch. Previous counts are kept.");
      }
    })();
    r.analysisPromise=work;
    try{await work;}finally{r.analysisPromise=null;}
    if(flush&&r.poseFrames.length)await analyzePendingPose(r,true);
  }

  useEffect(()=>{
    mounted.current=true;
    void cvApi<CvContext>("/context").then(async value=>{
      if(!mounted.current)return;setContext(value);setRecovery(readRecovery());
      setNotice("Hold your comfortable resting position when tracking starts; Gemini will prompt you to move to your end position.");
      const history=await cvApi<CvReport[]>("/sessions");if(mounted.current)setReports(history);
    }).catch(e=>setError(e.message));
    return()=>{mounted.current=false;run.current?.transport.dispose();if(traceTimer.current)clearInterval(traceTimer.current);};
  },[]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      const now=performance.now();
      const r=run.current;
      if(!r){
        if(!trace&&!staticQuads&&!busy&&!recovery&&context?.gemini.mode==="controlled"&&context.gemini.configured&&camera.status==="tracking"&&measurement.valid&&liveFrameIsStale(lastFrameAt.current,now)===false&&(calibration.start===null||calibration.target===null)&&!calibrationAutoBusy.current&&now-calibrationAutoAt.current>=1500){
          calibrationAutoAt.current=now;void autoAnalyzeCalibration();
        }
        return;
      }
      if(r.terminal)return;
      if(!trace && r.transport.session.exerciseId!=="static-quads" && r.tracking && liveFrameIsStale(r.frameAt,now)){
        r.tracking=false;enqueue(r,{type:"tracking_changed",valid:false},now);
        setMeasurement(previous=>({...previous,valid:false,reason:"frames_delayed"}));
        if(r.simulated){const invalid=invalidateExercise(r.engine,"sample_gap",now-r.start);r.engine=invalid.state;setEngine(invalid.state);if(invalid.attempt)saveAttempt(r,invalid.attempt,now);}
        setCaption(messageFor.TRACKING_LOST);
      }
      if(!r.simulated&&!r.paused&&!r.finishing&&r.poseFrames.length>=3&&now-r.analysisAt>=1500){r.analysisAt=now;void analyzePendingPose(r);}
      const summary=tick(r,now);
      if(now-r.checkpointAt>=1000){r.checkpointAt=now;r.transport.checkpoint(summary,summary.elapsedTimeMs);}
      if(!r.polling&&now-r.pollAt>=1000){r.pollAt=now;r.polling=true;void cvApi<CvChanges>(`/sessions/${r.transport.session.id}/changes?after=${r.cursor}`).then(change=>{r.cursor=change.nextCursor;for(const item of change.changes)acceptFeedback(item.feedback);}).catch(()=>{}).finally(()=>{r.polling=false;});}
    },200);
    return()=>clearInterval(timer);
  },[trace,context,camera.status,staticQuads,calibration.start,calibration.target,calibrationBusy,busy,recovery,measurement.valid,exercise,side]);

  function setCalibrationReference(which:"start"|"target",capturedAngle:number,source:"Gemini"|"Manual") {
    const nextStart=which==="start"?capturedAngle:calibration.start;
    const nextTarget=which==="target"?capturedAngle:calibration.target;
    setCalibration(previous=>({...previous,[which]:capturedAngle}));
    setCalibrationSource(previous=>({...previous,[which]:source}));
    setError("");
    if(nextStart!==null&&nextTarget!==null&&!deriveCalibration(nextStart,nextTarget))setError("Captured, but the resting and comfortable target positions need at least 15° of separation. Adjust or re-capture one position.");
    else setNotice(`${which==="start"?"Resting":"Comfortable target"} reference set to ${capturedAngle}° by ${source}. You can replace it before starting.`);
  }
  function capture(which:"start"|"target") {
    if(liveFrameIsStale(lastFrameAt.current,performance.now()) || !measurement.valid || measurement.angle===null){setError(`No current ${exercise==="straight-leg-raise"?"leg elevation":"knee angle"} is available. Keep the selected ${side} leg${exercise==="straight-leg-raise"?" and torso":""} visible, then capture again.`);return;}
    const capturedAngle=Math.round(measurement.angle);
    calibrationCandidate.current=null;calibrationMemory.current=null;setCalibrationConsensus(null);
    setCalibrationReference(which,capturedAngle,"Manual");
  }
  async function autoAnalyzeCalibration() {
    if(exercise==="static-quads"||!context||calibrationAutoBusy.current)return;
    if(camera.status!=="tracking"||liveFrameIsStale(lastFrameAt.current,performance.now())||!measurement.valid)return;
    const frames=calibrationPoseFrames.current.slice(-8);
    if(frames.length<3||frames.at(-1)!.offsetMs-frames[0].offsetMs<500||performance.now()-lastFrameAt.current>700)return;
    calibrationAutoBusy.current=true;setCalibrationBusy("auto");setError("");
    const generation=calibrationGeneration.current,exerciseAtRequest=exercise,sideAtRequest=side;
    try{
      const result=await cvApi<CvCalibrationAssistResponse>("/calibrate",{requestId:crypto.randomUUID(),exerciseId:exercise,side,requestedPosition:"auto",previous:calibrationMemory.current?{detectedPosition:calibrationMemory.current.detectedPosition,workingMemory:calibrationMemory.current.workingMemory,startAngleDeg:calibration.start,targetAngleDeg:calibration.target}:null,frames},context.csrfToken);
      if(generation!==calibrationGeneration.current||selected.current.exercise!==exerciseAtRequest||selected.current.side!==sideAtRequest)return;
      calibrationMemory.current=result;
      if(result.detectedPosition==="transition"){
        calibrationCandidate.current=null;setCalibrationConsensus(null);
        if(result.cue)setNotice(result.cue);
        return;
      }
      if(result.detectedPosition==="uncertain"){
        if(result.cue)setNotice(result.cue);
        return;
      }
      if(result.detectedPosition==="comfortable_target"&&calibration.start===null){
        calibrationCandidate.current=null;setCalibrationConsensus(null);
        setNotice("Gemini sees your extended position. Return to your comfortable resting position first.");
        return;
      }
      const detected=result.detectedPosition;
      const key=detected==="rest"?"start":"target";
      if(calibration[key]!==null||result.angleDeg===null||!result.accepted||!result.stable||result.confidence<0.72){
        if(result.cue)setNotice(result.cue);
        return;
      }
      const now=performance.now(),previous=calibrationCandidate.current;
      const samePose=previous?.position===detected&&now-previous.lastAt<=4500;
      const candidate:CalibrationCandidate=samePose?{
        ...previous!,angles:[...previous!.angles,result.angleDeg].slice(-3),confidences:[...previous!.confidences,result.confidence].slice(-3),lastAt:now,
      }:{position:detected,angles:[result.angleDeg],confidences:[result.confidence],firstAt:now,lastAt:now};
      calibrationCandidate.current=candidate;
      setCalibrationConsensus({position:detected,count:candidate.angles.length});
      const consistentTimeMs=candidate.lastAt-candidate.firstAt;
      const bufferedAcceptance=candidate.angles.length>=3&&consistentTimeMs>=2400&&median(candidate.confidences)>=0.72;
      if(!bufferedAcceptance){
        setNotice(`Gemini sees your ${detected==="rest"?"resting":"comfortable end"} position. Hold it while the estimate settles (${candidate.angles.length}/3).`);
        return;
      }
      const settledAngle=Math.round(median(candidate.angles));
      if(detected==="rest"){
        setCalibrationReference("start",settledAngle,"Gemini");
        calibrationCandidate.current=null;setCalibrationConsensus(null);
        setNotice("Rest position settled. Now move to your comfortable end position and hold it.");
        return;
      }
      if(!deriveCalibration(calibration.start!,settledAngle)){
        setNotice("Gemini sees the end position, but it is too close to rest. Move farther within your comfort and hold again.");
        return;
      }
      setCalibrationReference("target",settledAngle,"Gemini");
      calibrationCandidate.current=null;setCalibrationConsensus(null);
      setNotice("Both references are settled. Review them or start your set.");
    }catch(e){
      if(generation===calibrationGeneration.current)setError(e instanceof Error?e.message:"Gemini calibration failed. It will retry when fresh landmarks arrive.");
    }finally{
      if(generation===calibrationGeneration.current){calibrationAutoBusy.current=false;setCalibrationBusy(null);}
    }
  }
  function resetCalibration(){calibrationGeneration.current++;calibrationAutoBusy.current=false;calibrationMemory.current=null;calibrationCandidate.current=null;calibrationAutoAt.current=-Infinity;setCalibrationBusy(null);setCalibrationConsensus(null);setCalibration({start:null,target:null});setCalibrationSource({start:null,target:null});calibrationPoseFrames.current=[];calibrationPoseLastAt.current=-Infinity;}
  function selectExercise(id:CvExerciseId) {camera.stop();lastFrameAt.current=-Infinity;setExercise(id);resetCalibration();setMeasurement(empty);filter.current=createAngleFilter();setFeedback(null);setCaption("Gemini will identify your comfortable starting and end positions automatically.");setNotice(id==="static-quads"?"Guided static quads uses your confirmation. Camera tracking is not required.":"Enable the camera, hold your resting position, then follow the on-screen cue to move to a comfortable end position.");}
  function selectSide(value:"left"|"right") {camera.stop();lastFrameAt.current=-Infinity;setSide(value);resetCalibration();setMeasurement(empty);filter.current=createAngleFilter();setNotice(`Working leg changed to ${value}. Enable the camera and hold your resting position for Gemini.`);}
  function selectPoseModel(value:PoseModelId) {camera.stop();lastFrameAt.current=-Infinity;setPoseModel(value);resetCalibration();setMeasurement(empty);filter.current=createAngleFilter();setFeedback(null);setError("");setNotice(`${poseModelFor(value).label} model selected. Enable the camera and Gemini will find both comfortable positions.`);}
  async function begin(simulated=false):Promise<Run|null> {
    if(!context || run.current || recovery || calibrationBusy)return null;
    if(!simulated&&!staticQuads&&(context.gemini.mode!=="controlled"||!context.gemini.configured)){setError("Gemini rep analysis is not configured. Configure the server-side Gemini key before starting a camera-counted set.");return null;}
    if(!simulated && !staticQuads && (camera.status!=="tracking" || !measurement.valid || calibration.start===null || calibration.target===null || !deriveCalibration(calibration.start,calibration.target))){setError("Enable tracking and set both the resting and comfortable target references at least 15° apart first.");return null;}
    setBusy(true);setError("");
    const start=performance.now();
    try{
      const value=await cvApi<CvSession>("/sessions",{requestId:crypto.randomUUID(),exerciseId:exercise,side,startedAtUtc:new Date().toISOString(),evidence:staticQuads?"patient_reported":simulated?"simulated":"camera_estimated",...(!simulated&&!staticQuads?{calibration:{startAngleDeg:calibration.start,targetAngleDeg:calibration.target}}:{})},context.csrfToken);
      const config=createLiveEngineConfig(exercise,{startAngleDeg:value.configuration.startAngleDeg,targetAngleDeg:value.configuration.targetAngleDeg,holdMs:value.configuration.targetHoldMs,flexionHoldMs:value.configuration.flexionHoldMs});
      const transport=new SessionTransport(value,context,acceptFeedback,setError);
      const r:Run={transport,config,engine:createExerciseState(),timing:createTimingState(start),start,paused:false,terminal:false,finishing:false,tracking:false,simulated,poseFrames:[],lastPoseFrameAt:-Infinity,analysisBatchSequence:0,analysisAt:start,analysisPromise:null,frameAt:performance.now(),checkpointAt:start,guidedAt:null,guidedMs:0,cursor:0,polling:false,pollAt:0,attempts:new Map(),feedbackRanks:new Map(),shownRank:0,finishReport:null};
      run.current=r;setSession(value);setEngine(r.engine);setRepAnalysis(null);setPaused(false);setFeedback(null);setLastReport(null);setAttemptNote("");setTrace(simulated);
      tick(r,performance.now());
      if(simulated || staticQuads){r.tracking=simulated;enqueue(r,{type:"tracking_changed",valid:simulated||staticQuads},performance.now());}
      setCaption(simulated?"Simulated input is running. These are test movements, not camera observations.":staticQuads?"Start the guided timer, then confirm the hold yourself.":"Gemini is ready. Move comfortably from the detected resting position toward your target, then return.");
      setNotice(simulated?"SIMULATED measurement trace — never saved as camera evidence.":"Set started. Text feedback works with sound off.");return r;
    }catch(e){setError(e instanceof Error?e.message:"The set could not start.");return null;}
    finally{setBusy(false);}
  }
  async function finish(status:CvFinishInput["report"]["completionStatus"]="completed",reason:CvFinishInput["report"]["terminationReason"]="finished") {
    const r=run.current;if(!r || r.finishing)return;r.finishing=true;setBusy(true);setError("");
    if(!r.finishReport){
      const now=performance.now();
      if(traceTimer.current){clearInterval(traceTimer.current);traceTimer.current=null;}
      camera.stop();
      if(!r.simulated&&r.transport.session.evidence==="camera_estimated")await analyzePendingPose(r,true);
      if(r.simulated||r.transport.session.exerciseId==="static-quads"){const invalid=invalidateExercise(r.engine,"user_pause",now-r.start);r.engine=invalid.state;if(invalid.attempt)saveAttempt(r,invalid.attempt,now);}
      if(r.guidedAt!==null){r.guidedMs+=Math.max(0,now-r.guidedAt);r.guidedAt=null;}
      const summary=tick(r,now,true);r.transport.checkpoint(summary,summary.elapsedTimeMs);r.terminal=true;
      r.finishReport={observedEndedAtUtc:new Date().toISOString(),completionStatus:status,terminationReason:reason,timing:summary,timingQuality:"complete"};
      setGuided(false);setTrace(false);
    }
    try{
      const report=await r.transport.finish(r.finishReport);run.current=null;setSession(null);setPaused(false);setLastReport(report);setEngine(r.engine);
      setReports(await cvApi<CvReport[]>("/sessions"));setNotice(`Report saved once · ${report.completionStatus.replaceAll("_"," ")}.`);
      setCaption("Your report is saved. You can review the measurements below.");
    }catch(e){r.finishing=false;setError(`${e instanceof Error?e.message:"Save is pending."} Your frozen measurements are retained; retry saving.`);}
    finally{setBusy(false);}
  }
  finishAction.current=finish;
  function pauseResume() {
    const r=run.current;if(!r || r.terminal)return;const now=performance.now();
    if(!r.paused){if(r.simulated||r.transport.session.exerciseId==="static-quads"){const invalid=invalidateExercise(r.engine,"user_pause",now-r.start);r.engine=invalid.state;setEngine(invalid.state);if(invalid.attempt)saveAttempt(r,invalid.attempt,now);}if(r.guidedAt!==null){r.guidedMs+=Math.max(0,now-r.guidedAt);r.guidedAt=null;setGuided(false);}}
    r.paused=!r.paused;tick(r,now);enqueue(r,{type:"session_state_changed",action:r.paused?"pause":"resume"},now);setPaused(r.paused);setCaption(r.paused?"Set paused. Timed holds and repetition counting are stopped.":"Set resumed. Return to your start position to begin a new movement.");
  }
  function guidedHold() {
    const r=run.current;if(!r || r.terminal||r.paused)return;const now=performance.now();
    if(r.guidedAt===null){r.guidedAt=now;setGuided(true);setCaption("Guided timer running. Only you can confirm the muscle contraction.");return;}
    const duration=now-r.guidedAt;r.guidedMs+=duration;r.guidedAt=null;setGuided(false);
    const result=completeGuidedHold(r.engine,duration,true,r.config);r.engine=result.state;setEngine(result.state);if(result.attempt)saveAttempt(r,result.attempt,now);
    setCaption(duration>=r.config.holdMs?"Your patient-confirmed hold is recorded.":"Your confirmation was recorded as a shorter guided hold.");
  }
  async function replay() {
    camera.stop();const r=await begin(true);if(!r)return;
    const start=r.transport.session.configuration.startAngleDeg,target=r.transport.session.configuration.targetAngleDeg;
    let elapsed=0;
    // Two deliberate fixture cycles: one short hold, then one qualifying hold.
    const cycle=(hold:number)=>[{ms:600,a:start},{ms:600,a:target},{ms:hold,a:target},{ms:700,a:start},{ms:exercise==="seated-knee-flexion-extension"?5600:700,a:start}];
    const phases=[...cycle(3000),...cycle(5600)];
    traceTimer.current=setInterval(()=>{
      if(run.current!==r || r.terminal){if(traceTimer.current)clearInterval(traceTimer.current);return;}
      if(r.paused)return;elapsed+=100;let t=elapsed;let current=phases.at(-1)!;
      for(const phase of phases){current=phase;if(t<=phase.ms)break;t-=phase.ms;}
      const now=performance.now();setMeasurement({valid:true,angle:current.a,knee:165,confidence:1,inferenceMs:0,reason:null});observe(current.a,165,true,now);
      if(elapsed>=phases.reduce((sum,p)=>sum+p.ms,0)){if(traceTimer.current)clearInterval(traceTimer.current);traceTimer.current=null;setNotice("Simulated trace complete. Finish and save to inspect the clearly labeled report.");}
    },100);
  }
  async function recover() {
    if(!context||!recovery)return;setBusy(true);setError("");
    try{const transport=new SessionTransport(recovery.session,context,()=>{},setError,recovery);const report=await transport.finish(recovery.finish?.report??{observedEndedAtUtc:new Date().toISOString(),completionStatus:"interrupted",terminationReason:"recovered_crash",timing:recovery.timing,timingQuality:"partial"});setLastReport(report);setReports(await cvApi<CvReport[]>("/sessions"));setRecovery(null);setNotice("Recovered measurements saved as an interrupted result; missing time was not invented.");}
    catch(e){setError(e instanceof Error?e.message:"Recovery is waiting to save.");}finally{setBusy(false);}
  }

  const calibrated=calibration.start!==null&&calibration.target!==null&&!!deriveCalibration(calibration.start,calibration.target);
  const running=!!session;
  const holdDisplay=staticQuads&&run.current?.guidedAt!=null?performance.now()-run.current.guidedAt:engine.currentHoldMs;
  const liveConfig=run.current?.config;
  const liveAnalysis=session?.evidence==="camera_estimated"?repAnalysis:null;
  const displayedMovements=liveAnalysis?.movementCycles??engine.movementCycles;
  const displayedReps=liveAnalysis?.completedReps??engine.qualifyingReps;
  const displayedPhase=liveAnalysis?.phase??engine.phase;
  const displayedHold=liveAnalysis?.currentHoldMs??holdDisplay;
  const rangeText=(range:[number,number])=>`${range[0].toFixed(0)}–${range[1].toFixed(0)}°`;
  const measurementHelp=measurement.reason==="person_ambiguous"?"Keep just one person in view.":measurement.reason==="processing_slow"||measurement.reason==="frames_delayed"?"Pose updates are delayed. Keep the page visible and wait for fresh tracking.":measurement.reason==="torso_unavailable"?"This leg raise also needs your working-side shoulder visible for its torso reference.":`Keep your selected ${side} hip, knee and ankle visible. Choose the leg nearest the camera.`;
  const countingInstruction=!running?"Wait for Gemini to find both positions, then start the set to count movements.":paused?"Counting is paused.":!trace&&!measurement.valid?measurementHelp:!liveConfig?"Waiting for exercise references.":!trace&&!liveAnalysis?"Waiting for Gemini to analyze the first landmark batch.":liveAnalysis?.phase==="uncertain"?liveAnalysis.cue:({
    await_start:`Return to your start reference (${rangeText(liveConfig.startRangeDeg)}) and hold briefly.`,
    armed:"Ready. Move toward your comfortable target.",
    outbound:`Reach your comfortable target (${rangeText(liveConfig.targetRangeDeg)}). Do not force the movement.`,
    holding:`Hold ${seconds(engine.currentHoldMs)} / ${seconds(liveConfig.holdMs)} seconds, then return to start.`,
    returning:`Return to your start reference (${rangeText(liveConfig.startRangeDeg)}) to finish this movement.`,
    return_hold:`Hold the bent position: ${seconds(engine.currentHoldMs)} / ${seconds(liveConfig.flexionHoldMs??0)} seconds.`,
  }[displayedPhase==="uncertain"?"await_start":displayedPhase]);
  const calibrationInstruction=camera.status!=="tracking"?"Enable the camera to begin automatic calibration.":context?.gemini.mode!=="controlled"||context?.gemini.configured!==true?"Gemini is unavailable. You can set references manually, but camera-counted sets need Gemini.":calibration.start===null?"Hold your comfortable resting position; Gemini will average a few checks automatically.":calibration.target===null?"Resting position saved. Move to your comfortable end position and hold it while Gemini settles the estimate.":"Both positions were found. Review them, then start your set.";
  return <div className={styles.workspace}>
    <div className={styles.intro}><div><div className={styles.eyebrow}>Yuvraj / Camera to text</div><h1>Every movement.<br/>A little more clarity.</h1><p>Track your demonstration, see what was measured, and get clear text feedback as you move.</p></div><span className={styles.scope}>Standalone exercise demo</span></div>
    <p className={`${styles.status} ${error?styles.error:""}`} role="status">{error||notice}</p>
    {recovery&&<div className={styles.status}><p>An unfinished set was found on this browser. Save its last known measurements before starting another.</p><button disabled={busy} onClick={()=>void recover()}>Save recovered set</button></div>}
    <div className={styles.layout}><div>
      <section className={styles.panel} aria-label="Live exercise camera">
        <div className={styles.panelHead}><div><h2>Your movement workspace</h2><p>Camera frames stay on this device.</p></div><span className={`${styles.badge} ${trace?styles.badgeAmber:""}`}><span className={styles.dot}/>{trace?"Simulated input":camera.status==="tracking"?"Camera on":"Camera off"}</span></div>
        <div className={styles.stage}>
          <video ref={camera.videoRef} muted playsInline autoPlay style={{transform:"scaleX(-1)"}} aria-label="Live camera preview"/><canvas ref={camera.canvasRef} aria-hidden="true"/>
          {camera.status!=="tracking"&&<div className={styles.stageEmpty}><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="12" width="27" height="24" rx="5" stroke="currentColor" strokeWidth="2"/><path d="m32 20 11-6v20l-11-6" stroke="currentColor" strokeWidth="2"/></svg><h3>{trace?"Example movements":"A clear view starts here"}</h3><p>{trace?"The trace tests the same movement engine. It is always labeled simulated.":staticQuads?"Static quads uses a guided timer and your confirmation. Camera inference cannot verify muscle contraction.":"Place the camera side-on so your working hip, knee and ankle stay visible."}</p></div>}
          <span className={styles.stageLabel}>{trace?"TRACE / SIMULATED":measurement.valid?"WORKING LEG VISIBLE":"POSITION YOUR CAMERA"}</span>
          <div className={styles.stageBottom}><span>{measurement.angle===null?"Angle unavailable":`${measurement.angle.toFixed(0)}° estimated ${exercise==="straight-leg-raise"?"elevation":"knee angle"}`}</span><span>{camera.backend?`${camera.backend} · ${measurement.inferenceMs.toFixed(0)} ms inference`:"No microphone or speech required"}</span></div>
        </div>
        <div className={styles.cameraActions}><button disabled={staticQuads||!context||running||busy||camera.status==="permission"||camera.status==="loading"} onClick={()=>void camera.start()}>{camera.status==="permission"?"Waiting for permission…":camera.status==="loading"?"Loading pose model…":"Enable camera"}</button><button className={styles.outline} onClick={()=>{camera.stop();setMeasurement(empty);if(run.current)void finish("interrupted","patient_stopped");}}>Stop camera</button><small>{trackingProfile.framingInstruction}</small></div>
        {camera.error&&<p className={`${styles.status} ${styles.error}`}>{camera.error}</p>}
        {!staticQuads&&<div className={styles.countingGuide} aria-label="Repetition counting guidance"><strong>{countingInstruction}</strong><p>{running&&liveConfig?`Start ${rangeText(liveConfig.startRangeDeg)} · Target ${rangeText(liveConfig.targetRangeDeg)} · ${side} leg`:camera.status==="tracking"&&!measurement.valid?measurementHelp:"A full movement includes reaching the target and returning to start. The hold target is shown separately."}</p>{attemptNote&&<p>{attemptNote}</p>}</div>}
        <div className={styles.metrics}><div className={styles.metric}><strong>{displayedMovements}</strong><span>Full movements</span></div><div className={styles.metric}><strong>{displayedReps}/{configuration?.targetReps??10}</strong><span>{liveAnalysis?"Gemini estimated reps":"Met demo targets"}</span></div><div className={styles.metric}><strong>{seconds(displayedHold)}s</strong><span>{staticQuads?"Guided hold":"Current hold"}</span></div><div className={styles.metric}><strong>{clock(timing.elapsedTimeMs)}</strong><span>Elapsed time</span></div></div>
      </section>
      <section className={styles.feedback} aria-label="Panda text feedback"><div className={styles.feedbackTop}><span className={styles.eyebrow}>Panda feedback</span><span className={styles.source}>{liveAnalysis?`Gemini rep analysis · ${Math.round(liveAnalysis.confidence*100)}%`:feedback?.textSource==="gemini_selected_approved_variant"?"Gemini selected wording":feedback?.generationStatus==="pending"?"Natural wording pending":"Immediate text"}</span></div><blockquote aria-live="polite">{caption}</blockquote><p>{paused?"Paused":running?displayedPhase.replaceAll("_"," "):"Ready when you are"} · {staticQuads?`Guided time ${clock(timing.guidedTimerMs??0)}`:`Active ${clock(timing.activeTimeMs)} · Paused ${clock(timing.pausedTimeMs)}`}</p></section>
    </div><div className={styles.sideStack}>
      <section className={styles.panel}><div className={styles.panelHead}><div><h2>Set up your demonstration</h2><p>Comfortable references, never a prescription.</p></div></div><div className={styles.setup}>
        <div className={styles.fieldRow}><label>Exercise<select value={exercise} disabled={running||busy||calibrationBusy!==null} onChange={e=>selectExercise(e.target.value as CvExerciseId)}>{context?.exercises.map(item=><option key={item.exerciseId} value={item.exerciseId}>{item.label}</option>)}</select></label><label>Working leg<select value={side} disabled={running||busy||calibrationBusy!==null} onChange={e=>selectSide(e.target.value as "left"|"right")}><option value="left">Left</option><option value="right">Right</option></select></label></div>
        <div className={styles.fieldRow}><label>Pose model<select aria-label="Pose model" value={poseModel} disabled={staticQuads||running||busy||calibrationBusy!==null} onChange={e=>selectPoseModel(e.target.value as PoseModelId)}>{POSE_MODELS.map(model=><option key={model.id} value={model.id}>{model.label}{model.id==="lite"?" (default)":""}</option>)}</select></label></div>
        <p className={styles.footnote}>{staticQuads?"This guided exercise does not need a pose model.":poseModelFor(poseModel).description} Camera frames stay on this device.</p>
        <div className={styles.configNote}>{configuration?.description??"Loading exercise references…"}<br/>{configuration?.targetHoldMs?`${configuration.targetHoldMs/1000}-second demonstration hold · ${configuration.targetReps} target repetitions`:""}</div>
        {!staticQuads&&<div><div className={styles.stepLabel}>Automatic Gemini calibration</div><p className={styles.calibrationInstruction} aria-live="polite">{calibrationBusy==="auto"?`Gemini is checking the live landmark sequence${calibrationConsensus?` · same pose ${calibrationConsensus.count}/3`:""}…`:calibrationConsensus?`Gemini sees the ${calibrationConsensus.position==="rest"?"resting":"comfortable end"} pose · settling estimate ${calibrationConsensus.count}/3`:calibrationInstruction}</p><div className={styles.calibration}>{(["start","target"] as const).map(which=>{const value=calibration[which];const label=which==="start"?"Resting position":"Comfortable target";return <div className={`${styles.calibrationItem} ${value!==null?styles.captured:""}`} key={which}><span>{label}</span><strong>{value===null?"Waiting…":`${value}°`}</strong><small>{calibrationSource[which]?`Detected by ${calibrationSource[which]}. You can override it below.`:which==="start"?"Hold this position until Gemini detects it.":"Move here after the resting position is detected."}</small></div>})}</div><p className={styles.calibrationHint}>Once camera tracking is ready, Gemini reviews eight landmarks across about two seconds and settles each reference from repeated estimates. Camera images stay on this device.</p><details className={styles.calibrationOverride}><summary>Manual override</summary><div className={styles.calibrationActions}><button className={styles.outline} disabled={running||busy||calibrationBusy!==null||camera.status!=="tracking"} onClick={()=>capture("start")}>Use current angle for rest</button><button className={styles.outline} disabled={running||busy||calibrationBusy!==null||camera.status!=="tracking"} onClick={()=>capture("target")}>Use current angle for target</button></div></details></div>}
        {!running?<button className={styles.runButton} disabled={!context||busy||calibrationBusy!==null||!!recovery||(!staticQuads&&!calibrated)} onClick={()=>void begin()}>{busy?"Starting…":"Start set"}</button>:<><div className={styles.progress} role="progressbar" aria-label="Gemini estimated repetition progress" aria-valuemin={0} aria-valuemax={configuration?.targetReps??10} aria-valuenow={displayedReps}><span style={{width:`${Math.min(100,displayedReps/(configuration?.targetReps??10)*100)}%`}}/></div><div className={styles.controls}><button className={styles.secondary} disabled={busy||!!run.current?.terminal} onClick={pauseResume}>{paused?"Resume":"Pause"}</button><button disabled={busy} onClick={()=>void finish()}>{busy?"Saving…":run.current?.terminal?"Retry save":"Finish and save"}</button><button className={styles.danger} disabled={busy} onClick={()=>void finish("cancelled","patient_stopped")}>Cancel set</button></div>{staticQuads&&<button disabled={paused||busy} onClick={guidedHold}>{guided?"Confirm this hold":"Start guided hold"}</button>}<button className={styles.outline} disabled={busy} onClick={()=>void finish("interrupted","discomfort_reported")}>Stop for discomfort</button></>}
        <p className={styles.footnote}>{context?.gemini.configured?`Gemini ready · ${context.gemini.model}${running&&session?.evidence==="camera_estimated"?" · landmark batches sent for AI rep estimates; camera images stay on this device":""}`:"Gemini is off or unconfigured. Camera-counted sets need server-side Gemini analysis."}</p>
      </div></section>
      <section className={`${styles.panel} ${styles.guide}`}><h3>A comfortable setup</h3><ol><li>{trackingProfile.framingInstruction}</li><li>Capture two comfortable references. Change position if tracking is unclear.</li><li>Move, hold and return. A movement and a target-complete repetition are shown separately.</li></ol><p className={styles.footnote}>Camera angles are estimates. Stop if uncomfortable. No clinician acknowledgement or medical correctness is implied.</p></section>
    </div></div>
    <details className={styles.trace}><summary>Try a clearly labeled example trace</summary><p>Test the same evaluator and text pipeline without a camera. Includes a short hold and a full hold. Saved evidence is simulated.</p><button disabled={!context||running||busy||!!recovery||staticQuads} className={styles.outline} onClick={()=>void replay()}>Run sample movements</button></details>
    <section id="history" className={styles.history}><div className={styles.historyHeading}><h2>Saved exercise history</h2><span className={styles.badge}>{reports.length} saved</span></div>{reports.length?<div className={styles.historyGrid}>{[...reports].reverse().map(report=><article key={report.sessionId} className={styles.historyCard}><span className={`${styles.badge} ${report.evidence==="simulated"?styles.badgeAmber:""}`}>{report.evidence.replaceAll("_"," ")}</span><h3>{report.configuration.label}</h3><p><strong>{report.movementCycles} movements · {report.completedReps} met targets</strong></p><p>{report.completionStatus} · Active {clock(report.timing.activeTimeMs)} · Elapsed {clock(report.timing.elapsedTimeMs)}</p><p>{report.shortHolds} short holds · {report.side} leg · demo references</p></article>)}</div>:<p className={styles.emptyHistory}>Your measured or clearly labeled demonstration results will appear here after you save a set.</p>}</section>
    <details className={styles.technical}><summary>Inspect final text and report JSON</summary><pre>{JSON.stringify({feedback,report:lastReport},null,2)}</pre></details>
  </div>;
}
