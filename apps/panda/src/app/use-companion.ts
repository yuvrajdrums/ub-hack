"use client";
import { useEffect, useRef, useState } from "react";
import { useLoggedFailure } from "../../../../packages/ui/client-feedback";
import { exerciseInstruction, type ExerciseRuntime } from "../../../../packages/contracts/exercise-runtime";
import { requestsExercise } from "../../../../packages/contracts/exercise-navigation";
import { recordedRecognition, shouldFallbackToRecordedRecognition, speechInputMode } from "./recorded-recognition";
import { spokenConfirmation } from "./voice-confirmation";
import { ConversationMicrophone } from "./conversation-microphone";
import { pcmRecognition, preparePcmInput } from "./pcm-recognition";
import { playbackEcho } from "./speech-turn";
import {
  ExerciseCoachingCadence,
  queueExerciseFeedback,
  transientExerciseEvent,
  type PendingExerciseFeedback,
} from "./exercise-coaching";
import { ConversationAudio } from "./conversation-audio";
import type { VoiceContext, VoiceHistoryTurn, VoiceReply } from "@contracts";
import type {
  CheckinSession,
  RehabBridgeEvent,
} from "../../../../packages/contracts/checkin";

export type Phase =
  | "permission"
  | "ready"
  | "listening"
  | "thinking"
  | "confirmation"
  | "saving"
  | "speech_loading"
  | "speaking";
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        results: { [key: number]: { [key: number]: { transcript: string } } };
      }) => void)
    | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  start(): void;
  abort(): void;
};
type PandaExerciseCue = { eventId: string; text: string; expiresAt: string | null };
type SpeechWindow = {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  route: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  const out = await response.json();
  if (!response.ok || !out.ok)
    throw new ApiError(
      out.error?.message || "Request failed. Retry with the same action.",
      out.error?.code || "UNAVAILABLE",
      response.status,
    );
  return out.data as T;
}
export function useCompanion() {
  const [context, setContext] = useState<VoiceContext | null>(null);
  const contextRef = useRef<VoiceContext | null>(context);
  contextRef.current = context;
  const [history, setHistory] = useState<VoiceHistoryTurn[]>([]);
  const [reply, setReply] = useState<VoiceReply | null>(null);
  const [pandaExerciseCue, setPandaExerciseCue] =
    useState<PandaExerciseCue | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState("");
  useLoggedFailure("Panda companion", error);
  const [notice, setNotice] = useState("");
  const [micConsent, setMicConsent] = useState(false);
  const [speechConsent, setSpeechConsent] = useState(false);
  const micConsentRef = useRef(false),
    speechConsentRef = useRef(false);
  const [canMic, setCanMic] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [checkin, setCheckin] = useState<VoiceReply["checkin"]>();
  const checkinRef = useRef<VoiceReply["checkin"]>(undefined);
  const startAttempt = useRef<{ requestId: string } | null>(null);
  const exerciseAttempt = useRef<{ requestId: string } | null>(null);
  const continueAttempt = useRef<{
    requestId: string;
    checkinId: string;
    proposalId: string;
    confirmationText?: string;
  } | null>(null);
  const handsfree = useRef(false);
  const inputLevel = useRef(0);
  const pcmReady = useRef(false),
    speaking = useRef(false),
    patientSpeaking = useRef(false);
  const transcribing = useRef(false);
  const heardProposal = useRef<string | null>(null),
    queuedCue = useRef<VoiceReply | null>(null),
    queuedReview = useRef<VoiceReply | null>(null);
  const feedbackQueue = useRef<PendingExerciseFeedback[]>([]);
  const coachingCadence = useRef(new ExerciseCoachingCadence());
  const coachingEpoch = useRef(0);
  const coachingTick = useRef<() => void>(() => {});
  const preferRecordedRecognition = useRef(false);
  const flushingFeedback = useRef(false);
  const feedbackFailures = useRef(0),
    feedbackRetryAt = useRef(0);
  const live = useRef(true);
  const generation = useRef(0);
  const soundGeneration = useRef(0);
  const latestReply = useRef<VoiceReply | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const micRestart = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speaker = useRef(new ConversationAudio());
  const microphone = useRef(new ConversationMicrophone());
  const speechAbort = useRef<AbortController | null>(null);
  const requests = useRef(new Set<AbortController>());
  const pending = useRef<{
    requestId: string;
    text: string;
    route: string;
    checkinId?: string;
    expectedStage?: string;
    exerciseContext?: ExerciseRuntime;
  } | null>(null);
  const inFlight = useRef(false);
  const exerciseRuntime = useRef<ExerciseRuntime | undefined>(undefined);
  const settledPhase = () =>
    latestReply.current?.proposalId
      ? ("confirmation" as const)
      : ("ready" as const);

  function stopMic() {
    patientSpeaking.current = false;
    transcribing.current = false;
    inputLevel.current = 0;
    if (micRestart.current) clearTimeout(micRestart.current);
    micRestart.current = null;
    const rec = recognition.current;
    recognition.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onspeechstart = null;
      rec.onspeechend = null;
      rec.abort();
    }
  }
  function stopSound() {
    speaking.current = false;
    soundGeneration.current++;
    speechAbort.current?.abort();
    speechAbort.current = null;
    speaker.current.stop();
    window.speechSynthesis?.cancel();
  }
  function cleanup() {
    handsfree.current = false;
    generation.current++;
    stopMic();
    stopSound();
    speaker.current.close();
    microphone.current.close();
    pcmReady.current = false;
    queuedCue.current = null;
    coachingEpoch.current++;
    feedbackQueue.current = feedbackQueue.current.filter(
      (item) => !transientExerciseEvent(item.event),
    );
    queuedReview.current = null;
    heardProposal.current = null;
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    inFlight.current = false;
  }
  function stop() {
    const wasSaving = phase === "saving";
    cleanup();
    setRefreshing(false);
    setPhase(settledPhase());
    setNotice(
      wasSaving
        ? "Stopped waiting. The action may already be recorded. Retry the same confirmation to check."
        : "Stopped. You can continue whenever you’re ready.",
    );
  }
  function acceptReply(value: VoiceReply) {
    latestReply.current = value;
    heardProposal.current = null;
    setReply(value);
    if (value.checkin) {
      checkinRef.current = value.checkin;
      setCheckin(value.checkin);
    }
    setPhase(value.proposalId ? "confirmation" : "ready");
  }
  async function request<T>(route: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await api<T>(route, controller.signal, body);
    } finally {
      requests.current.delete(controller);
    }
  }
  async function loadContext() {
    const c = await request<VoiceContext>("context");
    if (live.current) setContext(c);
    return c;
  }
  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await loadContext();
    } catch (e) {
      if (live.current && (e as Error).name !== "AbortError")
        setError((e as Error).message);
    } finally {
      if (live.current) setRefreshing(false);
    }
  }
  useEffect(() => {
    setCanMic(
      window.isSecureContext &&
        Boolean(
          (window as SpeechWindow).SpeechRecognition ||
          (window as SpeechWindow).webkitSpeechRecognition ||
          (context?.sttConfigured &&
            "MediaRecorder" in window &&
            "AudioContext" in window &&
            navigator.mediaDevices?.getUserMedia),
        ),
    );
  }, [context?.sttConfigured]);
  useEffect(() => {
    let mounted = true;
    live.current = true;
    const initGeneration = generation.current;
    setCanMic(
      window.isSecureContext &&
        Boolean(
          (window as SpeechWindow).SpeechRecognition ||
          (window as SpeechWindow).webkitSpeechRecognition,
        ),
    );
    setCanSpeak(Boolean(window.speechSynthesis));
    const init = async () => {
      const results = await Promise.allSettled([
        loadContext(),
        request<VoiceHistoryTurn[]>("voice/history"),
        request<{
          checkin: CheckinSession | null;
          transcript?: { role: string; text: string }[];
        }>("voice/memory"),
      ]);
      if (!live.current || initGeneration !== generation.current) return;
      const past = results[1];
      if (past.status === "fulfilled") {
        setHistory(past.value);
        const last = past.value.at(-1)?.reply;
        // Restoring a transcript must not replay a past navigation command.
        if (last) acceptReply({ ...last, navigation: undefined });
      }
      const remembered = results[2];
      if (remembered.status === "fulfilled" && remembered.value.checkin) {
        checkinRef.current = {
          id: remembered.value.checkin.id,
          stage: remembered.value.checkin.stage,
        };
        setCheckin(checkinRef.current);
        const last = remembered.value.transcript
            ?.filter((turn) => turn.role === "assistant")
            .at(-1),
          loaded = results[0];
        if (last && loaded.status === "fulfilled")
          acceptReply({
            mode: loaded.value.mode,
            engine: loaded.value.aiEngine,
            message: last.text,
            checkin: checkinRef.current,
            proposalId: remembered.value.checkin.pendingProposalId,
          });
      }
      const failed = results.find(
        (r) => r.status === "rejected" && r.reason?.name !== "AbortError",
      );
      if (failed?.status === "rejected") setError(failed.reason.message);
    };
    void init().finally(() => {
      if (mounted) setInitialized(true);
    });
    const leave = () => cleanup();
    const hide = () => {
      if (document.visibilityState === "hidden") {
        cleanup();
        if (live.current) {
          setPhase(settledPhase());
          setRefreshing(false);
        }
      }
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted = false;
      live.current = false;
      cleanup();
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
    };
    // Refs own resource cleanup; initialise once per mounted page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(value = text, direct = false) {
    if (!value.trim() || value.length > 2000 || inFlight.current) return;
    stopMic();
    stopSound();
    inFlight.current = true;
    const run = ++generation.current;
    setPhase("thinking");
    setError("");
    setNotice("");
    const openingExercise = !exerciseRuntime.current && requestsExercise(value);
    const activeCheckin =
      !direct && !openingExercise ? checkinRef.current : undefined;
    const route = openingExercise
      ? "voice/checkin/open-exercise"
      : activeCheckin
        ? "voice/checkin/answer"
        : "voice/turn";
    if (pending.current?.text !== value || pending.current.route !== route)
      pending.current = {
        requestId: crypto.randomUUID(),
        text: value,
        route,
        ...(activeCheckin
          ? { checkinId: activeCheckin.id, expectedStage: activeCheckin.stage, ...(exerciseRuntime.current ? {exerciseContext:exerciseRuntime.current} : {}) }
          : {}),
      };
    const input = pending.current;
    try {
      const { route: target, ...payload } = input;
      const result = await request<VoiceReply>(target, payload);
      if (!live.current || run !== generation.current) return;
      pending.current = null;
      inFlight.current = false;
      acceptReply(result);
      setText("");
      if (handsfree.current) void speak();
      setHistory((items) =>
        [
          ...items.filter((i) => i.requestId !== input.requestId),
          {
            requestId: input.requestId,
            text: input.text,
            reply: result,
            at: new Date().toISOString(),
          },
        ].slice(-50),
      );
      try {
        await loadContext();
      } catch (e) {
        if ((e as Error).name !== "AbortError" && run === generation.current)
          setError(
            "Reply saved. Context refresh failed: " + (e as Error).message,
          );
      }
    } catch (e) {
      if (live.current && run === generation.current) {
        if (!exerciseRuntime.current) {
          handsfree.current = false;
          microphone.current.close();
        }
        setPhase(settledPhase());
        setError(exerciseRuntime.current ? "Panda couldn't answer that question. Your set can continue using the exercise controls." : (e as Error).message);
      }
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        if (feedbackQueue.current.length) void flushFeedback();
      }
    }
  }
  async function resolveProposal(
    action: "confirm" | "cancel",
    confirmationText?: string,
  ) {
    const proposalId = latestReply.current?.proposalId;
    if (!proposalId || inFlight.current) return;
    stopMic();
    stopSound();
    inFlight.current = true;
    const run = ++generation.current;
    setPhase("saving");
    setError("");
    setNotice("");
    try {
      let result = await request<VoiceReply>("voice/" + action, { proposalId });
      const current = checkinRef.current;
      if (
        current &&
        ["medication_confirmation", "help_confirmation"].includes(current.stage)
      ) {
        if (continueAttempt.current?.proposalId !== proposalId)
          continueAttempt.current = {
            requestId: crypto.randomUUID(),
            checkinId: current.id,
            proposalId,
            ...(confirmationText ? { confirmationText } : {}),
          };
        result = await request<VoiceReply>(
          "voice/checkin/continue",
          continueAttempt.current,
        );
        continueAttempt.current = null;
      }
      if (!live.current || run !== generation.current) return;
      inFlight.current = false;
      acceptReply(result);
      setHistory((items) =>
        items.map((i) =>
          i.reply.proposalId === proposalId ? { ...i, reply: result } : i,
        ),
      );
      if (handsfree.current) void speak();
      try {
        await loadContext();
      } catch (e) {
        if ((e as Error).name !== "AbortError" && run === generation.current)
          setError(
            "Action result received. Refresh Care status: " +
              (e as Error).message,
          );
      }
    } catch (e) {
      if (!live.current || run !== generation.current) return;
      handsfree.current = false;
      microphone.current.close();
      const err = e as ApiError;
      if (err.status === 409 || err.status === 404) {
        acceptReply({
          ...latestReply.current!,
          proposalId: undefined,
          message: err.message,
        });
        void refresh();
      } else setPhase("confirmation");
      setError(err.message);
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        if (feedbackQueue.current.length) void flushFeedback();
      }
    }
  }
  function mic(duringSpeech = false) {
    const Ctor =
      (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition;
    if (!micConsentRef.current || !canMic || inFlight.current) return;
    stopMic();
    if (!duringSpeech) stopSound();
    setError("");
    setNotice("");
    const recordingAvailable = Boolean(
      "MediaRecorder" in window &&
      "AudioContext" in window &&
      navigator.mediaDevices?.getUserMedia,
    );
    const selected = preferRecordedRecognition.current && recordingAvailable && context?.sttConfigured
      ? "recorded"
      : speechInputMode(
          Boolean(Ctor),
          recordingAvailable,
          Boolean(context?.sttConfigured),
        );
    const transcribe = async (blob: Blob, signal: AbortSignal) => {
      const form = new FormData();
      form.set(
        "file",
        blob,
        /wav/.test(blob.type)
          ? "microphone.wav"
          : /mp4/.test(blob.type)
            ? "microphone.mp4"
            : "microphone.webm",
      );
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: form,
        signal,
      });
      const out = await response.json();
      if (!response.ok || !out.ok)
        throw Error(out.error?.message || "Transcription unavailable");
      return out.data.text as string;
    };
    const processing = () => {
      patientSpeaking.current = false;
      inputLevel.current = 0;
      transcribing.current = true;
      if (live.current) setPhase("thinking");
    };
    const rec =
      selected === "native" && Ctor
        ? new Ctor()
        : pcmReady.current
          ? pcmRecognition(
              transcribe,
              speaker.current.captureContext(),
              () => microphone.current.open(),
              {
                playback: () => speaking.current,
                level: (value) => {
                  inputLevel.current = value;
                },
                onSpeechStart: () => {
                  patientSpeaking.current = true;
                  if (speaking.current) {
                    heardProposal.current = null;
                    stopSound();
                    if (live.current) setPhase("listening");
                  }
                },
                processing,
              },
            )
          : recordedRecognition(
              transcribe,
              processing,
              () => speaker.current.captureContext(),
              () => microphone.current.open(),
            );
    recognition.current = rec;
    if (selected === "native") {
      const native = rec as Recognition;
      native.onspeechstart = () => {
        if (recognition.current === rec) patientSpeaking.current = true;
      };
      native.onspeechend = () => {
        if (recognition.current === rec) {
          patientSpeaking.current = false;
          transcribing.current = true;
        }
      };
    }
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    const spokenProposal = latestReply.current?.proposalId;
    let received = false,
      failed = false;
    rec.onresult = (e) => {
      if (recognition.current !== rec || !live.current) return;
      transcribing.current = false;
      patientSpeaking.current = false;
      const transcript = e.results[0][0].transcript.trim();
      if (!transcript) {
        received = false;
        return;
      }
      received = true;
      if (
        duringSpeech &&
        playbackEcho(
          transcript,
          latestReply.current?.speechText || latestReply.current?.message || "",
        )
      ) {
        received = false;
        setText("");
        return;
      }
      setText(transcript);
      if (handsfree.current && spokenProposal) {
        if (spokenProposal !== latestReply.current?.proposalId) return;
        const choice = spokenConfirmation(
          transcript,
          latestReply.current?.confirmationPrompt !== false &&
            heardProposal.current === spokenProposal,
        );
        if (choice) {
          setText("");
          void resolveProposal(choice, transcript);
        } else void send(transcript);
      } else if (handsfree.current) void send(transcript);
      else setNotice("Transcript ready. Review it, then choose Send.");
    };
    rec.onerror = (e) => {
      transcribing.current = false;
      if (recognition.current !== rec || !live.current) return;
      // Silence is normal in a conversation. Keep waiting until the patient ends or mutes it.
      if (e.error === "no-speech" && handsfree.current) {
        if (!speaking.current) setPhase("listening");
        return;
      }
      if (shouldFallbackToRecordedRecognition(
        selected === "native",
        recordingAvailable,
        Boolean(contextRef.current?.sttConfigured),
        e.error,
      )) {
        failed = true;
        preferRecordedRecognition.current = true;
        recognition.current = null;
        rec.abort();
        setNotice("Switching to server transcription.");
        micRestart.current = setTimeout(() => {
          micRestart.current = null;
          if (live.current && micConsentRef.current && !inFlight.current)
            mic(duringSpeech);
        }, 0);
        return;
      }
      failed = true;
      handsfree.current = false;
      microphone.current.close();
      setError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was denied. Allow it in browser settings, then tap the mic again. You can also use Keyboard."
          : e.error === "no-speech"
            ? "No speech was heard. Tap the mic to try again."
            : e.error === "transcription-unavailable"
              ? e.message ||
                "Transcription is unavailable. Tap the mic to retry or use Keyboard."
              : e.error === "audio-capture"
                ? "The microphone could not record. Check your input device, then tap the mic again."
                : "Browser speech recognition failed. Tap the mic to retry or use Keyboard.",
      );
      setPhase(settledPhase());
    };
    rec.onend = () => {
      transcribing.current = false;
      patientSpeaking.current = false;
      if (recognition.current === rec && live.current) {
        recognition.current = null;
        if (handsfree.current && !received && !failed && !inFlight.current) {
          if (!speaking.current) setPhase("listening");
          micRestart.current = setTimeout(() => {
            micRestart.current = null;
            if (live.current && handsfree.current) mic(speaking.current);
          }, 120);
        } else setPhase(settledPhase());
      }
    };
    try {
      rec.start();
      if (preferRecordedRecognition.current && selected === "recorded")
        setNotice("Using server transcription.");
      if (!duringSpeech) setPhase("listening");
    } catch {
      recognition.current = null;
      setError("Could not start the microphone. Type your message below.");
      setPhase(settledPhase());
    }
  }
  async function speak(browserFallback = false) {
    const message =
      latestReply.current?.speechText || latestReply.current?.message;
    if (!message || inFlight.current) return;
    stopMic();
    stopSound();
    setError("");
    setNotice("");
    const token = soundGeneration.current;
    speaking.current = true;
    heardProposal.current = null;
    if (pcmReady.current && handsfree.current) mic(true);
    const done = () => {
      if (live.current && token === soundGeneration.current) {
        stopSound();
        heardProposal.current = latestReply.current?.proposalId || null;
        setPhase(settledPhase());
        if (latestReply.current?.conversationEnded) handsfree.current = false;
        if (handsfree.current) {
          if (!speakQueuedCue()) {
            if (recognition.current) setPhase("listening");
            else mic();
          }
        } else {
          stopMic();
          microphone.current.close();
        }
        if (feedbackQueue.current.length) void flushFeedback();
      }
    };
    if (browserFallback || context?.ttsEngine !== "elevenlabs") {
      if (!window.speechSynthesis) {
        handsfree.current = false;
        setError(
          "Browser speech is unavailable. You can read the response above.",
        );
        done();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.onend = done;
      utterance.onerror = () => {
        if (live.current && token === soundGeneration.current) {
          handsfree.current = false;
          setError("Browser speech could not play. Text remains available.");
          done();
        }
      };
      setPhase("speaking");
      window.speechSynthesis.speak(utterance);
      return;
    }
    if (!speechConsentRef.current) {
      setError(
        "Enable speech consent before sending response text to ElevenLabs.",
      );
      return;
    }
    const controller = new AbortController();
    speechAbort.current = controller;
    setPhase("speech_loading");
    const playBufferedSpeech = async () => {
      const response = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: message }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const out = await response.json();
        throw new Error(
          out.error?.message ||
            "Speech could not load. Read the response above or retry playback.",
        );
      }
      if (
        controller.signal.aborted ||
        token !== soundGeneration.current ||
        !live.current
      ) return;
      await speaker.current.play(await response.arrayBuffer(), done);
      if (token === soundGeneration.current && live.current)
        setPhase("speaking");
    };
    try {
      const response = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/pcm" },
        body: JSON.stringify({ text: message }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const out = await response.clone().json().catch(() => null);
        const streamError = new Error(
          out?.error?.message ||
            "Speech could not load. Choose browser speech or read the text.",
        );
        await response.body?.cancel();
        setNotice("Trying backup speech playback.");
        try {
          await playBufferedSpeech();
          return;
        } catch {
          throw streamError;
        }
      }
      if (
        controller.signal.aborted ||
        token !== soundGeneration.current ||
        !live.current
      ) {
        await response.body?.cancel();
        return;
      }
      if (
        response.headers.get("content-type")?.startsWith("audio/pcm") &&
        response.body
      ) {
        try {
          await speaker.current.playPcm(
            response.body,
            Number(response.headers.get("x-panda-audio-rate") || 24000),
            () => {
              if (token === soundGeneration.current && live.current)
                setPhase("speaking");
            },
            done,
          );
        } catch (streamError) {
          if (
            controller.signal.aborted ||
            token !== soundGeneration.current ||
            !live.current
          ) return;
          setNotice("Trying backup speech playback.");
          try {
            await playBufferedSpeech();
          } catch {
            throw streamError;
          }
        }
      } else {
        const bytes = await response.arrayBuffer();
        if (
          controller.signal.aborted ||
          token !== soundGeneration.current ||
          !live.current
        )
          return;
        await speaker.current.play(bytes, done);
        if (token === soundGeneration.current && live.current)
          setPhase("speaking");
      }
    } catch (e) {
      if (token === soundGeneration.current && live.current) {
        if (!controller.signal.aborted && window.speechSynthesis) {
          setNotice("Panda voice is unavailable right now. Using device speech.");
          void speak(true);
          return;
        }
        handsfree.current = false;
        setError((e as Error).message);
        done();
      }
    }
  }

  async function openExercise() {
    stopMic();
    stopSound();
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    const run = ++generation.current;
    inFlight.current = true;
    pending.current = null;
    setError("");
    setNotice("");
    setPhase("thinking");
    exerciseAttempt.current ??= { requestId: crypto.randomUUID() };
    try {
      const result = await request<VoiceReply>(
        "voice/checkin/open-exercise",
        exerciseAttempt.current,
      );
      if (!live.current || run !== generation.current) return;
      exerciseAttempt.current = null;
      inFlight.current = false;
      acceptReply(result);
      if (handsfree.current) void speak();
    } catch (error) {
      if (live.current && run === generation.current) {
        setError((error as Error).message);
        setPhase(settledPhase());
      }
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        if (feedbackQueue.current.length) void flushFeedback();
      }
    }
  }

  async function beginCheckin(withVoice = false) {
    if (inFlight.current) return;
    stopMic();
    stopSound();
    inFlight.current = true;
    const run = ++generation.current;
    setError("");
    setNotice("");
    setPhase("thinking");
    startAttempt.current ??= { requestId: crypto.randomUUID() };
    try {
      const result = await request<VoiceReply>(
        "voice/checkin/start",
        startAttempt.current,
      );
      if (!live.current || run !== generation.current) return;
      startAttempt.current = null;
      inFlight.current = false;
      acceptReply(result);
      handsfree.current = Boolean(
        withVoice &&
        micConsentRef.current &&
        canMic &&
        (context?.ttsEngine !== "elevenlabs" || speechConsentRef.current),
      );
      if (handsfree.current) void speak();
    } catch (e) {
      if (live.current && run === generation.current) {
        handsfree.current = false;
        microphone.current.close();
        setError((e as Error).message);
        setPhase(settledPhase());
      }
    } finally {
      if (run === generation.current) {
        inFlight.current = false;
        if (feedbackQueue.current.length) void flushFeedback();
      }
    }
  }
  async function flushFeedback() {
    if (
      flushingFeedback.current ||
      inFlight.current ||
      speaking.current ||
      patientSpeaking.current ||
      transcribing.current ||
      Date.now() < feedbackRetryAt.current
    )
      return;
    flushingFeedback.current = true;
    try {
      while (
        feedbackQueue.current.length &&
        live.current &&
        !speaking.current &&
        !patientSpeaking.current &&
        !transcribing.current &&
        !inFlight.current
      ) {
        const item = feedbackQueue.current[0];
        const epoch = coachingEpoch.current;
        const result = await request<VoiceReply>(
          "voice/exercise-feedback",
          item,
        );
        feedbackQueue.current = feedbackQueue.current.filter(
          (queued) => queued.requestId !== item.requestId,
        );
        feedbackFailures.current = 0;
        feedbackRetryAt.current = 0;
        if (!live.current) break;
        // Camera/tracking updates must not interrupt a patient mid-sentence.
        if (result.exerciseCue) {
          if (epoch !== coachingEpoch.current) continue;
          const position = result.exerciseCue.setupPosition;
          const stage = exerciseRuntime.current?.stage;
          if (position === "rest" && stage && stage !== "rest" || position === "comfortable_target" && stage && stage !== "target") continue;
          setPandaExerciseCue({ eventId: result.exerciseCue.eventId, text: result.message, expiresAt: result.exerciseCue.expiresAt });
          queuedCue.current = result;
          speakQueuedCue();
        } else if (
          ["report_saved", "guided_report_saved"].includes(item.event.type)
        ) {
          setPandaExerciseCue(null);
          if (
            result.checkin &&
            ["help_confirmation", "wellbeing_followup"].includes(
              result.checkin.stage,
            )
          )
            continue;
          if (result.checkin) {
            checkinRef.current = result.checkin;
            setCheckin(result.checkin);
          }
          queuedReview.current = result;
          speakQueuedCue();
        } else if (result.checkin) {
          checkinRef.current = result.checkin;
          setCheckin(result.checkin);
        }
      }
    } catch (e) {
      feedbackFailures.current++;
      feedbackRetryAt.current =
        Date.now() +
        Math.min(30000, 1000 * 2 ** Math.min(5, feedbackFailures.current));
      if (live.current)
        setError(
          "Panda couldn't receive the latest exercise update. Reconnect to retry: " +
            (e as Error).message,
        );
    } finally {
      flushingFeedback.current = false;
    }
  }
  function queueSetupGuidance() {
    const state = exerciseRuntime.current, current = checkinRef.current;
    if (!state || !current || current.stage !== "exercise" || ["paused", "saved"].includes(state.stage)) return;
    queuedCue.current = {
      mode: context?.mode || "connected", engine: "checkin_workflow", checkin: current,
      message: exerciseInstruction(state),
      exerciseCue: { eventId: "setup:"+state.exerciseId+":"+state.side+":"+state.stage, code: "EXERCISE_SETUP", expiresAt: new Date(Date.now()+30000).toISOString() },
    };
  }
  function updateExerciseContext(state?: ExerciseRuntime) {
    const previous = exerciseRuntime.current;
    exerciseRuntime.current = state;
    if (!state) { cancelExerciseCoaching(); return; }
    if (state.stage !== previous?.stage || state.exerciseId !== previous?.exerciseId || state.side !== previous?.side || state.missingJoint !== previous?.missingJoint) {
      if (queuedCue.current?.exerciseCue?.code === "EXERCISE_SETUP") queuedCue.current = null;
      if (latestReply.current?.exerciseCue?.code === "EXERCISE_SETUP" && speaking.current) {
        stopSound();
        setPhase(settledPhase());
      }
      queueSetupGuidance();
      if (!speakQueuedCue() && handsfree.current && !recognition.current && !inFlight.current) mic();
    }
  }
  function exerciseFeedback(event: RehabBridgeEvent) {
    const current = checkinRef.current;
    if (!current) return;
    if (event.type === "guided_session_started") setPandaExerciseCue(null);
    if (["report_saved", "guided_report_saved"].includes(event.type))
      cancelExerciseCoaching();
    feedbackQueue.current = queueExerciseFeedback(feedbackQueue.current, {
      requestId: crypto.randomUUID(),
      checkinId: current.id,
      event,
    });
    void flushFeedback();
  }
  async function rememberedContext() {
    return request<{
      patientId: string;
      retention: string;
      totalEvents: number;
      events: {
        id: string;
        kind: string;
        quote: string;
        at: string;
        source: string;
      }[];
      transcript?: {
        id: string;
        role: "user" | "assistant";
        text: string;
        at: string;
      }[];
    }>("voice/memory");
  }

  async function activateVoice(forExercise = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++generation.current;
    setError("");
    setNotice("");
    setPhase("permission");
    let permissionStream: MediaStream | undefined;
    try {
      if (!canMic)
        throw Error(
          "Speech recognition is unavailable in this browser. Use the keyboard button below.",
        );
      // Resume from the original tap before awaiting permission/network work.
      if (context?.ttsEngine === "elevenlabs" || context?.sttConfigured)
        await speaker.current.unlock();
      if (!live.current || token !== generation.current) return;
      if (context?.sttConfigured && "MediaRecorder" in window) {
        await microphone.current.open();
        pcmReady.current = await preparePcmInput(
          speaker.current.captureContext(),
        );
      } else if (
        !micConsentRef.current &&
        navigator.mediaDevices?.getUserMedia
      ) {
        permissionStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        permissionStream.getTracks().forEach((track) => track.stop());
        permissionStream = undefined;
      }
      if (!live.current || token !== generation.current) return;
      changeMicConsent(true);
      changeSpeechConsent(true);
      inFlight.current = false;
      if (forExercise && checkinRef.current) {
        handsfree.current = true;
        queueSetupGuidance();
        if (!speakQueuedCue()) mic();
      } else await beginCheckin(true);
    } catch (e) {
      if (live.current && token === generation.current) {
        handsfree.current = false;
        microphone.current.close();
        setError(
          (e as Error).name === "NotAllowedError"
            ? "Microphone permission was denied. Allow it in browser settings, or use the keyboard."
            : (e as Error).message,
        );
        setPhase(settledPhase());
      }
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
      if (token === generation.current) inFlight.current = false;
    }
  }
  function interrupt() {
    if (!micConsentRef.current || !canMic) return;
    heardProposal.current = null;
    stopSound();
    handsfree.current = true;
    mic();
  }
  function speakQueuedCue() {
    if (
      inFlight.current ||
      speaking.current ||
      patientSpeaking.current ||
      transcribing.current
    )
      return false;
    const review = queuedReview.current;
    if (review) {
      queuedReview.current = null;
      if (
        review.checkin?.id === checkinRef.current?.id &&
        review.checkin?.stage === checkinRef.current?.stage
      ) {
        acceptReply(review);
        if (handsfree.current) void speak();
        return handsfree.current;
      }
    }
    const cue = queuedCue.current;
    if (!cue || !handsfree.current) return false;
    if (
      checkinRef.current?.stage !== "exercise" ||
      latestReply.current?.pauseExercise ||
      cue.checkin?.id !== checkinRef.current.id ||
      (cue.exerciseCue?.expiresAt &&
        Date.parse(cue.exerciseCue.expiresAt) <= Date.now())
    ) {
      queuedCue.current = null;
      return false;
    }
    const decision = coachingCadence.current.decide(cue);
    if (decision === "wait") return false;
    queuedCue.current = null;
    if (decision === "drop") return false;
    acceptReply(cue);
    void speak();
    return true;
  }
  function cancelExerciseCoaching() {
    setPandaExerciseCue(null);
    coachingEpoch.current++;
    queuedCue.current = null;
    feedbackQueue.current = feedbackQueue.current.filter(
      (item) => !transientExerciseEvent(item.event),
    );
    if (latestReply.current?.exerciseCue && speaking.current) {
      stopSound();
      setPhase(settledPhase());
      if (handsfree.current && !inFlight.current) {
        if (recognition.current) setPhase("listening");
        else mic();
      }
    }
  }
  coachingTick.current = () => {
    if (!live.current) return;
    if (feedbackQueue.current.length) void flushFeedback();
    speakQueuedCue();
  };
  useEffect(() => {
    const timer = setInterval(() => coachingTick.current(), 250);
    return () => clearInterval(timer);
  }, []);

  function listen(forExercise = false) {
    if (
      latestReply.current?.conversationEnded ||
      !micConsentRef.current ||
      !canMic
    ) {
      void activateVoice(forExercise);
      return;
    }
    const token = generation.current;
    const ready =
      context?.ttsEngine === "elevenlabs" || context?.sttConfigured
        ? speaker.current.unlock()
        : Promise.resolve();
    void ready
      .then(() => {
        if (live.current && token === generation.current) {
          handsfree.current = true;
          if (forExercise) queueSetupGuidance();
          if (!forExercise || !speakQueuedCue()) mic();
        }
      })
      .catch(() => {
        if (live.current && token === generation.current)
          setError("Audio is unavailable. Use the keyboard to continue.");
      });
  }

  function changeMicConsent(value: boolean) {
    micConsentRef.current = value;
    setMicConsent(value);
    if (!value) {
      stopMic();
      microphone.current.close();
      handsfree.current = false;
      if (phase === "listening") setPhase(settledPhase());
    }
  }
  function changeSpeechConsent(value: boolean) {
    speechConsentRef.current = value;
    setSpeechConsent(value);
    if (!value) {
      stopSound();
      if (phase === "speaking" || phase === "speech_loading")
        setPhase(settledPhase());
    }
  }
  function audioLevels() {
    const levels = speaker.current.readLevels();
    if (!speaking.current)
      for (let i = 0; i < levels.length; i++)
        levels[i] =
          inputLevel.current * (0.65 + 0.35 * Math.sin(i * 0.42) ** 2);
    return levels;
  }
  const retryAction = error.startsWith(
    "Exercise is saved in Rehab, but Panda context sync needs a retry:",
  )
    ? "sync"
    : error.startsWith("Reply saved. Context refresh failed:")
      ? "refresh"
      : pending.current && error
        ? "reply"
        : null;
  function retryError() {
    if (retryAction === "reply") {
      const failed = pending.current;
      if (failed)
        void send(
          failed.text,
          failed.route === "voice/turn" && Boolean(checkinRef.current),
        );
    } else if (retryAction === "refresh") {
      void refresh();
    } else if (retryAction === "sync") {
      void flushFeedback();
    }
  }
  return {
    audioLevels,
    context,
    history,
    reply,
    pandaExerciseCue,
    text,
    setText,
    phase,
    error,
    retryAction,
    retryError,
    notice,
    checkin,
    micConsent,
    speechConsent,
    canMic,
    canSpeak,
    refreshing,
    initialized,
    busy: phase === "thinking" || phase === "saving",
    refresh,
    send,
    confirm: () => resolveProposal("confirm"),
    cancel: () => resolveProposal("cancel"),
    mic,
    listen,
    speak,
    stop,
    interrupt,
    activateVoice,
    changeMicConsent,
    changeSpeechConsent,
    openExercise,
    beginCheckin,
    exerciseFeedback,
    updateExerciseContext,
    cancelExerciseCoaching,
    retryFeedback: () => {
      feedbackRetryAt.current = 0;
      return flushFeedback();
    },
    rememberedContext,
  };
}
