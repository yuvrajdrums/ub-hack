"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { poseModelFor, type PoseModelId } from "./pose-models";

export type CameraLandmark = { x: number; y: number; z: number; visibility?: number; presence?: number };
export type CameraFrame = {
  timestampMs: number;
  landmarks: CameraLandmark[];
  width: number;
  height: number;
  personCount: number;
  inferenceMs: number;
};
type CameraStatus = "off" | "permission" | "loading" | "tracking" | "error";

const connections = [[11,12],[11,23],[12,24],[23,24],[23,25],[24,26],[25,27],[26,28],[27,29],[28,30],[29,31],[30,32]];

export function usePoseCamera(onFrame: (frame: CameraFrame) => void, onInterrupted: (reason: string) => void, poseModel: PoseModelId = "lite") {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const model = useRef<PoseLandmarker | null>(null);
  const generation = useRef(0);
  const animation = useRef(0);
  const videoCallback = useRef<number|null>(null);
  const mounted = useRef(true);
  const frameHandler = useRef(onFrame);
  const interruptHandler = useRef(onInterrupted);
  frameHandler.current = onFrame;
  interruptHandler.current = onInterrupted;
  const [status, setStatus] = useState<CameraStatus>("off");
  const [error, setError] = useState("");
  const [backend, setBackend] = useState("");

  const stop = useCallback(() => {
    generation.current += 1;
    cancelAnimationFrame(animation.current);
    if(videoCallback.current!==null)videoRef.current?.cancelVideoFrameCallback?.(videoCallback.current);
    videoCallback.current=null;
    stream.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    stream.current = null;
    model.current?.close();
    model.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (mounted.current) setStatus("off");
  }, []);

  const start = useCallback(async () => {
    stop();
    const token = generation.current;
    setError("");
    setStatus("permission");
    let acquired: MediaStream | null = null;
    let loaded: PoseLandmarker | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Use HTTPS or localhost in a browser that supports camera access.");
      acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } } });
      if (!mounted.current || generation.current !== token || document.hidden) { acquired.getTracks().forEach((t) => t.stop()); return; }
      stream.current = acquired;
      const video = videoRef.current;
      if (!video) throw new Error("The camera preview is not ready. Please try again.");
      video.srcObject = acquired;
      await video.play();
      if (generation.current !== token || document.hidden) { acquired.getTracks().forEach((t) => t.stop()); return; }
      setStatus("loading");
      const { FilesetResolver, PoseLandmarker: Landmarker } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks("/rehab/mediapipe");
      const create = (delegate: "GPU" | "CPU") => Landmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: poseModelFor(poseModel).assetPath, delegate },
        runningMode: "VIDEO", numPoses: 2,
        minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      });
      let delegate = "GPU";
      try { loaded = await create("GPU"); } catch { delegate = "CPU"; loaded = await create("CPU"); }
      if (!mounted.current || generation.current !== token || document.hidden) { loaded.close(); acquired.getTracks().forEach((t) => t.stop()); return; }
      model.current = loaded;
      setBackend(delegate);
      setStatus("tracking");
      acquired.getTracks().forEach((track) => { track.onended = () => { stop(); interruptHandler.current("Camera access ended"); }; });
      let lastTime = -1;
      let lastFrame = -1;
      let lastBody:{x:number;y:number;scale:number}|null=null;
      const schedule = () => {
        if(generation.current!==token)return;
        if(typeof video.requestVideoFrameCallback==="function")videoCallback.current=video.requestVideoFrameCallback(loop);
        else animation.current=requestAnimationFrame(loop);
      };
      const loop = (now: number) => {
        if (generation.current !== token || !model.current) return;
        schedule();
        if (now - lastTime < 75 || video.readyState < 2 || video.currentTime === lastFrame) return;
        lastTime = now;
        lastFrame = video.currentTime;
        try {
          const before = performance.now();
          const result = model.current.detectForVideo(video, before);
          const canvas = canvasRef.current;
          if (canvas && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
          const pose=result.landmarks.length===1?result.landmarks[0]:null;
          if(pose && [23,24,25,26].every(i=>(pose[i]?.visibility??0)>=.6)){
            const body={x:(pose[23].x+pose[24].x)/2,y:(pose[23].y+pose[24].y)/2,scale:Math.hypot(pose[23].x-pose[25].x,pose[23].y-pose[25].y)};
            if(lastBody && (Math.hypot(body.x-lastBody.x,body.y-lastBody.y)>.25 || (lastBody.scale>.03 && Math.abs(body.scale/lastBody.scale-1)>.6))){
              stop();setError("Camera position or tracked person changed. Recalibrate before starting again.");interruptHandler.current("Tracking continuity changed");return;
            }
            lastBody=body;
          }
          const ctx = canvas?.getContext("2d");
          if (ctx && canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (result.landmarks.length === 1) {
              const points = result.landmarks[0];
              ctx.strokeStyle = "#b9efce"; ctx.lineWidth = 4;
              for (const [a,b] of connections) {
                if ((points[a]?.visibility ?? 0) < .6 || (points[b]?.visibility ?? 0) < .6) continue;
                ctx.beginPath();ctx.moveTo(points[a].x * canvas.width, points[a].y * canvas.height);ctx.lineTo(points[b].x * canvas.width, points[b].y * canvas.height);ctx.stroke();
              }
              for (const i of [11,12,23,24,25,26,27,28]) {
                const p = points[i];
                if ((p?.visibility ?? 0) < .6) continue;
                ctx.fillStyle = "#fff";ctx.beginPath();ctx.arc(p.x*canvas.width,p.y*canvas.height,6,0,Math.PI*2);ctx.fill();
              }
            }
          }
          frameHandler.current({ timestampMs: before, landmarks: result.landmarks[0] ?? [], width: video.videoWidth, height: video.videoHeight, personCount: result.landmarks.length, inferenceMs: performance.now() - before });
        } catch {
          stop(); setError("Pose tracking stopped. Reload the camera to try again.");setStatus("error");interruptHandler.current("Pose model error");
        }
      };
      schedule();
    } catch (e) {
      acquired?.getTracks().forEach((track) => track.stop());
      loaded?.close();
      if (generation.current !== token || !mounted.current) return;
      stop();
      const message = e instanceof Error ? e.message : "Camera could not start.";
      setError(message);setStatus("error");
    }
  }, [stop, poseModel]);

  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) { stop(); interruptHandler.current("Page hidden"); } };
    const orientation = () => { stop();interruptHandler.current("Camera orientation changed; recalibrate before continuing"); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("orientationchange", orientation);
    return () => { mounted.current = false;stop();document.removeEventListener("visibilitychange",hidden);window.removeEventListener("orientationchange",orientation); };
  }, [stop]);
  return { videoRef, canvasRef, status, error, backend, start, stop };
}
