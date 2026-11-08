"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { logClientFailure, useLoggedFailure, useMinimumDisplay } from "../ui/client-feedback";
import type { ExerciseRuntime, ExerciseControl } from "../contracts/exercise-runtime";
import type {
  CvChanges,
  CvContext,
  CvExerciseConfig,
  CvExerciseId,
  CvFeedbackText,
  CvFinishInput,
  CvReport,
  CvSession,
  CvTiming,
} from "../contracts/rehab-cv";
import { usePoseCamera, type CameraFrame } from "../yuvraj-integration/camera";
import { missingTrackingJoint, exerciseTrackingProfile } from "../../apps/rehab/src/features/camera/tracking-profile";
import {
  advanceExercise,
  advanceTiming,
  completeGuidedHold,
  createAngleFilter,
  createExerciseState,
  createTimingState,
  createLiveEngineConfig,
  LIVE_DETECTOR,
  liveFrameIsStale,
  deriveCalibration,
  evaluateCalibration,
  filterAngle,
  invalidateExercise,
  measurePose,
  timingSummary,
  type AttemptOutcome,
  type EngineConfig,
  type ExerciseState,
  type TimingState,
  type CalibrationSample,
} from "../../apps/rehab/src/features/exercise";
import {
  cvApi,
  readRecovery,
  SessionTransport,
  type MeasurementBody,
  type Recovery,
} from "../../apps/rehab/src/features/feedback/session-client";
import type { RehabBridgeEvent } from "../contracts/checkin";
import styles from "../../apps/rehab/src/app/cv.module.css";
import immersive from "./guided-screen.module.css";

type Run = {
  simulated: boolean;
  measurementIncomplete: boolean;
  transport: SessionTransport;
  config: EngineConfig;
  engine: ExerciseState;
  timing: TimingState;
  start: number;
  paused: boolean;
  terminal: boolean;
  finishing: boolean;
  tracking: boolean;
  frameAt: number;
  checkpointAt: number;
  guidedAt: number | null;
  guidedMs: number;
  cursor: number;
  polling: boolean;
  pollAt: number;
  attempts: Map<string, string>;
  feedbackRanks: Map<string, number>;
  shownRank: number;
  finishReport: CvFinishInput["report"] | null;
};
const empty = {
  valid: false,
  angle: null as number | null,
  knee: null as number | null,
  confidence: 0,
  inferenceMs: 0,
  reason: null as string | null,
  missingJoint: undefined as ExerciseRuntime["missingJoint"],
};
const messageFor: Record<string, string> = {
  HOLD_TOO_SHORT:
    "Try holding the position for the full demonstration duration.",
  EXTENSION_INCOMPLETE:
    "Follow your comfortable calibrated target without forcing the movement.",
  KNEE_BENDING: "Keep an eye on your knee position during the leg raise.",
  TRACKING_LOST: "I cannot see your working leg clearly. Please reposition.",
  TRACKING_RESTORED: "Tracking is ready. Return to your starting position.",
  REP_COMPLETED: "That movement met the demonstration targets.",
  MOVEMENT_TOO_FAST: "Follow the configured demonstration pace.",
};
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const seconds = (ms: number) => (ms / 1000).toFixed(1);

export default function GuidedWorkspace({
  onEvent,
  onCoachingPause,
  onAskPanda,
  presentation = "workspace",
  companion,
  conversation,
  pandaMessage,
  pandaCue,
  onExit,
  pauseRequested = false,
  canStart = true,
  onRuntime,
  control,
}: {
  onEvent?: (event: RehabBridgeEvent) => void;
  onCoachingPause?: () => void;
  onAskPanda?: () => void;
  presentation?: "workspace" | "camera";
  companion?: ReactNode;
  conversation?: ReactNode;
  pandaMessage?: string;
  pandaCue?: { eventId: string; text: string; expiresAt: string | null } | null;
  onExit?: () => void;
  pauseRequested?: boolean;
  canStart?: boolean;
  onRuntime?: (state: ExerciseRuntime) => void;
  control?: { id: string; action: ExerciseControl };
} = {}) {
  const callbacks = useRef({ onEvent, onAskPanda, onCoachingPause, onRuntime });
  callbacks.current = { onEvent, onAskPanda, onCoachingPause, onRuntime };
  const [context, setContext] = useState<CvContext | null>(null);
  const [exercise, setExercise] = useState<CvExerciseId>(
    "seated-knee-extension",
  );
  const [side, setSide] = useState<"left" | "right">("left");
  const [calibration, setCalibration] = useState<{
    start: number | null;
    target: number | null;
  }>({ start: null, target: null });
  const [measurement, setMeasurement] = useState(empty);
  const [session, setSession] = useState<CvSession | null>(null);
  const [engine, setEngine] = useState(createExerciseState);
  const [timing, setTiming] = useState<CvTiming>({
    elapsedTimeMs: 0,
    activeTimeMs: 0,
    pausedTimeMs: 0,
    userPausedTimeMs: 0,
    trackingPausedTimeMs: 0,
    otherPausedTimeMs: 0,
  });
  const [feedback, setFeedback] = useState<CvFeedbackText | null>(null);
  const [caption, setCaption] = useState(
    "Turn on your camera and follow the guidance for your assigned exercise.",
  );
  const [pandaCueExpired, setPandaCueExpired] = useState(false);
  const [notice, setNotice] = useState(
    "Loading your standalone demonstration…",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const lastControl = useRef<string | undefined>(undefined);
  const timerTick = useRef<() => void>(() => {});
  const [paused, setPaused] = useState(false);
  const [trace, setTrace] = useState(false);
  const [guided, setGuided] = useState(false);
  const [reports, setReports] = useState<CvReport[]>([]);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [lastReport, setLastReport] = useState<CvReport | null>(null);
  const [attemptNote, setAttemptNote] = useState("");
  const run = useRef<Run | null>(null);
  const samples = useRef<CalibrationSample[]>([]);
  const filter = useRef(createAngleFilter());
  const lastFrameAt = useRef(-Infinity);
  const selected = useRef({ exercise, side });
  selected.current = { exercise, side };
  const traceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishAction = useRef<
    (
      status?: CvFinishInput["report"]["completionStatus"],
      reason?: CvFinishInput["report"]["terminationReason"],
    ) => Promise<void>
  >(async () => {});
  const mounted = useRef(true);
  useEffect(() => {
    setPandaCueExpired(false);
    if (!pandaCue?.expiresAt) return;
    const delay = Date.parse(pandaCue.expiresAt) - Date.now();
    if (delay <= 0) {
      setPandaCueExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setPandaCueExpired(true), delay);
    return () => window.clearTimeout(timer);
  }, [pandaCue?.eventId, pandaCue?.expiresAt]);
  const displayedFeedback = useRef<CvFeedbackText | null>(null);
  const configuration = context?.exercises.find(
    (v) => v.exerciseId === exercise,
  );
  const assignmentResolution = context?.planExercise;
  const assignedExercise = assignmentResolution?.assignment ?? null;
  const planDriven =
    presentation === "camera" ||
    (context !== null && context.mode !== "standalone_demo");
  const assignmentMessage =
    context === null
      ? "Loading your approved exercise from your care plan…"
      : assignmentResolution?.message ||
        "No supported exercise and working side were found in the approved plan.";
  const staticQuads = exercise === "static-quads";
  const trackingProfile = exerciseTrackingProfile(exercise, side);

  function acceptFeedback(value: CvFeedbackText) {
    const r = run.current;
    if (
      !r ||
      r.terminal ||
      r.paused ||
      value.sessionId !== r.transport.session.id
    )
      return;
    if (value.expiresAtUtc && Date.parse(value.expiresAtUtc) < Date.now())
      return;
    if (value.feedbackCode === "TRACKING_LOST" && r.tracking) return;
    if (value.feedbackCode === "TRACKING_RESTORED" && !r.tracking) return;
    if (!r.feedbackRanks.has(value.eventId))
      r.feedbackRanks.set(value.eventId, r.feedbackRanks.size + 1);
    const rank = r.feedbackRanks.get(value.eventId)!;
    if (rank < r.shownRank) return;
    if (
      displayedFeedback.current?.eventId === value.eventId &&
      displayedFeedback.current.textRevision > value.textRevision
    )
      return;
    displayedFeedback.current = value;
    r.shownRank = rank;
    setFeedback((previous) =>
      previous?.eventId === value.eventId &&
      previous.textRevision > value.textRevision
        ? previous
        : value,
    );
    setCaption(value.text);
    if (value.generationStatus === "complete")
      callbacks.current.onEvent?.({
        version: "1.0.0",
        type: "guided_feedback",
        sessionId: value.sessionId,
        feedbackId: value.eventId,
      });
  }
  function tick(r: Run, now: number, terminal = false) {
    r.timing = advanceTiming(r.timing, now, {
      terminal,
      userPaused: r.paused,
      trackingValid:
        r.transport.session.exerciseId !== "static-quads" && r.tracking,
      ready: true,
    });
    const summary = {
      ...timingSummary(r.timing),
      ...(r.transport.session.exerciseId === "static-quads"
        ? {
            guidedTimerMs:
              r.guidedMs +
              (r.guidedAt === null ? 0 : Math.max(0, now - r.guidedAt)),
          }
        : {}),
    };
    r.transport.rememberTiming(summary);
    setTiming(summary);
    return summary;
  }
  function enqueue(r: Run, body: MeasurementBody, now: number) {
    const summary = tick(r, now);
    r.transport.rememberTiming(summary);
    r.transport.enqueue(body, summary.elapsedTimeMs);
  }
  function saveAttempt(r: Run, outcome: AttemptOutcome, now: number) {
    if (outcome.invalidated) r.measurementIncomplete = true;
    if (!outcome.invalidated)
      setAttemptNote(
        outcome.qualifying
          ? "Last movement met the hold and return targets."
          : outcome.reason === "short_hold"
            ? "Last movement counted; its hold was shorter than the demo target."
            : outcome.reason === "incomplete_target"
              ? "Last movement did not reach the captured target."
              : outcome.reason === "target_overshoot"
                ? "Last movement went beyond the captured target range. Review your references."
                : outcome.reason === "knee_bending"
                  ? "Last movement counted; the knee-straightness target was not met."
                  : "Last movement did not meet all demonstration targets.",
      );
    let id = r.attempts.get(outcome.attemptId);
    if (!id) {
      id = crypto.randomUUID();
      r.attempts.set(outcome.attemptId, id);
    }
    const { reason, ...metrics } = outcome;
    const allowed = [
      "tracking_lost",
      "user_pause",
      "short_hold",
      "incomplete_target",
      "knee_bending",
      "target_overshoot",
      "movement_too_fast",
    ];
    enqueue(
      r,
      {
        type: "attempt_finalized",
        ...metrics,
        attemptId: id,
        ...(reason
          ? {
              reason: (allowed.includes(reason)
                ? reason
                : "tracking_lost") as Extract<MeasurementBody, { type: "attempt_finalized" }>["reason"],
            }
          : {}),
      },
      now,
    );
  }
  function observe(
    angle: number | null,
    knee: number | null,
    valid: boolean,
    now: number,
    receivedAtMs = now,
  ) {
    const r = run.current;
    if (!r || r.terminal) return;
    r.frameAt = receivedAtMs;
    if (r.tracking !== valid) {
      r.tracking = valid;
      enqueue(r, { type: "tracking_changed", valid }, now);
    }
    tick(r, now);
    if (
      r.paused ||
      r.transport.session.exerciseId === "static-quads"
    )
      return;
    const result = advanceExercise(
      r.engine,
      { atMs: now - r.start, valid, angleDeg: angle, kneeAngleDeg: knee },
      r.config,
    );
    r.engine = result.state;
    setEngine(result.state);
    if (result.attempt) saveAttempt(r, result.attempt, now);
    if (result.feedbackCodes.length) {
      const code =
        result.feedbackCodes.find((c) => c !== "TRACKING_RESTORED") ??
        result.feedbackCodes[0];
      setCaption(
        messageFor[code] ??
          "Keep following your comfortable reference positions.",
      );
    }
  }
  function onFrame(frame: CameraFrame) {
    const choice = selected.current;
    const profile = exerciseTrackingProfile(choice.exercise, choice.side);
    const measured = measurePose(
      frame.landmarks,
      choice.side,
      frame.width,
      frame.height,
      {
        requireTorso: profile.requireTorso,
        minimumVisibility: profile.minimumVisibility,
        minimumPresence: profile.minimumPresence,
        personCount: frame.personCount,
      },
    );
    lastFrameAt.current = frame.receivedAtMs;
    const valid =
      measured.valid && frame.inferenceMs <= LIVE_DETECTOR.maximumSampleGapMs;
    const raw =
      choice.exercise === "straight-leg-raise"
        ? measured.elevationDeg
        : measured.kneeAngleDeg;
    filter.current = filterAngle(
      filter.current,
      valid ? raw : null,
      frame.timestampMs,
      {
        alpha: LIVE_DETECTOR.filterAlpha,
        medianWindow: LIVE_DETECTOR.medianWindow,
        maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs,
      },
    );
    const angle = filter.current.value;
    samples.current = [...samples.current, {atMs: frame.receivedAtMs, angleDeg: angle ?? 0, valid: valid && angle !== null}].filter(sample => frame.receivedAtMs - sample.atMs <= 2000);
    setMeasurement({
      valid,
      angle,
      knee: measured.kneeAngleDeg,
      confidence: measured.confidence,
      missingJoint: missingTrackingJoint(frame.landmarks, profile),
      inferenceMs: frame.inferenceMs,
      reason:
        frame.inferenceMs > LIVE_DETECTOR.maximumSampleGapMs
          ? "processing_slow"
          : measured.reason,
    });
    observe(
      angle,
      measured.kneeAngleDeg,
      valid,
      frame.timestampMs,
      frame.receivedAtMs,
    );
  }
  const camera = usePoseCamera(
    trackingProfile,
    onFrame,
    (reason) => {
      setMeasurement(empty);
      resetCalibration();
      filter.current = createAngleFilter();
      setNotice(reason);
      if (run.current && !run.current.terminal)
        void finishAction.current(
          "interrupted",
          reason.includes("hidden")
            ? "backgrounded"
            : reason.includes("model")
              ? "model_error"
              : "tracking_lost",
        );
    },
    "heavy",
  );
  const cameraWasTracking = useRef(false);
  useLoggedFailure("Rehab session", error);
  useLoggedFailure("Rehab camera", camera.error);
  useLoggedFailure("Rehab assignment", context && planDriven && !assignedExercise ? assignmentMessage : "");
  const noticeIsFailure = /unavailable|failed|couldn.t|could not|error|reconnect|retry|delayed|ended|hidden|changed/i.test(notice);
  useLoggedFailure("Rehab status", noticeIsFailure ? notice : "");
  useEffect(() => {
    if (cameraWasTracking.current && camera.status !== "tracking")
      callbacks.current.onCoachingPause?.();
    cameraWasTracking.current = camera.status === "tracking";
  }, [camera.status]);

  useEffect(() => {
    if (!planDriven) return;
    if (!assignedExercise) {
      if (!run.current && camera.status !== "off") camera.stop();
      return;
    }
    if (run.current && !run.current.terminal) return;
    if (
      exercise === assignedExercise.exerciseId &&
      side === assignedExercise.side
    )
      return;
    if (camera.status !== "off") camera.stop();
    lastFrameAt.current = -Infinity;
    setExercise(assignedExercise.exerciseId);
    setSide(assignedExercise.side);
    resetCalibration();
    setMeasurement(empty);
    filter.current = createAngleFilter();
    setFeedback(null);
  }, [
    planDriven,
    assignedExercise?.exerciseId,
    assignedExercise?.side,
    exercise,
    side,
    camera.status,
  ]);

  useEffect(() => {
    mounted.current = true;
    void cvApi<CvContext>("/context")
      .then(async (value) => {
        if (!mounted.current) return;
        setContext(value);
        setRecovery(readRecovery(value.storageScope));
        setNotice(
          "Demo references are synthetic. Your live camera measurements stay separate from simulated examples.",
        );
        const history = await cvApi<CvReport[]>("/sessions");
        if (mounted.current) setReports(history);
      })
      .catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
      run.current?.transport.dispose();
      if (traceTimer.current) clearInterval(traceTimer.current);
    };
  }, []);
  // A stable interval survives rapidly changing valid/invalid pose frames.
  timerTick.current = () => {
      const now = performance.now();
      const r = run.current;
      if (!r || r.terminal) return;
      if (
        !trace &&
        r.transport.session.exerciseId !== "static-quads" &&
        r.tracking &&
        liveFrameIsStale(r.frameAt, now)
      ) {
        r.tracking = false;
        enqueue(r, { type: "tracking_changed", valid: false }, now);
        setMeasurement((previous) => ({
          ...previous,
          valid: false,
          reason: "frames_delayed",
        }));
        {
          const invalid = invalidateExercise(
            r.engine,
            "sample_gap",
            now - r.start,
          );
          r.engine = invalid.state;
          setEngine(invalid.state);
          if (invalid.attempt) saveAttempt(r, invalid.attempt, now);
        }
        setCaption(messageFor.TRACKING_LOST);
      }
      const summary = tick(r, now);
      if (now - r.checkpointAt >= 1000) {
        r.checkpointAt = now;
        r.transport.checkpoint(summary, summary.elapsedTimeMs);
      }
      if (!r.polling && now - r.pollAt >= 1000) {
        r.pollAt = now;
        r.polling = true;
        void cvApi<CvChanges>(
          `/sessions/${r.transport.session.id}/changes?after=${r.cursor}`,
        )
          .then((change) => {
            r.cursor = change.nextCursor;
            for (const item of change.changes) acceptFeedback(item.feedback);
          })
          .catch(() => {})
          .finally(() => {
            r.polling = false;
          });
      }
  };
  useEffect(() => {
    const timer = setInterval(() => timerTick.current(), 200);
    return () => clearInterval(timer);
  }, []);

  function setCalibrationReference(
    which: "start" | "target",
    capturedAngle: number,
  ) {
    const nextStart = which === "start" ? capturedAngle : calibration.start;
    const nextTarget = which === "target" ? capturedAngle : calibration.target;
    setCalibration((previous) => ({ ...previous, [which]: capturedAngle }));
    setError("");
    if (
      nextStart !== null &&
      nextTarget !== null &&
      !deriveCalibration(nextStart, nextTarget)
    )
      setError(
        "Captured, but the resting and comfortable target positions need at least 15° of separation. Adjust or re-capture one position.",
      );
    else
      setNotice(
        `${which === "start" ? "Resting" : "Comfortable target"} reference set to ${capturedAngle}°. You can replace it before starting.`,
      );
  }
  function capture(which: "start" | "target") {
    if (
      liveFrameIsStale(lastFrameAt.current, performance.now()) ||
      !measurement.valid ||
      measurement.angle === null
    ) {
      setError(
        `No current ${exercise === "straight-leg-raise" ? "leg elevation" : "knee angle"} is available. Keep your assigned ${side} leg${exercise === "straight-leg-raise" ? " and torso" : ""} visible, then capture again.`,
      );
      return;
    }
    const stable = evaluateCalibration(samples.current, { maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs });
    if (!stable.ready || stable.angleDeg === null) {
      setError("Hold this position still for one second, then save it again.");
      return;
    }
    setCalibrationReference(which, Math.round(stable.angleDeg));
  }
  function resetCalibration() {
    samples.current = [];
    setCalibration({ start: null, target: null });
  }
  async function begin(simulated = false): Promise<Run | null> {
    if (planDriven && !assignedExercise) {
      setError(assignmentMessage);
      return null;
    }
    if (
      planDriven &&
      assignedExercise &&
      (exercise !== assignedExercise.exerciseId || side !== assignedExercise.side)
    ) {
      setError("This session must match the exercise in your approved plan.");
      return null;
    }
    if (!context || run.current || recovery || !canStart)
      return null;
    if (
      !simulated &&
      !staticQuads &&
      (camera.status !== "tracking" ||
        !measurement.valid ||
        calibration.start === null ||
        calibration.target === null ||
        !deriveCalibration(calibration.start, calibration.target))
    ) {
      setError(
        "Enable tracking and capture two stable, separated reference positions first.",
      );
      return null;
    }
    setStartRequested(false);
    setBusy(true);
    setError("");
    const start = performance.now();
    try {
      const value = await cvApi<CvSession>(
        "/sessions",
        {
          requestId: crypto.randomUUID(),
          exerciseId: exercise,
          side,
          startedAtUtc: new Date().toISOString(),
          evidence: staticQuads
            ? "patient_reported"
            : simulated
              ? "simulated"
              : "camera_estimated",
          ...(!simulated && !staticQuads
            ? {
                calibration: {
                  startAngleDeg: calibration.start,
                  targetAngleDeg: calibration.target,
                },
              }
            : {}),
        },
        context.csrfToken,
      );
      const config = createLiveEngineConfig(exercise, {
        startAngleDeg: value.configuration.startAngleDeg,
        targetAngleDeg: value.configuration.targetAngleDeg,
        holdMs: value.configuration.targetHoldMs,
        flexionHoldMs: value.configuration.flexionHoldMs,
      });
      const transport = new SessionTransport(
        value,
        context,
        acceptFeedback,
        setError,
      );
      const r: Run = {
        simulated,
        measurementIncomplete: false,
        transport,
        config,
        engine: createExerciseState(),
        timing: createTimingState(start),
        start,
        paused: false,
        terminal: false,
        finishing: false,
        tracking: false,
        frameAt: performance.now(),
        checkpointAt: start,
        guidedAt: null,
        guidedMs: 0,
        cursor: 0,
        polling: false,
        pollAt: 0,
        attempts: new Map(),
        feedbackRanks: new Map(),
        shownRank: 0,
        finishReport: null,
      };
      run.current = r;
      setSession(value);
      if (value.careReference)
        callbacks.current.onEvent?.({
          version: "1.0.0",
          type: "guided_session_started",
          sessionId: value.id,
        });
      setEngine(r.engine);
      setPaused(false);
      setFeedback(null);
      setLastReport(null);
      setAttemptNote("");
      setTrace(simulated);
      tick(r, performance.now());
      if (simulated || staticQuads) {
        r.tracking = simulated;
        enqueue(
          r,
          { type: "tracking_changed", valid: simulated || staticQuads },
          performance.now(),
        );
      }
      setCaption(
        simulated
          ? "Simulated input is running. These are test movements, not camera observations."
          : staticQuads
            ? "Start the guided timer, then confirm the hold yourself."
            : "Return to the start reference, then move toward your comfortable target.",
      );
      setNotice(
        simulated
          ? "SIMULATED measurement trace — never saved as camera evidence."
          : "Set started. Text feedback works with sound off.",
      );
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The set could not start.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function finish(
    status: CvFinishInput["report"]["completionStatus"] = "completed",
    reason: CvFinishInput["report"]["terminationReason"] = "finished",
  ) {
    const r = run.current;
    if (!r || r.finishing) return;
    callbacks.current.onCoachingPause?.();
    r.finishing = true;
    setBusy(true);
    setError("");
    if (!r.finishReport) {
      const now = performance.now();
      const observedEndedAtUtc = new Date().toISOString();
      if (traceTimer.current) {
        clearInterval(traceTimer.current);
        traceTimer.current = null;
      }
      camera.stop();
      {
        const invalid = invalidateExercise(
          r.engine,
          "user_pause",
          now - r.start,
        );
        r.engine = invalid.state;
        if (invalid.attempt) saveAttempt(r, invalid.attempt, now);
      }
      if (r.guidedAt !== null) {
        r.guidedMs += Math.max(0, now - r.guidedAt);
        r.guidedAt = null;
      }
      const summary = tick(r, now, true);
      r.transport.checkpoint(summary, summary.elapsedTimeMs);
      r.terminal = true;
      r.finishReport = {
        observedEndedAtUtc,
        completionStatus: status,
        terminationReason: reason,
        timing: summary,
        timingQuality: r.measurementIncomplete ? "partial" : "complete",
      };
      camera.stop();
      setGuided(false);
      setTrace(false);
    }
    try {
      const report = await r.transport.finish(r.finishReport);
      if (r.transport.session.careReference)
        callbacks.current.onEvent?.({
          version: "1.0.0",
          type: "guided_report_saved",
          sessionId: report.sessionId,
        });
      run.current = null;
      setSession(null);
      setPaused(false);
      setLastReport(report);
      setEngine(r.engine);
      setReports(await cvApi<CvReport[]>("/sessions"));
      setNotice(
        `Report saved once · ${report.completionStatus.replaceAll("_", " ")}.`,
      );
      setCaption(
        "Your report is saved. You can review the measurements below.",
      );
    } catch (e) {
      r.finishing = false;
      setError(
        `${e instanceof Error ? e.message : "Save is pending."} Your frozen measurements are retained; retry saving.`,
      );
    } finally {
      setBusy(false);
    }
  }
  finishAction.current = finish;
  function pauseResume() {
    const r = run.current;
    if (!r || r.terminal) return;
    callbacks.current.onCoachingPause?.();
    const now = performance.now();
    if (!r.paused) {
      const invalid = invalidateExercise(r.engine, "user_pause", now - r.start);
      r.engine = invalid.state;
      setEngine(invalid.state);
      if (invalid.attempt) saveAttempt(r, invalid.attempt, now);
      if (r.guidedAt !== null) {
        r.guidedMs += Math.max(0, now - r.guidedAt);
        r.guidedAt = null;
        setGuided(false);
      }
    }
    r.paused = !r.paused;
    tick(r, now);
    enqueue(
      r,
      { type: "session_state_changed", action: r.paused ? "pause" : "resume" },
      now,
    );
    setPaused(r.paused);
    setCaption(
      r.paused
        ? "Set paused. Timed holds and repetition counting are stopped."
        : "Set resumed. Return to your start position to begin a new movement.",
    );
  }
  function guidedHold() {
    const r = run.current;
    if (!r || r.terminal || r.paused) return;
    const now = performance.now();
    if (r.guidedAt === null) {
      r.guidedAt = now;
      setGuided(true);
      setCaption(
        "Guided timer running. Only you can confirm the muscle contraction.",
      );
      return;
    }
    const duration = now - r.guidedAt;
    r.guidedMs += duration;
    r.guidedAt = null;
    setGuided(false);
    const result = completeGuidedHold(r.engine, duration, true, r.config);
    r.engine = result.state;
    setEngine(result.state);
    if (result.attempt) saveAttempt(r, result.attempt, now);
    setCaption(
      duration >= r.config.holdMs
        ? "Your patient-confirmed hold is recorded."
        : "Your confirmation was recorded as a shorter guided hold.",
    );
  }
  async function replay() {
    camera.stop();
    const r = await begin(true);
    if (!r) return;
    const start = r.transport.session.configuration.startAngleDeg,
      target = r.transport.session.configuration.targetAngleDeg;
    let elapsed = 0;
    // Two deliberate fixture cycles: one short hold, then one qualifying hold.
    const cycle = (hold: number) => [
      { ms: 600, a: start },
      { ms: 600, a: target },
      { ms: hold, a: target },
      { ms: 700, a: start },
      {
        ms: exercise === "seated-knee-flexion-extension" ? 5600 : 700,
        a: start,
      },
    ];
    const phases = [...cycle(3000), ...cycle(5600)];
    traceTimer.current = setInterval(() => {
      if (run.current !== r || r.terminal) {
        if (traceTimer.current) clearInterval(traceTimer.current);
        return;
      }
      if (r.paused) return;
      elapsed += 100;
      let t = elapsed;
      let current = phases.at(-1)!;
      for (const phase of phases) {
        current = phase;
        if (t <= phase.ms) break;
        t -= phase.ms;
      }
      const now = performance.now();
      setMeasurement({
        valid: true,
        angle: current.a,
        knee: 165,
        confidence: 1,
        inferenceMs: 0,
        reason: null,
        missingJoint: undefined,
      });
      observe(current.a, 165, true, now);
      if (elapsed >= phases.reduce((sum, p) => sum + p.ms, 0)) {
        if (traceTimer.current) clearInterval(traceTimer.current);
        traceTimer.current = null;
        setNotice(
          "Simulated trace complete. Finish and save to inspect the clearly labeled report.",
        );
      }
    }, 100);
  }
  async function recover() {
    if (!context || !recovery) return;
    setBusy(true);
    setError("");
    try {
      const transport = new SessionTransport(
        recovery.session,
        context,
        () => {},
        setError,
        recovery,
      );
      const report = await transport.finish(
        recovery.finish?.report ?? {
          observedEndedAtUtc: new Date().toISOString(),
          completionStatus: "interrupted",
          terminationReason: "recovered_crash",
          timing: recovery.timing,
          timingQuality: "partial",
        },
      );
      setLastReport(report);
      if (recovery.session.careReference)
        callbacks.current.onEvent?.({
          version: "1.0.0",
          type: "guided_report_saved",
          sessionId: report.sessionId,
        });
      setReports(await cvApi<CvReport[]>("/sessions"));
      setRecovery(null);
      setNotice(
        "Recovered measurements saved as an interrupted result; missing time was not invented.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery is waiting to save.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (pauseRequested && run.current && !run.current.terminal)
      void finishAction.current("interrupted", "discomfort_reported");
  }, [pauseRequested, session?.id]);

  const calibrated =
    calibration.start !== null &&
    calibration.target !== null &&
    !!deriveCalibration(calibration.start, calibration.target);
  const manualCaptureReady =
    camera.status === "tracking" &&
    measurement.valid &&
    measurement.angle !== null &&
    !liveFrameIsStale(lastFrameAt.current, performance.now()) &&
    evaluateCalibration(samples.current, { maximumSampleGapMs: LIVE_DETECTOR.maximumSampleGapMs }).ready;
  const running = !!session;
  const canCaptureReference = measurement.valid && !liveFrameIsStale(lastFrameAt.current, performance.now()) && evaluateCalibration(samples.current, {maximumSampleGapMs:LIVE_DETECTOR.maximumSampleGapMs}).ready;
  const runtimeStage: ExerciseRuntime["stage"] = lastReport ? "saved" : running ? paused ? "paused" : "running" : staticQuads ? "ready" : camera.status !== "tracking" ? "camera_off" : !measurement.valid ? "framing" : calibration.start === null ? "rest" : calibration.target === null ? "target" : calibrated ? "ready" : "target";
  const runtimeReps = engine.qualifyingReps;
  useEffect(() => {
    if (configuration) callbacks.current.onRuntime?.({ exerciseId: exercise, label: configuration.label, side, stage: runtimeStage, missingJoint: measurement.missingJoint, completedReps: runtimeReps, targetReps: configuration.targetReps });
  }, [exercise, configuration?.label, side, runtimeStage, measurement.missingJoint, runtimeReps, configuration?.targetReps]);
  async function requestStart() {
    if (!canStart || busy || recovery) return;
    if (planDriven && !assignedExercise) { setError(assignmentMessage); return; }
    if (staticQuads || calibrated && camera.status === "tracking" && measurement.valid) { await begin(); return; }
    setStartRequested(true);
    setError("");
    if (camera.status === "off" || camera.status === "error") {
      // A new camera run needs fresh references; never reuse a finished set's pose.
      resetCalibration();
      setLastReport(null);
      await camera.start();
    }
  }
  useEffect(() => {
    if (startRequested && canStart && !busy && !run.current && calibrated && measurement.valid && camera.status === "tracking") void begin();
  }, [startRequested, canStart, busy, calibrated, measurement.valid, camera.status]);
  useEffect(() => {
    if (!control || control.id === lastControl.current) return;
    lastControl.current = control.id;
    const active = run.current;
    if (control.action === "start" && !active) void requestStart();
    if (control.action === "pause" && active && !active.paused) pauseResume();
    if (control.action === "resume" && active?.paused) pauseResume();
    if (control.action === "finish" && active) void finish();
  }, [control?.id]);

  useEffect(() => {
    const active = run.current;
    const reps = engine.qualifyingReps;
    if (active && !active.terminal && !active.finishing && !active.paused && reps >= active.transport.session.configuration.targetReps) void finishAction.current();
  }, [session?.id, engine.qualifyingReps]);
  const shortHolds = engine.shortHolds;
  const holdDisplay =
    staticQuads && run.current?.guidedAt != null
      ? performance.now() - run.current.guidedAt
      : engine.currentHoldMs;
  const liveConfig = run.current?.config;
  const displayedReps = engine.qualifyingReps,
    displayedMovements = engine.movementCycles,
    displayedPhase = engine.phase,
    displayedHold = holdDisplay;
  const calibrationInstruction =
    camera.status !== "tracking"
      ? "Turn on the camera to capture your reference positions."
      : calibration.start === null
        ? "Hold your comfortable resting position, then capture Resting position below."
        : calibration.target === null
          ? "Move to your comfortable end position, then capture Comfortable target below."
          : calibrated
            ? "Your references are ready. Start when you feel comfortable."
            : "Re-capture one position so the two references are at least 15° apart.";
  const rangeText = (range: [number, number]) =>
    `${range[0].toFixed(0)}–${range[1].toFixed(0)}°`;
  const measurementHelp =
    measurement.reason === "person_ambiguous"
      ? "Keep just one person in view."
      : measurement.reason === "processing_slow" ||
          measurement.reason === "frames_delayed"
        ? "Pose updates are delayed. Keep the page visible and wait for fresh tracking."
        : measurement.reason === "torso_unavailable"
          ? "This leg raise also needs your working-side shoulder visible for its torso reference."
          : measurement.missingJoint
            ? `I can’t see your ${side} ${measurement.missingJoint} clearly. Move back so your whole working leg is in view, with that leg nearest the camera.`
            : `Keep your assigned ${side} hip, knee and ankle visible. Place that leg nearest the camera.`;
  const countingInstruction = !running
    ? "Follow the on-screen guidance, then start your exercise."
    : paused
      ? "Counting is paused."
      : !trace && !measurement.valid
        ? measurementHelp
        : !liveConfig
          ? "Waiting for exercise references."
          : {
              await_start: `Return to your start reference (${rangeText(liveConfig.startRangeDeg)}) and hold briefly.`,
              armed: "Ready. Move toward your comfortable target.",
              outbound: `Reach your comfortable target (${rangeText(liveConfig.targetRangeDeg)}). Do not force the movement.`,
              holding: `Hold ${seconds(engine.currentHoldMs)} / ${seconds(liveConfig.holdMs)} seconds, then return to start.`,
              returning: `Return to your start reference (${rangeText(liveConfig.startRangeDeg)}) to finish this movement.`,
              return_hold: `Hold the bent position: ${seconds(displayedHold)} / ${seconds(liveConfig.flexionHoldMs ?? 0)} seconds.`,
            }[engine.phase];
  const exerciseHint = staticQuads
      ? "Gently tighten the thigh muscle, then confirm your hold."
      : exercise === "straight-leg-raise"
        ? "Lift your leg at your own pace."
        : "Gently straighten your leg.";
    const movementText = paused
      ? "Take a little break."
      : staticQuads
        ? guided
          ? "Hold gently. Breathe naturally."
          : "Ready for your next hold?"
        : !measurement.valid && !trace
          ? "Let’s get you back in view."
          : displayedPhase === "holding"
            ? "Hold there. Take your time."
            : displayedPhase === "returning"
              ? "Slowly return to the start."
              : displayedPhase === "return_hold"
                ? "Hold your bent position."
                : displayedPhase === "await_start"
                  ? "Find your starting position."
                  : exerciseHint;
    const cueVisible =
      feedback &&
      (!feedback.expiresAtUtc ||
        Date.parse(feedback.expiresAtUtc) > Date.now());
    const bridgeCueVisible =
      running &&
      Boolean(pandaMessage) &&
      Boolean(pandaCue) &&
      !pandaCueExpired &&
      pandaCue?.text !== pandaMessage;
  const feedbackScope = exercise + ":" + side + ":" + (session?.id ?? "setup") + ":" + (pauseRequested || paused ? "paused" : lastReport ? "saved" : "active");
  const heading = pandaMessage || (planDriven && !assignedExercise ? "Waiting for your assigned exercise." : lastReport ? "How did that feel?" : running ? movementText : staticQuads ? "Make yourself comfortable." : camera.status === "tracking" ? !measurement.valid ? "Let’s get your working leg in view." : calibration.start === null ? "Hold your comfortable starting position." : calibration.target === null ? "Now find your comfortable target." : "Your references are ready." : "Let’s get you in view.");
  const detail = pandaMessage ? "" : running ? paused ? "Counting is paused. Take your time." : (cueVisible ? feedback.text : staticQuads ? exerciseHint : "Follow your comfortable references. Stop if it feels uncomfortable.") : lastReport ? "Panda will help you review how you felt." : staticQuads ? "This guided timer uses your confirmation. No camera measurement is claimed." : camera.status === "tracking" ? !measurement.valid ? measurementHelp : calibrationInstruction : trackingProfile.framingInstruction;
  const cameraGuide = useMinimumDisplay({ heading, detail, fromPanda: Boolean(pandaMessage) }, feedbackScope);
  const stableCountingInstruction = useMinimumDisplay(countingInstruction, feedbackScope);
  const stableCaption = useMinimumDisplay(caption, feedbackScope);
  const stableBridgeCue = useMinimumDisplay(bridgeCueVisible ? pandaCue?.text ?? "" : "", feedbackScope);
  const cameraStatusText = useMinimumDisplay(trace ? "Simulated movements" : staticQuads ? "Patient-confirmed holds" : camera.status === "tracking" ? measurement.valid ? `Tracking your ${side} leg` : `Bring your ${side} leg into view` : "Camera off", feedbackScope);
  if (presentation === "camera") {
    async function exit() {
      if (run.current) await finish("interrupted", "patient_stopped");
      if (!run.current) onExit?.();
    }
    return (
      <div className={immersive.screen} aria-label="Guided exercise camera">
        <video
          ref={camera.videoRef}
          muted
          playsInline
          autoPlay
          aria-label="Live camera preview"
          className={immersive.video}
        />
        <canvas
          ref={camera.canvasRef}
          className={immersive.skeleton}
          aria-hidden="true"
        />
        <div className={immersive.shade} />
        <div className={immersive.header}>
          <button
            type="button"
            aria-label="Exit exercise"
            disabled={busy}
            onClick={() => void exit()}
          >
            ‹
          </button>
          <div>
            <small>Move with Panda</small>
            <strong>
              {planDriven
                ? assignedExercise?.label ?? "Your exercise"
                : configuration?.label ?? "Your exercise"}
            </strong>
            <span>{cameraStatusText}</span>
          </div>
        </div>
        <aside
          className={immersive.companion}
          aria-label="Panda exercise companion"
        >
          {companion}
        </aside>
        <div className={immersive.guide} role="status" aria-live="polite">
          {cameraGuide.fromPanda ? (
            <>
              <span className={immersive.eyebrow}>Panda is here with you</span>
              <h1>{cameraGuide.heading}</h1>
            </>
          ) : (
            <>
              <span className={immersive.eyebrow}>
                {lastReport
                  ? "Your exercise is saved"
                  : running
                    ? paused
                      ? "Paused"
                      : "One movement at a time"
                    : "A little movement, together"}
              </span>
              <h1>{cameraGuide.heading}</h1>

              <p>{cameraGuide.detail}</p>

            </>
          )}
          {running &&
            (guided ||
              displayedPhase === "holding" ||
              displayedPhase === "return_hold") && (
              <strong className={immersive.hold}>
                {seconds(displayedHold)}
                <span>
                  {" "}
                  /{" "}
                  {seconds(
                    displayedPhase === "return_hold"
                      ? (configuration?.flexionHoldMs ?? 0)
                      : (configuration?.targetHoldMs ?? 5000),
                  )}{" "}
                  sec
                </span>
              </strong>
            )}
          {!running &&
            !lastReport &&
            !staticQuads &&
            camera.status !== "tracking" && (
              <button
                disabled={
                  busy ||
                  (planDriven && !assignedExercise) ||
                  camera.status === "loading" ||
                  camera.status === "permission"
                }
                onClick={() => void camera.start()}
              >
                {camera.status === "loading"
                  ? "Preparing camera…"
                  : camera.status === "permission"
                    ? "Waiting for camera…"
                    : "Enable camera"}
              </button>
            )}

        </div>
        {stableBridgeCue && (
          <aside
            className={immersive.feedbackOverlay}
            role="status"
            aria-live="polite"
            aria-label="Live movement feedback from Panda"
          >
            <span>Live movement cue</span>
            <p>{stableBridgeCue}</p>
          </aside>
        )}
        <div className={immersive.bottom}>
          {running && (
            <div className={immersive.progress}>
              <span>
                Set {reports.filter(report => report.exerciseId === exercise && report.side === side && report.startedAtUtc.slice(0,10) === new Date().toISOString().slice(0,10)).length + 1} · {displayedReps} of {configuration?.targetReps ?? 10} reps · {displayedMovements} movements · {shortHolds} short holds
              </span>
              <span>{clock(timing.elapsedTimeMs)}</span>
            </div>
          )}
          {!running && !lastReport && !staticQuads && camera.status === "tracking" && (
            <div className={immersive.referenceSteps} aria-label="Manual calibration">
              <span>{calibration.start === null ? "1 · Starting position" : calibration.target === null ? "2 · Comfortable end position" : "Reference positions saved"}</span>
              <button disabled={!canCaptureReference || busy} onClick={() => capture("start")}>Save starting position{calibration.start !== null ? ` · ${calibration.start}°` : ""}</button>
              <button disabled={!canCaptureReference || busy || calibration.start === null} onClick={() => capture("target")}>Save comfortable target{calibration.target !== null ? ` · ${calibration.target}°` : ""}</button>
              <small>{!measurement.valid ? measurementHelp : canCaptureReference ? `Current estimate: ${measurement.angle?.toFixed(0)}°. Save each comfortable position.` : "Hold still for one second before saving each position."}</small>
            </div>
          )}
          {lastReport && <div className={immersive.progress}><span>{lastReport.completedReps} reps saved</span><span>{reports.filter(report => report.exerciseId === exercise && report.side === side && report.startedAtUtc.slice(0,10) === new Date().toISOString().slice(0,10)).length} sets saved today</span></div>}
          {conversation}
          {!canStart && context && <p className={immersive.reviewHint}>{lastReport ? "Tell Panda how the set felt before starting another." : "Continue the check-in with Panda before starting a set."}</p>}
          <div className={immersive.buttons}>
            {running ? (
              <>
                <button
                  disabled={busy || !!run.current?.terminal}
                  onClick={pauseResume}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button disabled={busy} onClick={() => void finish()}>
                  {busy ? "Saving…" : "Finish and save"}
                </button>
              </>
            ) : (
              <button
                disabled={!context || (planDriven && !assignedExercise) || !canStart || busy || !!recovery}
                onClick={() => void requestStart()}
              >
                {busy ? "Starting…" : !canStart && context ? "Continue with Panda" : staticQuads || calibrated ? "Start set" : camera.status === "loading" || camera.status === "permission" ? "Starting camera…" : camera.status !== "tracking" ? "Set up & start" : startRequested ? "Start after setup" : "Set up this set"}
              </button>
            )}
          </div>
          {running && staticQuads && (
            <button
              className={immersive.holdButton}
              disabled={paused || busy}
              onClick={guidedHold}
            >
              {guided ? "Confirm this hold" : "Start guided hold"}
            </button>
          )}
          {running && (
            <button
              className={immersive.stop}
              disabled={busy}
              onClick={() => void finish("interrupted", "discomfort_reported")}
            >
              Stop for discomfort
            </button>
          )}
          <small className={immersive.evidence}>
            {trace
              ? "Simulated example"
              : staticQuads
                ? "Patient-reported"
                : "Camera estimates"}{" "}
            · demonstration references
          </small>
        </div>
        {!staticQuads && !running && (
          <small className={immersive.landmarkNote}>
            Images stay on this device. Joint positions are sent to Gemini.
          </small>
        )}
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.intro}>
        <div>
          <div className={styles.eyebrow}>Yuvraj / Camera to text</div>
          <h1>
            Every movement.
            <br />A little more clarity.
          </h1>
          <p>
            Track your demonstration, see what was measured, and get clear text
            feedback as you move.
          </p>
        </div>
        <span className={styles.scope}>
          {onAskPanda
            ? "Guided demo · Panda stays with you"
            : "Standalone exercise demo"}
        </span>
      </div>
      {onAskPanda && (
        <button type="button" className={styles.outline} onClick={onAskPanda}>
          Talk to Panda
        </button>
      )}
      <p
        className={styles.status}
        role="status"
      >
        {noticeIsFailure ? "" : notice}
      </p>
      {recovery && (
        <div className={styles.status}>
          <p>
            An unfinished set was found on this browser. Save its last known
            measurements before starting another.
          </p>
          <button disabled={busy} onClick={() => void recover()}>
            Save recovered set
          </button>
        </div>
      )}
      <div className={styles.layout}>
        <div>
          <section className={styles.panel} aria-label="Live exercise camera">
            <div className={styles.panelHead}>
              <div>
                <h2>Your movement workspace</h2>
                <p>Camera frames stay on this device.</p>
              </div>
              <span
                className={`${styles.badge} ${trace ? styles.badgeAmber : ""}`}
              >
                <span className={styles.dot} />
                {trace
                  ? "Simulated input"
                  : camera.status === "tracking"
                    ? "Camera on"
                    : "Camera off"}
              </span>
            </div>
            <div className={styles.stage}>
              <video
                ref={camera.videoRef}
                muted
                playsInline
                autoPlay
                style={{ transform: "scaleX(-1)" }}
                aria-label="Live camera preview"
              />
              <canvas ref={camera.canvasRef} aria-hidden="true" />
              {camera.status !== "tracking" && (
                <div className={styles.stageEmpty}>
                  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
                    <rect
                      x="5"
                      y="12"
                      width="27"
                      height="24"
                      rx="5"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path
                      d="m32 20 11-6v20l-11-6"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                  <h3>
                    {trace ? "Example movements" : "A clear view starts here"}
                  </h3>
                  <p>
                    {trace
                      ? "The trace tests the same movement engine. It is always labeled simulated."
                      : staticQuads
                        ? "Static quads uses a guided timer and your confirmation. Camera inference cannot verify muscle contraction."
                        : "Place the camera side-on so your working hip, knee and ankle stay visible."}
                  </p>
                </div>
              )}
              <span className={styles.stageLabel}>
                {trace
                  ? "TRACE / SIMULATED"
                  : measurement.valid
                    ? "WORKING LEG VISIBLE"
                    : "POSITION YOUR CAMERA"}
              </span>
              <div className={styles.stageBottom}>
                <span>
                  {measurement.angle === null
                    ? "Angle unavailable"
                    : `${measurement.angle.toFixed(0)}° estimated ${exercise === "straight-leg-raise" ? "elevation" : "knee angle"}`}
                </span>
                <span>
                  {camera.backend
                    ? `${camera.backend} · ${measurement.inferenceMs.toFixed(0)} ms inference`
                    : "No microphone or speech required"}
                </span>
              </div>
            </div>
            <div className={styles.cameraActions}>
              <button
                disabled={
                  staticQuads ||
                  !context ||
                  running ||
                  busy ||
                  (planDriven && !assignedExercise) ||
                  camera.status === "permission" ||
                  camera.status === "loading"
                }
                onClick={() => void camera.start()}
              >
                {camera.status === "permission"
                  ? "Waiting for permission…"
                  : camera.status === "loading"
                    ? "Loading pose model…"
                    : "Enable camera"}
              </button>
              <button
                className={styles.outline}
                onClick={() => {
                  camera.stop();
                  setMeasurement(empty);
                  if (run.current)
                    void finish("interrupted", "patient_stopped");
                }}
              >
                Stop camera
              </button>
              <small>{trackingProfile.framingInstruction}</small>
            </div>

            {!staticQuads && (
              <div
                className={styles.countingGuide}
                aria-label="Repetition counting guidance"
              >
                <strong>{stableCountingInstruction}</strong>
                <p>
                  {running && liveConfig
                    ? `Start ${rangeText(liveConfig.startRangeDeg)} · Target ${rangeText(liveConfig.targetRangeDeg)} · ${side} leg`
                    : camera.status === "tracking" && !measurement.valid
                      ? measurementHelp
                      : "A full movement includes reaching the target and returning to start. The hold target is shown separately."}
                </p>
                {attemptNote && <p>{attemptNote}</p>}
              </div>
            )}
            <div className={styles.metrics}>
              <div className={styles.metric}><strong>{shortHolds}</strong><span>Short holds</span></div>
              <div className={styles.metric}>
                <strong>{displayedMovements}</strong>
                <span>Full movements</span>
              </div>
              <div className={styles.metric}>
                <strong>
                  {displayedReps}/{configuration?.targetReps ?? 10}
                </strong>
                <span>Met demo targets</span>
              </div>
              <div className={styles.metric}>
                <strong>{seconds(displayedHold)}s</strong>
                <span>{staticQuads ? "Guided hold" : "Current hold"}</span>
              </div>
              <div className={styles.metric}>
                <strong>{clock(timing.elapsedTimeMs)}</strong>
                <span>Elapsed time</span>
              </div>
            </div>
          </section>
          <section className={styles.feedback} aria-label="Panda text feedback">
            <div className={styles.feedbackTop}>
              <span className={styles.eyebrow}>Panda feedback</span>
              <span className={styles.source}>
                {feedback?.textSource === "gemini_selected_approved_variant"
                  ? "Gemini selected wording"
                  : feedback?.generationStatus === "pending"
                    ? "Natural wording pending"
                    : "Immediate text"}
              </span>
            </div>
            <blockquote aria-live="polite">{stableCaption}</blockquote>
            <p>
              {paused
                ? "Paused"
                : running
                  ? displayedPhase.replaceAll("_", " ")
                  : "Ready when you are"}{" "}
              ·{" "}
              {staticQuads
                ? `Guided time ${clock(timing.guidedTimerMs ?? 0)}`
                : `Active ${clock(timing.activeTimeMs)} · Paused ${clock(timing.pausedTimeMs)}`}
            </p>
          </section>
        </div>
        <div className={styles.sideStack}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <h2>Your assigned exercise</h2>
                <p>Follow the exercise and side from your care plan.</p>
              </div>
            </div>
            <div className={styles.setup}>
              <div className={styles.fieldRow}>
                <label>
                  Exercise
                  <span>{assignedExercise?.label ?? configuration?.label ?? "Loading exercise…"}</span>
                </label>
                <label>
                  Working leg
                  <span>
                    {(assignedExercise?.side ?? side) === "left" ? "Left" : "Right"}
                  </span>
                </label>
              </div>

              <p className={styles.footnote}>
                {calibrationInstruction}
              </p>
              <div className={styles.configNote}>
                {configuration?.description ?? "Loading exercise references…"}
                <br />
                {configuration?.targetHoldMs
                  ? `${configuration.targetHoldMs / 1000}-second demonstration hold · ${configuration.targetReps} target repetitions`
                  : ""}
              </div>
              {!staticQuads && (
                <div>
                  <div className={styles.stepLabel}>
                    Manual calibration
                  </div>
                  <div>
                    <div className={styles.calibration}>
                      <button
                        className={calibration.start !== null ? styles.captured : ""}
                        disabled={running || !manualCaptureReady}
                        onClick={() => capture("start")}
                      >
                        <span>Resting position</span>
                        <strong>{calibration.start === null ? "—" : `${calibration.start}°`}</strong>
                        <small>Current estimate: {manualCaptureReady ? `${measurement.angle!.toFixed(0)}°` : "waiting for tracking"}</small>
                      </button>
                      <button
                        className={calibration.target !== null ? styles.captured : ""}
                        disabled={running || !manualCaptureReady}
                        onClick={() => capture("target")}
                      >
                        <span>Comfortable target</span>
                        <strong>{calibration.target === null ? "—" : `${calibration.target}°`}</strong>
                        <small>Capture while holding comfortably</small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {!running ? (
                <button
                  className={styles.runButton}
                  disabled={
                    !context ||
                    (planDriven && !assignedExercise) ||
                    busy ||
                    !!recovery ||
                    (!staticQuads && !calibrated)
                  }
                  onClick={() => void begin()}
                >
                  {busy ? "Starting…" : "Start exercise"}
                </button>
              ) : (
                <>
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-label="Qualifying repetition progress"
                    aria-valuemin={0}
                    aria-valuemax={configuration?.targetReps ?? 10}
                    aria-valuenow={displayedReps}
                  >
                    <span
                      style={{
                        width: `${Math.min(100, (displayedReps / (configuration?.targetReps ?? 10)) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className={styles.controls}>
                    <button
                      className={styles.secondary}
                      disabled={busy || !!run.current?.terminal}
                      onClick={pauseResume}
                    >
                      {paused ? "Resume" : "Pause"}
                    </button>
                    <button disabled={busy} onClick={() => void finish()}>
                      {busy
                        ? "Saving…"
                        : run.current?.terminal
                          ? "Retry save"
                          : "Finish and save"}
                    </button>
                    <button
                      className={styles.danger}
                      disabled={busy}
                      onClick={() =>
                        void finish("cancelled", "patient_stopped")
                      }
                    >
                      Cancel set
                    </button>
                  </div>
                  {staticQuads && (
                    <button disabled={paused || busy} onClick={guidedHold}>
                      {guided ? "Confirm this hold" : "Start guided hold"}
                    </button>
                  )}
                  <button
                    className={styles.outline}
                    disabled={busy}
                    onClick={() =>
                      void finish("interrupted", "discomfort_reported")
                    }
                  >
                    Stop for discomfort
                  </button>
                </>
              )}
              <p className={styles.footnote}>
                {context?.gemini.configured
                  ? "Automatic Gemini feedback is configured."
                  : "Gemini is off or unconfigured. Deterministic text remains available."}
              </p>
            </div>
          </section>
          <section className={`${styles.panel} ${styles.guide}`}>
            <h3>A comfortable setup</h3>
            <ol>
              <li>{trackingProfile.framingInstruction}</li>
              <li>Capture your resting position and comfortable target using the two buttons before starting. Keep each position steady while capturing.</li>
              <li>
                Move, hold and return. A movement and a target-complete
                repetition are shown separately.
              </li>
            </ol>
            <p className={styles.footnote}>
              Camera angles are estimates. Stop if uncomfortable. No clinician
              acknowledgement or medical correctness is implied.
            </p>
          </section>
        </div>
      </div>
      <details className={styles.trace}>
        <summary>Try a clearly labeled example trace</summary>
        <p>
          Test the same evaluator and text pipeline without a camera. Includes a
          short hold and a full hold. Saved evidence is simulated.
        </p>
        <button
          disabled={!context || running || busy || !!recovery || staticQuads}
          className={styles.outline}
          onClick={() => void replay()}
        >
          Run sample movements
        </button>
      </details>
      <section id="history" className={styles.history}>
        <div className={styles.historyHeading}>
          <h2>Saved exercise history</h2>
          <span className={styles.badge}>{reports.length} saved</span>
        </div>
        {reports.length ? (
          <div className={styles.historyGrid}>
            {[...reports].reverse().map((report) => (
              <article key={report.sessionId} className={styles.historyCard}>
                <span
                  className={`${styles.badge} ${report.evidence === "simulated" ? styles.badgeAmber : ""}`}
                >
                  {report.evidence.replaceAll("_", " ")}
                </span>
                <h3>{report.configuration.label}</h3>
                <p>
                  <strong>
                    {report.movementCycles} movements · {report.completedReps}{" "}
                    met targets
                  </strong>
                </p>
                <p>
                  {report.completionStatus} · Active{" "}
                  {clock(report.timing.activeTimeMs)} · Elapsed{" "}
                  {clock(report.timing.elapsedTimeMs)}
                </p>
                <p>
                  {report.shortHolds} short holds · {report.side} leg · demo
                  references
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.emptyHistory}>
            Your measured or clearly labeled demonstration results will appear
            here after you save a set.
          </p>
        )}
      </section>
      <details className={styles.technical}>
        <summary>Inspect final text and report JSON</summary>
        <pre>{JSON.stringify({ feedback, report: lastReport }, null, 2)}</pre>
      </details>
    </div>
  );
}
