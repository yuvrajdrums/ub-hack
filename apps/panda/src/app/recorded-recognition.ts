export type SpeechInput = {
  lang:string;continuous:boolean;interimResults:boolean;
  onresult:((event:{results:{[key:number]:{[key:number]:{transcript:string}}}})=>void)|null;
  onerror:((event:{error:string;message?:string})=>void)|null;onend:(()=>void)|null;
  start:()=>void;abort:()=>void;
};
// Some embedded browsers expose Web Speech while their recognition service is unavailable.
export function speechInputMode(nativeAvailable:boolean,recordingAvailable:boolean,transcriptionConfigured:boolean) {
  return transcriptionConfigured&&recordingAvailable ? "recorded" : nativeAvailable ? "native" : undefined;
}
export function shouldFallbackToRecordedRecognition(nativeSelected:boolean,recordingAvailable:boolean,transcriptionConfigured:boolean,error:string) {
  return nativeSelected&&recordingAvailable&&transcriptionConfigured&&!(["not-allowed","audio-capture","no-speech"].includes(error));
}
/** Bounded microphone turn; configured server transcription is preferred to browser recognition. */
export function recordedRecognition(transcribe:(audio:Blob,signal:AbortSignal)=>Promise<string>,processing:()=>void,sharedContext?:()=>AudioContext,sharedStream?:()=>Promise<MediaStream>):SpeechInput {
  let active=false,stream:MediaStream|null=null,recorder:MediaRecorder|null=null,context:AudioContext|null=null;
  let timer:ReturnType<typeof setInterval>|null=null,controller:AbortController|null=null;
  let input:MediaStreamAudioSourceNode|null=null,analyser:AnalyserNode|null=null;
  const cleanup=()=>{
    if(timer)clearInterval(timer);timer=null;
    if(!sharedStream)stream?.getTracks().forEach(track=>track.stop());stream=null;
    input?.disconnect();input=null;analyser?.disconnect();analyser=null;
    if(context&&!sharedContext)void context.close().catch(()=>{});context=null;
  };
  const port:SpeechInput={
    lang:"en-US",continuous:false,interimResults:false,onresult:null,onerror:null,onend:null,
    abort() {
      active=false;controller?.abort();controller=null;
      if(recorder){recorder.onstop=null;recorder.ondataavailable=null;if(recorder.state!=="inactive")recorder.stop();}
      recorder=null;cleanup();
    },
    start() {
      if(active)throw Error("Recording is already active.");
      active=true;
      void (async()=>{
        try {
          const captured=await (sharedStream?sharedStream():navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}));
          if(!active){if(!sharedStream)captured.getTracks().forEach(track=>track.stop());return;}
          stream=captured;
          const mime=["audio/webm;codecs=opus","audio/mp4","audio/webm"].find(value=>MediaRecorder.isTypeSupported(value));
          recorder=new MediaRecorder(captured,mime?{mimeType:mime}:undefined);
          const chunks:Blob[]=[];
          recorder.ondataavailable=event=>{if(active&&event.data.size)chunks.push(event.data);};
          recorder.onerror=()=>{if(active){port.abort();port.onerror?.({error:"audio-capture"});port.onend?.();}};
          recorder.onstop=()=>{
            const audio=new Blob(chunks,{type:recorder?.mimeType||mime||"audio/webm"});
            cleanup();
            if(!active)return;
            controller=new AbortController();processing();
            void transcribe(audio,controller.signal).then(text=>{
              if(!active)return;
              const transcript=text.trim();
              if(transcript)port.onresult?.({results:{0:{0:{transcript}}}});
              else port.onerror?.({error:"no-speech"});
              if(active){active=false;port.onend?.();}
            }).catch(error=>{
              if(active){active=false;port.onerror?.({error:"transcription-unavailable",message:error instanceof Error?error.message:"Speech transcription is unavailable."});port.onend?.();}
            });
          };
          recorder.start(200);
          context=sharedContext?sharedContext():new AudioContext();await context.resume();
          if(!active)return;
          const meter=context.createAnalyser();meter.fftSize=1024;analyser=meter;
          input=context.createMediaStreamSource(captured);input.connect(meter);
          const samples=new Uint8Array(meter.fftSize);
          const started=performance.now();let heard=false,lastSound=started;
          timer=setInterval(()=>{
            if(!active||!recorder)return;
            meter.getByteTimeDomainData(samples);
            let sum=0;for(const sample of samples){const value=(sample-128)/128;sum+=value*value;}
            const now=performance.now();
            if(Math.sqrt(sum/samples.length)>0.018){heard=true;lastSound=now;}
            if(!heard&&now-started>8000){port.abort();port.onerror?.({error:"no-speech"});port.onend?.();return;}
            if((heard&&now-lastSound>800)||now-started>30000){if(recorder.state==="recording")recorder.stop();}
          },100);
        }catch(error){
          if(active){port.abort();port.onerror?.({error:(error as Error).name==="NotAllowedError"?"not-allowed":"audio-capture"});port.onend?.();}
        }
      })();
    },
  };
  return port;
}
