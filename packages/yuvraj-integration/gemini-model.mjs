import { queuedGeminiFetch } from "./gemini-queue.mjs";

export const PANDA_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const REHAB_GEMINI_MODEL = "gemini-3.5-flash-lite";

function requestForModel(init, model) {
  if (typeof init.body !== "string" || !/^gemini-2\./.test(model)) return init;
  try {
    const body = JSON.parse(init.body);
    const thinking = body.generationConfig?.thinkingConfig;
    if (thinking) {
      if (/^gemini-2\.5/.test(model)) {
        const level = thinking.thinkingLevel;
        body.generationConfig.thinkingConfig = {
          thinkingBudget: level === "LOW" ? 1024 : 0,
        };
      } else {
        delete body.generationConfig.thinkingConfig;
      }
    }
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

/** Send requests to the model ID selected by the application; never silently switch models. */
export async function geminiFlashFetch(url, init, apiKey, fetcher = fetch) {
  const modelMatch = /\/models\/([^/:]+):generateContent(?=$|\?)/.exec(url);
  if (!modelMatch) return fetcher(url, init);

  const model = decodeURIComponent(modelMatch[1]);
  return queuedGeminiFetch(url, requestForModel(init, model), apiKey, fetcher);
}
