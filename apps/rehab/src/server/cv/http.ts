import { createHmac,randomBytes,randomUUID,timingSafeEqual } from "node:crypto";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { DomainError,dataFile } from "../../../../../packages/platform/json-store";
import { CV_FEATURE_VERSION,type CvContext } from "../../../../../packages/contracts/rehab-cv";
import { CV_CONFIGS } from "./config";
import { geminiReadiness } from "./gemini";

const COOKIE="panda_cv_demo";
const globals=globalThis as typeof globalThis & {__cvAuthSecret?:Promise<string>};
function secret():Promise<string> {
  if(process.env.REHAB_CV_AUTH_SECRET)return Promise.resolve(process.env.REHAB_CV_AUTH_SECRET);
  if(!globals.__cvAuthSecret)globals.__cvAuthSecret=(async()=>{
    const file=dataFile("cv-auth-secret");await mkdir(path.dirname(file),{recursive:true});
    try{return await readFile(file,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const value=randomBytes(32).toString("hex");
    try{await writeFile(file,value,{flag:"wx",mode:0o600});return value;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;return readFile(file,"utf8");}
  })();
  return globals.__cvAuthSecret;
}
function safeEqual(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);}
function signature(value:string,key:string){return createHmac("sha256",key).update(value).digest("base64url");}
function cookie(req:Request){return req.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);}
function publicOrigin(req:Request) {
  if(process.env.REHAB_DEMO_ALLOWED_ORIGIN)return new URL(process.env.REHAB_DEMO_ALLOWED_ORIGIN).origin;
  const internal=new URL(req.url);
  const host=req.headers.get("host");
  // Next may normalize req.url to localhost even when the browser used 127.0.0.1.
  return host ? new URL(`${internal.protocol}//${host}`).origin : internal.origin;
}
function guardOrigin(req:Request) {
  const origin=req.headers.get("origin");
  const allowed=publicOrigin(req);
  if(req.headers.get("sec-fetch-site")==="cross-site" || (origin && origin!==allowed))throw new DomainError("ORIGIN_REJECTED","Use the same demo origin",403);
  if(req.method!=="GET" && !origin)throw new DomainError("ORIGIN_REQUIRED","A same-origin request is required",403);
}
function headers(){return {"Cache-Control":"no-store","X-Panda-Mode":"synthetic-demo","X-Content-Type-Options":"nosniff"};}
export interface CvIdentity {subject:string;csrfToken:string;token:string}
async function readIdentity(req:Request):Promise<CvIdentity|null> {
  const token=cookie(req);if(!token || token.length>700)return null;
  const [payload,sig,...extra]=token.split(".");if(!payload || !sig || extra.length)return null;
  const key=await secret();if(!safeEqual(sig,signature(payload,key)))return null;
  try {
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if(typeof data.sub!=="string" || typeof data.exp!=="number" || data.exp<Date.now() || data.exp>Date.now()+25*3600000)return null;
    return {subject:data.sub,token,csrfToken:signature(`csrf:${token}`,key)};
  }catch{return null;}
}
export async function requireIdentity(req:Request):Promise<CvIdentity> {
  guardOrigin(req);
  const identity=await readIdentity(req);
  if(!identity)throw new DomainError("DEMO_SESSION_REQUIRED","Open the exercise page to start a demo session",401);
  if(req.method!=="GET" && !safeEqual(req.headers.get("x-cv-csrf")||"",identity.csrfToken))throw new DomainError("CSRF_REJECTED","Refresh the demo context and retry",403);
  return identity;
}
export async function readBody(req:Request):Promise<unknown> {
  if(!req.headers.get("content-type")?.includes("application/json"))throw new DomainError("CONTENT_TYPE","JSON request required",400);
  if(Number(req.headers.get("content-length")||0)>32768)throw new DomainError("BODY_TOO_LARGE","Request exceeds the demo size limit",413);
  const reader=req.body?.getReader();if(!reader)throw new DomainError("BODY_REQUIRED","JSON request required",400);
  let length=0;const chunks:Uint8Array[]=[];
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32768){await reader.cancel();throw new DomainError("BODY_TOO_LARGE","Request exceeds the demo size limit",413);}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function cvRespond<T>(req:Request,fn:(identity:CvIdentity)=>Promise<T>):Promise<Response> {
  try {return Response.json({ok:true,data:await fn(await requireIdentity(req))},{headers:headers()});}
  catch(error){return cvError(error);}
}
export function cvError(error:unknown) {
  const status=error instanceof DomainError?error.status:error instanceof ZodError || error instanceof SyntaxError?400:503;
  const code=error instanceof DomainError?error.code:status===400?"VALIDATION_ERROR":"UNAVAILABLE";
  const message=error instanceof DomainError?error.message:status===400?"Invalid demo request":"Demo service unavailable; retry with the same request ID";
  return Response.json({ok:false,error:{code,message}},{status,headers:headers()});
}
export async function contextResponse(req:Request):Promise<Response> {
  try {
    guardOrigin(req);
    let identity=await readIdentity(req);let newToken=false;
    if(!identity) {
      const hostname=new URL(publicOrigin(req)).hostname;
      const local=["localhost","127.0.0.1","[::1]","::1"].includes(hostname);
      if(!local) {
        const access=process.env.REHAB_DEMO_ACCESS_KEY;
        if(!access || !safeEqual(req.headers.get("x-cv-demo-access")||"",access))throw new DomainError("DEMO_ACCESS_REQUIRED","This remote demo needs its configured access key",401);
      }
      const key=await secret();
      const payload=Buffer.from(JSON.stringify({sub:randomUUID(),exp:Date.now()+24*3600000})).toString("base64url");
      const token=`${payload}.${signature(payload,key)}`;
      identity={subject:JSON.parse(Buffer.from(payload,"base64url").toString()).sub,token,csrfToken:signature(`csrf:${token}`,key)};newToken=true;
    }
    const context:CvContext={featureVersion:CV_FEATURE_VERSION,mode:"standalone_demo",csrfToken:identity.csrfToken,exercises:CV_CONFIGS,gemini:geminiReadiness()};
    const out=Response.json({ok:true,data:context},{headers:headers()});
    if(newToken)out.headers.set("Set-Cookie",`${COOKIE}=${identity.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${new URL(publicOrigin(req)).protocol==="https:"?"; Secure":""}`);
    return out;
  }catch(error){return cvError(error);}
}

