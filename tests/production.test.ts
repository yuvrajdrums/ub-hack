import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import {
  databaseTransaction,
  type DatabasePool,
} from "../packages/platform/production/database";
import { accountIdentity } from "../packages/platform/production/accounts";
import {
  identityScope,
  type Identity,
} from "../packages/platform/production/context";
import {
  authorizeOperation,
  checkOrigin,
  authenticate,
} from "../packages/platform/production/auth";
import { readJson } from "../packages/platform/body";
import { careService } from "../apps/care/src/server/service";
import { rehabService } from "../apps/rehab/src/server/service";
import { cvService } from "../apps/rehab/src/server/cv/service";
import { PatientMemoryRepository } from "../apps/panda/src/server/patient-memory";
import { PostgresVoiceRepository } from "../apps/panda/src/server/postgres-repository";
import { PostgresStore } from "../packages/platform/production/database";
import { respond } from "../packages/platform/http";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222",
  doctor = "33333333-3333-4333-8333-333333333333";
let db: PGlite, actorA: Identity, actorB: Identity, clinician: Identity;
const env = { ...process.env };
const runtime = globalThis as typeof globalThis & {
  __pandaPostgres?: DatabasePool;
};
before(async () => {
  process.env.PANDA_RUNTIME = "production";
  process.env.PANDA_INTEGRATION = "connected";
  process.env.PANDA_PUBLIC_ORIGIN = "https://panda.test";
  process.env.PANDA_SUPABASE_URL = "https://auth.test";
  process.env.PANDA_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.PANDA_DATABASE_URL = "postgres://unused";
  db = new PGlite();
  for (const file of (
    await readdir(new URL("../supabase/migrations", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await db.exec(
      await readFile(
        new URL("../supabase/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  runtime.__pandaPostgres = {
    connect: async () => ({
      query: (sql: string, values?: unknown[]) => db.query(sql, values),
      release() {},
    }),
    end: () => db.close(),
  } as unknown as DatabasePool;
  actorA = await accountIdentity(a, "Alex", undefined, "token-a", true);
  actorB = await accountIdentity(b, "Blair", undefined, "token-b", true);
  await db.query(
    "INSERT INTO panda_identity.principals(subject,role,display_name) VALUES($1,'clinician','Dr Example')",
    [doctor],
  );
  await db.query(
    "INSERT INTO panda_identity.patient_grants(subject,patient_id) VALUES($1,$2)",
    [doctor, a],
  );
  clinician = await accountIdentity(doctor, "ignored", a, "doctor-token");
});
after(async () => {
  delete runtime.__pandaPostgres;
  await db?.close();
  for (const name of Object.keys(process.env))
    if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
});
const as = <T>(actor: Identity, fn: () => T) => identityScope.run(actor, fn);
test("new verified accounts have empty, separate clinical records and cannot become clinicians", async () => {
  const care = careService();
  const one = await as(actorA, () => care.snapshot()),
    two = await as(actorB, () => care.snapshot());
  assert.equal(one.patientId, a);
  assert.equal(two.patientId, b);
  assert.equal(one.plan, null);
  assert.deepEqual(one.tasks, []);
  assert.equal(one.contractVersion, "2.1.0");
  await assert.rejects(
    () => accountIdentity(a, "Forged clinician", b, "token"),
    /not assigned/,
  );
  await assert.rejects(
    () =>
      databaseTransaction(a, a, (client) =>
        client.query(
          "UPDATE panda_identity.principals SET role='clinician' WHERE subject=$1",
          [a],
        ),
      ),
    /permission denied/,
  );
  assert.equal(
    (await accountIdentity(a, "", undefined, "token")).role,
    "patient",
  );
});
test("only an assigned clinician imports and approves; patients never receive drafts", async () => {
  const care = careService();
  await assert.rejects(
    () =>
      as(actorA, () =>
        care.importPlan({
          requestId: randomUUID(),
          sourceText: "Take approved medicine",
        }),
      ),
    /clinician/,
  );
  const draft = await as(clinician, () =>
    care.importPlan({
      requestId: randomUUID(),
      sourceText: "Take medicine from the reviewed plan.",
    }),
  );
  assert.equal(draft.demoOnly, false);
  assert.equal((await as(actorA, () => care.snapshot())).drafts.length, 0);
  const approved = await as(clinician, () =>
    care.approve(draft.id, {
      requestId: randomUUID(),
      expectedCurrentVersion: 0,
    }),
  );
  assert.equal(approved.approvedBy, doctor);
  assert.equal(approved.patientId, a);
  await assert.rejects(
    () => accountIdentity(doctor, "", b, "token"),
    /not assigned/,
  );
});
test("guided exercise uses authenticated patient storage and patient-only writes", async () => {
  const care=await as(clinician,()=>careService());
  const current=await as(clinician,()=>care.snapshot());
  const draft=await as(clinician,()=>care.importPlan({
    requestId:randomUUID(),
    sourceText:"Static quads\nWorking leg: left",
  }));
  await as(clinician,()=>care.approve(draft.id,{
    requestId:randomUUID(),
    expectedCurrentVersion:current.plan?.version||0,
  }));
  const cv=cvService(undefined,{care:()=>care.snapshot()});
  const payload={requestId:randomUUID(),exerciseId:"static-quads",side:"left",startedAtUtc:new Date().toISOString(),evidence:"patient_reported"};
  const session=await as(actorA,()=>cv.start(a,payload));
  assert.equal(session.careReference?.patientId,a);
  await assert.rejects(()=>as(actorB,()=>cv.get(a,session.id)),/not found/i);
  await assert.rejects(()=>as(actorA,()=>cv.start(b,{...payload,requestId:randomUUID()})),/approved patient context/);
  await assert.rejects(()=>as(clinician,()=>cv.start(a,payload)),/patient/);
  assert.equal((await as(actorA,()=>cv.get(a,session.id))).id,session.id);
  assert.equal((await as(actorB,()=>cv.reports(b))).length,0);
});
test("patient writes and idempotency are isolated; foreign task and session IDs fail", async () => {
  const care = careService();
  const requestId = randomUUID();
  const first = await as(actorA, () =>
    care.help({ requestId, quote: "A synthetic concern" }),
  );
  const second = await as(actorB, () =>
    care.help({ requestId, quote: "A different synthetic concern" }),
  );
  assert.notEqual(first.id, second.id);
  assert.equal((await as(actorB, () => care.snapshot())).help.length, 1);
  const current = await as(actorA, () => care.snapshot()),
    task = current.tasks[0];
  assert.ok(task);
  await assert.rejects(
    () =>
      as(actorB, () =>
        care.confirm(task.id, {
          requestId: randomUUID(),
          expectedRevision: 0,
          evidence: "patient_reported",
        }),
      ),
    /not found/,
  );
  const rehab = rehabService();
  const session = await as(actorA, () =>
    rehab.start(
      {
        requestId: randomUUID(),
        planId: current.plan!.id,
        planVersion: current.plan!.version,
        exerciseId: "demo-elbow",
      },
      current,
    ),
  );
  await assert.rejects(
    () => as(actorB, () => rehab.session(session.id)),
    /not found/,
  );
});
test("database RLS rejects a forged patient selection even without an application filter", async () => {
  await assert.rejects(
    () =>
      databaseTransaction(a, b, (client) =>
        client.query(
          "INSERT INTO care.patient_state(patient_id,data) VALUES($1,'{}') ON CONFLICT(patient_id) DO UPDATE SET data='{}'",
          [b],
        ),
      ),
    /row-level security/,
  );
  const out = await databaseTransaction(a, b, (client) =>
    client.query("SELECT * FROM care.patient_state"),
  );
  assert.equal(out.rows.length, 0);
  const own = await databaseTransaction(a, a, (client) =>
    client.query("SELECT * FROM care.patient_state"),
  );
  assert.equal(own.rows.length, 1);
});
test("persistent Panda memory and receipts survive repository recreation and remain patient scoped", async () => {
  const memory = new PatientMemoryRepository(),
    id = randomUUID(),
    now = new Date().toISOString();
  await as(actorA, () =>
    memory.transaction(a, (tx) => {
      tx.saveSession({
        id,
        patientId: a,
        planId: "approved",
        planVersion: 1,
        stage: "food",
        medicationTaskIds: [],
        medicationIndex: 0,
        startedAt: now,
        updatedAt: now,
      });
      tx.append({
        id: "meal",
        patientId: a,
        kind: "food",
        quote: "Synthetic soup",
        at: now,
        source: "patient_report",
        metadata: {},
      });
      tx.appendDialogue({
        id: "turn",
        checkinId: id,
        role: "user",
        text: "Synthetic soup",
        at: now,
      });
      tx.saveReceipt("same-id", { topic: "meal" }, { saved: true });
    }),
  );
  const saved = await as(actorA, () =>
    new PatientMemoryRepository().snapshot(a),
  );
  assert.equal(saved.totalEvents, 1);
  assert.equal(saved.transcript.length, 1);
  const foreign = await as(actorB, () => memory.snapshot(b));
  assert.equal(foreign.totalEvents, 0);
  await assert.rejects(() => as(actorA, () => memory.snapshot(b)), /mismatch/);
  await as(actorA, () => memory.transaction(a, (tx) => tx.forget()));
  assert.equal((await as(actorA, () => memory.snapshot(a))).totalEvents, 0);
  assert.ok((await as(actorA, () => careService().snapshot())).plan);
});
test("voice transaction rollback, retry receipts and patient separation use Postgres", async () => {
  const repo = new PostgresVoiceRepository(),
    requestId = randomUUID();
  const reply = {
    mode: "connected" as const,
    engine: "gemini" as const,
    message: "Synthetic reply",
  };
  await assert.rejects(
    () =>
      as(actorA, () =>
        repo.transaction((tx) => {
          tx.saveTurn(
            { requestId, text: "hello", reply, at: new Date().toISOString() },
            "fingerprint",
          );
          throw Error("cancel");
        }),
      ),
    /cancel/,
  );
  assert.equal(
    await as(actorA, () => repo.transaction((tx) => tx.receipt(requestId))),
    undefined,
  );
  await as(actorA, () =>
    repo.transaction((tx) =>
      tx.saveTurn(
        { requestId, text: "hello", reply, at: new Date().toISOString() },
        "fingerprint",
      ),
    ),
  );
  assert.equal(
    (
      await as(actorA, () =>
        new PostgresVoiceRepository().transaction((tx) =>
          tx.receipt(requestId),
        ),
      )
    )?.result.message,
    "Synthetic reply",
  );
  assert.equal(
    await as(actorB, () => repo.transaction((tx) => tx.receipt(requestId))),
    undefined,
  );
});
test("domain transactions roll back failed changes instead of leaving partial records", async () => {
  const store = new PostgresStore<{ value: number }>("rehab", () => ({
    value: 0,
  }));
  await assert.rejects(
    () =>
      as(actorB, () =>
        store.update((state) => {
          state.value = 7;
          throw Error("cancel");
        }),
      ),
    /cancel/,
  );
  assert.equal((await as(actorB, () => store.snapshot())).value, 0);
});
test("all sensitive API operations have role checks and browser writes require the public origin", () => {
  assert.throws(
    () => authorizeOperation("patient", "/care/api/plans/import", "POST"),
    /clinician/,
  );
  assert.throws(
    () => authorizeOperation("patient", "/care/api/help/abc/ack", "POST"),
    /clinician/,
  );
  assert.throws(
    () => authorizeOperation("clinician", "/api/voice/speak", "POST"),
    /patient/,
  );
  assert.doesNotThrow(() =>
    authorizeOperation("clinician", "/care/api/state", "GET"),
  );
  assert.throws(
    () =>
      checkOrigin(
        new Request("https://panda.test/api/voice/turn", {
          method: "POST",
          headers: { Origin: "https://evil.test" },
        }),
      ),
    /own site/,
  );
  assert.throws(
    () =>
      checkOrigin(
        new Request("https://panda.test/api/voice/turn", { method: "POST" }),
      ),
    /own site/,
  );
  assert.doesNotThrow(() =>
    checkOrigin(
      new Request("https://panda.test/api/voice/turn", {
        method: "POST",
        headers: { Origin: "https://panda.test" },
      }),
    ),
  );
});
test("request bodies are bounded while streaming, even without a Content-Length header", async () => {
  await assert.rejects(
    () =>
      readJson(
        new Request("https://panda.test/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"message":"too long"}',
        }),
        8,
      ),
    /too large/,
  );
  const out = await readJson(
    new Request("https://panda.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    }),
  );
  assert.deepEqual(out, { ok: true });
});
test("Supabase verification, not cookies or user-editable metadata, establishes identity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: a,
      email: "synthetic@example.test",
      email_confirmed_at: new Date().toISOString(),
      user_metadata: { role: "clinician", display_name: "Synthetic" },
    });
  try {
    const actor = await authenticate(
      new Request("https://panda.test/api/context", {
        headers: { Authorization: "Bearer synthetic-token" },
      }),
    );
    assert.equal(actor.role, "patient");
    assert.equal(actor.patientId, a);
    await assert.rejects(
      () =>
        authenticate(
          new Request("https://panda.test/api/context", {
            headers: {
              Authorization: "Bearer synthetic-token",
              "X-Panda-Patient": b,
            },
          }),
        ),
      /not assigned/,
    );
    const rejected = await respond(() => ({ shouldNotRun: true }));
    assert.equal(rejected.status, 401);
  } finally {
    globalThis.fetch = original;
  }
});

test("public self-signup cannot activate app access; only a verified provider invitation can enroll", async () => {
  const subject = "44444444-4444-4444-8444-444444444444";
  await assert.rejects(
    () => accountIdentity(subject, "Self signup", undefined, "token"),
    /activate/,
  );
  const invited = await accountIdentity(
    subject,
    "Invited",
    undefined,
    "token",
    true,
  );
  assert.equal(invited.role, "patient");
  assert.equal(invited.patientId, subject);
});

test("patient and doctor portal instances share requests, acknowledgements and approved plan updates", async () => {
  const patientPortal = careService(), doctorPortal = careService();
  const otherPatientBefore = await as(actorB, () => patientPortal.snapshot());
  const request = await as(actorA, () => patientPortal.help({ requestId: randomUUID(), quote: "Synthetic request: please arrange a follow-up." }));
  const doctorView = await as(clinician, () => doctorPortal.snapshot());
  assert.ok(doctorView.help.some(item => item.id === request.id && item.status === "open"));
  await as(clinician, () => doctorPortal.acknowledgeHelp(request.id, { requestId: randomUUID() }));
  assert.equal((await as(actorA, () => careService().snapshot())).help.find(item => item.id === request.id)?.status, "acknowledged");
  const draft = await as(clinician, () => doctorPortal.importPlan({ requestId: randomUUID(), sourceText: "Medication: follow the updated approved instructions.\nExercise: follow the updated approved movement.\nFollow-up: contact the care team to arrange a time." }));
  const beforeApproval = await as(actorA, () => patientPortal.snapshot());
  assert.equal(beforeApproval.plan?.id, doctorView.plan?.id);
  assert.deepEqual(beforeApproval.drafts, []);
  const approved = await as(clinician, () => doctorPortal.approve(draft.id, { requestId: randomUUID(), expectedCurrentVersion: beforeApproval.plan?.version || 0 }));
  const patientView = await as(actorA, () => careService().snapshot());
  assert.equal(patientView.plan?.id, approved.id);
  assert.equal(patientView.plan?.version, (beforeApproval.plan?.version || 0) + 1);
  assert.ok(patientView.tasks.every(task => task.planId === approved.id && task.planVersion === approved.version));
  assert.deepEqual(await as(actorB, () => patientPortal.snapshot()), otherPatientBefore);
  await assert.rejects(() => as(actorA, () => patientPortal.acknowledgeHelp(request.id, { requestId: randomUUID() })), /clinician/);
});
