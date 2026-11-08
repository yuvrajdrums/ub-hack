import { routineExerciseTurn } from "../../../../packages/contracts/exercise-runtime";
import { getGuidedSession,getGuidedFeedback,getGuidedAnalysis,GuidedAnalysisSchema,getGuidedCalibration,GuidedCalibrationSchema } from "../../../../packages/platform/guided-rehab";
import { CvSessionSchema,CvFeedbackSchema,type CvSession,type CvFeedbackText } from "../../../../packages/contracts/rehab-cv";
import { requestsExercise } from "../../../../packages/contracts/exercise-navigation";
import { resolvePlanExercise } from "../../../../packages/rehab-bridge/plan-assignment";
import { randomUUID } from "node:crypto";
import { StartCheckinSchema, OpenExerciseSchema, AnswerCheckinSchema, ContinueCheckinSchema, ExerciseFeedbackSchema,
  type CheckinSession, type PatientMemoryEvent, type MemoryKind } from "../../../../packages/contracts/checkin";
import type { CareSnapshot } from "../../../../packages/contracts/care";
import type { VoiceReply } from "../../../../packages/contracts/voice";
import { ReportSchema, SessionSchema, type Session } from "../../../../packages/contracts/rehab";
import { DomainError } from "../../../../packages/platform/json-store";
import { getCare, callPeer, connected } from "../../../../packages/platform/peers";
import { approvedMedicationTasks } from "../app/today-actions";
import { PatientMemoryRepository, patientMemory, fingerprint, type MemoryTransaction } from "./patient-memory";
import { voice, type voiceService } from "./service";
import {dialogueTurn,medicationLanguage,worseningConcern,symptomConcern,patientQuestion,type DialogueModel,type Move,type Decision} from "./conversation";
import {demoPatientProfile} from "../../../../packages/contracts/fixtures";

type Voice = ReturnType<typeof voiceService>;
type Dependencies = {
  snapshot: () => Promise<CareSnapshot>;
  exerciseSession: (id: string) => Promise<Session>;
  mode: "fixture" | "connected";
  guidedSession?:(id:string)=>Promise<CvSession>;
  guidedCalibration?:(id:string)=>Promise<import("zod").infer<typeof GuidedCalibrationSchema>>;
  guidedAnalysis?:(id:string)=>Promise<import("zod").infer<typeof GuidedAnalysisSchema>>;
  guidedFeedback?:(id:string,eventId:string)=>Promise<CvFeedbackText>;
};
export function polarity(text: string): "yes" | "no" | "unknown" {
  const value = text.toLowerCase().trim();
  if (/\b(not sure|don't know|do not know|maybe|unsure)\b/.test(value)) return "unknown";
  if (/\b(no|nope|not|haven't|didn't|dont|don't|unable|not yet)\b/.test(value)) return "no";
  if (/^(yes|yeah|yep|sure|ready|i have|i did|i took|already taken|taken|done)\b/.test(value)) return "yes";
  return "unknown";
}
function medicationTasks(care: CareSnapshot) {
  return approvedMedicationTasks({plan:care.plan,tasks:care.tasks,help:care.help,mode:"fixture",
    aiEngine:"demo_rules",aiConfigured:true,ttsEngine:"browser",ttsConfigured:true});
}
export function checkinService(
  memory: PatientMemoryRepository = patientMemory,
  assistant: Voice = voice,
  bridge: Dependencies = {
    snapshot: getCare,
    guidedSession:getGuidedSession,guidedFeedback:getGuidedFeedback,guidedAnalysis:getGuidedAnalysis,
    exerciseSession: async id => SessionSchema.parse(await callPeer("rehab","sessions/"+encodeURIComponent(id))),
    mode: connected() ? "connected" : "fixture",
  },
  now = Date.now,
  model:DialogueModel=dialogueTurn,
) {
  const time = () => new Date(now()).toISOString();
  function event(tx: MemoryTransaction, s: CheckinSession, requestId: string, kind: MemoryKind, quote: string,
    source: PatientMemoryEvent["source"] = "patient_report", metadata: Record<string,unknown> = {}) {
    tx.append({id:requestId+":"+kind,patientId:s.patientId,kind,quote,at:time(),source,
      metadata:{checkinId:s.id,planId:s.planId,planVersion:s.planVersion,...metadata}});
  }
  function save(tx: MemoryTransaction,s: CheckinSession) { s.updatedAt=time(); tx.saveSession(s); }
  function reply(s: CheckinSession,message: string,extra: Partial<VoiceReply> = {}): VoiceReply {
    return {mode:bridge.mode,engine:"checkin_workflow",message,checkin:{id:s.id,stage:s.stage},
      ...(s.exerciseSessionId ? {exerciseSessionId:s.exerciseSessionId} : {}),...extra};
  }
  function remaining(s:CheckinSession) {
    return s.medicationIndex<s.medicationTaskIds.length ? "medications" : !s.foodReviewed ? "food" : !s.followupReviewed ? "followup" : (s.concernPending||s.exerciseReviewed)?"complete":"readiness";
  }
  function question(s: CheckinSession,care: CareSnapshot): VoiceReply {
    const task=care.tasks.find(task=>task.id===s.medicationTaskIds[s.medicationIndex]);
    const medicine=task&&medicationLanguage(task,medicationTasks(care),s.medicationDetailsRequired?.includes(task.id));
    const first=demoPatientProfile(care.patientId)?.firstName;
    const subject=/\belbow\b/i.test(care.plan?.sourceText||"")?"your elbow":"you";
    if(s.stage==="greeting")return reply(s,`Hey${first?", "+first:""}, it's Panda. How ${subject==="you"?"are you feeling":"is "+subject+" feeling"} today?`);
    if(s.stage==="wellbeing_followup")return reply(s,s.concernPending?"Let's put the routine questions aside. What would you like to talk through?":"Can you tell me a little more about how it feels?");
    if(s.stage==="medications"&&medicine&&task&&s.medicationDetailsRequired?.includes(task.id))return reply(s,"Your plan now lists "+medicine.exact+". Have you taken that updated dose?");
    if(s.stage==="medications"&&medicine&&task?.status==="completed")return reply(s,"I have "+medicine.spoken+" recorded as taken earlier. Is that still right?");
    if(s.stage==="medications")return reply(s,medicine?`Have you taken ${medicine.spoken} ${medicine.precise?"as listed in your plan":medicine.daypart?"":"today"}?`:"What have you had to eat today?");
    if(s.stage==="medication_confirmation"||s.stage==="help_confirmation")return reply(s,"Would you like me to record that?",{proposalId:s.pendingProposalId});
    if(s.stage==="food")return reply(s,s.foodKnown?"Have you had anything else to eat since your last check-in?":"What have you had to eat today?");
    if(s.stage==="followup")return reply(s,"When would you like your next care-team check-in? I can note a preference, but booking is still pending.");
    if(s.stage==="readiness")return reply(s,"How are you feeling about doing a little exercise?");
    if(s.stage==="exercise"){
      const assignment=resolvePlanExercise(care.plan);
      return assignment.assignment
        ? reply(s,"Let's open the exercise in your approved plan. I'll stay here with you.",{navigation:"/rehab"})
        : reply(s,assignment.message);
    }
    if(s.stage==="exercise_review")return reply(s,"How did that exercise feel?");
    if(s.stage==="pain_check")return reply(s,"Did you notice any pain or discomfort?");
    return reply(s,"We've covered the check-in. What's on your mind?");
  }
  function utterance(tx:MemoryTransaction,s:CheckinSession,id:string,text:string,role:"user"|"assistant") {
    tx.appendDialogue({id:id+":"+role,checkinId:s.id,role,text,at:time()});
  }
  function presented(s:CheckinSession,base:VoiceReply,d:Decision):VoiceReply {
    let response=d.response;
    const advancing=["respond","wellbeing_answer","continue_checkin","med_yes","med_no","med_unsure","food_report","food_unchanged","followup_preference","followup_declined"];
    if(advancing.includes(d.move)&&["medications","food","followup","readiness"].includes(s.stage)&&!response.includes("?"))response=base.message;
    return {...base,engine:d.engine,checkin:{id:s.id,stage:s.stage},...(base.proposalId?{speechText:response,confirmationPrompt:["respond","med_yes","care_request","care_concern","pain_report"].includes(d.move)}:{message:response})};
  }
  function reports(tx:MemoryTransaction) {
    const topics:MemoryKind[]=["wellbeing","food","medication_report","pain_review","exercise_report","exercise_review","exercise_readiness","exercise_feedback"];
    const values=[...topics.flatMap(kind=>tx.events(kind,2)),...tx.events(undefined,10)];
    return [...new Map(values.map(value=>[value.id,value])).values()];
  }
  async function say(tx:MemoryTransaction,s:CheckinSession,care:CareSnapshot,id:string,base:VoiceReply,goal:string,text?:string,signal?:AbortSignal) {
    let d:Decision;
    try { d=await model({care,session:s,history:tx.dialogue(),memory:reports(tx),text,moves:[{id:"respond",goal,fallback:base.message}]},signal); }
    catch(error) {
      // Saving a canonical exercise report must not depend on conversational quota.
      if(s.stage==="exercise_review" && error instanceof DomainError && ["AI_RATE_LIMITED","AI_UNAVAILABLE"].includes(error.code))return base;
      throw error;
    }
    return presented(s,base,d);
  }
  function requireSession(tx: MemoryTransaction,id: string,care: CareSnapshot) {
    const s=tx.session(id);
    if (!s) throw new DomainError("NOT_FOUND","This check-in is not available for the current patient.",404);
    if (!["exercise","exercise_review","pain_check","help_confirmation","complete"].includes(s.stage) &&
      (care.plan?.id !== s.planId || care.plan?.version !== s.planVersion))
      throw new DomainError("CONFLICT","The approved plan changed. Start a refreshed check-in before continuing.");
    return s;
  }
  async function once(raw: {requestId:string}, payload: unknown, signal:AbortSignal|undefined, fn: (tx: MemoryTransaction,care: CareSnapshot)=>Promise<VoiceReply>|VoiceReply) {
    const care=await bridge.snapshot();
    if (!care.plan || care.plan.status !== "approved") throw new DomainError("CONFLICT","An approved plan is required for this check-in.");
    return memory.transaction(care.patientId,async tx => {
      const previous=tx.receipt(raw.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint(payload)) throw new DomainError("CONFLICT","Request ID reused with different check-in input.");
        return previous.result as VoiceReply;
      }
      signal?.throwIfAborted();
      const result=await fn(tx,care);
      signal?.throwIfAborted();
      const callback=payload as {op?:string;event?:{type:string}};
      const silent=callback.op==="exercise-feedback"&&(!["report_saved","guided_report_saved"].includes(callback.event?.type||"")||["help_confirmation","wellbeing_followup"].includes(result.checkin?.stage||""));
      if(result.checkin&&!silent){const session=tx.session(result.checkin.id);if(session){
        const input=payload as {text?:string};if(input.text)utterance(tx,session,raw.requestId,input.text,"user");
        utterance(tx,session,raw.requestId,result.speechText||result.message,"assistant");
      }}
      tx.saveReceipt(raw.requestId,payload,result);
      return result;
    });
  }
  function nextMedication(tx: MemoryTransaction,s: CheckinSession,care: CareSnapshot) {
    s.medicationIndex++;
    s.pendingProposalId=undefined;
    s.stage=remaining(s);
    save(tx,s);
    return question(s,care);
  }
  function rememberReport(tx:MemoryTransaction,s:CheckinSession,captured:Session) {
    if(!captured.report)throw new DomainError("CONFLICT","Rehab has not saved this report yet.");
    const report=ReportSchema.parse(captured.report);
    if(report.planId!==s.planId||report.planVersion!==s.planVersion)throw new DomainError("CONFLICT","Report plan does not match the captured check-in.");
    event(tx,s,"report:"+captured.id,"exercise_report","Rehab report summary: "+report.repetitions+" repetitions; range "+(report.rangeDegrees===null?"unavailable":report.rangeDegrees+" degrees")+"; evidence: "+report.evidence+"; tracking: "+report.trackingQuality+"; ended: "+report.terminationReason+".","rehab_report",{sessionId:captured.id,sourceRoute:"/rehab/api/sessions/"+captured.id,evidence:report.evidence,trackingQuality:report.trackingQuality});
    return report;
  }
  function rememberGuided(tx:MemoryTransaction,s:CheckinSession,captured:CvSession){
    const report=captured.report;if(!report)throw new DomainError("CONFLICT","Rehab has not saved this guided report yet.");
    const ref=captured.careReference;if(!ref||ref.patientId!==s.patientId||ref.planId!==s.planId||ref.planVersion!==s.planVersion)throw new DomainError("CONFLICT","Guided report does not match the captured care context.");
    event(tx,s,"guided-report:"+captured.id,"exercise_report",report.configuration.label+": "+report.movementCycles+" movements, "+report.completedReps+" met demonstration targets; "+report.shortHolds+" short holds; evidence "+report.evidence+"; tracking "+report.trackingQuality+"; ended "+report.terminationReason+".","rehab_report",{sessionId:captured.id,sourceRoute:"/rehab/api/cv/v1/sessions/"+captured.id,evidence:report.evidence,configurationMode:report.configurationMode,report});
    return report;
  }
  function guidedReportSummary(report:NonNullable<CvSession["report"]>) {
    const status=report.completionStatus==="completed"?"Set complete":"Set saved as incomplete";
    const evidence=report.evidence==="camera_estimated"?"Camera estimate":"Evidence: "+report.evidence.replaceAll("_"," ");
    const tracking=report.trackingQuality.replaceAll("_"," ");
    const range=report.rangeDegrees===null?"Range estimate unavailable.":"Estimated range "+Math.round(report.rangeDegrees)+" degrees.";
    const stop=report.terminationReason==="discomfort_reported"
      ? "We stopped for discomfort. Keep the exercise paused and tell me what felt uncomfortable. "
      : report.completionStatus==="completed"?"":"The set ended early. ";
    return `${stop}${report.configuration.label}. ${status}: ${report.completedReps} of ${report.targetReps} demonstration targets met across ${report.movementCycles} movement cycles; ${report.shortHolds} short holds. ${evidence}; tracking ${tracking}. ${range} Demonstration targets are examples, not a prescription or clinical validation. How did that feel?`;
  }
  function currentSession(tx:MemoryTransaction,care:CareSnapshot,requestId:string){
        let s=tx.latestSession();
        const changed=s && (s.planId !== care.plan!.id || s.planVersion !== care.plan!.version);
        const tooOld=s && now()-Date.parse(s.updatedAt)>24*60*60*1000;
        if (!s || s.endedAt || s.stage==="complete" || changed || tooOld || (s.agendaVersion!==2&&!s.pendingProposalId&&!s.exerciseSessionId)) {
          const meds=medicationTasks(care);
          const baseline=tx.events("medication_context",200);
          const required=meds.filter(task=>{const current=medicationLanguage(task,meds);const old=baseline.find(e=>e.metadata.name===current.key);return Boolean(old&&old.metadata.title!==task.title);}).map(t=>t.id);
          s={id:randomUUID(),patientId:care.patientId,planId:care.plan!.id,planVersion:care.plan!.version,
            stage:"greeting",agendaVersion:2,foodReviewed:false,followupReviewed:false,foodKnown:tx.events("food").some(e=>time().slice(0,10)===e.at.slice(0,10)),concernPending:care.help.some(h=>h.status==="open"&&worseningConcern(h.quote)),medicationDetailsRequired:required,medicationTaskIds:meds.map(t=>t.id),medicationIndex:0,startedAt:time(),updatedAt:time()};
          save(tx,s);
          for(const task of meds)event(tx,s,requestId+":"+task.id,"medication_context",task.title,"system",{name:medicationLanguage(task,meds).key,title:task.title});
        }
    return s;
  }
  function enterExercise(tx:MemoryTransaction,s:CheckinSession,care:CareSnapshot,requestId:string,text?:string):VoiceReply {
    if(s.pendingProposalId)return {...question(s,care),message:"Before starting a set, let's resolve the action we were confirming."};
    if(s.concernPending)return reply(s,"Let's keep exercise on hold while we talk through your concern.",{pauseExercise:true});
    const assignment=resolvePlanExercise(care.plan);
    if(!assignment.assignment)return reply(s,assignment.message);
    if(["exercise_review","pain_check"].includes(s.stage))return {...question(s,care),navigation:"/rehab"};
    if(s.stage!=="exercise"){
      if(s.exerciseReviewed){s.exerciseSessionId=undefined;s.exerciseFeature=undefined;s.exerciseLabel=undefined;}
      if(["greeting","wellbeing_followup","medications","food","followup"].includes(s.stage))s.exerciseResumeStage=["greeting","wellbeing_followup"].includes(s.stage)?remaining(s):s.stage;
      s.stage="exercise";s.exerciseReviewed=false;
      event(tx,s,requestId,"checkin_review",text||"Opened guided exercise from the home action.",text?"patient_report":"client_observation",{topic:"exercise_navigation",unfinishedCheckinsPreserved:true});save(tx,s);
    }
    return question(s,care);
  }
  return {
    async openExercise(raw:unknown,signal?:AbortSignal){
      const v=OpenExerciseSchema.parse(raw);
      if(v.text&&!requestsExercise(v.text))throw new DomainError("VALIDATION_ERROR","Use an explicit request to open exercise.",400);
      return once(v,{op:"open-exercise",...v},signal,(tx,care)=>enterExercise(tx,currentSession(tx,care,v.requestId),care,v.requestId,v.text));
    },
    async start(raw: unknown,signal?:AbortSignal) {
      const v=StartCheckinSchema.parse(raw);
      return once(v,{op:"start",...v},signal,async(tx,care) => {
        const s=currentSession(tx,care,v.requestId);
        if (["medication_confirmation","help_confirmation"].includes(s.stage) && s.pendingProposalId) {
          const pending=await assistant.proposalStatus(s.pendingProposalId,care.patientId);
          if (!pending || (pending.confirmedAt===undefined && !pending.result && pending.expiresAt<=now())) {
            s.pendingProposalId=undefined;s.stage=s.stage==="medication_confirmation"?"medications":"pain_check";save(tx,s);
          }
        }
        let base=question(s,care);
        if(s.pendingProposalId){
          const pending=await assistant.proposalStatus(s.pendingProposalId,care.patientId);
          if(pending?.command.name==="confirm_task"){const taskId=pending.command.args.taskId;base={...base,message:"Record your completion of “"+care.tasks.find(t=>t.id===taskId)?.title+"”? This is patient-reported."};}
          else if(pending?.command.name==="request_help")base={...base,message:"Record this for care-team review? “"+pending.command.args.quote+"”"};
        }
        if(s.stage==="exercise")return reply(s,"I'm here. Would you like to continue your exercise, or talk about something else?");
        return say(tx,s,care,v.requestId,base,s.stage==="greeting"?"Greet warmly as Panda, ask how the documented elbow/body part feels. If a prior concern is pending acknowledge it gently. No checklist, medicines, meals or booking at hello.":"Resume the actual unfinished topic naturally. Do not restart completed items or recite the plan. Pending action details remain in the visible proposal.",undefined,signal);
      });
    },
    async answer(raw: unknown,signal?:AbortSignal) {
      const v=AnswerCheckinSchema.parse(raw);
      const currentCare=await bridge.snapshot();
      const previous=await memory.transaction(currentCare.patientId,tx=>tx.receipt(v.requestId));
      if (previous) {
        if (previous.fingerprint!==fingerprint({op:"answer",...v})) throw new DomainError("CONFLICT","Request ID reused with different check-in input.");
        return previous.result as VoiceReply;
      }
      return once(v,{op:"answer",...v},signal,async(tx,care)=>{
        const s=requireSession(tx,v.checkinId,care);
        if(s.stage==="exercise" && v.exerciseContext && !s.concernPending && !s.pendingProposalId && !symptomConcern(v.text)) {
          if(v.expectedStage && v.expectedStage!==s.stage)throw new DomainError("CONFLICT","The conversation moved to another step. Resume it before answering.");
          const routine=routineExerciseTurn(v.text,v.exerciseContext);
          if(routine) { save(tx,s); return reply(s,routine.message,routine.control?{exerciseControl:{id:v.requestId,action:routine.control}}:{}); }
        }
        if(requestsExercise(v.text))return enterExercise(tx,s,care,v.requestId,v.text);
        if(v.expectedStage&&s.stage!==v.expectedStage)throw new DomainError("CONFLICT","The conversation moved to another step. Resume it before answering.");
        if(s.agendaVersion!==2&&!s.pendingProposalId){s.agendaVersion=2;s.medicationTaskIds=medicationTasks(care).map(t=>t.id);s.medicationIndex=0;s.foodReviewed=false;s.followupReviewed=false;}
        const next={...s,medicationIndex:s.medicationIndex+1};
        const task=care.tasks.find(t=>t.id===s.medicationTaskIds[s.medicationIndex]);
        const med=task&&medicationLanguage(task,medicationTasks(care),s.medicationDetailsRequired?.includes(task.id));
        const goal=(stage:CheckinSession["stage"])=>question({...s,stage},care).message;
        const moves:Move[]=[
          {id:"question",goal:"Answer the patient's actual question from documented facts and attributed reports. If diagnosis/procedure is missing say so, without guessing or dumping instructions. Stay with their question; don't advance the check-in.",fallback:"I can help with what's in your plan, but I don't have a diagnosis or procedure recorded here. What would you like to know?"},
          {id:"chat",goal:"Respond briefly to a social/ambiguous turn. Do not close the call while routine topics are pending. If the patient says they have no questions or wants to move on, choose continue_checkin instead. Do not mark any check-in answered.",fallback:s.stage==="complete"?"I'm here. What would you like to talk about?":question(s,care).message},
          {id:"care_request",goal:"Acknowledge their explicit wish to contact the care team. Ask permission to record the exact concern for review, never claim delivery or acknowledgement.",fallback:"Would you like me to record that for your care team to review?"},
          {id:"care_concern",goal:"Their pain is worsening or concerning. Put exercise and routine questions aside. Acknowledge it, suggest contacting their care team promptly, and ask permission to record their exact words for review. This app is not monitored, so don't imply this request replaces getting medical help.",fallback:"I'm sorry the pain is getting worse. Let's pause the exercise and contact your care team promptly. Would you like me to record what you've told me for their review?"},
          {id:"symptom_detail",goal:"Acknowledge the discomfort in their own words and ask ONE relevant follow-up about what changed or when it started. Pause routine check-in questions and don't diagnose or reassure.",fallback:/\bsullen\b/i.test(v.text)?"Did you mean your elbow is swollen?":"I'm sorry it's bothering you. What's changed since we last spoke?"},
        ];
        if(["greeting","wellbeing_followup"].includes(s.stage))moves.push({id:"wellbeing_answer",goal:"Acknowledge how they feel, then ASK the next routine question: "+goal(remaining(s))+". An older pending concern holds exercise, but does NOT cancel medicine, food or follow-up checks. Do not end with an open invitation instead of this question.",fallback:"Good to hear how you're doing. "+goal(remaining(s))});
        if(!s.pendingProposalId&&s.stage!=="exercise")moves.push({id:"continue_checkin",goal:"They have no more questions, thanked you, or asked to move on. Do not say goodbye. ASK this next required question: "+goal(remaining(s)),fallback:goal(remaining(s))});
        if(!s.pendingProposalId&&(/\b(?:bye|goodbye|good night|end (?:the |this )?call|stop (?:the |this )?(?:call|conversation)|hang up)\b/i.test(v.text)||s.stage==="complete"))moves.push({id:"end_call",goal:"They explicitly want to end the call (or all check-ins are covered and they are saying goodbye). Give a short warm goodbye, do not ask another question. Never mark unanswered topics completed.",fallback:"Take care. We can pick up again whenever you're ready."});
        if(s.stage==="medications")moves.push(
          {id:"med_yes",goal:`They clearly report taking the medicine. Acknowledge briefly. ${task?.status==="completed"?"The task is ALREADY completed; do not propose or record it again. Ask the next food question: "+goal(remaining(next)):"Ask if you should mark "+(med?.spoken||"it")+" taken. This creates a proposal, not a saved Care action."}`,fallback:task?.status==="completed"?"Got it. "+goal(remaining(next)):`Got it. Shall I mark ${med?.spoken||"it"} as taken?`},
          {id:"med_no",goal:"They have not taken it. Acknowledge without judgment or catch-up dosing advice, then move to: "+goal(remaining(next)),fallback:"Okay, thanks for letting me know. "+goal(remaining(next))},
          {id:"med_unsure",goal:"They are unsure. Do not mark the task done or recommend another dose. Acknowledge uncertainty and move gently to: "+goal(remaining(next)),fallback:"That's okay—let's leave it unconfirmed. "+goal(remaining(next))});
        if(s.stage==="food"&&s.foodKnown)moves.push({id:"food_unchanged",goal:"They have eaten nothing more since the meal already recorded. Retain that meal; do not save no/unchanged as a food. ASK the next follow-up question: "+goal("followup"),fallback:"Okay. "+goal("followup")});
        if(s.stage==="food")moves.push({id:"food_report",goal:"They reported a meal/snack or not eating. Acknowledge what they actually said without judging it. Then ask this one next question: "+goal("followup")+". Booking availability is pending; do not announce it unless they asked about booking.",fallback:"Got it. "+goal("followup")});
        if(s.stage==="followup")moves.push(
          {id:"followup_preference",goal:"They give a preferred next check-in time. Note it as a preference only; booking is NOT connected. "+(s.concernPending?"Exercise remains on hold for the concern; say that briefly, then the routine checks are covered.":"ASK whether they are ready for exercise: "+goal("readiness")),fallback:s.concernPending?"I've noted that preference; it isn't booked. Let's leave exercise on hold while your care concern is reviewed. Anything else before we finish?":"I've noted that preference; it isn't booked. "+goal("readiness")},
          {id:"followup_declined",goal:"They don't want a follow-up or don't have a time yet. Record that without booking. "+(s.concernPending?"Keep exercise on hold for the concern and briefly wrap up the completed routine checks.":"ASK about exercise readiness: "+goal("readiness")),fallback:s.concernPending?"Okay. We'll keep exercise on hold for now. Anything else before we finish?":"Okay. "+goal("readiness")});
        if(s.stage==="readiness"||s.stage==="complete"&&!s.concernPending)moves.push({id:"ready_yes",goal:s.concernPending?"Do not open exercise with an unresolved worsening-pain concern. Keep the conversation with their care concern.":"Only select this if they clearly want to start exercise now. Say you'll stay with them and open the exercise workspace; don't claim measured feedback or correct technique.",fallback:"Let's open the exercise. I'll stay here with you."},{id:"ready_no",goal:"They aren't ready or prefer to talk. Don't close the conversation. Acknowledge and invite their questions; no booking status recitation.",fallback:"No rush—we can leave exercise for later. What would you like to talk about?"});
        if(s.stage==="exercise_review")moves.push({id:"review",goal:"Acknowledge how the session felt specifically, then ask whether there was any pain or discomfort. Don't call the exercise beneficial or correct.",fallback:"Thanks for telling me. Did you notice any pain or discomfort?"});
        if(s.stage==="pain_check")moves.push({id:"pain_none",goal:"They report no pain/discomfort. Acknowledge briefly and leave the conversation open for their questions. No redundant medical/scheduling boilerplate.",fallback:"Good to know. Is there anything else you'd like to talk through?"},{id:"pain_report",goal:"They described pain/discomfort. Acknowledge, suggest stopping exercise, and offer to record their exact words for care-team review. Do not diagnose or claim someone has been notified.",fallback:"Let's leave exercise there. Would you like me to record that discomfort for your care team to review?"},{id:"pain_more",goal:"They said there was pain but haven't described it. Ask one natural follow-up, not a yes/no form prompt.",fallback:"Can you tell me what the discomfort felt like?"});
        const wantsEnd=/\b(?:bye|goodbye|good night|end (?:the |this )?call|stop (?:the |this )?(?:call|conversation)|hang up)\b/i.test(v.text);
        const resume=!patientQuestion(v.text)&&(/\b(?:let.s (?:go on|move on|continue)|go on|move on)\b/i.test(v.text)||["greeting","wellbeing_followup"].includes(s.stage)&&/\b(?:no (?:more |other )?questions|nothing else|(?:don.t|do not) (?:think I )?(?:have|need) anything else|thank you|thanks)\b/i.test(v.text));
        if(s.exerciseReviewed&&s.stage==="followup")for(const move of moves)if(["followup_preference","followup_declined"].includes(move.id)){move.goal="Acknowledge their preference without claiming a booking. Exercise was already reviewed. Briefly wrap up the completed check-in and invite remaining questions.";move.fallback="I've noted that. Booking is still pending. We've covered today's check-in—anything else on your mind?";}
        const allowed=worseningConcern(v.text)?moves.filter(m=>m.id==="care_concern") : wantsEnd&&moves.some(m=>m.id==="end_call")?moves.filter(m=>m.id==="end_call") : resume&&!["followup","complete","exercise"].includes(s.stage)&&!s.pendingProposalId?moves.filter(m=>m.id==="continue_checkin"):moves;
        let d:Decision;
        try {
          const concern = worseningConcern(v.text) ? allowed.find(move=>move.id==="care_concern") : undefined;
          d = concern ? {move:concern.id,response:concern.fallback,foodQuote:null,engine:"checkin_workflow"} : await model({care,session:s,history:tx.dialogue(),memory:reports(tx),text:v.text,moves:allowed,exerciseContext:v.exerciseContext},signal);
        }
        catch(error) {
          const reviewMove = !patientQuestion(v.text) && !/^(hi|hey|hello)\b/i.test(v.text.trim()) && s.stage==="exercise_review" ? moves.find(move=>move.id==="review") : s.stage==="pain_check" && /^(?:no|none|nope)\b/i.test(v.text.trim()) && !symptomConcern(v.text) ? moves.find(move=>move.id==="pain_none") : undefined;
          if(reviewMove && error instanceof DomainError && ["AI_RATE_LIMITED","AI_UNAVAILABLE"].includes(error.code)) d={move:reviewMove.id,response:reviewMove.fallback,foodQuote:null,engine:"checkin_workflow"};
          else if(s.stage==="exercise" && !symptomConcern(v.text) && error instanceof DomainError && error.code==="AI_RATE_LIMITED")
            return reply(s,"I couldn't answer that question just now. You can still use the exercise controls.");
          else throw error;
        }
        if(!allowed.some(m=>m.id===d.move)||d.foodQuote&&!v.text.includes(d.foodQuote))throw new DomainError("VALIDATION_ERROR","Unsupported conversation decision or patient quote.",400);
        let base=question(s,care);
        if(d.foodQuote&&!["question","care_concern","symptom_detail","care_request"].includes(d.move)){
          event(tx,s,v.requestId,"food",d.foodQuote);s.foodKnown=true;
        }
        if(d.move==="care_concern"||d.move==="care_request"||d.move==="pain_report"){
          if(d.move!=="care_request"){s.concernPending=true;event(tx,s,v.requestId,"pain_review",v.text,"patient_report",{possibleDiscomfort:true,worsening:d.move==="care_concern"});}
          base=await assistant.turn({requestId:v.requestId,text:v.text},undefined,{name:"request_help",args:{quote:v.text}});
          s.pendingProposalId=base.proposalId;s.stage="help_confirmation";
        }else if(d.move==="symptom_detail"){
          event(tx,s,v.requestId,"wellbeing",v.text);s.stage="wellbeing_followup";
        }else if(d.move==="wellbeing_answer"||d.move==="continue_checkin"){
          if(d.move==="wellbeing_answer")event(tx,s,v.requestId,"wellbeing",v.text);s.stage=remaining(s);base=question(s,care);
        }else if(["med_yes","med_no","med_unsure"].includes(d.move)){
          if(!task)throw new DomainError("CONFLICT","Medication task changed. Start a refreshed conversation.");
          event(tx,s,v.requestId,"medication_report",v.text,"patient_report",{taskId:task.id,answer:d.move.slice(4),careStatus:task.status});
          if(d.move==="med_yes"&&task.status==="pending"){
            base=await assistant.turn({requestId:v.requestId,text:v.text},undefined,{name:"confirm_task",args:{taskId:task.id,expectedRevision:task.revision}});
            s.pendingProposalId=base.proposalId;s.stage="medication_confirmation";
          }else{base=nextMedication(tx,s,care);}
        }else if(d.move==="food_unchanged"){
          event(tx,s,v.requestId,"checkin_review",v.text,"patient_report",{topic:"food",unchanged:true});s.foodReviewed=true;s.stage="followup";base=question(s,care);
        }else if(d.move==="food_report"){
          if(!d.foodQuote){event(tx,s,v.requestId,"food",v.text);s.foodKnown=true;}
          event(tx,s,v.requestId,"scheduling_pending","Doctor availability is not connected; no follow-up was booked.","system",{booked:false});
          s.foodReviewed=true;s.stage="followup";base=question(s,care);
        }else if(d.move==="followup_preference"||d.move==="followup_declined"){
          event(tx,s,v.requestId,"scheduling_pending",v.text,"patient_report",{requested:d.move==="followup_preference",booked:false});s.followupReviewed=true;s.stage=(s.concernPending||s.exerciseReviewed)?"complete":"readiness";base=question(s,care);
        }else if(d.move==="end_call"){
          s.endedAt=time();base=reply(s,d.response,{conversationEnded:true});
        }else if(d.move==="ready_yes"||d.move==="ready_no"){
          event(tx,s,v.requestId,"exercise_readiness",v.text,"patient_report",{ready:d.move==="ready_yes"&&!s.concernPending});
          s.stage=s.concernPending?"wellbeing_followup":d.move==="ready_yes"?"exercise":"complete";
          base=question(s,care);
        }else if(d.move==="review"){
          event(tx,s,v.requestId,"exercise_review",v.text,"patient_report",{sessionId:s.exerciseSessionId});s.stage="pain_check";
        }else if(d.move==="pain_more"){
          event(tx,s,v.requestId,"pain_review",v.text,"patient_report",{sessionId:s.exerciseSessionId,reportedPain:true});s.painReported=true;
        }else if(d.move==="pain_none"){
          event(tx,s,v.requestId,"pain_review",v.text,"patient_report",{sessionId:s.exerciseSessionId,possibleDiscomfort:false});s.exerciseReviewed=true;
          if(s.exerciseResumeStage){s.stage=s.exerciseResumeStage;s.exerciseResumeStage=undefined;save(tx,s);return {...question(s,care),message:"Thanks for letting me know. "+question(s,care).message};}
          s.stage="complete";
        }
        save(tx,s);
        if(s.pendingProposalId){
          base={...base,proposalId:s.pendingProposalId};
          const pending=await assistant.proposalStatus(s.pendingProposalId,care.patientId);
          if(pending?.command.name==="confirm_task"){const taskId=pending.command.args.taskId;base.message="Record your completion of “"+care.tasks.find(t=>t.id===taskId)?.title+"”? This is patient-reported.";}
          else if(pending?.command.name==="request_help")base.message="Record this for care-team review? “"+pending.command.args.quote+"”";
        }
        return {...presented(s,base,d),...(["care_concern","symptom_detail","pain_report"].includes(d.move)?{pauseExercise:true}:{})};
      });
    },
    async continueAfterConfirmation(raw: unknown,signal?:AbortSignal) {
      const v=ContinueCheckinSchema.parse(raw);
      const care=await bridge.snapshot();
      const proposal=await assistant.proposalResult(v.proposalId,care.patientId);
      if (!proposal) throw new DomainError("CONFLICT","The action has no saved result yet. Confirm or dismiss it first.");
      return once(v,{op:"continue",...v},signal,async(tx,current) => {
        const s=requireSession(tx,v.checkinId,current);
        if (s.pendingProposalId!==v.proposalId) throw new DomainError("CONFLICT","This proposal does not belong to the active check-in step.");
        const sent=proposal.confirmedAt!==undefined;
        utterance(tx,s,v.requestId,v.confirmationText||(sent?"Confirm action":"Dismiss action"),"user");
        if (s.stage==="medication_confirmation") {
          event(tx,s,v.requestId,"medication_report",sent ? "Patient confirmed the preceding medication self-report." : "Patient dismissed the medication completion proposal.",
            "system",{proposalId:v.proposalId,careWrite:sent && bridge.mode==="connected",dryRun:bridge.mode==="fixture"});
          const next=nextMedication(tx,s,current);
          return say(tx,s,current,v.requestId,next,(sent?(bridge.mode==="fixture"?"This was only a dry run; no Care record changed.":"The medication self-report was recorded successfully."):"The patient dismissed the medication action; no completion was recorded.")+" Acknowledge briefly and continue with just this next topic: "+next.message,undefined,signal);
        }
        if (s.stage!=="help_confirmation") throw new DomainError("CONFLICT","No confirmation is pending in this step.");
        s.pendingProposalId=undefined; s.stage=s.concernPending?"wellbeing_followup":"complete"; save(tx,s);
        return say(tx,s,current,v.requestId,reply(s,proposal.result!.message),"Actual action outcome: "+proposal.result!.message+". Say plainly whether it was only a dry run, recorded for review, or dismissed. A recorded request has NOT been acknowledged, delivered or reviewed. Don't imply care is coming or this is monitored. Keep the conversation open; don't jump into exercises/checklists after a concern.",undefined,signal);
      });
    },
    async exerciseFeedback(raw: unknown,signal?:AbortSignal) {
      const v=ExerciseFeedbackSchema.parse(raw);
      const care=await bridge.snapshot();
      const isGuided=v.event.type.startsWith("guided_");
      const guided=isGuided&&"sessionId" in v.event?CvSessionSchema.parse(await (bridge.guidedSession||getGuidedSession)(v.event.sessionId)):undefined;
      const calibrationResult=v.event.type==="guided_calibration"?GuidedCalibrationSchema.parse(await (bridge.guidedCalibration||getGuidedCalibration)(v.event.calibrationId)):undefined;
      const cue=v.event.type==="guided_feedback"?CvFeedbackSchema.parse(await (bridge.guidedFeedback||getGuidedFeedback)(v.event.sessionId,v.event.feedbackId)):undefined;
      const analysisResult=v.event.type==="guided_analysis"?GuidedAnalysisSchema.parse(await (bridge.guidedAnalysis||getGuidedAnalysis)(v.event.sessionId)):undefined;
      const captured=(!isGuided&&"sessionId" in v.event) ? SessionSchema.parse(await bridge.exerciseSession(v.event.sessionId)) : undefined;
      if (captured && captured.patientId!==care.patientId) throw new DomainError("FORBIDDEN","Exercise session belongs to a different patient.",403);
      return once(v,{op:"exercise-feedback",...v},signal,async(tx,current) => {
        const s=requireSession(tx,v.checkinId,current);
        if(calibrationResult){
          const ref=calibrationResult.careReference;if(!ref||ref.patientId!==current.patientId||ref.planId!==s.planId||ref.planVersion!==s.planVersion)throw new DomainError("FORBIDDEN","Calibration belongs to another care context.",403);
          if(s.stage!=="exercise"||s.concernPending||now()-Date.parse(calibrationResult.acceptedAt)>10000)return question(s,current);
          const result=calibrationResult.result;if(tx.events("exercise_feedback",200).some(e=>e.metadata.calibrationId===calibrationResult.calibrationId))return question(s,current);
          event(tx,s,"guided-calibration:"+calibrationResult.calibrationId,"exercise_feedback",result.cue||"Calibration updated.","rehab_report",{calibrationId:calibrationResult.calibrationId,textSource:"gemini_calibration",detectedPosition:result.detectedPosition,angleDeg:result.angleDeg,confidence:result.confidence,exerciseId:calibrationResult.exerciseId,side:calibrationResult.side});
          if(!result.cue)return question(s,current);
          return reply(s,result.cue,{exerciseCue:{eventId:calibrationResult.calibrationId,code:"GEMINI_CALIBRATION",setupPosition:result.detectedPosition,expiresAt:new Date(Date.parse(calibrationResult.acceptedAt)+10000).toISOString()}});
        }
        if(guided){
          const ref=guided.careReference;
          if(!ref||ref.patientId!==current.patientId||ref.planId!==s.planId||ref.planVersion!==s.planVersion)throw new DomainError("FORBIDDEN","Guided session does not belong to this patient and care context.",403);
          if(s.exerciseSessionId&&s.exerciseSessionId!==guided.id)throw new DomainError("CONFLICT","Guided feedback belongs to a different exercise session.");
          if(s.stage!=="exercise"){
            if(v.event.type==="guided_report_saved"&&["exercise_review","pain_check","help_confirmation","wellbeing_followup","complete"].includes(s.stage)){rememberGuided(tx,s,guided);return question(s,current);}
            throw new DomainError("CONFLICT","No guided exercise is active in this check-in.");
          }
          s.exerciseSessionId=guided.id;s.exerciseFeature="guided";s.exerciseLabel=guided.configuration.label;save(tx,s);
          if(v.event.type==="guided_report_saved"){
            const report=rememberGuided(tx,s,guided);if(report.terminationReason==="discomfort_reported")s.concernPending=true;s.stage="exercise_review";save(tx,s);
            return reply(s,guidedReportSummary(report));
          }
          if(analysisResult&&v.event.type==="guided_analysis"){
            if(analysisResult.batchSequence!==v.event.batchSequence||analysisResult.session.id!==guided.id||analysisResult.sessionControlRevision!==guided.sessionControlRevision||guided.status!=="running"||now()-Date.parse(analysisResult.acceptedAt)>10000)return question(s,current);
            const analysis=analysisResult.analysis;const batchSequence=v.event.batchSequence;
            if(tx.events("exercise_feedback",200).some(e=>e.metadata.analysisBatchSequence===batchSequence&&e.metadata.sessionId===guided.id))return question(s,current);
            event(tx,s,"guided-analysis:"+guided.id+":"+v.event.batchSequence,"exercise_feedback",analysis.cue||"Movement analysis updated.","rehab_report",{sessionId:guided.id,analysisBatchSequence:v.event.batchSequence,textSource:"gemini_rep_analysis",confidence:analysis.confidence,phase:analysis.phase,completedReps:analysis.completedReps,movementCycles:analysis.movementCycles,shortHolds:analysis.shortHolds,rangeDegrees:analysis.rangeDegrees,sourceRoute:"/rehab/api/cv/v1/sessions/"+guided.id+"/analysis"});
            if(!analysis.cue)return question(s,current);
            return reply(s,analysis.cue,{exerciseCue:{eventId:guided.id+":"+v.event.batchSequence,code:"GEMINI_ANALYSIS",expiresAt:new Date(Date.parse(analysisResult.acceptedAt)+10000).toISOString()}});
          }
          if(cue){
            if(cue.generationStatus!=="complete"||cue.sessionId!==guided.id||cue.sessionControlRevision!==guided.sessionControlRevision||guided.status!=="running"||cue.expiresAtUtc&&Date.parse(cue.expiresAtUtc)<=now())return question(s,current);
            const seen=tx.events("exercise_feedback",200).some(e=>e.metadata.feedbackId===cue.eventId);
            if(seen)return question(s,current);
            event(tx,s,"guided-cue:"+cue.eventId,"exercise_feedback",cue.text,"rehab_report",{sessionId:guided.id,feedbackId:cue.eventId,code:cue.feedbackCode,evidence:cue.evidence,textSource:cue.textSource,textRevision:cue.textRevision,phraseId:cue.phraseId,fallbackReason:cue.fallbackReason,sourceRoute:"/rehab/api/cv/v1/sessions/"+guided.id+"/feedback/"+cue.eventId});
            return reply(s,cue.text,{exerciseCue:{eventId:cue.eventId,code:cue.feedbackCode,expiresAt:cue.expiresAtUtc}});
          }
          return question(s,current);
        }
        if (s.stage!=="exercise") {
          if (v.event.type==="camera_status") return question(s,current);
          if (v.event.type==="report_saved" && captured && captured.id===s.exerciseSessionId && ["exercise_review","pain_check","help_confirmation","wellbeing_followup","complete"].includes(s.stage)) {rememberReport(tx,s,captured);return question(s,current);}
          throw new DomainError("CONFLICT","No exercise is active in this check-in.");
        }
        if (v.event.type==="session_started") {
          if (!captured || captured.planId!==s.planId || captured.planVersion!==s.planVersion)
            throw new DomainError("CONFLICT","Exercise session does not match the captured plan.");
          if (s.exerciseSessionId && s.exerciseSessionId!==captured.id) throw new DomainError("CONFLICT","Finish the current exercise session before starting another.");
          s.exerciseSessionId=captured.id;
        } else if (v.event.type==="report_saved") {
          if (!captured?.report) throw new DomainError("CONFLICT","Rehab has not saved this report yet.");
          if (s.exerciseSessionId && s.exerciseSessionId!==captured.id) throw new DomainError("CONFLICT","Report does not match this exercise check-in.");
          const report=rememberReport(tx,s,captured);
          s.exerciseSessionId=captured.id;
          s.stage="exercise_review"; save(tx,s);
          const review=question(s,current);
          return say(tx,s,current,v.requestId,{...review,message:(report.evidence==="simulated"?"That was a simulated demo session. ":"Your report is saved. ")+review.message},"The exercise report is saved. "+(report.evidence==="simulated"?"You MUST explicitly say this was simulated/a demo, not measured exercise. ":"")+"Ask how the patient felt, one question. Don't read statistics or technical report fields aloud.",undefined,signal);
        } else if(v.event.type==="camera_status"||v.event.type==="tracking_status") {
          if (v.event.type==="tracking_status" && (!captured || s.exerciseSessionId!==captured.id))
            throw new DomainError("CONFLICT","Tracking feedback does not match the active session.");
          event(tx,s,v.requestId,"exercise_feedback",v.event.type==="camera_status"
            ? (v.event.status==="preview_on" ? "Camera preview enabled. Preview alone does not measure exercise." : "Camera preview stopped.")
            : "Exercise module tracking status: "+v.event.status+".","client_observation",{event:v.event});
        }
        save(tx,s);
        return question(s,current);
      });
    },
    async memory() { const care=await bridge.snapshot(); return memory.snapshot(care.patientId); },
    async forget(raw: unknown) {
      const { z }=await import("zod");
      z.object({confirm:z.literal(true)}).strict().parse(raw);
      const care=await bridge.snapshot();
      await memory.transaction(care.patientId,tx=>tx.forget());
      return {patientId:care.patientId,forgotten:true,careRecordsUnchanged:true};
    },
  };
}
export const checkins=checkinService();
