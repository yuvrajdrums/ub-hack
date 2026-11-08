import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (existsSync(path.join(root, ".env.local"))) process.loadEnvFile(path.join(root, ".env.local"));
const ai = process.env.PANDA_AI_MODE || "demo";
const tts = process.env.PANDA_TTS_MODE || "browser";
const fields = ai === "openai"
  ? ["PANDA_OPENAI_API_KEY", "PANDA_OPENAI_MODEL"]
  : ["PANDA_GEMINI_API_KEY"];
const missingAI = fields.filter(key => !process.env[key]);
const missingTTS = ["PANDA_ELEVENLABS_API_KEY", "PANDA_ELEVENLABS_VOICE_ID", "PANDA_ELEVENLABS_MODEL_ID"].filter(key => !process.env[key]);
console.log("Configuration check. Secret values are never printed.");
console.log("AI mode: " + ai + (ai === "demo" ? " (labelled rules, no live AI)" : ""));
if (ai === "gemini") console.log("Panda Gemini model: gemini-3.5-flash-lite (application-pinned)");
console.log("Speech mode: " + tts);
if (!["demo", "gemini", "openai"].includes(ai)) console.log("FIX: PANDA_AI_MODE must be demo, gemini, or openai.");
if (!["browser", "elevenlabs"].includes(tts)) console.log("FIX: PANDA_TTS_MODE must be browser or elevenlabs.");
console.log(missingAI.length ? "AI fields to configure: " + missingAI.join(", ") : "AI account fields are present. Live verification is still required.");
console.log(missingTTS.length ? "ElevenLabs fields to configure: " + missingTTS.join(", ") : "ElevenLabs account fields are present. Live playback verification is still required.");
console.log("Use root .env.local. Keep keys out of chat and source control.");
console.log("Next: npm run test:providers:live (actual provider calls), then npm run dev for the connected apps.");
