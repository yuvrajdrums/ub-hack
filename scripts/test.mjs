import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const env = {
  ...process.env,
  PANDA_RUNTIME: "demo",
  PANDA_INTEGRATION: "fixture",
  PANDA_AI_MODE: "demo",
  PANDA_TTS_MODE: "browser",
};
for (const name of [
  "PANDA_GEMINI_API_KEY",
  "REHAB_GEMINI_API_KEY",
  "PANDA_OPENAI_API_KEY",
  "PANDA_ELEVENLABS_API_KEY",
  "PANDA_DATABASE_URL",
  "PANDA_MIGRATION_DATABASE_URL",
  "PANDA_SUPABASE_PUBLISHABLE_KEY",
])
  delete env[name];
const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => "tests/" + name);
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { env, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
