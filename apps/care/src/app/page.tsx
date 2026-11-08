"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AccountMenu } from "../../../../packages/account-ui/AccountMenu";
import type { CvReport } from "../../../../packages/contracts/rehab-cv";
import type { CareSnapshot, ExerciseReport } from "@contracts";
import { patientPlan, type PatientPlanItem } from "./patient-plan";
import styles from "./care.module.css";
import { PATIENT_ROUTES } from "../../../../packages/ui/patient-navigation";
import { useLoggedFailure } from "../../../../packages/ui/client-feedback";

type IconName =
  | "pill"
  | "exercise"
  | "calendar"
  | "message"
  | "report"
  | "arrow"
  | "refresh"
  | "wave"
  | "check"
  | "plus";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    pill: (
      <>
        <path d="m9 5-4 4a5.7 5.7 0 0 0 8 8l4-4a5.7 5.7 0 0 0-8-8Z" />
        <path d="m7 7 8 8" />
      </>
    ),
    exercise: (
      <>
        <circle cx="14" cy="4" r="2" />
        <path d="m11 9 4 3 4 1M5 12l6-3-2 7m0 0-4 6m4-6 6 5" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-13 4h3m3 0h2" />
      </>
    ),
    message: (
      <path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
    ),
    report: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6M8 13h8m-8 4h5" />
      </>
    ),
    arrow: <path d="M5 19 19 5M5 5h14v14" />,
    refresh: (
      <>
        <path d="M20 9a8 8 0 1 0 .3 5M20 3v6h-6" />
      </>
    ),
    wave: <path d="M3 12c4 0 2-6 5-6s1 12 4 12 1-16 4-16 1 10 5 10" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch("/care/api/" + path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await response.json();
  if (!response.ok || !out.ok)
    throw Error(
      out.error?.message || "Your care information could not be loaded.",
    );
  return out.data;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function evidenceLabel(evidence: string) {
  return (
    (
      {
        camera_estimated: "Camera estimate",
        simulated: "Simulated session",
        patient_reported: "Self-reported",
        unavailable: "Tracking unavailable",
      } as Record<string, string>
    )[evidence] || "Recorded session"
  );
}

function PlanWording({ item }: { item: PatientPlanItem }) {
  const [title, ...details] = item.text.split("·");
  return (
    <>
      <h3>{title.trim()}</h3>
      {details.length > 0 && <p>{details.join(" · ").trim()}</p>}
    </>
  );
}

export default function Care() {
  const [data, setData] = useState<CareSnapshot | null>(null);
  const [reports, setReports] = useState<ExerciseReport[]>([]);
  const [guidedReports, setGuidedReports] = useState<CvReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reportErrors, setReportErrors] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [quote, setQuote] = useState("");
  const [sending, setSending] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [notice, setNotice] = useState("");
  useLoggedFailure("Care plan", error);
  useLoggedFailure("Care reports", reportErrors.join("; "));
  useLoggedFailure("Care request", requestError);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const pendingRequest = useRef<{ requestId: string; quote: string } | null>(
    null,
  );
  const requestField = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setRefreshing(true);
    const promise = (async () => {
      const [state, standard, guided] = await Promise.allSettled([
        api<CareSnapshot>("state"),
        api<ExerciseReport[]>("reports"),
        api<CvReport[]>("guided-reports"),
      ]);
      if (state.status === "fulfilled") {
        setData(state.value);
        setError("");
        setLastUpdated(new Date());
      } else
        setError(
          state.reason instanceof Error
            ? state.reason.message
            : "Your plan could not be refreshed.",
        );
      const errors: string[] = [];
      if (standard.status === "fulfilled") setReports(standard.value);
      else errors.push("Some exercise reports could not be refreshed.");
      if (guided.status === "fulfilled") setGuidedReports(guided.value);
      else errors.push("Guided exercise reports could not be refreshed.");
      setReportErrors(errors);
    })().finally(() => {
      setLoading(false);
      setRefreshing(false);
      refreshInFlight.current = null;
    });
    refreshInFlight.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    void load();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refreshVisible, 15000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load]);

  useEffect(() => {
    if (composerOpen) requestField.current?.focus();
  }, [composerOpen]);

  function newRequest(prefill = "") {
    if (prefill) setQuote(prefill);
    setComposerOpen(true);
    setRequestError("");
    setNotice("");
    requestField.current?.focus();
    document
      .getElementById("my-requests")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    const text = quote.trim();
    if (!text || sending) return;
    if (pendingRequest.current?.quote !== text)
      pendingRequest.current = { requestId: crypto.randomUUID(), quote: text };
    setSending(true);
    setRequestError("");
    try {
      const saved = await api<CareSnapshot["help"][number]>(
        "help",
        pendingRequest.current!,
      );
      setData((current) =>
        current
          ? {
              ...current,
              help: [
                ...current.help.filter((item) => item.id !== saved.id),
                saved,
              ],
            }
          : current,
      );
      setQuote("");
      setComposerOpen(false);
      pendingRequest.current = null;
      setNotice("Request saved. You can follow its status below.");
      // A read started before this write must finish before reading the new state.
      if (refreshInFlight.current) await refreshInFlight.current;
      await load();
    } catch (e) {
      setRequestError(
        e instanceof Error
          ? e.message
          : "Your request could not be saved. Please try again.",
      );
    } finally {
      setSending(false);
    }
  }

  const plan =
    data?.plan?.status === "approved" && data.plan.patientId === data.patientId
      ? data.plan
      : null;
  const groups = patientPlan(data);
  const requestList = [...(data?.help ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const exerciseReports = [
    ...guidedReports
      .filter(
        (report) => !data || report.careReference?.patientId === data.patientId,
      )
      .map((report) => ({
        id: report.sessionId,
        date: report.observedEndedAtUtc,
        title: report.configuration.label,
        evidence: report.evidence,
        detail: `${report.completedReps} of ${report.targetReps} target reps · ${Math.round(report.timing.activeTimeMs / 1000)} seconds active`,
        status: report.completionStatus,
        quality: report.trackingQuality,
        details: `${report.movementCycles} movements · ${report.shortHolds} short holds · ${report.side} side`,
        stopped: report.terminationReason === "discomfort_reported",
        demo: report.configurationMode === "synthetic_demo",
      })),
    ...reports
      .filter((report) => !data || report.patientId === data.patientId)
      .map((report) => ({
        id: report.sessionId,
        date: report.endedAt,
        title: "Elbow movement",
        evidence: report.evidence,
        detail: `${report.repetitions} reps · Plan ${report.planVersion}`,
        status:
          report.terminationReason === "completed" ? "completed" : "incomplete",
        quality: report.trackingQuality,
        details:
          report.rangeDegrees === null
            ? "Range unavailable"
            : `Estimated range ${Math.round(report.rangeDegrees)}°`,
        stopped: report.terminationReason === "discomfort_reported",
        demo: report.evidence === "simulated",
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className={styles.app}>
      <main className={styles.surface}>
        <header className={styles.topbar}>
          <a href={PATIENT_ROUTES.today} className={styles.backLink}>
            <span aria-hidden="true">←</span> Today
          </a>
          <span className={styles.pageLabel}>Care hub</span>
          <AccountMenu />
        </header>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>A little clarity, every day</span>
          <h1>
            Your care,
            <br />
            all in one place.
          </h1>
          <p>Your plan, your progress, and a way to reach your care team.</p>
          <div className={styles.planBar}>
            <span className={styles.planBadge}>
              <span />
              {plan
                ? `Approved plan · v${plan.version}`
                : loading
                  ? "Loading your plan"
                  : "Waiting for your care plan"}
            </span>
            <button
              type="button"
              className={styles.refresh}
              onClick={() => void load()}
              disabled={refreshing}
              aria-label="Refresh care plan"
            >
              <Icon name="refresh" />
              <span>{refreshing ? "Refreshing" : "Refresh"}</span>
            </button>
          </div>
          <p className={styles.syncNote}>
            {lastUpdated ? "Your care plan" : "Connecting to your care"}
          </p>
        </div>

        {loading && (
          <div className={styles.loading} role="status">
            Gathering your care plan…
          </div>
        )}

        {data && (
          <>
            {plan?.demoOnly && (
              <p className={styles.demoNote}>
                Synthetic demo plan · example prescriptions only
              </p>
            )}
            <div className={styles.grid}>
              <section
                className={styles.card}
                aria-labelledby="medication-title"
              >
                <div className={styles.cardHeading}>
                  <span className={styles.icon}>
                    <Icon name="pill" />
                  </span>
                  <h2 id="medication-title">Medication prescribed</h2>
                  <span className={styles.count}>
                    {groups.medication.length.toString().padStart(2, "0")}
                  </span>
                </div>
                {groups.medication.length ? (
                  <ul className={styles.items}>
                    {groups.medication.map((item) => (
                      <li key={item.id}>
                        <PlanWording item={item} />
                        <span className={styles.itemNote}>
                          {item.task?.status === "completed" ? (
                            <>
                              <Icon name="check" /> Taken · self-reported
                            </>
                          ) : (
                            "As written in your approved plan"
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.empty}>
                    {plan
                      ? "No medication is listed in your approved plan."
                      : "Your prescribed medicines will appear here when your care team adds a plan."}
                  </p>
                )}
              </section>
              <section className={styles.card} aria-labelledby="exercise-title">
                <div className={styles.cardHeading}>
                  <span className={styles.icon}>
                    <Icon name="exercise" />
                  </span>
                  <h2 id="exercise-title">Exercise prescribed</h2>
                  <span className={styles.count}>
                    {groups.exercise.length.toString().padStart(2, "0")}
                  </span>
                </div>
                {groups.exercise.length ? (
                  <ul className={styles.items}>
                    {groups.exercise.map((item) => (
                      <li key={item.id}>
                        <PlanWording item={item} />
                        <span className={styles.itemNote}>
                          From your approved plan
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.empty}>
                    {plan
                      ? "No exercise is listed in your approved plan."
                      : "Your exercise instructions will appear here once approved."}
                  </p>
                )}
                {groups.exercise.length > 0 && (
                  <a
                    href={PATIENT_ROUTES.exerciseFromCare}
                    className={styles.cardLink}
                  >
                    Open guided exercise <Icon name="arrow" />
                  </a>
                )}
              </section>
              <section
                className={`${styles.card} ${styles.followUp}`}
                aria-labelledby="followup-title"
              >
                <div className={styles.cardHeading}>
                  <span className={styles.icon}>
                    <Icon name="calendar" />
                  </span>
                  <h2 id="followup-title">Next follow-up</h2>
                  <span className={styles.badge}>Scheduling pending</span>
                </div>
                <div className={styles.followUpBody}>
                  <div>
                    <h3>Let’s find a time to check in.</h3>
                    <p>
                      Doctor availability is still being connected. A request
                      won’t book an appointment yet.
                    </p>
                    {groups.followUp.map((item) => (
                      <p key={item.id} className={styles.planInstruction}>
                        {item.text}
                      </p>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() =>
                      newRequest(
                        "I'd like to arrange my next follow-up check-in.",
                      )
                    }
                  >
                    Request a follow-up <Icon name="arrow" />
                  </button>
                </div>
              </section>
              <section
                id="my-requests"
                className={styles.card}
                aria-labelledby="requests-title"
              >
                <div className={styles.cardHeading}>
                  <span className={styles.icon}>
                    <Icon name="message" />
                  </span>
                  <h2 id="requests-title">My requests</h2>
                  <span className={styles.count}>
                    {requestList.length.toString().padStart(2, "0")}
                  </span>
                </div>
                <p className={styles.sectionCopy}>
                  A note to your care team, with its status in one place.
                </p>
                {notice && (
                  <p className={styles.success} role="status">
                    {notice}
                  </p>
                )}
                {!composerOpen && (
                  <button
                    type="button"
                    className={styles.outlineButton}
                    onClick={() => newRequest()}
                  >
                    <Icon name="plus" /> New request
                  </button>
                )}
                {composerOpen && (
                  <form className={styles.composer} onSubmit={submitRequest}>
                    <label htmlFor="care-request">
                      What would you like your care team to know?
                    </label>
                    <textarea
                      ref={requestField}
                      id="care-request"
                      placeholder="Write a question, ask for a follow-up, or share a concern…"
                      rows={4}
                      maxLength={2000}
                      value={quote}
                      onChange={(event) => setQuote(event.target.value)}
                      disabled={sending}
                      required
                    />
                    <div className={styles.composerActions}>
                      <small>{quote.length}/2000</small>
                      <button
                        type="button"
                        className={styles.textButton}
                        disabled={sending}
                        onClick={() => {
                          setComposerOpen(false);
                          setRequestError("");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className={styles.primaryButton}
                        disabled={sending || !quote.trim()}
                      >
                        {sending ? "Saving…" : "Send request"}
                        <Icon name="arrow" />
                      </button>
                    </div>

                  </form>
                )}
                {!requestList.length ? (
                  <div className={styles.emptyState}>
                    <span className={styles.emptyIcon}>
                      <Icon name="message" />
                    </span>
                    <h3>A little support is a message away.</h3>
                    <p>
                      Your requests and care team acknowledgements will appear
                      here.
                    </p>
                  </div>
                ) : (
                  <ul className={styles.requests}>
                    {requestList.map((request) => (
                      <li key={request.id}>
                        <div className={styles.rowMeta}>
                          <time dateTime={request.createdAt}>
                            {dateLabel(request.createdAt)}
                          </time>
                          <span
                            className={`${styles.badge} ${request.status === "acknowledged" ? styles.reviewed : ""}`}
                          >
                            {request.status === "acknowledged"
                              ? "Acknowledged"
                              : "Awaiting review"}
                          </span>
                        </div>
                        <p>{request.quote}</p>
                        <small>
                          {request.status === "acknowledged"
                            ? "Your care team has acknowledged this request."
                            : "Saved for your care team. Not yet acknowledged."}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={styles.finePrint}>
                  {plan?.demoOnly
                    ? "Demo requests are saved locally; no healthcare provider is notified. "
                    : ""}
                  For urgent help, contact emergency services directly.
                </p>
              </section>
              <section className={styles.card} aria-labelledby="reports-title">
                <div className={styles.cardHeading}>
                  <span className={styles.icon}>
                    <Icon name="report" />
                  </span>
                  <h2 id="reports-title">Exercise reports</h2>
                  <span className={styles.count}>
                    {exerciseReports.length.toString().padStart(2, "0")}
                  </span>
                </div>
                <p className={styles.sectionCopy}>
                  The movements you’ve made, and the progress you’ve recorded.
                </p>

                {!exerciseReports.length && !reportErrors.length && (
                  <div className={styles.emptyState}>
                    <span className={styles.emptyIcon}>
                      <Icon name="report" />
                    </span>
                    <h3>Every session is a step forward.</h3>
                    <p>
                      Finish and save a guided exercise session to see your
                      report here.
                    </p>
                    {groups.exercise.length > 0 && (
                      <a
                        href={PATIENT_ROUTES.exerciseFromCare}
                        className={styles.cardLink}
                      >
                        Start an exercise <Icon name="arrow" />
                      </a>
                    )}
                  </div>
                )}
                <ul className={styles.reports}>
                  {exerciseReports.map((report) => {
                    const ack = data.acknowledgements.find(
                      (item) => item.sessionId === report.id,
                    );
                    return (
                      <li key={report.id}>
                        <div className={styles.rowMeta}>
                          <time dateTime={report.date}>
                            {dateLabel(report.date)}
                          </time>
                          <span className={styles.badge}>
                            {report.status === "completed"
                              ? "Completed"
                              : "Partial session"}
                          </span>
                        </div>
                        <h3>{report.title}</h3>
                        <p>{report.detail}</p>
                        <details>
                          <summary>View session details</summary>
                          <div className={styles.reportDetail}>
                            <p>
                              {evidenceLabel(report.evidence)}
                              {report.demo ? " · Demo exercise" : ""}
                            </p>
                            <p>{report.details}</p>
                            <p>
                              Tracking: {report.quality.replaceAll("_", " ")}
                            </p>
                            {report.stopped && (
                              <p>Stopped after discomfort was reported.</p>
                            )}
                            <small>
                              Measurements are estimates, not a clinical
                              assessment.
                            </small>
                          </div>
                        </details>
                        <span className={styles.itemNote}>
                          {ack ? (
                            <>
                              <Icon name="check" /> Acknowledged by your care
                              team
                            </>
                          ) : (
                            "Awaiting care team acknowledgement"
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
            {plan && (
              <details className={styles.planDetails}>
                <summary>
                  View all approved plan instructions{" "}
                  <span>v{plan.version}</span>
                </summary>
                <div>
                  {plan.instructions.map((item) => (
                    <div key={item.id}>
                      <p>{item.text}</p>
                      <small>Source: {item.sourceRef}</small>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        <p className={styles.closingNote}>
          One plan. A little more peace of mind.
        </p>
      </main>
      <nav className={styles.dock} aria-label="Companion navigation">
        <a href={PATIENT_ROUTES.today}>
          <Icon name="wave" />
          <span>Today</span>
        </a>
        <a href={PATIENT_ROUTES.care} aria-current="page">
          <Icon name="calendar" />
          <span>My plan</span>
        </a>
        <a href={PATIENT_ROUTES.exerciseFromCare}>
          <Icon name="exercise" />
          <span>Exercise</span>
        </a>
      </nav>
    </div>
  );
}
