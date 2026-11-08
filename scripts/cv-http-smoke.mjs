import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const origin = process.env.CV_TEST_ORIGIN || 'http://127.0.0.1:3002';
const base = origin + '/rehab/api/cv/v1';
const live = process.argv.includes('--live-gemini');
const sitesPreview = process.argv.includes('--sites-preview');
let cookie = '', csrf = '';
async function request(path, body, {anonymous=false,noCsrf=false}={}) {
  const response = await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(!anonymous&&cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json',...(!noCsrf?{'x-cv-csrf':csrf}:{})}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {response,body:await response.json()};
}
assert.equal((await request('/sessions',undefined,{anonymous:true})).response.status,401);
if(sitesPreview){
  const login=await fetch(origin+'/signin-with-chatgpt?return_to=%2Frehab',{redirect:'manual'});
  cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
  assert.ok(cookie,'Local Sites preview must supply its mock sign-in cookie');
}
const boot=await request('/context',undefined,{anonymous:!sitesPreview});
assert.equal(boot.response.status,200);
assert.equal(boot.body.data.exercises.length,4);
if(!sitesPreview){cookie=boot.response.headers.get('set-cookie').split(';')[0];assert.match(boot.response.headers.get('set-cookie'),/HttpOnly/);}
csrf=boot.body.data.csrfToken;
const start={requestId:randomUUID(),exerciseId:'seated-knee-extension',side:'left',startedAtUtc:new Date().toISOString(),evidence:'simulated'};
assert.equal((await request('/sessions',start,{noCsrf:true})).response.status,403);
const [started,parallelRetry]=await Promise.all([request('/sessions',start),request('/sessions',start)]);assert.equal(started.response.status,200);assert.equal(parallelRetry.response.status,200);assert.equal(parallelRetry.body.data.id,started.body.data.id);
const id=started.body.data.id;
assert.equal((await request('/sessions',start)).body.data.id,id);
const event=(sequence,type,fields,offset)=>({requestId:randomUUID(),event:{eventId:randomUUID(),sequence,type,observedOffsetMs:offset,...fields}});
assert.equal((await request(`/sessions/${id}/events`,event(2,'tracking_changed',{valid:true},0))).response.status,409);
await request(`/sessions/${id}/events`,event(1,'tracking_changed',{valid:true},0));
const attempt=event(2,'attempt_finalized',{attemptId:randomUUID(),movementComplete:true,qualifying:false,holdMs:3100,flexionHoldMs:0,targetReached:true,rangeDegrees:75,kneeBent:false,invalidated:false,reason:'short_hold'},4000);
const admitted=await request(`/sessions/${id}/events`,attempt);assert.equal(admitted.response.status,200);
assert.equal((await request(`/sessions/${id}/events`,attempt)).body.data.acknowledgedSequence,2);
const cue=admitted.body.data.feedback.find(f=>f.feedbackCode==='HOLD_TOO_SHORT');assert.ok(cue);
const oldCursor=(await request(`/sessions/${id}/changes?after=0`)).body.data.nextCursor;
let source='not_requested',reason=null;
if(live){
  const generated=await request(`/sessions/${id}/feedback/${cue.eventId}/generate`,{requestId:randomUUID()});
  assert.equal(generated.response.status,200);
  source=generated.body.data.textSource;reason=generated.body.data.fallbackReason;
  assert.ok(generated.body.data.text.length<=180);
  const updates=(await request(`/sessions/${id}/changes?after=${oldCursor}`)).body.data;
  assert.ok(updates.nextCursor>oldCursor);
  assert.ok(updates.changes.some(c=>c.feedback.eventId===cue.eventId&&c.feedback.generationStatus==='complete'));
}
const timing={elapsedTimeMs:10000,activeTimeMs:9000,pausedTimeMs:1000,userPausedTimeMs:0,trackingPausedTimeMs:0,otherPausedTimeMs:1000};
const finish={requestId:randomUUID(),lastMeasurementSequence:3,report:{observedEndedAtUtc:new Date().toISOString(),completionStatus:'incomplete',terminationReason:'finished',timing,timingQuality:'complete'}};
assert.equal((await request(`/sessions/${id}/finish`,finish)).body.error.code,'MEASUREMENTS_PENDING');
assert.equal((await request(`/sessions/${id}/events`,event(3,'checkpoint',{timing},10000))).response.status,200);
const saved=await request(`/sessions/${id}/finish`,finish);assert.equal(saved.response.status,200);
assert.deepEqual((await request(`/sessions/${id}/finish`,finish)).body.data,saved.body.data);
assert.equal(saved.body.data.movementCycles,1);assert.equal(saved.body.data.completedReps,0);
assert.equal(saved.body.data.evidence,'simulated');
assert.ok((await request('/sessions')).body.data.some(r=>r.sessionId===id));
const concurrent=await Promise.all([0,1].map(()=>request('/sessions',{...start,requestId:randomUUID(),startedAtUtc:new Date().toISOString()})));
for(const created of concurrent){assert.equal(created.response.status,200);assert.equal((await request(`/sessions/${created.body.data.id}`)).response.status,200);}
console.log(JSON.stringify({httpChecks:'passed',sessionId:id,evidence:'simulated',realGeminiRequested:live,textSource:source,fallbackReason:reason,configuredModel:boot.body.data.gemini.model},null,2));
