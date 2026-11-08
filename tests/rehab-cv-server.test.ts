import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cvService } from "../apps/rehab/src/server/cv/service";
import { contextResponse,requireIdentity,readBody } from "../apps/rehab/src/server/cv/http";
import type { CvEventCandidate,CvTiming,CvFinishInput } from "../packages/contracts/rehab-cv";

const clock="2026-11-07T22:00:00.000Z";
async function setup(t:test.TestContext,fetcher?:typeof fetch) {
  const dir=await mkdtemp(path.join(tmpdir(),"panda-cv-server-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const service=cvService(path.join(dir,"cv.json"),{now:()=>new Date(clock),fetcher});
  const session=await service.start("actor",{requestId:randomUUID(),exerciseId:"seated-knee-extension",side:"left",startedAtUtc:clock,evidence:"simulated"});
  return {service,session,file:path.join(dir,"cv.json")};
}
function event(sequence:number,changes:Partial<CvEventCandidate>={}):CvEventCandidate {
  return {eventId:randomUUID(),sequence,observedOffsetMs:sequence*10000,type:"attempt_finalized",attemptId:randomUUID(),movementComplete:true,qualifying:true,holdMs:5000,targetReached:true,rangeDegrees:75,...changes} as CvEventCandidate;
}
function timing(ms=130000):CvTiming {return {elapsedTimeMs:ms,activeTimeMs:96000,pausedTimeMs:ms-96000,userPausedTimeMs:14000,trackingPausedTimeMs:20000,otherPausedTimeMs:ms-130000};}
function finish(lastMeasurementSequence:number):CvFinishInput {return {requestId:randomUUID(),lastMeasurementSequence,report:{observedEndedAtUtc:"2026-11-07T22:02:10.000Z",completionStatus:"completed",terminationReason:"finished",timing:timing(),timingQuality:"complete"}};}
function controlled(t:test.TestContext) {
  const names=["REHAB_GEMINI_MODE","REHAB_GEMINI_API_KEY","REHAB_GEMINI_MODEL"];
  const before=names.map(n=>process.env[n]);
  process.env.REHAB_GEMINI_MODE="controlled";process.env.REHAB_GEMINI_API_KEY="test-only-key";process.env.REHAB_GEMINI_MODEL="test-model";
  t.after(()=>names.forEach((n,i)=>{if(before[i]===undefined)delete process.env[n];else process.env[n]=before[i];}));
}
test("CV ordered admission rejects gaps, deduplicates requests, and binds reports to their owner",async t=>{
  const {service,session}=await setup(t);
  await assert.rejects(()=>service.events("actor",session.id,{requestId:randomUUID(),event:event(2)}),/Expected measurement sequence 1/);
  const input={requestId:randomUUID(),event:event(1)};
  const first=await service.events("actor",session.id,input);
  assert.deepEqual(await service.events("actor",session.id,input),first);
  assert.equal((await service.get("actor",session.id)).completedReps,1);
  await assert.rejects(()=>service.events("actor",session.id,{...input,event:event(1)}),/reused/);
  await assert.rejects(()=>service.get("other",session.id),/not found/);
});
test("Finish high-water mark waits for the last rep and immutable retry saves one report",async t=>{
  const {service,session}=await setup(t);
  const final=finish(2);
  await service.events("actor",session.id,{requestId:randomUUID(),event:event(1)});
  await assert.rejects(()=>service.finish("actor",session.id,final),/Saved through sequence 1/);
  await service.events("actor",session.id,{requestId:randomUUID(),event:event(2)});
  const report=await service.finish("actor",session.id,final);
  assert.equal(report.completedReps,2);
  assert.equal(report.completionStatus,"incomplete");
  assert.deepEqual(await service.finish("actor",session.id,final),report);
  assert.equal((await service.reports("actor")).length,1);
  assert.deepEqual(await service.reports("other"),[]);
  await assert.rejects(()=>service.finish("actor",session.id,{...final,requestId:randomUUID()}),/immutable report/);
  await assert.rejects(()=>service.events("actor",session.id,{requestId:randomUUID(),event:event(3)}),/finished/);
});
test("Short observed holds differ from interrupted holds and use captured targets",async t=>{
  const {service,session}=await setup(t);
  const short=await service.events("actor",session.id,{requestId:randomUUID(),event:event(1,{holdMs:3100,qualifying:false})});
  assert.equal(short.session.movementCycles,1);assert.equal(short.session.completedReps,0);
  assert.equal(short.feedback[0].feedbackCode,"HOLD_TOO_SHORT");
  const interrupted=await service.events("actor",session.id,{requestId:randomUUID(),event:event(2,{holdMs:3100,qualifying:false,invalidated:true,movementComplete:false,reason:"tracking_lost"} as Partial<CvEventCandidate>)});
  assert.equal(interrupted.feedback.length,0);
  await assert.rejects(()=>service.events("actor",session.id,{requestId:randomUUID(),event:event(3,{holdMs:3100})}),/Qualifying count/);
});
test("Paused camera sessions cannot report qualified movement; overshoot cannot qualify",async t=>{
  const {service}=await setup(t);
  const s=await service.start("actor",{requestId:randomUUID(),exerciseId:"seated-knee-extension",side:"right",startedAtUtc:clock,evidence:"camera_estimated"});
  await assert.rejects(()=>service.events("actor",s.id,{requestId:randomUUID(),event:event(1)}),/untracked/);
  await service.events("actor",s.id,{requestId:randomUUID(),event:{eventId:randomUUID(),sequence:1,observedOffsetMs:0,type:"tracking_changed",valid:true}});
  const overshoot=await service.events("actor",s.id,{requestId:randomUUID(),event:event(2,{qualifying:false,reason:"target_overshoot"} as Partial<CvEventCandidate>)});
  assert.equal(overshoot.session.completedReps,0);
  await service.events("actor",s.id,{requestId:randomUUID(),event:{eventId:randomUUID(),sequence:3,observedOffsetMs:20001,type:"session_state_changed",action:"pause"}});
  await assert.rejects(()=>service.events("actor",s.id,{requestId:randomUUID(),event:event(4)}),/paused/);
});
test("Gemini text update gets a new change cursor without another measurement and retries call provider once",async t=>{
  controlled(t);let calls=0;let payload="";
  const {service,session}=await setup(t,(async(_url,init)=>{calls++;payload=String(init?.body);return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"phraseId":"gentle"}'}]}}]});}) as typeof fetch);
  const admitted=await service.events("actor",session.id,{requestId:randomUUID(),event:event(1,{holdMs:3100,qualifying:false})});
  const initial=await service.changes("actor",session.id,0);
  const body={requestId:randomUUID()};
  const final=await service.generate("actor",session.id,admitted.feedback[0].eventId,body);
  assert.equal(final.textSource,"gemini_selected_approved_variant");
  assert.equal(final.phraseId,"gentle");
  assert.deepEqual(await service.generate("actor",session.id,admitted.feedback[0].eventId,body),final);
  assert.equal(calls,1);
  const changes=await service.changes("actor",session.id,initial.nextCursor);
  assert.equal(changes.changes.length,1);assert.ok(changes.nextCursor>initial.nextCursor);
  assert.equal(changes.changes[0].feedback.eventId,initial.changes[0].feedback.eventId);
  assert.equal(changes.changes[0].feedback.generationStatus,"complete");
  assert.ok(!payload.includes(session.id));assert.ok(!payload.includes("actor"));assert.ok(!payload.includes("test-only-key"));
});
test("Malformed provider wording cannot enter final text and provider failure falls back truthfully",async t=>{
  controlled(t);
  for(const body of [{candidates:[{finishReason:"STOP",content:{parts:[{text:'{"phraseId":"invented","text":"Push through pain"}'}]}}]},{}]) {
    const {service,session}=await setup(t,(async()=>Response.json(body)) as typeof fetch);
    const admitted=await service.events("actor",session.id,{requestId:randomUUID(),event:event(1,{holdMs:3100,qualifying:false})});
    const final=await service.generate("actor",session.id,admitted.feedback[0].eventId,{requestId:randomUUID()});
    assert.equal(final.textSource,"deterministic_fallback");assert.ok(final.fallbackReason);assert.ok(!final.text.includes("pain"));
  }
});

test("Independent service instances share a persisted Gemini lease and return one final revision",async t=>{
  controlled(t);let calls=0;let release!:(value:Response)=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const provider=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher=(async()=>{calls++;entered();return provider;}) as typeof fetch;
  const {service,session,file}=await setup(t,fetcher);
  const other=cvService(file,{now:()=>new Date(clock),fetcher});
  const admitted=await service.events("actor",session.id,{requestId:randomUUID(),event:event(1,{holdMs:3100,qualifying:false})});
  const eventId=admitted.feedback[0].eventId;
  const first=service.generate("actor",session.id,eventId,{requestId:randomUUID()});
  await started;
  const duplicate=other.generate("actor",session.id,eventId,{requestId:randomUUID()});
  release(Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"phraseId":"gentle"}'}]}}]}));
  const [a,b]=await Promise.all([first,duplicate]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  assert.equal(a.textSource,"gemini_selected_approved_variant");
  assert.equal(a.textRevision,2);
});
test("Generation does not hold measurement lock and stale results are not applied",async t=>{
  controlled(t);let release!:(value:Response)=>void;let called!:()=>void;
  const entered=new Promise<void>(resolve=>{called=resolve;});
  const provider=new Promise<Response>(resolve=>{release=resolve;});
  const {service,session}=await setup(t,(async()=>{called();return provider;}) as typeof fetch);
  const admitted=await service.events("actor",session.id,{requestId:randomUUID(),event:event(1,{holdMs:3100,qualifying:false})});
  const pending=service.generate("actor",session.id,admitted.feedback[0].eventId,{requestId:randomUUID()});
  await entered;
  const paused=await service.events("actor",session.id,{requestId:randomUUID(),event:{eventId:randomUUID(),sequence:2,observedOffsetMs:10001,type:"session_state_changed",action:"pause"}});
  assert.equal(paused.session.status,"paused");
  release(Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"phraseId":"gentle"}'}]}}]}));
  const final=await pending;assert.equal(final.textSource,"deterministic_fallback");assert.equal(final.fallbackReason,"stale_result");
});
test("Timing arithmetic and unavailable/patient-reported evidence stay honest",async t=>{
  const {service}=await setup(t);
  const s=await service.start("actor",{requestId:randomUUID(),exerciseId:"static-quads",side:"left",startedAtUtc:clock,evidence:"patient_reported"});
  await assert.rejects(()=>service.finish("actor",s.id,{...finish(0),report:{...finish(0).report,timing:{...timing(),pausedTimeMs:2}}}),/Timing buckets/);
  const report=await service.finish("actor",s.id,finish(0));
  assert.equal(report.trackingQuality,"patient_reported");assert.equal(report.performanceScore,null);assert.equal(report.rangeDegrees,null);
  await assert.rejects(()=>service.start("actor",{requestId:randomUUID(),exerciseId:"static-quads",side:"left",startedAtUtc:clock,evidence:"camera_estimated"}),/patient-reported/);
});
test("Demo identity cookies persist across reload while CSRF/origin and remote bootstrap are protected",async t=>{
  const old=process.env.REHAB_CV_AUTH_SECRET;process.env.REHAB_CV_AUTH_SECRET="test-secret-only-for-cv-http";
  t.after(()=>{if(old===undefined)delete process.env.REHAB_CV_AUTH_SECRET;else process.env.REHAB_CV_AUTH_SECRET=old;});
  const response=await contextResponse(new Request("http://localhost:3002/rehab/api/cv/v1/context"));
  const out=await response.json();assert.equal(response.status,200);
  const cookie=response.headers.get("set-cookie")!.split(";")[0];assert.ok(response.headers.get("set-cookie")!.includes("HttpOnly"));
  const req=(origin="http://localhost:3002",csrf=out.data.csrfToken)=>new Request("http://localhost:3002/rehab/api/cv/v1/sessions",{method:"POST",headers:{cookie,origin,"x-cv-csrf":csrf}});
  const first=await requireIdentity(req());
  const reload=await contextResponse(new Request("http://localhost:3002/rehab/api/cv/v1/context",{headers:{cookie}}));
  assert.equal((await reload.json()).data.csrfToken,out.data.csrfToken);
  assert.equal((await requireIdentity(req())).subject,first.subject);
  await assert.rejects(()=>requireIdentity(req("https://attacker.example")),/origin/);
  await assert.rejects(()=>requireIdentity(req("http://localhost:3002","bad")),/Refresh/);
  const ipBootstrap=await contextResponse(new Request("http://localhost:3002/rehab/api/cv/v1/context",{headers:{host:"127.0.0.1:3002",origin:"http://127.0.0.1:3002"}}));
  assert.equal(ipBootstrap.status,200,"Next's internal localhost normalization must not reject the actual loopback browser origin");
  const rebound=await contextResponse(new Request("http://localhost:3002/rehab/api/cv/v1/context",{headers:{host:"attacker.example",origin:"http://attacker.example"}}));
  assert.equal(rebound.status,401,"An external Host cannot use the internal loopback URL to bypass remote bootstrap protection");
  const remote=await contextResponse(new Request("https://public.example/rehab/api/cv/v1/context"));assert.equal(remote.status,401);
});
test("Body limits reject oversized or non-JSON input",async()=>{
  await assert.rejects(()=>readBody(new Request("http://localhost",{method:"POST",headers:{"content-type":"text/plain"},body:"{}"})),/JSON request/);
  await assert.rejects(()=>readBody(new Request("http://localhost",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"x".repeat(33000)})})),/size limit/);
});
