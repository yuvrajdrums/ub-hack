import { REHAB_GEMINI_MODEL } from "./gemini-model.mjs";

/** Server-process defaults for the unmodified upstream provider. */
export function yuvrajEnvironment(env){
 const enabled=env.PANDA_INTEGRATION==='connected';
 const rehabEnabled=enabled&&Boolean(env.REHAB_GEMINI_API_KEY);
 return {
  ...(!env.REHAB_GEMINI_MODE?{REHAB_GEMINI_MODE:rehabEnabled?'controlled':'off'}:{}),
  ...(enabled?{REHAB_GEMINI_MODEL}:{}),
 };
}

/** The preserved Rehab provider reads a legacy Panda-named variable inside its own process. */
export function rehabProcessEnvironment(env) {
 return { ...env, ...yuvrajEnvironment(env), PANDA_GEMINI_API_KEY: env.REHAB_GEMINI_API_KEY || "" };
}
