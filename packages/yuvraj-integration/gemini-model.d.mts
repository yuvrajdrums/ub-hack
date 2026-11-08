export const PANDA_GEMINI_MODEL: "gemini-3.5-flash-lite";
export const REHAB_GEMINI_MODEL: "gemini-3.5-flash-lite";

export function geminiFlashFetch(
  url: string,
  init: RequestInit,
  apiKey: string,
  fetcher?: typeof fetch,
): Promise<Response>;
