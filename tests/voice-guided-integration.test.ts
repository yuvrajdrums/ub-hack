import { requestsExercise } from "../packages/contracts/exercise-navigation";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { careService } from "../apps/care/src/server/service";
import { cvService } from "../apps/rehab/src/server/cv/service";
import { voiceService } from "../apps/panda/src/server/service";
import { checkinService } from "../apps/panda/src/server/checkin";
import { PatientMemoryRepository } from "../apps/panda/src/server/patient-memory";
import {
  CvSessionSchema,
  CvFeedbackSchema,
} from "../packages/contracts/rehab-cv";
import type { VoiceReply } from "../packages/contracts/voice";
async function setup(t: test.TestContext, advance = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "panda-guided-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const care = careService(path.join(dir, "care.json")),
    memory = new PatientMemoryRepository(path.join(dir, "memory.sqlite"));
  const cv = cvService(path.join(dir, "cv.json"), {
    care: () => care.snapshot(),
  });
  const owner = (await care.snapshot()).patientId;
  const voice = voiceService(
    path.join(dir, "voice.sqlite"),
    {
      mode: "connected",
      snapshot: () => care.snapshot(),
      write: (route, body) =>
        route === "help"
          ? care.help(body)
          : care.confirm(route.split("/")[1], body),
    },
    undefined,
    undefined,
    Date.now,
    memory,
  );
  const chat = checkinService(memory, voice, {
    mode: "connected",
    snapshot: () => care.snapshot(),
    exerciseSession: async () => {
      throw Error("legacy not used");
    },
    guidedSession: (id) => cv.get(owner, id),
    guidedFeedback: (id, event) => cv.feedback(owner, id, event),
  });
  let r: VoiceReply = await chat.start({ requestId: randomUUID() });
  async function answer(text: string) {
    r = await chat.answer({
      requestId: randomUUID(),
      checkinId: r.checkin!.id,
      expectedStage: r.checkin!.stage,
      text,
    });
    return r;
  }
  if (advance)
    for (const text of [
      "My elbow feels okay",
      "No not yet",
      "Soup",
      "Tomorrow",
      "Yes",
    ])
      await answer(text);
  if (advance) assert.equal(r.checkin?.stage, "exercise");
  return {
    owner,
    cv,
    chat,
    memory,
    voice,
    care,
    answer,
    reply: () => r,
    feedback: (event: unknown) =>
      chat.exerciseFeedback({
        requestId: randomUUID(),
        checkinId: r.checkin!.id,
        event,
      }),
  };
}
test("guided owner reports feed Panda memory and post-exercise review without a duplicate report store", async (t) => {
  const x = await setup(t);
  const session = await x.cv.start(x.owner, {
    requestId: randomUUID(),
    exerciseId: "static-quads",
    side: "left",
    startedAtUtc: new Date().toISOString(),
    evidence: "patient_reported",
  });
  CvSessionSchema.parse(session);
  assert.ok(session.careReference);
  await x.feedback({
    version: "1.0.0",
    type: "guided_session_started",
    sessionId: session.id,
  });
  await x.cv.events(x.owner, session.id, {
    requestId: randomUUID(),
    event: {
      eventId: randomUUID(),
      sequence: 1,
      observedOffsetMs: 6000,
      type: "attempt_finalized",
      attemptId: randomUUID(),
      movementComplete: true,
      qualifying: true,
      holdMs: 5000,
      targetReached: true,
      rangeDegrees: null,
    },
  });
  const timing = {
    elapsedTimeMs: 6000,
    activeTimeMs: 0,
    pausedTimeMs: 6000,
    userPausedTimeMs: 0,
    trackingPausedTimeMs: 6000,
    otherPausedTimeMs: 0,
    guidedTimerMs: 5000,
  };
  await x.cv.finish(x.owner, session.id, {
    requestId: randomUUID(),
    lastMeasurementSequence: 1,
    report: {
      observedEndedAtUtc: new Date().toISOString(),
      completionStatus: "incomplete",
      terminationReason: "finished",
      timing,
    },
  });
  const review = await x.feedback({
    version: "1.0.0",
    type: "guided_report_saved",
    sessionId: session.id,
  });
  assert.equal(review.checkin?.stage, "exercise_review");
  const memory = await x.chat.memory();
  const report = memory.events.find((e) => e.kind === "exercise_report");
  assert.equal(report?.metadata.evidence, "patient_reported");
  assert.match(report!.quote, /Guided static quads/);
  assert.equal((await x.cv.reports(x.owner)).length, 1);
  await x.care.acknowledgeReport(
    { patientId: x.owner, sessionId: session.id },
    { requestId: randomUUID() },
  );
  assert.equal((await x.care.snapshot()).acknowledgements.length, 1);
});
test("guided feedback is fetched from Rehab, deduplicated and cannot cross patient ownership", async (t) => {
  const x = await setup(t);
  const session = await x.cv.start(x.owner, {
    requestId: randomUUID(),
    exerciseId: "seated-knee-extension",
    side: "left",
    startedAtUtc: new Date().toISOString(),
    evidence: "simulated",
  });
  await x.feedback({
    version: "1.0.0",
    type: "guided_session_started",
    sessionId: session.id,
  });
  const event = await x.cv.events(x.owner, session.id, {
    requestId: randomUUID(),
    event: {
      eventId: randomUUID(),
      sequence: 1,
      observedOffsetMs: 6000,
      type: "attempt_finalized",
      attemptId: randomUUID(),
      movementComplete: true,
      qualifying: true,
      holdMs: 5000,
      targetReached: true,
      rangeDegrees: 70,
    },
  });
  const cue = event.feedback[0];
  CvFeedbackSchema.parse(cue);
  const first = await x.feedback({
    version: "1.0.0",
    type: "guided_feedback",
    sessionId: session.id,
    feedbackId: cue.eventId,
  });
  assert.equal(first.exerciseCue?.eventId, cue.eventId);
  const duplicate = await x.feedback({
    version: "1.0.0",
    type: "guided_feedback",
    sessionId: session.id,
    feedbackId: cue.eventId,
  });
  assert.equal(duplicate.exerciseCue, undefined);
  const foreign = await x.cv
    .start("another-patient", {
      requestId: randomUUID(),
      exerciseId: "static-quads",
      side: "left",
      startedAtUtc: new Date().toISOString(),
      evidence: "patient_reported",
    })
    .catch((error) => error);
  assert.ok(foreign instanceof Error);
});

test("Panda waits for finalized Gemini wording and keeps the source in patient context", async (t) => {
  const names = [
    "REHAB_GEMINI_MODE",
    "PANDA_GEMINI_API_KEY",
    "REHAB_GEMINI_API_KEY",
    "REHAB_GEMINI_MODEL",
  ];
  const previous = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    REHAB_GEMINI_MODE: "controlled",
    PANDA_GEMINI_API_KEY: "test-private",
    REHAB_GEMINI_API_KEY: "test-rehab-private",
    REHAB_GEMINI_MODEL: "test-model",
  });
  t.after(() =>
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }),
  );
  const x = await setup(t);
  const session = await x.cv.start(x.owner, {
    requestId: randomUUID(),
    exerciseId: "seated-knee-extension",
    side: "left",
    startedAtUtc: new Date().toISOString(),
    evidence: "simulated",
  });
  await x.feedback({
    version: "1.0.0",
    type: "guided_session_started",
    sessionId: session.id,
  });
  const update = await x.cv.events(x.owner, session.id, {
    requestId: randomUUID(),
    event: {
      eventId: randomUUID(),
      sequence: 1,
      observedOffsetMs: 6000,
      type: "attempt_finalized",
      attemptId: randomUUID(),
      movementComplete: true,
      qualifying: true,
      holdMs: 5000,
      targetReached: true,
      rangeDegrees: 70,
    },
  });
  const cue = update.feedback[0];
  assert.equal(cue.generationStatus, "pending");
  const early = await x.feedback({
    version: "1.0.0",
    type: "guided_feedback",
    sessionId: session.id,
    feedbackId: cue.eventId,
  });
  assert.equal(early.exerciseCue, undefined);
  assert.equal(
    (await x.chat.memory()).events.filter((e) => e.kind === "exercise_feedback")
      .length,
    0,
  );
  const fetcher = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: JSON.stringify({ phraseId: "gentle" }) }],
            },
          },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  try {
    const final = await x.cv.generate(x.owner, session.id, cue.eventId, {
      requestId: randomUUID(),
    });
    assert.equal(final.textSource, "gemini_selected_approved_variant");
    const spoken = await x.feedback({
      version: "1.0.0",
      type: "guided_feedback",
      sessionId: session.id,
      feedbackId: cue.eventId,
    });
    assert.equal(spoken.message, final.text);
    assert.ok(spoken.exerciseCue);
    const remembered = (await x.chat.memory()).events.find(
      (e) => e.kind === "exercise_feedback",
    );
    assert.equal(remembered?.quote, final.text);
    assert.equal(
      remembered?.metadata.textSource,
      "gemini_selected_approved_variant",
    );
  } finally {
    globalThis.fetch = fetcher;
  }
});

test("explicit exercise requests are navigation, while questions and refusals stay in conversation", () => {
  for (const text of [
    "Open rehab",
    "Can you open the exercise module?",
    "Panda, let's exercise",
    "I want to exercise",
    "Let's do some exercise",
    "Take me to rehabilitation",
  ])
    assert.equal(requestsExercise(text), true, text);
  for (const text of [
    "I don't want to exercise",
    "I can't start exercise",
    "How do I start exercise?",
    "Panda, how do I start exercise?",
    "Show me my exercise report",
    "Can I start exercise after surgery?",
    "Will exercise hurt my elbow?",
    "Not ready to exercise",
    "Start exercise but my elbow hurts",
  ])
    assert.equal(requestsExercise(text), false, text);
});
test("direct exercise opening and spoken navigation do not depend on model generation", async (t) => {
  const x = await setup(t, false);
  let modelCalls = 0;
  const chat = checkinService(
    x.memory,
    x.voice,
    {
      mode: "connected",
      snapshot: () => x.care.snapshot(),
      exerciseSession: async () => {
        throw Error("unused");
      },
    },
    Date.now,
    async () => {
      modelCalls++;
      throw Error("Provider unavailable");
    },
  );
  const input = { requestId: randomUUID() };
  const opened = await chat.openExercise(input);
  assert.equal(opened.navigation, "/rehab");
  assert.equal(opened.checkin?.stage, "exercise");
  assert.deepEqual(await chat.openExercise(input), opened);
  const spoken = await chat.answer({
    requestId: randomUUID(),
    checkinId: opened.checkin!.id,
    text: "Open the rehab section",
  });
  assert.equal(spoken.navigation, "/rehab");
  const resumed = await chat.start({ requestId: randomUUID() });
  assert.equal(resumed.checkin?.stage, "exercise");
  assert.equal(resumed.navigation, undefined, "Starting a general conversation must not force exercise to reopen");
  assert.equal(modelCalls, 0);
  const remembered = await chat.memory();
  assert.equal(remembered.checkin?.medicationIndex, 0);
  assert.equal(remembered.checkin?.foodReviewed, false);
  assert.equal(remembered.checkin?.followupReviewed, false);
  assert.ok(
    (await x.care.snapshot()).tasks.every((task) => task.status === "pending"),
  );
});
test("exercise opened first returns to unfinished check-ins after the owner report and pain review", async (t) => {
  const x = await setup(t, false);
  const opened = await x.chat.openExercise({ requestId: randomUUID() });
  const session = await x.cv.start(x.owner, {
    requestId: randomUUID(),
    exerciseId: "static-quads",
    side: "left",
    startedAtUtc: new Date().toISOString(),
    evidence: "patient_reported",
  });
  await x.feedback({
    version: "1.0.0",
    type: "guided_session_started",
    sessionId: session.id,
  });
  await x.cv.finish(x.owner, session.id, {
    requestId: randomUUID(),
    lastMeasurementSequence: 0,
    report: {
      observedEndedAtUtc: new Date().toISOString(),
      completionStatus: "incomplete",
      terminationReason: "finished",
      timing: {
        elapsedTimeMs: 0,
        activeTimeMs: 0,
        pausedTimeMs: 0,
        userPausedTimeMs: 0,
        trackingPausedTimeMs: 0,
        otherPausedTimeMs: 0,
        guidedTimerMs: 0,
      },
    },
  });
  await x.feedback({
    version: "1.0.0",
    type: "guided_report_saved",
    sessionId: session.id,
  });
  let reply = await x.chat.answer({
    requestId: randomUUID(),
    checkinId: opened.checkin!.id,
    expectedStage: "exercise_review",
    text: "It felt okay",
  });
  assert.equal(reply.checkin?.stage, "pain_check");
  reply = await x.chat.answer({
    requestId: randomUUID(),
    checkinId: opened.checkin!.id,
    expectedStage: "pain_check",
    text: "No pain or discomfort",
  });
  assert.equal(reply.checkin?.stage, "medications");
  assert.match(reply.message, /atorvastatin/i);
});
test("opening rehab preserves a pending confirmation and holds exercise for an existing concern", async (t) => {
  const x = await setup(t, false);
  await x.answer("My elbow feels okay");
  const proposal = await x.answer("Yes");
  assert.ok(proposal.proposalId);
  let opened = await x.chat.openExercise({ requestId: randomUUID() });
  assert.equal(opened.navigation, "/rehab");
  assert.equal(opened.proposalId, proposal.proposalId);
  assert.equal(opened.checkin?.stage, "medication_confirmation");
  await x.memory.transaction(x.owner, (tx) => {
    const s = tx.latestSession()!;
    s.pendingProposalId = undefined;
    s.concernPending = true;
    s.stage = "wellbeing_followup";
    tx.saveSession(s);
  });
  opened = await x.chat.openExercise({ requestId: randomUUID() });
  assert.equal(opened.navigation, undefined);
  assert.equal(opened.pauseExercise, true);
  assert.notEqual(opened.checkin?.stage, "exercise");
});
