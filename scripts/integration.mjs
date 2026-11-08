import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const port of [3000, 3001, 3002])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", () =>
      reject(
        Error(
          `Port ${port} is occupied. Stop existing Panda servers before integration tests.`,
        ),
      ),
    );
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
const dir = await mkdtemp(path.join(tmpdir(), "panda-integration-"));
const proc = spawn(process.execPath, ["scripts/run.mjs", "start", "all"], {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PANDA_DATA_DIR: dir,
    PANDA_INTEGRATION: "connected",
    PANDA_AI_MODE: "demo",
    REHAB_DEMO_ALLOWED_ORIGIN: "http://127.0.0.1:3000",
  },
});
let logs = "";
proc.stdout.on("data", (b) => {
  logs += b;
});
proc.stderr.on("data", (b) => {
  logs += b;
});
const origin = "http://127.0.0.1:3000";
async function api(url, body, status = 200) {
  const r = await fetch(origin + url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(r.status, status, await r.clone().text());
  const out = await r.json();
  assert.equal(out.ok, status === 200);
  return out.data;
}
let checks = 0;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await Promise.all(
        ["/api/health", "/care/api/health", "/rehab/api/health"].map(
          async (p) => {
            const r = await fetch(origin + p);
            if (!r.ok) throw Error("not ready");
          },
        ),
      );
      ready = true;
      break;
    } catch {
      if (proc.exitCode !== null) break;
      await sleep(300);
    }
  }
  if (!ready) throw Error("Servers failed to start: " + logs);
  for (const [route, label] of [
    ["/", "Talk to Panda"],
    ["/care", "A clear plan."],
    ["/rehab", "Your movement workspace"],
  ]) {
    const r = await fetch(origin + route);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(label), route + " missing its own app markup");
    const css = [...html.matchAll(/href="([^" ]+\.css(?:\?[^" ]*)?)"/g)].map(
      (m) => m[1],
    );
    assert.ok(css.length, route + " no CSS");
    for (const asset of css) {
      const res = await fetch(origin + asset);
      assert.equal(res.status, 200, asset);
    }
    checks++;
  }
  const initial = await api("/care/api/state");
  assert.equal(initial.plan.version, 1);
  checks++;
  const turn = {
    requestId: "integration-help",
    text: "Please help me contact my care team",
  };
  const proposal = await api("/api/voice/turn", turn);
  assert.ok(proposal.proposalId);
  assert.equal((await api("/care/api/state")).help.length, 0);
  checks++;
  const confirmation = await api("/api/voice/confirm", {
    proposalId: proposal.proposalId,
  });
  assert.match(confirmation.message, /not acknowledged/);
  await api("/api/voice/confirm", { proposalId: proposal.proposalId });
  let state = await api("/care/api/state");
  assert.equal(state.help.length, 1);
  assert.equal(state.help[0].status, "open");
  checks++;
  await api("/care/api/help/" + state.help[0].id + "/ack", {
    requestId: "integration-ack-help",
  });
  assert.equal((await api("/api/context")).help[0].status, "acknowledged");
  checks++;
  const s = await api("/rehab/api/sessions", {
    requestId: "integration-start",
    planId: initial.plan.id,
    planVersion: 1,
    exerciseId: "demo-elbow",
  });
  const report = {
    sessionId: s.id,
    patientId: s.patientId,
    planId: s.planId,
    planVersion: s.planVersion,
    exerciseId: s.exerciseId,
    startedAt: s.startedAt,
    endedAt: new Date().toISOString(),
    repetitions: 3,
    rangeDegrees: 90,
    trackingQuality: "simulated",
    evidence: "simulated",
    terminationReason: "completed",
  };
  const finish = { requestId: "integration-finish", report };
  await api("/rehab/api/sessions/" + s.id + "/finish", finish);
  await api("/rehab/api/sessions/" + s.id + "/finish", finish);
  assert.equal((await api("/care/api/reports")).length, 1);
  checks++;
  await api("/care/api/reports/" + s.id + "/ack", {
    requestId: "integration-report-ack",
  });
  assert.equal(
    (await api("/care/api/state")).acknowledgements[0].sessionId,
    s.id,
  );
  checks++;
  const task = await api("/api/voice/turn", {
    requestId: "integration-task",
    text: "Confirm task task-demo-001",
  });
  await api("/api/voice/confirm", { proposalId: task.proposalId });
  assert.equal(
    (await api("/care/api/state")).tasks[0].evidence,
    "patient_reported",
  );
  checks++;
  await api(
    "/care/api/tasks/task-demo-001/confirm",
    {
      requestId: "integration-stale",
      expectedRevision: 0,
      evidence: "patient_reported",
    },
    409,
  );
  checks++;
  const draft = await api("/care/api/plans/import", {
    requestId: "integration-import",
    sourceText: "Demo approved instruction\nSecond line",
  });
  assert.equal((await api("/api/context")).plan.version, 1);
  checks++;
  await api("/care/api/plans/" + draft.id + "/approve", {
    requestId: "integration-approve",
    expectedCurrentVersion: 1,
  });
  assert.equal((await api("/api/context")).plan.version, 2);
  assert.equal((await api("/rehab/api/context")).plan.version, 2);
  assert.equal((await api("/care/api/reports"))[0].planVersion, 1);
  checks++;
  await api(
    "/rehab/api/sessions",
    {
      requestId: "integration-stale-start",
      planId: initial.plan.id,
      planVersion: 1,
      exerciseId: "demo-elbow",
    },
    409,
  );
  checks++;
  await api(
    "/rehab/api/sessions/" + s.id + "/finish",
    {
      requestId: "integration-fake",
      report: { ...report, evidence: "camera_estimated" },
    },
    400,
  );
  checks++;
  const cvCheck=spawn(process.execPath,["scripts/cv-http-smoke.mjs"],{
    stdio:"inherit",env:{...process.env,CV_TEST_ORIGIN:origin},
  });
  const cvCode=await new Promise(resolve=>cvCheck.once("exit",resolve));
  assert.equal(cvCode,0,"Scoped CV endpoints must work through the production gateway");
  checks++;
  console.log(
    `PASS: ${checks} integrated checks across three built apps, one gateway origin, versioned plans, voice confirmation, reports, acknowledgement and assets.`,
  );
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  const done = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", resolve);
  });
  const kill = (signal) => {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  kill("SIGTERM");
  await Promise.race([done, sleep(3500)]);
  kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
}
await import("./standalone.mjs");
