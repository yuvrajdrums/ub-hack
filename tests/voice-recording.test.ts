import test from "node:test";
import assert from "node:assert/strict";
import { recordedRecognition, shouldFallbackToRecordedRecognition, speechInputMode } from "../apps/panda/src/app/recorded-recognition";
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function microphone(t:test.TestContext){
  let stopped=0,disconnected=0,closed=0;
  const stream={getTracks:()=>[{stop:()=>{stopped++;}}]} as unknown as MediaStream;
  const node={connect:()=>{},disconnect:()=>{disconnected++;}};
  const context={resume:async()=>{},close:async()=>{closed++;},createAnalyser:()=>({...node,fftSize:1024,getByteTimeDomainData:(samples:Uint8Array)=>samples.fill(128)}),createMediaStreamSource:()=>node} as unknown as AudioContext;
  let current!:Recorder;
  class Recorder {
    static isTypeSupported(mime:string){return mime==="audio/mp4";}
    state="inactive";mimeType="audio/mp4";
    ondataavailable:((event:{data:Blob})=>void)|null=null;
    onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
    constructor(){current=this;}
    start(){this.state="recording";}
    stop(){this.state="inactive";this.onstop?.();}
    data(){this.ondataavailable?.({data:new Blob(["synthetic-audio-chunk"],{type:"audio/mp4"})});}
  }
  for(const [name,value] of Object.entries({navigator:{mediaDevices:{getUserMedia:async()=>stream}},MediaRecorder:Recorder})){
    const original=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true});
    t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);});
  }
  return {context,recorder:()=>current,counts:()=>({stopped,disconnected,closed})};
}
test("configured transcription bypasses an exposed but unreliable native speech service",()=>{
  assert.equal(speechInputMode(true,true,true),"recorded");
  assert.equal(speechInputMode(false,true,true),"recorded");
  assert.equal(speechInputMode(true,true,false),"native");
  assert.equal(speechInputMode(false,true,false),undefined);
  assert.equal(shouldFallbackToRecordedRecognition(true,true,true,"network"),true);
  assert.equal(shouldFallbackToRecordedRecognition(true,true,true,"not-allowed"),false);
  assert.equal(shouldFallbackToRecordedRecognition(true,false,true,"network"),false);
  assert.equal(shouldFallbackToRecordedRecognition(false,true,true,"network"),false);
});
test("recorded audio reaches transcription and emits a turn using the existing unlocked audio context",async t=>{
  const x=microphone(t);let processing=0,calls=0,words="",ended=0;
  const port=recordedRecognition(async(blob)=>{
    calls++;assert.equal(blob.type,"audio/mp4");assert.equal(await blob.text(),"synthetic-audio-chunk");return "I ate soup today.";
  },()=>{processing++;},()=>x.context);
  port.onresult=e=>{words=e.results[0][0].transcript;};port.onend=()=>{ended++;};
  port.start();t.after(()=>port.abort());await tick();x.recorder().data();x.recorder().stop();await tick();
  assert.equal(calls,1);assert.equal(processing,1);assert.equal(words,"I ate soup today.");assert.equal(ended,1);
  assert.deepEqual(x.counts(),{stopped:1,disconnected:2,closed:0});
});
test("muting during server transcription aborts the request and discards late words",async t=>{
  const x=microphone(t);let resolve!:(text:string)=>void,signal:AbortSignal|undefined,words=0;
  const port=recordedRecognition(async(_blob,s)=>{signal=s;return new Promise<string>(done=>{resolve=done;});},()=>{},()=>x.context);
  port.onresult=()=>{words++;};port.start();t.after(()=>port.abort());await tick();
  x.recorder().data();x.recorder().stop();port.abort();resolve("This must not be sent.");await tick();
  assert.equal(signal?.aborted,true);assert.equal(words,0);assert.equal(x.counts().stopped,1);
});
test("recording failures release the microphone and identify the capture failure",async t=>{
  const x=microphone(t);let error="";
  const port=recordedRecognition(async()=>{throw Error("must not send failed audio");},()=>{},()=>x.context);
  port.onerror=e=>{error=e.error;};port.start();t.after(()=>port.abort());await tick();x.recorder().onerror?.();
  assert.equal(error,"audio-capture");assert.equal(x.recorder().state,"inactive");assert.equal(x.counts().stopped,1);
});

test("an empty recorded transcript ends as no-speech without emitting patient words",async t=>{
 const x=microphone(t);let error="",words=0,ended=0;
 const port=recordedRecognition(async()=>" \n ",()=>{},()=>x.context);port.onresult=()=>{words++;};port.onerror=e=>{error=e.error;};port.onend=()=>{ended++;};
 port.start();t.after(()=>port.abort());await tick();x.recorder().data();x.recorder().stop();await tick();
 assert.equal(error,"no-speech");assert.equal(words,0);assert.equal(ended,1);assert.equal(x.counts().stopped,1);
});
