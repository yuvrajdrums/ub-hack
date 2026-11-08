"use client";
import { AccountMenu } from "../../../../packages/account-ui/AccountMenu";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  PATIENT_ROUTES,
  exerciseReturnPath,
} from "../../../../packages/ui/patient-navigation";
import { useCompanion } from "./use-companion";
import { approvedMedicationTasks } from "./today-actions";
import styles from "./panda.module.css";
import { VoiceCircle } from "./voice-circle";
import RehabWorkspace from "../../../../packages/rehab-bridge/GuidedWorkspace";
import { useLoggedFailure } from "../../../../packages/ui/client-feedback";
function MicIcon() {
  return (
    <svg
      width="18"
      height="22"
      viewBox="0 0 24 26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M6 10v3a6 6 0 0 0 12 0v-3M12 19v5M8 24h8" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z" />
    </svg>
  );
}
function WaveIcon() {
  return (
    <svg viewBox="0 0 30 30" fill="currentColor" aria-hidden="true">
      <path d="M2 15c6 0 4-8 7-8s1 16 5 16 1-21 5-21 1 13 9 13c-8 0-5 5-8 5s-2-4-5-4-2 4-5 4-2-5-8-5Z" />
    </svg>
  );
}
function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="m6 6 12 12M6 18 18 6" />
    </svg>
  );
}
function PillIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="m9 5-5 9a5 5 0 0 0 9 5l5-9a5 5 0 0 0-9-5Zm-3 6 9 5" />
    </svg>
  );
}
function MotionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="15" cy="4" r="2" />
      <path d="m6 9 5-2 4 5 5 1M11 7 9 14l-4 7m4-7 5 2 2 5" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="16" rx="3" />
      <path d="M8 2v6m8-6v6M4 11h16m-11 5h6" />
    </svg>
  );
}
function MemoryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 6h10M5 12h14M5 18h8" />
      <circle cx="19" cy="6" r="1" fill="currentColor" />
      <circle cx="17" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

type Panel = "medicines" | "memory" | "emergency" | null;
type Mode = "idle" | "voice" | "text";
export default function Panda() {
  const c = useCompanion();
  const exerciseOpen = usePathname() === PATIENT_ROUTES.exercise;
  const [panel, setPanel] = useState<Panel>(null),
    [mode, setMode] = useState<Mode>("idle");
  const [directDraft, setDirectDraft] = useState(false);
  const entryRequested = useRef(false);
  const [remembered, setRemembered] = useState<Awaited<
    ReturnType<typeof c.rememberedContext>
  > | null>(null);
  const [memoryError, setMemoryError] = useState("");
  useLoggedFailure("Panda memory", memoryError);
  const dialog = useRef<HTMLDialogElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const medicines = approvedMedicationTasks(c.context),
    plan = c.context?.plan,
    firstName = c.context?.patient?.firstName;
  const active = !["ready", "confirmation"].includes(c.phase);
  useEffect(() => {
    if (panel && !dialog.current?.open) dialog.current?.showModal();
    if (!panel && dialog.current?.open) dialog.current?.close();
  }, [panel]);
  useEffect(() => {
    if (mode === "text") composer.current?.focus();
  }, [mode, exerciseOpen]);
  useEffect(() => {
    if (!c.text) setDirectDraft(false);
  }, [c.text]);
  useEffect(() => {
    if (c.reply?.navigation === "/rehab") {
      // The conversation already entered exercise on the server. Do not enter twice.
      entryRequested.current = true;
      showExercise();
    }
    if (
      c.reply?.checkin &&
      ["exercise_review", "pain_check"].includes(c.reply.checkin.stage)
    )
      setMode((current) => (current === "idle" ? "voice" : current));
  }, [c.reply]);
  useEffect(() => {
    if (!exerciseOpen) {
      c.updateExerciseContext(undefined);
      if (entryRequested.current) c.stop();
      entryRequested.current = false;
      return;
    }
    setPanel(null);
    if (!c.initialized || entryRequested.current) return;
    entryRequested.current = true;
    void c.openExercise();
    // Initial hydration must finish before a direct URL restores the check-in.
    // The hook owns its request lifecycle; opening happens once per route entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseOpen, c.initialized]);
  function showExercise() {
    if (window.location.pathname !== PATIENT_ROUTES.exercise)
      window.history.pushState(null, "", PATIENT_ROUTES.exercise);
  }
  function talk() {
    setMode("voice");
    if (exerciseOpen && c.checkin && c.checkin.stage !== "complete")
      c.listen(true);
    else void c.activateVoice();
  }
  function openExercise() {
    showExercise();
  }
  function closeExercise() {
    c.stop();
    setMode("idle");
    if (exerciseReturnPath(window.location.search) === PATIENT_ROUTES.care)
      window.location.replace(PATIENT_ROUTES.care);
    else window.history.replaceState(null, "", PATIENT_ROUTES.today);
  }
  function keyboard() {
    c.stop();
    if (mode === "text") {
      setMode("voice");
      void c.activateVoice();
      return;
    }
    setMode("text");
    if (c.checkin?.stage !== "complete") void c.beginCheckin(false);
  }
  async function memoryPanel() {
    setPanel("memory");
    setMemoryError("");
    try {
      setRemembered(await c.rememberedContext());
    } catch (e) {
      setMemoryError((e as Error).message);
    }
  }
  const voiceHeading =
    c.phase === "permission"
      ? "Let's get connected."
      : c.phase === "listening"
        ? "I’m listening"
        : c.phase === "thinking"
          ? "Let me think about that."
          : c.phase === "speaking"
            ? "Just you and Panda."
            : c.phase === "speech_loading"
              ? "One moment, together."
              : "I'm here with you.";
  function confirmations() {
    return c.reply?.proposalId ? (
      <div className={styles.inlineConfirm}>
        <button
          type="button"
          disabled={c.busy}
          onClick={() => void c.confirm()}
        >
          {c.reply.mode === "fixture" ? "Confirm dry run" : "Confirm action"}
        </button>
        <button type="button" disabled={c.busy} onClick={() => void c.cancel()}>
          Dismiss
        </button>
      </div>
    ) : null;
  }
  function replyText() {
    return (
      <div className={styles.inlineReply} role="status" aria-live="polite">
        {c.busy && (
          <span className={styles.thinking}>
            {c.phase === "saving" ? "Saving your choice…" : "Thinking…"}
          </span>
        )}
        {c.reply ? (
          <>
            <p>{c.reply.speechText || c.reply.message}</p>
            {c.reply.speechText && c.reply.speechText !== c.reply.message && (
              <details>
                <summary>Review exact action</summary>
                <p>{c.reply.message}</p>
              </details>
            )}
          </>
        ) : (
          <p>What’s on your mind?</p>
        )}
        {c.reply?.sourceRefs?.length ? (
          <small>From your approved plan</small>
        ) : null}
      </div>
    );
  }
  function interaction() {
    if (mode === "text")
      return (
        <div className={styles.inlineText} aria-label="Text conversation">
          <span className={styles.eyebrow}>A moment with Panda</span>
          <h1>
            What’s on
            <br />
            your mind?
          </h1>
          {replyText()}
          {confirmations()}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void c.send(c.text, directDraft);
            }}
          >
            <label className={styles.srOnly} htmlFor="message">
              Your message
            </label>
            <textarea
              ref={composer}
              id="message"
              rows={2}
              value={c.text}
              maxLength={2000}
              placeholder="Tell Panda how you’re feeling…"
              onChange={(event) => c.setText(event.target.value)}
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={c.busy || !c.text.trim()}
            >
              <ArrowIcon />
            </button>
          </form>
        </div>
      );
    if (mode === "voice")
      return (
        <div className={styles.inlineVoice} aria-label="Voice conversation">
          <span className={styles.eyebrow}>A moment with Panda</span>
          <h1>
            {voiceHeading}
            {c.phase === "listening" && firstName ? <>, {firstName}.</> : null}
          </h1>
          <VoiceCircle phase={c.phase} readLevels={c.audioLevels} />
          {replyText()}
          {confirmations()}
          <small className={styles.inlineCaption}>
            {["speaking", "speech_loading"].includes(c.phase)
              ? "Tap the mic whenever you want to jump in."
              : c.phase === "listening"
                ? "Take your time. I’m right here."
                : "One step at a time."}
          </small>
        </div>
      );
    return (
      <div className={styles.idleScene}>
        <p>Ready for a good day{firstName ? ", " + firstName : ""}?</p>
        <h1>
          Where would you
          <br />
          like to begin?
        </h1>
        <button
          type="button"
          className={styles.panda}
          onClick={talk}
          aria-label="Talk to Panda"
        >
          <VoiceCircle phase="idle" readLevels={c.audioLevels} />
        </button>
        <small>Take a breath. Let’s talk.</small>

        {c.reply?.proposalId && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setMode("text")}
          >
            Review pending action →
          </button>
        )}
      </div>
    );
  }
  return (
    <div className={styles.app}>
      <div className={styles.surface} inert={exerciseOpen}>
        <section className={styles.today} aria-labelledby="today-title">
          <div className={styles.sectionHeading}>
            <h2 id="today-title">Your day, gently.</h2>
            <button
              type="button"
              disabled={c.refreshing || c.busy}
              onClick={() => void c.refresh()}
              aria-label="Refresh care status"
            >
              ↻ <span>Plan {plan?.version ?? "—"}</span>
            </button>
          </div>
          <ol className={styles.actions}>
            <li>
              <span className={styles.actionIcon}>
                <PillIcon />
              </span>
              <div>
                <strong>Take medicines</strong>
                <small title={medicines[0]?.title}>
                  {medicines[0]?.title ?? "Medicine details pending"}
                </small>
              </div>
              <button
                type="button"
                onClick={() => setPanel("medicines")}
                aria-label="View medicines"
              >
                ↗
              </button>
            </li>
            <li>
              <button
                type="button"
                className={styles.exerciseAction}
                disabled={!plan}
                onClick={openExercise}
                aria-label="Open guided exercise"
              >
                <span className={styles.actionIcon}>
                  <MotionIcon />
                </span>
                <span className={styles.exerciseActionCopy}>
                  <strong>Move a little</strong>
                  <small>Guided exercise</small>
                </span>
                <span aria-hidden="true" className={styles.exerciseArrow}>
                  ↗
                </span>
              </button>
            </li>
            <li>
              <span className={styles.actionIcon}>
                <CalendarIcon />
              </span>
              <div>
                <strong>Follow-up check-in</strong>
                <small>Doctor availability pending</small>
              </div>
              <span className={styles.pending}>Soon</span>
            </li>
          </ol>
        </section>
        <section className={styles.center} aria-label="Panda interaction">
          {!exerciseOpen && interaction()}
        </section>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.modeControl}
            aria-label={
              mode === "text" ? "Use microphone mode" : "Use keyboard"
            }
            onClick={keyboard}
          >
            <span>{mode === "text" ? <MicIcon /> : <PenIcon />}</span>
            {mode === "text" ? "Speak" : "Type"}
          </button>
          {mode === "voice" ? (
            <button
              type="button"
              className={styles.mainControl}
              aria-label={
                ["speaking", "speech_loading"].includes(c.phase)
                  ? "Interrupt Panda"
                  : active
                    ? "Mute conversation"
                    : "Resume conversation"
              }
              onClick={() =>
                ["speaking", "speech_loading"].includes(c.phase)
                  ? c.interrupt()
                  : active
                    ? c.stop()
                    : c.listen()
              }
            >
              <span>
                <MicIcon />
              </span>
              {["speaking", "speech_loading"].includes(c.phase)
                ? "Jump in"
                : active
                  ? "Pause"
                  : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              className={styles.mainControl}
              aria-label="Start voice conversation"
              onClick={talk}
            >
              <span>
                <WaveIcon />
              </span>
              Talk
            </button>
          )}
          <button
            type="button"
            className={styles.modeControl}
            aria-label={
              mode === "voice"
                ? "End voice conversation"
                : "Open patient context"
            }
            onClick={() =>
              mode === "voice"
                ? (c.stop(), setMode("idle"))
                : void memoryPanel()
            }
          >
            <span>{mode === "voice" ? <CloseIcon /> : <MemoryIcon />}</span>
            {mode === "voice" ? "End call" : "Context"}
          </button>
        </div>
        <div className={styles.mode}>
          <span />
          {c.context?.runtime === "production"
            ? "Your private care companion"
            : c.context
              ? "Synthetic demo"
              : "Connecting to your care…"}
          <AccountMenu onLeave={c.stop} />
        </div>
      </div>
      <nav
        className={styles.dock}
        aria-label="Companion navigation"
        inert={exerciseOpen}
      >
        <button
          type="button"
          aria-current="page"
          onClick={() => {
            c.stop();
            window.history.replaceState(null, "", PATIENT_ROUTES.today);
            setMode("idle");
          }}
        >
          <WaveIcon />
          <span>Today</span>
        </button>
        <a href={PATIENT_ROUTES.care} onClick={c.stop}>
          <CalendarIcon />
          <span>My plan</span>
        </a>
        <button type="button" onClick={() => void memoryPanel()}>
          <MemoryIcon />
          <span>My context</span>
        </button>
      </nav>
      {exerciseOpen && (
        <section
          className={styles.exerciseShell}
          aria-label="Exercise with Panda"
        >
          <RehabWorkspace
            presentation="camera"
            canStart={c.checkin?.stage === "exercise" && !c.reply?.pauseExercise && !c.reply?.proposalId}
            onEvent={c.exerciseFeedback}
            onRuntime={c.updateExerciseContext}
            control={c.reply?.exerciseControl}
            onCoachingPause={c.cancelExerciseCoaching}
            onAskPanda={talk}
            pauseRequested={Boolean(c.reply?.pauseExercise)}
            pandaCue={c.pandaExerciseCue}
            onExit={closeExercise}
            pandaMessage={
              c.checkin?.stage !== "exercise" ||
              ["speaking", "speech_loading"].includes(c.phase)
                ? c.reply?.speechText || c.reply?.message
                : undefined
            }
            companion={
              <div
                className={styles.cameraPanda}
                aria-label="Voice conversation"
              >
                <VoiceCircle
                  phase={mode === "voice" ? c.phase : "idle"}
                  readLevels={c.audioLevels}
                />
                <span>
                  Panda{" "}
                  <small>
                    {mode !== "voice"
                      ? "Tap to hear coaching"
                      : c.phase === "listening"
                        ? "Listening"
                        : c.phase === "speaking"
                          ? "Speaking"
                          : c.phase === "thinking" ||
                              c.phase === "speech_loading"
                            ? "One moment"
                            : "With you"}
                  </small>
                </span>
                <div>
                  {mode !== "text" && (
                    <button
                      type="button"
                      aria-label={
                        ["speaking", "speech_loading"].includes(c.phase)
                          ? "Interrupt Panda"
                          : mode !== "voice"
                            ? "Talk to Panda"
                            : active
                              ? "Mute conversation"
                              : "Resume conversation"
                      }
                      onClick={() =>
                        mode !== "voice"
                          ? talk()
                          : ["speaking", "speech_loading"].includes(c.phase)
                            ? c.interrupt()
                            : active
                              ? c.stop()
                              : c.listen(true)
                      }
                    >
                      <MicIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={
                      mode === "text" ? "Use microphone mode" : "Use keyboard"
                    }
                    onClick={keyboard}
                  >
                    {mode === "text" ? <MicIcon /> : <PenIcon />}
                  </button>
                </div>
              </div>
            }
            conversation={
              <>
                <span className={styles.srOnly}>
                  Panda · {c.checkin?.stage?.replaceAll("_", " ")}
                </span>

                {confirmations()}
                {mode === "text" && (
                  <form
                    className={styles.exerciseComposer}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void c.send(c.text, directDraft);
                    }}
                  >
                    <label className={styles.srOnly} htmlFor="message">
                      Your message
                    </label>
                    <textarea
                      ref={composer}
                      id="message"
                      rows={2}
                      value={c.text}
                      maxLength={2000}
                      placeholder="Tell Panda how you’re feeling…"
                      onChange={(event) => c.setText(event.target.value)}
                    />
                    <button
                      type="submit"
                      aria-label="Send message"
                      disabled={c.busy || !c.text.trim()}
                    >
                      <ArrowIcon />
                    </button>
                  </form>
                )}
              </>
            }
          />
        </section>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          setPanel(null);
        }}
      >
        <button
          type="button"
          className={styles.dialogClose}
          aria-label="Close dialog"
          onClick={() => setPanel(null)}
        >
          ×
        </button>
        {panel === "emergency" ? (
          <>
            <span className="eyebrow">Emergency information</span>
            <h2 id="dialog-title">Panda cannot call for help.</h2>
            <p>
              This demonstration is not monitored and cannot contact emergency
              services. For urgent help, contact your local emergency services
              directly.
            </p>
            <p>Care requests are recorded for separate acknowledgement.</p>
          </>
        ) : panel === "memory" ? (
          <>
            <span className="eyebrow">Patient-scoped memory</span>
            <h2 id="dialog-title">What Panda remembers</h2>
            <p>
              Check-in answers remain until explicitly deleted. Plans and
              exercise reports remain in their own apps.
            </p>

            {!remembered ? (
              <p>Loading…</p>
            ) : (
              <>
                <small>
                  {remembered.totalEvents} remembered entries · current patient
                  only
                </small>
                {remembered.events.map((entry) => (
                  <div className={styles.memoryEntry} key={entry.id}>
                    <small>
                      {entry.kind.replaceAll("_", " ")} · {entry.at}
                    </small>
                    <p>{entry.quote}</p>
                    <small>{entry.source.replaceAll("_", " ")}</small>
                  </div>
                ))}
                {!remembered.events.length && <p>No check-in answers yet.</p>}
                {remembered.transcript?.length ? (
                  <details>
                    <summary>Conversation transcript</summary>
                    {remembered.transcript.map((turn) => (
                      <div className={styles.memoryEntry} key={turn.id}>
                        <strong>
                          {turn.role === "user" ? "You" : "Panda"}
                        </strong>
                        <p>{turn.text}</p>
                      </div>
                    ))}
                  </details>
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <span className="eyebrow">
              Approved plan · v{plan?.version ?? "—"}
            </span>
            <h2 id="dialog-title">Your medicines</h2>
            {medicines.length ? (
              medicines.map((task) => (
                <div className={styles.medicine} key={task.id}>
                  <p>{task.title}</p>
                  <small>
                    {task.status === "completed"
                      ? "Completed · patient-reported"
                      : "Exact text from your approved plan"}
                  </small>
                  {task.status === "pending" && (
                    <button
                      type="button"
                      disabled={c.busy}
                      onClick={() => {
                        setPanel(null);
                        setMode("text");
                        void c.send("Confirm task " + task.id, true);
                      }}
                    >
                      Report done
                    </button>
                  )}
                </div>
              ))
            ) : (
              <p>
                Medicine details are not available in your approved plan yet.
              </p>
            )}
            <a
              className="button secondary"
              href={PATIENT_ROUTES.care}
              onClick={c.stop}
            >
              Open full plan
            </a>
            {c.context?.runtime !== "production" && (
              <small className={styles.finePrint}>
                Synthetic examples only.
              </small>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
