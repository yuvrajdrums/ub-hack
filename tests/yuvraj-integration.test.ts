import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cvService } from "../packages/yuvraj-integration/service";
import { careService } from "../apps/care/src/server/service";
import { voiceService } from "../apps/panda/src/server/service";
import { checkinService } from "../apps/panda/src/server/checkin";
import { PatientMemoryRepository } from "../apps/panda/src/server/patient-memory";
import {
  CvSessionSchema,
  CvReportSchema,
} from "../packages/contracts/rehab-cv";
const frames = (start = 1000) =>
  Array.from({ length: 3 }, (_, i) => ({
    offsetMs: start + i * 500,
    personCount: 1,
    landmarks: Array.from({ length: 33 }, () => [0.2, 0.3, 0, 1, 1]),
  }));
const analysis = {
  attemptedCycles: 1,
  movementCycles: 1,
  completedReps: 1,
  shortHolds: 0,
  phase: "armed",
  currentHoldMs: 0,
  confidence: 0.9,
  cue: "One movement met the demonstration targets.",
  workingMemory: "One completed movement.",
  rangeDegrees: 70,
};
const response = (data: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify(data) }] },
        },
      ],
    }),
  );
async function setup(t: test.TestContext, fetcher: typeof fetch) {
  const names = [
    "REHAB_GEMINI_MODE",
    "REHAB_GEMINI_MODEL",
    "PANDA_GEMINI_API_KEY",
    "REHAB_GEMINI_API_KEY",
  ];
  const prior = names.map((n) => process.env[n]);
  Object.assign(process.env, {
    REHAB_GEMINI_MODE: "controlled",
    REHAB_GEMINI_MODEL: "test-model",
    PANDA_GEMINI_API_KEY: "test-panda-private",
    REHAB_GEMINI_API_KEY: "test-rehab-private",
  });
  t.after(() =>
    names.forEach((n, i) => {
      if (prior[i] === undefined) delete process.env[n];
      else process.env[n] = prior[i];
    }),
  );
  const dir = await mkdtemp(path.join(tmpdir(), "panda-upstream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cv.json"),
    careStore = careService(path.join(dir, "care.json"));
  const snapshot = await careStore.snapshot();
  snapshot.plan!.instructions = [{ id: "synthetic-exercise", sourceRef: "synthetic:1", text: "Seated knee extension. Working leg: left." }];
  const care = { snapshot: async () => structuredClone(snapshot) }, owner = snapshot.patientId;
  const cv = cvService(file, { care: () => care.snapshot(), fetcher });
  const session = await cv.start(owner, {
    requestId: randomUUID(),
    exerciseId: "seated-knee-extension",
    side: "left",
    evidence: "camera_estimated",
    startedAtUtc: new Date().toISOString(),
    calibration: { startAngleDeg: 90, targetAngleDeg: 160 },
  });
  await cv.events(owner, session.id, {
    requestId: randomUUID(),
    event: {
      eventId: randomUUID(),
      sequence: 1,
      observedOffsetMs: 0,
      type: "tracking_changed",
      valid: true,
    },
  });
  return { cv, session, owner, file, care, dir };
}
test("unchanged upstream analysis composes with patient binding, canonical reports and Panda feedback", async (t) => {
  let calls = 0;
  const x = await setup(t, async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-rehab-private");
    return response(analysis);
  });
  const input = { requestId: randomUUID(), batchSequence: 1, frames: frames() };
  const result = await x.cv.analyze(x.owner, x.session.id, input);
  CvSessionSchema.parse(result.session);
  assert.equal(result.session.careReference?.patientId, x.owner);
  assert.equal(result.session.analysisMethod, "gemini_landmark_analysis");
  assert.equal(result.session.completedReps, 1);
  assert.equal(
    (await x.cv.analyze(x.owner, x.session.id, input)).analysis.completedReps,
    1,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () => x.cv.analysis("another-patient", x.session.id),
    /not found/i,
  );
  const memory = new PatientMemoryRepository(path.join(x.dir, "memory.sqlite"));
  const voice = voiceService(
    path.join(x.dir, "voice.sqlite"),
    {
      mode: "connected",
      snapshot: () => x.care.snapshot(),
      write: () => {
        throw Error("unexpected");
      },
    },
    undefined,
    undefined,
    Date.now,
    memory,
  );
  const chat = checkinService(memory, voice, {
    mode: "connected",
    snapshot: () => x.care.snapshot(),
    exerciseSession: async () => {
      throw Error("unused");
    },
    guidedSession: (id) => x.cv.get(x.owner, id),
    guidedAnalysis: (id) => x.cv.analysis(x.owner, id),
  });
  const opening = await chat.openExercise({ requestId: randomUUID() });
  await chat.exerciseFeedback({
    requestId: randomUUID(),
    checkinId: opening.checkin!.id,
    event: {
      version: "1.0.0",
      type: "guided_session_started",
      sessionId: x.session.id,
    },
  });
  const event = {
    version: "1.0.0",
    type: "guided_analysis",
    sessionId: x.session.id,
    batchSequence: 1,
  };
  const speech = await chat.exerciseFeedback({
    requestId: randomUUID(),
    checkinId: opening.checkin!.id,
    event,
  });
  assert.equal(speech.message, analysis.cue);
  assert.ok(speech.exerciseCue);
  assert.equal(
    (
      await chat.exerciseFeedback({
        requestId: randomUUID(),
        checkinId: opening.checkin!.id,
        event,
      })
    ).exerciseCue,
    undefined,
  );
  const report = await x.cv.finish(x.owner, x.session.id, {
    requestId: randomUUID(),
    lastMeasurementSequence: 1,
    report: {
      observedEndedAtUtc: new Date().toISOString(),
      completionStatus: "incomplete",
      terminationReason: "finished",
      timing: {
        elapsedTimeMs: 3000,
        activeTimeMs: 3000,
        pausedTimeMs: 0,
        userPausedTimeMs: 0,
        trackingPausedTimeMs: 0,
        otherPausedTimeMs: 0,
      },
    },
  });
  CvReportSchema.parse(report);
  assert.equal(report.completedReps, 1);
  assert.equal(report.careReference?.patientId, x.owner);
  const review = await chat.exerciseFeedback({
    requestId: randomUUID(),
    checkinId: opening.checkin!.id,
    event: {
      version: "1.0.0",
      type: "guided_report_saved",
      sessionId: x.session.id,
    },
  });
  assert.equal(review.checkin?.stage, "exercise_review");
  assert.ok(
    (await chat.memory()).events.some(
      (e) => e.metadata.textSource === "gemini_rep_analysis",
    ),
  );
  assert.doesNotMatch(await readFile(x.file, "utf8"), /"landmarks"/);
});
test("automatic calibration is rejected without a provider call; manual references remain usable", async (t) => {
  let calls = 0;
  const x = await setup(t, async () => {
    calls++;
    throw Error("Calibration must not call a provider");
  });
  for (const requestedPosition of ["auto", "rest", "comfortable_target"]) {
    await assert.rejects(() => x.cv.calibrate(x.owner, {
      requestId: randomUUID(), exerciseId: "seated-knee-extension", side: "left", requestedPosition, frames: frames(),
    }), (error: any) => error.code === "MANUAL_CALIBRATION_REQUIRED" && error.status === 409);
  }
  assert.equal(calls, 0);
  assert.equal(x.session.configuration.startAngleDeg, 90);
  assert.equal(x.session.configuration.targetAngleDeg, 160);
  assert.doesNotMatch(await readFile(x.file, "utf8"), /"landmarks"/);
});

test("feedback wording uses the Rehab key", async (t) => {
  let calls = 0;
  const x = await setup(t, async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-rehab-private");
    return response({ phraseId: "primary" });
  });
  const changes = await x.cv.changes(x.owner, x.session.id, 0);
  const cue = changes.changes.map((item) => item.feedback).find((f) => f.generationStatus === "pending");
  assert.ok(cue);
  const result = await x.cv.generate(x.owner, x.session.id, cue.eventId, { requestId: randomUUID() });
  assert.equal(result.textSource, "gemini_selected_approved_variant");
  assert.equal(calls, 1);
});

test("missing Rehab key never falls back to Panda's key", async (t) => {
  let calls = 0;
  const x = await setup(t, async () => { calls++; return response(analysis); });
  delete process.env.REHAB_GEMINI_API_KEY;
  await assert.rejects(() => x.cv.analyze(x.owner, x.session.id, {
    requestId: randomUUID(), batchSequence: 1, frames: frames(),
  }), /Set REHAB_GEMINI_API_KEY/);
  assert.equal(calls, 0);
});

test("late analysis cannot cross a pause, and provider failure preserves earlier progress", async (t) => {
  let release!: (response: Response) => void;
  const x = await setup(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = x.cv.analyze(x.owner, x.session.id, {
    requestId: randomUUID(),
    batchSequence: 1,
    frames: frames(),
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await x.cv.events(x.owner, x.session.id, {
    requestId: randomUUID(),
    event: {
      eventId: randomUUID(),
      sequence: 2,
      observedOffsetMs: 3000,
      type: "session_state_changed",
      action: "pause",
    },
  });
  release(response(analysis));
  await assert.rejects(() => pending, /changed while analysis/);
  assert.equal((await x.cv.get(x.owner, x.session.id)).completedReps, 0);
  await assert.rejects(
    () => x.cv.analysis(x.owner, x.session.id),
    /No movement analysis/,
  );
});
test("regressive or out-of-order analysis is rejected without overwriting accepted counts", async (t) => {
  let calls = 0;
  const x = await setup(t, async () =>
    response(
      calls++ === 0
        ? analysis
        : {
            ...analysis,
            attemptedCycles: 0,
            movementCycles: 0,
            completedReps: 0,
          },
    ),
  );
  await x.cv.analyze(x.owner, x.session.id, {
    requestId: randomUUID(),
    batchSequence: 1,
    frames: frames(),
  });
  await assert.rejects(
    () =>
      x.cv.analyze(x.owner, x.session.id, {
        requestId: randomUUID(),
        batchSequence: 2,
        frames: frames(1000),
      }),
    /fresh, ordered/,
  );
  await assert.rejects(
    () =>
      x.cv.analyze(x.owner, x.session.id, {
        requestId: randomUUID(),
        batchSequence: 2,
        frames: frames(3000),
      }),
    /lower cumulative count/,
  );
  assert.equal((await x.cv.get(x.owner, x.session.id)).completedReps, 1);
});
