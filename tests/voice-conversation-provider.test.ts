import test from "node:test";
import assert from "node:assert/strict";
import {dialogueTurn,type DialogueInput} from "../apps/panda/src/server/conversation";
import {fixtureCare} from "../packages/contracts/fixtures";
function input():DialogueInput{return {care:fixtureCare(),session:{id:"00000000-0000-4000-8000-000000000001",patientId:"pat-demo-001",planId:"plan-demo-001",planVersion:1,stage:"medications",medicationTaskIds:["task-demo-001"],medicationIndex:0,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()},history:[{id:"hello",checkinId:"session",role:"assistant",text:"How's your elbow feeling?",at:new Date().toISOString()},{id:"answer",checkinId:"session",role:"user",text:"My elbow feels okay.",at:new Date().toISOString()}],memory:[],text:"I took it.",moves:[{id:"med_yes",goal:"Propose marking the evening medicine taken; don't execute it.",fallback:"Shall I mark it taken?"}]};}
async function configured(fn:()=>Promise<void>){
  const names=["PANDA_AI_MODE","PANDA_GEMINI_API_KEY"] as const;
  const values=names.map(name=>process.env[name]),fetch=globalThis.fetch;
  Object.assign(process.env,{PANDA_AI_MODE:"gemini",PANDA_GEMINI_API_KEY:"fake-secret"});
  try{await fn();}finally{globalThis.fetch=fetch;names.forEach((name,i)=>{if(values[i]===undefined)delete process.env[name];else process.env[name]=values[i];});}
}
function result(out:unknown){return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(out)}]}}]});}
test("conversation generation sends actual multi-turn history, approved facts and a constrained action agenda",()=>configured(async()=>{
  globalThis.fetch=async(url,options)=>{
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"),"fake-secret");assert.ok(options?.signal);
    const body=JSON.parse(String(options?.body));assert.equal(body.contents[0].role,"model");assert.equal(body.contents[1].parts[0].text,"My elbow feels okay.");assert.equal(body.contents.at(-1).parts[0].text,"I took it.");
    assert.deepEqual(body.generationConfig.responseJsonSchema.properties.move.enum,["med_yes"]);assert.match(body.systemInstruction.parts[0].text,/not the patient's doctor|not.*doctor/);assert.match(body.systemInstruction.parts[0].text,/evening/);
    return result({move:"med_yes",response:"Shall I mark your evening atorvastatin as taken?",foodQuote:null});
  };
  const out=await dialogueTurn(input());assert.equal(out.engine,"gemini");assert.equal(out.move,"med_yes");
}));
test("invented actions, invented patient quotes and malformed model output fail closed",()=>configured(async()=>{
  for(const out of [{move:"book_appointment",response:"Booked.",foodQuote:null},{move:"med_yes",response:"Okay.",foodQuote:"a meal the user never reported"},{move:"med_yes",response:"",foodQuote:null}]){
    globalThis.fetch=async()=>result(out);await assert.rejects(()=>dialogueTurn(input()),/couldn't finish/);
  }
}));
test("configured dialogue failure never becomes a successful scripted reply",()=>configured(async()=>{
  globalThis.fetch=async()=>Response.json({error:{message:"private upstream detail"}},{status:429});
  await assert.rejects(()=>dialogueTurn(input()),error=>String(error).includes("busy right now")&&!String(error).includes("private upstream"));
}));
test("dialogue provider cancellation uses the caller's bounded signal",()=>configured(async()=>{
  const controller=new AbortController();
  globalThis.fetch=async(_url,options)=>{controller.abort();assert.equal(options?.signal?.aborted,true);throw new DOMException("aborted","AbortError");};
  await assert.rejects(()=>dialogueTurn(input(),controller.signal));
}));

test("a temporary model outage retries the identical read-only generation without inventing a reply",()=>configured(async()=>{
  let calls=0,body="";globalThis.fetch=async(_url,options)=>{calls++;if(calls===1){body=String(options?.body);return new Response(null,{status:503});}assert.equal(String(options?.body),body);return result({move:"med_yes",response:"Shall I mark it taken?",foodQuote:null});};
  const out=await dialogueTurn(input());assert.equal(out.engine,"gemini");assert.equal(calls,2);
}));

test("voice generation uses a model-compatible low-latency thinking configuration",async()=>{
  const {conversationThinking}=await import("../apps/panda/src/server/conversation");
  assert.deepEqual(conversationThinking("gemini-3.5-flash-lite"),{thinkingLevel:"minimal"});
  assert.deepEqual(conversationThinking("gemini-2.5-flash"),{thinkingBudget:0});
  assert.equal(conversationThinking("gemma-4-31b-it"),undefined);
});
