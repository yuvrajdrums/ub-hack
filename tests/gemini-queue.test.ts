import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { geminiFlashFetch } from "../packages/yuvraj-integration/gemini-model.mjs";
import { rehabProcessEnvironment } from "../packages/yuvraj-integration/environment.mjs";

const url = "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent";
async function isolated(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "panda-gemini-queue-"));
  const previous = process.env.PANDA_DATA_DIR;
  process.env.PANDA_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PANDA_DATA_DIR;
    else process.env.PANDA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("requests using one Gemini key wait until the response body arrives", async (t) => {
  await isolated(t);
  let active = 0, maximum = 0, calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    maximum = Math.max(maximum, ++active);
    return new Response(new ReadableStream({
      async start(controller) {
        await delay(60);
        controller.enqueue(new TextEncoder().encode("reply"));
        active--;
        controller.close();
      },
    }));
  };
  const replies = await Promise.all(Array.from({ length: 3 }, () => geminiFlashFetch(url, {}, "same-key", fetcher)));
  assert.equal(maximum, 1);
  assert.equal(calls, 3);
  assert.deepEqual(await Promise.all(replies.map((r) => r.text())), ["reply", "reply", "reply"]);
});

test("a canceled queued request makes no provider call and the slot recovers after errors", async (t) => {
  await isolated(t);
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = geminiFlashFetch(url, {}, "same-key", async () => {
    calls++; entered();
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ ok: true });
  });
  await started;
  const controller = new AbortController();
  const queued = geminiFlashFetch(url, { signal: controller.signal }, "same-key", async () => {
    calls++; return Response.json({});
  });
  controller.abort();
  await assert.rejects(() => queued, /abort/i);
  release(); await first;
  assert.equal(calls, 1);
  await assert.rejects(() => geminiFlashFetch(url, {}, "same-key", async () => { throw Error("provider failed"); }), /provider failed/);
  assert.equal((await geminiFlashFetch(url, {}, "same-key", async () => Response.json({}))).status, 200);
});

test("independent Panda and Rehab keys can call Gemini in parallel", async (t) => {
  await isolated(t);
  let active = 0, maximum = 0;
  const fetcher: typeof fetch = async () => {
    maximum = Math.max(maximum, ++active);
    await delay(80);
    active--;
    return Response.json({ ok: true });
  };
  await Promise.all([
    geminiFlashFetch(url, {}, "panda-key", fetcher),
    geminiFlashFetch(url, {}, "rehab-key", fetcher),
  ]);
  assert.equal(maximum, 2);
});

test("the same key is serialized across app processes", async (t) => {
  const directory = await isolated(t);
  const moduleUrl = pathToFileURL(path.resolve("packages/yuvraj-integration/gemini-model.mjs")).href;
  const source = `
    import { geminiFlashFetch } from ${JSON.stringify(moduleUrl)};
    await geminiFlashFetch(${JSON.stringify(url)}, {}, "shared-key", async () => {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, 120));
      process.stdout.write(JSON.stringify({start, end: Date.now()}) + "\\n");
      return Response.json({ok:true});
    });
  `;
  async function child() {
    return new Promise<{ start: number; end: number }>((resolve, reject) => {
      const proc = spawn(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, PANDA_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", errors = "";
      proc.stdout.on("data", (chunk) => { output += chunk; });
      proc.stderr.on("data", (chunk) => { errors += chunk; });
      proc.on("error", reject);
      proc.on("exit", (code) => code === 0 ? resolve(JSON.parse(output.trim())) : reject(Error(errors)));
    });
  }
  const intervals = (await Promise.all([child(), child(), child()])).sort((a, b) => a.start - b.start);
  assert.ok(intervals[1].start >= intervals[0].end);
  assert.ok(intervals[2].start >= intervals[1].end);
});

test("only the Rehab process maps the preserved provider to the Rehab key", () => {
  const original = { PANDA_INTEGRATION: "connected", PANDA_AI_MODE: "demo", PANDA_GEMINI_API_KEY: "panda-only", REHAB_GEMINI_API_KEY: "rehab-only" };
  const rehab = rehabProcessEnvironment(original);
  assert.equal(rehab.PANDA_GEMINI_API_KEY, "rehab-only");
  assert.equal(rehab.REHAB_GEMINI_MODE, "controlled");
  assert.equal(original.PANDA_GEMINI_API_KEY, "panda-only");
  assert.equal(rehabProcessEnvironment({ ...original, REHAB_GEMINI_API_KEY: "" }).PANDA_GEMINI_API_KEY, "");
});
