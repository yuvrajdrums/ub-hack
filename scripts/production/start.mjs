import { spawn } from "node:child_process";
import { productionConfig } from "../../packages/platform/production/config.ts";
if (process.env.PANDA_RUNTIME !== "production")
  throw Error("start:production requires PANDA_RUNTIME=production");
productionConfig();
if (!/^(gemini|openai)$/.test(process.env.PANDA_AI_MODE || ""))
  throw Error("Production requires a configured model provider");
for (const key of process.env.PANDA_AI_MODE === "gemini"
  ? ["PANDA_GEMINI_API_KEY"]
  : ["PANDA_OPENAI_API_KEY", "PANDA_OPENAI_MODEL"])
  if (!process.env[key]) throw Error(key + " is missing");
if (
  process.env.PANDA_TTS_MODE !== "elevenlabs" ||
  !process.env.PANDA_ELEVENLABS_API_KEY ||
  !process.env.PANDA_ELEVENLABS_VOICE_ID ||
  !process.env.PANDA_ELEVENLABS_MODEL_ID
)
  throw Error("Production voice requires the ElevenLabs configuration");
if (!/^\d+$/.test(process.env.PORT || "3000"))
  throw Error("PORT must be numeric");
for (const [key, value] of Object.entries({
  PANDA_CARE_ORIGIN: "http://127.0.0.1:3001",
  PANDA_REHAB_ORIGIN: "http://127.0.0.1:3002",
}))
  if (process.env[key] && process.env[key] !== value)
    throw Error(key + " must use the private loopback origin");
const child = spawn(process.execPath, ["scripts/run.mjs", "start", "all"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", () => {
  process.exitCode = 1;
});
