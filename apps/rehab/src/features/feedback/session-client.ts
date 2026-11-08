import type { CvContext, CvEventCandidate, CvEventInput, CvEventResult, CvFeedbackText, CvFinishInput, CvReport, CvSession, CvTiming } from "../../../../../packages/contracts/rehab-cv";

const BASE = "/rehab/api/cv/v1";
export const RECOVERY_KEY = "panda-cv-pending-v1";
type WithoutBase<T> = T extends CvEventCandidate ? Omit<T,"eventId"|"sequence"|"observedOffsetMs"> : never;
export type MeasurementBody = WithoutBase<CvEventCandidate>;
export type Recovery = { session:CvSession; pending:CvEventInput[]; nextSequence:number; timing:CvTiming; finish:CvFinishInput|null };
export const emptyTiming = (): CvTiming => ({ elapsedTimeMs:0,activeTimeMs:0,pausedTimeMs:0,userPausedTimeMs:0,trackingPausedTimeMs:0,otherPausedTimeMs:0 });

export async function cvApi<T>(path:string,body?:unknown,csrf?:string):Promise<T> {
  const r=await fetch(BASE+path,{method:body===undefined?"GET":"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json",...(csrf?{"x-cv-csrf":csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  const value=await r.json() as {ok:boolean;data?:T;error?:{message?:string}};
  if(!r.ok||!value.ok)throw new Error(value.error?.message??"The request could not be completed.");
  return value.data as T;
}
export function readRecovery():Recovery|null {
  try { const s=localStorage.getItem(RECOVERY_KEY);return s?JSON.parse(s) as Recovery:null; } catch { return null; }
}

export class SessionTransport {
  private record:Recovery;
  private drainPromise:Promise<void>|null=null;
  private generationQueue:CvFeedbackText[]=[];
  private generating=false;
  private generated=new Set<string>();
  private disposed=false;
  constructor(session:CvSession,private context:CvContext,private feedback:(text:CvFeedbackText)=>void,private error:(message:string)=>void,recovery?:Recovery) {
    this.record=recovery??{session,pending:[],nextSequence:1,timing:emptyTiming(),finish:null};
    this.persist();
  }
  get session(){return this.record.session;}
  get timing(){return this.record.timing;}
  get lastSequence(){return this.record.nextSequence-1;}
  get queued(){return this.record.pending.length;}
  get finishAttempt(){return this.record.finish;}
  rememberTiming(timing:CvTiming){this.record.timing=timing;}
  private persist(){try{localStorage.setItem(RECOVERY_KEY,JSON.stringify(this.record));}catch{this.error("Browser recovery storage is unavailable. Keep this page open until the report saves.");}}
  checkpoint(timing:CvTiming,offset:number){this.record.timing=timing;this.enqueue({type:"checkpoint",timing},offset);}
  enqueue(body:MeasurementBody,offset:number){
    if(this.record.finish)return;
    const event={...body,eventId:crypto.randomUUID(),sequence:this.record.nextSequence++,observedOffsetMs:Math.max(0,offset)} as CvEventCandidate;
    this.record.pending.push({requestId:crypto.randomUUID(),event});this.persist();
    void this.drain().catch((e:unknown)=>this.error(e instanceof Error?e.message:"Measurements are waiting to save. Retry when connected."));
  }
  async drain():Promise<void>{
    if(this.drainPromise)return this.drainPromise;
    this.drainPromise=(async()=>{
      while(this.record.pending.length){
        const input=this.record.pending[0];
        const result=await cvApi<CvEventResult>(`/sessions/${this.session.id}/events`,input,this.context.csrfToken);
        this.record.session=result.session;
        if(result.acknowledgedSequence<input.event.sequence)throw new Error("Some measurements are still waiting to save.");
        this.record.pending.shift();this.persist();
        for(const text of result.feedback){this.feedback(text);this.scheduleGeneration(text);}
      }
    })();
    try{await this.drainPromise;}finally{this.drainPromise=null;}
  }
  private scheduleGeneration(text:CvFeedbackText){
    if(this.disposed||text.generationStatus==="complete"||this.generated.has(text.eventId))return;
    this.generated.add(text.eventId);this.generationQueue.push(text);void this.generateNext();
  }
  private async generateNext(){
    if(this.generating||this.disposed)return;
    this.generating=true;
    try{
      while(this.generationQueue.length&&!this.disposed){
        const item=this.generationQueue.shift()!;
        try{const text=await cvApi<CvFeedbackText>(`/sessions/${this.session.id}/feedback/${item.eventId}/generate`,{requestId:crypto.randomUUID()},this.context.csrfToken);if(!this.disposed)this.feedback(text);}
        catch{if(!this.disposed)this.error("Natural wording is unavailable. The measured feedback remains visible.");}
      }
    }finally{this.generating=false;}
  }
  async finish(report:CvFinishInput["report"]):Promise<CvReport>{
    if(!this.record.finish)this.record.finish={requestId:crypto.randomUUID(),lastMeasurementSequence:this.lastSequence,report};
    this.persist();
    await this.drain();
    const result=await cvApi<CvReport>(`/sessions/${this.session.id}/finish`,this.record.finish,this.context.csrfToken);
    try{localStorage.removeItem(RECOVERY_KEY);}catch{/* Report is safely saved server-side. */}
    this.disposed=true;this.generationQueue=[];
    return result;
  }
  dispose(){this.disposed=true;this.generationQueue=[];}
}
