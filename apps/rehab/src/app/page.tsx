"use client";

import { useEffect, useRef, useState } from "react";
import type { CvChanges, CvContext, CvExerciseConfig, CvExerciseId, CvFeedbackText, CvFinishInput, CvReport, CvSession, CvTiming } from "../../../../packages/contracts/rehab-cv";
import { usePoseCamera, type CameraFrame } from "@/features/camera/use-pose-camera";
import { advanceExercise, advanceTiming, completeGuidedHold, createAngleFilter, createExerciseState, createTimingState, defaultEngineConfig, deriveCalibration, evaluateCalibration, filterAngle, invalidateExercise, measurePose, timingSummary, type AttemptOutcome, type CalibrationSample, type EngineConfig, type ExerciseState, type TimingState } from "@/features/exercise";
import { cvApi, readRecovery, SessionTransport, type MeasurementBody, type Recovery } from "@/features/feedback/session-client";
import styles from "./cv.module.css";

type Run = {
  transport: SessionTransport; config: EngineConfig; engine: ExerciseState; timing: TimingState;
  start: number; paused: boolean; terminal: boolean; finishing: boolean; tracking: boolean;
  frameAt: number; checkpointAt: number; guidedAt: number | null; guidedMs: number;
  cursor: number; polling: boolean; attempts: Map<string,string>; feedbackRanks: Map<string,number>;
  shownRank: number; finishReport: CvFinishInput["report"] | null;
};
const empty = {valid:false,angle:null as number|null,knee:null as number|null,confidence:0,inferenceMs:0};
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

export default function Rehab() {
  const [context,setContext] = useState<CvContext|null>(null);
  const [exercise,setExercise] = useState<CvExerciseId>("seated-knee-extension");
  const [side,setSide] = useState<"left"|"right">("left");
  const [calibration,setCalibration] = useState<{start:number|null;target:number|null}>({start:null,target:null});
  const [measurement,setMeasurement] = useState(empty);
  const [session,setSession] = useState<CvSession|null>(null);
  const [engine,setEngine] = useState(createExerciseState);
  const [timing,setTiming] = useState<CvTiming>({elapsedTimeMs:0,activeTimeMs:0,pausedTimeMs:0,userPausedTimeMs:0,trackingPausedTimeMs:0,otherPausedTimeMs:0});
  const [feedback,setFeedback] = useState<CvFeedbackText|null>(null);
  const [caption,setCaption] = useState("Set up your camera, then capture two comfortable reference positions.");
  const [notice,setNotice] = useState("Loading your standalone demonstration…");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [paused,setPaused] = useState(false);
  const [trace,setTrace] = useState(false);
  const [guided,setGuided] = useState(false);
  const [reports,setReports] = useState<CvReport[]>([]);
  const [recovery,setRecovery] = useState<Recovery|null>(null);
  const [lastReport,setLastReport] = useState<CvReport|null>(null);
  const run = useRef<Run|null>(null);
  const samples = useRef<CalibrationSample[]>([]);
  const filter = useRef(createAngleFilter());
  const selected = useRef({exercise,side}); selected.current={exercise,side};
  const traceTimer = useRef<ReturnType<typeof setInterval>|null>(null);
  const finishAction = useRef<(status?:CvFinishInput["report"]["completionStatus"],reason?:CvFinishInput["report"]["terminationReason"])=>Promise<void>>(async()=>{});
  const mounted = useRef(true);
  const displayedFeedback = useRef<CvFeedbackText|null>(null);
  const configuration = context?.exercises.find(v=>v.exerciseId===exercise);
  const staticQuads = exercise==="static-quads";

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
    let id=r.attempts.get(outcome.attemptId);
    if(!id){id=crypto.randomUUID();r.attempts.set(outcome.attemptId,id);}
    const {reason,...metrics}=outcome;
    const allowed=["tracking_lost","user_pause","short_hold","incomplete_target","knee_bending","target_overshoot"];
    enqueue(r,{type:"attempt_finalized",...metrics,attemptId:id,...(reason?{reason:(allowed.includes(reason)?reason:"tracking_lost") as "tracking_lost"}: {})},now);
  }
  function observe(angle:number|null,knee:number|null,valid:boolean,now:number) {
    const r=run.current;if(!r || r.terminal)return;
    r.frameAt=now;
    if(r.tracking!==valid){r.tracking=valid;enqueue(r,{type:"tracking_changed",valid},now);}
    tick(r,now);
    if(r.paused || r.transport.session.exerciseId==="static-quads")return;
    const result=advanceExercise(r.engine,{atMs:now-r.start,valid,angleDeg:angle,kneeAngleDeg:knee},r.config);
    r.engine=result.state;setEngine(result.state);
    if(result.attempt)saveAttempt(r,result.attempt,now);
    if(result.feedbackCodes.length){const code=result.feedbackCodes.find(c=>c!=="TRACKING_RESTORED")??result.feedbackCodes[0];setCaption(messageFor[code]??"Keep following your comfortable reference positions.");}
  }
  function onFrame(frame:CameraFrame) {
    const choice=selected.current;
    const measured=measurePose(frame.landmarks,choice.side,frame.width,frame.height,{requireTorso:choice.exercise==="straight-leg-raise",personCount:frame.personCount});
    const raw=choice.exercise==="straight-leg-raise"?measured.elevationDeg:measured.kneeAngleDeg;
    filter.current=filterAngle(filter.current,measured.valid?raw:null,frame.timestampMs);
    const angle=filter.current.value;
    samples.current=[...samples.current,{atMs:frame.timestampMs,angleDeg:angle??NaN,valid:measured.valid}].filter(s=>frame.timestampMs-s.atMs<1800);
    setMeasurement({valid:measured.valid,angle,knee:measured.kneeAngleDeg,confidence:measured.confidence,inferenceMs:frame.inferenceMs});
    observe(angle,measured.kneeAngleDeg,measured.valid,frame.timestampMs);
  }
  const camera=usePoseCamera(onFrame,(reason)=>{
    setMeasurement(empty);setCalibration({start:null,target:null});samples.current=[];filter.current=createAngleFilter();
    setNotice(reason);
    if(run.current&&!run.current.terminal)void finishAction.current("interrupted",reason.includes("hidden")?"backgrounded":"model_error");
  });

  useEffect(()=>{
    mounted.current=true;
    void cvApi<CvContext>("/context").then(async value=>{
      if(!mounted.current)return;setContext(value);setRecovery(readRecovery());
      setNotice("Demo references are synthetic. Your live camera measurements stay separate from simulated examples.");
      const history=await cvApi<CvReport[]>("/sessions");if(mounted.current)setReports(history);
    }).catch(e=>setError(e.message));
    return()=>{mounted.current=false;run.current?.transport.dispose();if(traceTimer.current)clearInterval(traceTimer.current);};
  },[]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      const r=run.current;if(!r || r.terminal)return;
      const now=performance.now();
      if(!trace && r.transport.session.exerciseId!=="static-quads" && r.tracking && now-r.frameAt>250){
        r.tracking=false;enqueue(r,{type:"tracking_changed",valid:false},now);
        const invalid=invalidateExercise(r.engine,"sample_gap",now-r.start);r.engine=invalid.state;setEngine(invalid.state);
        if(invalid.attempt)saveAttempt(r,invalid.attempt,now);setCaption(messageFor.TRACKING_LOST);
      }
      const summary=tick(r,now);
      if(now-r.checkpointAt>=1000){r.checkpointAt=now;r.transport.checkpoint(summary,summary.elapsedTimeMs);}
      if(!r.polling){r.polling=true;void cvApi<CvChanges>(`/sessions/${r.transport.session.id}/changes?after=${r.cursor}`).then(change=>{r.cursor=change.nextCursor;for(const item of change.changes)acceptFeedback(item.feedback);}).catch(()=>{}).finally(()=>{r.polling=false;});}
    },200);
    return()=>clearInterval(timer);
  },[trace]);

  function capture(which:"start"|"target") {
    const value=evaluateCalibration(samples.current);
    if(!value.ready || value.angleDeg===null){setError("Keep your working leg clearly visible and still for one second, then capture again.");return;}
    setError("");setCalibration(previous=>({...previous,[which]:Math.round(value.angleDeg!)}));
    setNotice(`${which==="start"?"Starting":"Target"} reference captured. These are comfortable demonstration positions, not a prescription.`);
  }
  function selectExercise(id:CvExerciseId) {setExercise(id);setCalibration({start:null,target:null});setMeasurement(empty);samples.current=[];filter.current=createAngleFilter();setFeedback(null);setCaption("Choose your comfortable start and target references.");}
  async function begin(simulated=false):Promise<Run|null> {
    if(!context || run.current || recovery)return null;
    if(!simulated && !staticQuads && (camera.status!=="tracking" || !measurement.valid || calibration.start===null || calibration.target===null || !deriveCalibration(calibration.start,calibration.target))){setError("Enable tracking and capture two stable, separated reference positions first.");return null;}
    setBusy(true);setError("");
    const start=performance.now();
    try{
      const value=await cvApi<CvSession>("/sessions",{requestId:crypto.randomUUID(),exerciseId:exercise,side,startedAtUtc:new Date().toISOString(),evidence:staticQuads?"patient_reported":simulated?"simulated":"camera_estimated",...(!simulated&&!staticQuads?{calibration:{startAngleDeg:calibration.start,targetAngleDeg:calibration.target}}:{})},context.csrfToken);
      const ranges=deriveCalibration(value.configuration.startAngleDeg,value.configuration.targetAngleDeg);
      const config={...defaultEngineConfig(exercise),holdMs:value.configuration.targetHoldMs,flexionHoldMs:value.configuration.flexionHoldMs,...(ranges?{startRangeDeg:ranges.startRangeDeg,targetRangeDeg:ranges.targetRangeDeg}:{})};
      const transport=new SessionTransport(value,context,acceptFeedback,setError);
      const r:Run={transport,config,engine:createExerciseState(),timing:createTimingState(start),start,paused:false,terminal:false,finishing:false,tracking:false,frameAt:performance.now(),checkpointAt:start,guidedAt:null,guidedMs:0,cursor:0,polling:false,attempts:new Map(),feedbackRanks:new Map(),shownRank:0,finishReport:null};
      run.current=r;setSession(value);setEngine(r.engine);setPaused(false);setFeedback(null);setLastReport(null);setTrace(simulated);
      tick(r,performance.now());
      if(simulated || staticQuads){r.tracking=simulated;enqueue(r,{type:"tracking_changed",valid:simulated||staticQuads},performance.now());}
      setCaption(simulated?"Simulated input is running. These are test movements, not camera observations.":staticQuads?"Start the guided timer, then confirm the hold yourself.":"Return to the start reference, then move toward your comfortable target.");
      setNotice(simulated?"SIMULATED measurement trace — never saved as camera evidence.":"Set started. Text feedback works with sound off.");return r;
    }catch(e){setError(e instanceof Error?e.message:"The set could not start.");return null;}
    finally{setBusy(false);}
  }
  async function finish(status:CvFinishInput["report"]["completionStatus"]="completed",reason:CvFinishInput["report"]["terminationReason"]="finished") {
    const r=run.current;if(!r || r.finishing)return;r.finishing=true;setBusy(true);setError("");
    if(!r.finishReport){
      const now=performance.now();
      if(traceTimer.current){clearInterval(traceTimer.current);traceTimer.current=null;}
      const invalid=invalidateExercise(r.engine,"user_pause",now-r.start);r.engine=invalid.state;
      if(invalid.attempt)saveAttempt(r,invalid.attempt,now);
      if(r.guidedAt!==null){r.guidedMs+=Math.max(0,now-r.guidedAt);r.guidedAt=null;}
      const summary=tick(r,now,true);r.transport.checkpoint(summary,summary.elapsedTimeMs);r.terminal=true;
      r.finishReport={observedEndedAtUtc:new Date().toISOString(),completionStatus:status,terminationReason:reason,timing:summary,timingQuality:"complete"};
      camera.stop();setGuided(false);setTrace(false);
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
    if(!r.paused){const invalid=invalidateExercise(r.engine,"user_pause",now-r.start);r.engine=invalid.state;setEngine(invalid.state);if(invalid.attempt)saveAttempt(r,invalid.attempt,now);if(r.guidedAt!==null){r.guidedAt=null;setGuided(false);}}
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
    const phases=[{ms:600,a:start},{ms:600,a:target},{ms:3000,a:target},{ms:700,a:start},{ms:700,a:start},{ms:600,a:target},{ms:5600,a:target},{ms:700,a:start},{ms:700,a:start},...(exercise==="seated-knee-flexion-extension"?[{ms:5600,a:start}]:[])];
    traceTimer.current=setInterval(()=>{
      if(run.current!==r || r.terminal){if(traceTimer.current)clearInterval(traceTimer.current);return;}
      if(r.paused)return;elapsed+=100;let t=elapsed;let current=phases.at(-1)!;
      for(const phase of phases){current=phase;if(t<=phase.ms)break;t-=phase.ms;}
      const now=performance.now();setMeasurement({valid:true,angle:current.a,knee:165,confidence:1,inferenceMs:0});observe(current.a,165,true,now);
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
        <div className={styles.cameraActions}><button disabled={running||busy||camera.status==="permission"||camera.status==="loading"} onClick={()=>void camera.start()}>{camera.status==="permission"?"Waiting for permission…":camera.status==="loading"?"Loading pose model…":"Enable camera"}</button><button className={styles.outline} onClick={()=>{camera.stop();setMeasurement(empty);if(run.current)void finish("interrupted","patient_stopped");}}>Stop camera</button><small>One person · side view · clear working leg</small></div>
        {camera.error&&<p className={`${styles.status} ${styles.error}`}>{camera.error}</p>}
        <div className={styles.metrics}><div className={styles.metric}><strong>{engine.movementCycles}</strong><span>Full movements</span></div><div className={styles.metric}><strong>{engine.qualifyingReps}/{configuration?.targetReps??10}</strong><span>Met demo targets</span></div><div className={styles.metric}><strong>{seconds(engine.currentHoldMs)}s</strong><span>Current hold</span></div><div className={styles.metric}><strong>{clock(timing.elapsedTimeMs)}</strong><span>Elapsed time</span></div></div>
      </section>
      <section className={styles.feedback} aria-label="Panda text feedback"><div className={styles.feedbackTop}><span className={styles.eyebrow}>Panda feedback</span><span className={styles.source}>{feedback?.textSource==="gemini_selected_approved_variant"?"Gemini selected wording":feedback?.generationStatus==="pending"?"Natural wording pending":"Immediate text"}</span></div><blockquote aria-live="polite">{caption}</blockquote><p>{paused?"Paused":running?engine.phase.replaceAll("_"," "):"Ready when you are"} · {staticQuads?`Guided time ${clock(timing.guidedTimerMs??0)}`:`Active ${clock(timing.activeTimeMs)} · Paused ${clock(timing.pausedTimeMs)}`}</p></section>
    </div><div className={styles.sideStack}>
      <section className={styles.panel}><div className={styles.panelHead}><div><h2>Set up your demonstration</h2><p>Comfortable references, never a prescription.</p></div></div><div className={styles.setup}>
        <div className={styles.fieldRow}><label>Exercise<select value={exercise} disabled={running||busy} onChange={e=>selectExercise(e.target.value as CvExerciseId)}>{context?.exercises.map(item=><option key={item.exerciseId} value={item.exerciseId}>{item.label}</option>)}</select></label><label>Working leg<select value={side} disabled={running||busy} onChange={e=>{setSide(e.target.value as "left"|"right");setCalibration({start:null,target:null});samples.current=[];filter.current=createAngleFilter();}}><option value="left">Left</option><option value="right">Right</option></select></label></div>
        <div className={styles.configNote}>{configuration?.description??"Loading exercise references…"}<br/>{configuration?.targetHoldMs?`${configuration.targetHoldMs/1000}-second demonstration hold · ${configuration.targetReps} target repetitions`:""}</div>
        {!staticQuads&&<div><div className={styles.stepLabel}>Capture stable references</div><div className={styles.calibration}><button className={calibration.start!==null?styles.captured:""} disabled={running||camera.status!=="tracking"} onClick={()=>capture("start")}><span>1. Start position</span><strong>{calibration.start===null?"—":`${calibration.start}°`}</strong><small>Hold still for one second</small></button><button className={calibration.target!==null?styles.captured:""} disabled={running||camera.status!=="tracking"} onClick={()=>capture("target")}><span>2. Comfortable target</span><strong>{calibration.target===null?"—":`${calibration.target}°`}</strong><small>Capture, review, then start</small></button></div></div>}
        {!running?<button className={styles.runButton} disabled={!context||busy||!!recovery||(!staticQuads&&!calibrated)} onClick={()=>void begin()}>{busy?"Starting…":"Start set"}</button>:<><div className={styles.progress} role="progressbar" aria-label="Qualifying repetition progress" aria-valuemin={0} aria-valuemax={configuration?.targetReps??10} aria-valuenow={engine.qualifyingReps}><span style={{width:`${Math.min(100,engine.qualifyingReps/(configuration?.targetReps??10)*100)}%`}}/></div><div className={styles.controls}><button className={styles.secondary} disabled={busy||!!run.current?.terminal} onClick={pauseResume}>{paused?"Resume":"Pause"}</button><button disabled={busy} onClick={()=>void finish()}>{busy?"Saving…":run.current?.terminal?"Retry save":"Finish and save"}</button><button className={styles.danger} disabled={busy} onClick={()=>void finish("cancelled","patient_stopped")}>Cancel set</button></div>{staticQuads&&<button disabled={paused||busy} onClick={guidedHold}>{guided?"Confirm this hold":"Start guided hold"}</button>}<button className={styles.outline} disabled={busy} onClick={()=>void finish("interrupted","discomfort_reported")}>Stop for discomfort</button></>}
        <p className={styles.footnote}>{context?.gemini.configured?`Gemini ready · ${context.gemini.model}`:"Gemini is off or unconfigured. Deterministic text remains available."}</p>
      </div></section>
      <section className={`${styles.panel} ${styles.guide}`}><h3>A comfortable setup</h3><ol><li>Place your camera side-on with your working leg fully visible.</li><li>Capture two comfortable references. Change position if tracking is unclear.</li><li>Move, hold and return. A movement and a target-complete repetition are shown separately.</li></ol><p className={styles.footnote}>Camera angles are estimates. Stop if uncomfortable. No clinician acknowledgement or medical correctness is implied.</p></section>
    </div></div>
    <details className={styles.trace}><summary>Try a clearly labeled example trace</summary><p>Test the same evaluator and text pipeline without a camera. Includes a short hold and a full hold. Saved evidence is simulated.</p><button disabled={!context||running||busy||!!recovery||staticQuads} className={styles.outline} onClick={()=>void replay()}>Run sample movements</button></details>
    <section className={styles.history}><div className={styles.historyHeading}><h2>Saved exercise history</h2><span className={styles.badge}>{reports.length} saved</span></div>{reports.length?<div className={styles.historyGrid}>{[...reports].reverse().map(report=><article key={report.sessionId} className={styles.historyCard}><span className={`${styles.badge} ${report.evidence==="simulated"?styles.badgeAmber:""}`}>{report.evidence.replaceAll("_"," ")}</span><h3>{report.configuration.label}</h3><p><strong>{report.movementCycles} movements · {report.completedReps} met targets</strong></p><p>{report.completionStatus} · Active {clock(report.timing.activeTimeMs)} · Elapsed {clock(report.timing.elapsedTimeMs)}</p><p>{report.shortHolds} short holds · {report.side} leg · demo references</p></article>)}</div>:<p className={styles.emptyHistory}>Your measured or clearly labeled demonstration results will appear here after you save a set.</p>}</section>
    <details className={styles.technical}><summary>Inspect final text and report JSON</summary><pre>{JSON.stringify({feedback,report:lastReport},null,2)}</pre></details>
  </div>;
}
