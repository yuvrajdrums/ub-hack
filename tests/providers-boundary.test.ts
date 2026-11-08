import test from "node:test";
import assert from "node:assert/strict";
import { classify, providerStatus } from "../apps/panda/src/server/provider";
import { synthesize } from "../apps/panda/src/server/speech";
import { fixtureCare } from "../packages/contracts/fixtures";

async function environment(fn: () => Promise<void>) {
  const previous = { ...process.env }, fetch = globalThis.fetch;
  Object.assign(process.env, {
    PANDA_AI_MODE: "gemini", PANDA_GEMINI_API_KEY: "fake-secret", REHAB_GEMINI_API_KEY: "separate-rehab-secret",
    PANDA_OPENAI_API_KEY: "fake-secret", PANDA_OPENAI_MODEL: "test-model",
    PANDA_TTS_MODE: "elevenlabs", PANDA_ELEVENLABS_API_KEY: "fake-secret",
    PANDA_ELEVENLABS_VOICE_ID: "test-voice", PANDA_ELEVENLABS_MODEL_ID: "test-model",
  });
  try { await fn(); }
  finally {
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}
test("Gemini request uses server header, allowlisted schemas and a bounded signal", async () => environment(async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.ok(!String(url).includes("fake-secret"));
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"), "fake-secret");
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.tools[0].functionDeclarations.map((t: { name: string }) => t.name).sort(),
      ["confirm_task", "open_exercise", "read_patient_context", "read_plan", "request_help"]);
    assert.ok(body.tools[0].functionDeclarations.every((t: { parametersJsonSchema: { additionalProperties: boolean } }) => t.parametersJsonSchema.additionalProperties === false));
    assert.ok(options?.signal);
    return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "read_plan", args: {} } }] } }] });
  };
  assert.equal((await classify("my plan", fixtureCare())).command?.name, "read_plan");
}));
test("OpenAI uses strict tools and rejects malformed or multiple calls", async () => environment(async () => {
  process.env.PANDA_AI_MODE = "openai";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.parallel_tool_calls, false);
    assert.ok(body.tools.every((t: { function: { strict: boolean } }) => t.function.strict));
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "read_plan", arguments: "{}" } }] } }] });
  };
  assert.equal((await classify("my plan", fixtureCare())).engine, "openai");
  for (const calls of [
    [{ function: { name: "read_plan", arguments: "{invalid" } }],
    [{ function: { name: "read_plan", arguments: "{}" } }, { function: { name: "open_exercise", arguments: "{}" } }],
    [{ function: { name: "read_plan", arguments: '{"extra":"not allowed"}' } }],
  ]) {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: calls } }] });
    await assert.rejects(() => classify("test", fixtureCare()));
  }
}));
test("Gemini rejects unknown tools, extra args, multiple calls and malformed envelopes", async () => environment(async () => {
  for (const result of [
    {},
    { candidates: [] },
    { candidates: [{ content: { parts: "invalid" } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "change_dose", args: {} } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "read_plan", args: { extra: true } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "read_plan", args: {} } }, { functionCall: { name: "request_help", args: { quote: "help" } } }] } }] },
  ]) {
    globalThis.fetch = async () => Response.json(result);
    await assert.rejects(() => classify("test", fixtureCare()));
  }
}));
test("provider configuration, invalid JSON and timeouts never fall back to demo", async () => environment(async () => {
  process.env.PANDA_AI_MODE = "typo";
  assert.throws(() => providerStatus(), /must be/);
  process.env.PANDA_AI_MODE = "gemini";
  delete process.env.PANDA_GEMINI_API_KEY;
  await assert.rejects(() => classify("test", fixtureCare()), /Set PANDA_GEMINI/);
  process.env.PANDA_GEMINI_API_KEY = "fake-secret";
  assert.equal(providerStatus().configured, true);
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "read_plan", args: {} } }] } }] });
  };
  assert.equal((await classify("my plan", fixtureCare())).command?.name, "read_plan");
  globalThis.fetch = async () => new Response("invalid-json");
  await assert.rejects(() => classify("test", fixtureCare()), /invalid response/);
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  await assert.rejects(() => classify("test", fixtureCare()), /timed out/);
}));
test("caller cancellation propagates to the provider HTTP request", async () => environment(async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => {
    controller.abort();
    assert.equal(options?.signal?.aborted, true);
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(() => classify("test", fixtureCare(), controller.signal));
}));
test("ElevenLabs request returns audio with keys only in headers", async () => environment(async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.elevenlabs.io/v1/text-to-speech/test-voice?output_format=mp3_44100_128");
    assert.equal(new Headers(options?.headers).get("xi-api-key"), "fake-secret");
    assert.deepEqual(JSON.parse(String(options?.body)), { text: "Synthetic test.", model_id: "test-model",voice_settings:{stability:0.4,similarity_boost:0.75,style:0,speed:1} });
    assert.ok(options?.signal);
    return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
  };
  assert.equal((await synthesize({ text: "Synthetic test." })).byteLength, 3);
}));
test("ElevenLabs errors, timeouts, non-audio and empty bodies are explicit failures", async () => environment(async () => {
  for (const response of [
    Response.json({ error: "provider details and secrets" }, { status: 429 }),
    Response.json({ success: true }),
    new Response("", { headers: { "Content-Type": "audio/mpeg" } }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(() => synthesize({ text: "test" }), e => !String(e).includes("secrets"));
  }
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  await assert.rejects(() => synthesize({ text: "test" }), /timed out/);
  process.env.PANDA_TTS_MODE = "browser";
  await assert.rejects(() => synthesize({ text: "test" }), /Configure ElevenLabs/);
}));
