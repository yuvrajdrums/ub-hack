import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../apps/panda/src/server/provider";
import { fixtureCare } from "../packages/contracts/fixtures";
async function configured(
  mode: "gemini" | "openai",
  result: unknown,
  status: number,
  fn: () => Promise<void>,
) {
  const previous = { ...process.env },
    original = globalThis.fetch;
  process.env.PANDA_AI_MODE = mode;
  process.env.PANDA_GEMINI_API_KEY = "fake-test-key";
  process.env.PANDA_OPENAI_API_KEY = "fake-test-key";
  process.env.PANDA_OPENAI_MODEL = "test-model";
  globalThis.fetch = async () => Response.json(result, { status });
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
    for (const k of Object.keys(process.env))
      if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  }
}
test("Gemini tool response may carry a call ID; patient quote remains verbatim", async () => {
  await configured(
    "gemini",
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "provider-call",
                  name: "request_help",
                  args: { quote: "model paraphrase" },
                },
              },
            ],
          },
        },
      ],
    },
    200,
    async () => {
      const r = await classify("My own words", fixtureCare());
      assert.equal(r.engine, "gemini");
      assert.deepEqual(r.command, {
        name: "request_help",
        args: { quote: "My own words" },
      });
    },
  );
});
test("OpenAI unknown tools fail schema validation before any domain mutation", async () => {
  await configured(
    "openai",
    {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "change_dose", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    200,
    async () => {
      await assert.rejects(() => classify("change medicine", fixtureCare()));
    },
  );
});
test("configured provider rejection is an error, never a demo success", async () => {
  await configured("gemini", { error: "rejected" }, 429, async () => {
    await assert.rejects(
      () => classify("show plan", fixtureCare()),
      /rejected/,
    );
  });
});
