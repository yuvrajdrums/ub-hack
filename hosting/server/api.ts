import { env } from "cloudflare:workers";
import { createHmac,timingSafeEqual } from "node:crypto";
import { cvService } from "../shared/apps/rehab/src/server/cv/service";
import { CV_CONFIGS } from "../shared/apps/rehab/src/server/cv/config";
import { geminiReadiness } from "../shared/apps/rehab/src/server/cv/gemini";
import { cvError,readBody } from "../shared/apps/rehab/src/server/cv/http";
import { CV_FEATURE_VERSION } from "../shared/packages/contracts/rehab-cv";
import { DomainError } from "../shared/packages/platform/json-store";
import { D1CvStore } from "./d1-store";
const responseHeaders={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Panda-Mode":"synthetic-demo"};
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function handle(req:Request):Promise<Response>{
 try{
  const owner=req.headers.get("oai-authenticated-user-id");
  if(!owner)throw new DomainError("SIGN_IN_REQUIRED","Sign in with your ChatGPT account to open this private demo",401);
  const url=new URL(req.url),origin=req.headers.get("origin");
  const allowed=process.env.REHAB_DEMO_ALLOWED_ORIGIN || url.origin;
  if(req.headers.get("sec-fetch-site")==="cross-site" || (origin&&origin!==allowed))throw new DomainError("ORIGIN_REJECTED","Use the same demo origin",403);
  const key=process.env.REHAB_CV_AUTH_SECRET || (import.meta.env.DEV?"loopback-preview-only":"");
  if(!key)throw new DomainError("CONFIGURATION_REQUIRED","Private demo configuration is unavailable",503);
  const csrf=createHmac("sha256",key).update(`hosted-cv:${owner}`).digest("base64url");
  if(req.method!=="GET"&&(!origin||!equal(req.headers.get("x-cv-csrf")||"",csrf)))throw new DomainError("CSRF_REJECTED","Refresh this page and retry",403);
  const parts=url.pathname.replace(/^\/rehab\/api\/cv\/v1\/?/,"").split("/").filter(Boolean);
  let data:unknown;
  if(parts.length===1&&parts[0]==="context"&&req.method==="GET")data={featureVersion:CV_FEATURE_VERSION,mode:"standalone_demo",csrfToken:csrf,exercises:CV_CONFIGS,gemini:geminiReadiness()};
  else{
   if(!env.DB)throw new DomainError("STORAGE_UNAVAILABLE","Private demo storage is unavailable",503);
   const cv=cvService(undefined,{store:new D1CvStore(env.DB,`cv:${owner}`)});
   const [resource,id,action,eventId,last]=parts;
   if(resource!=="sessions")throw new DomainError("NOT_FOUND","Route not found",404);
   if(parts.length===1&&req.method==="GET")data=await cv.reports(owner);
   else if(parts.length===1&&req.method==="POST")data=await cv.start(owner,await readBody(req));
   else if(parts.length===2&&req.method==="GET")data=await cv.get(owner,id);
   else if(parts.length===3&&action==="changes"&&req.method==="GET")data=await cv.changes(owner,id,Number(url.searchParams.get("after")||0));
   else if(parts.length===3&&action==="events"&&req.method==="POST")data=await cv.events(owner,id,await readBody(req));
   else if(parts.length===3&&action==="finish"&&req.method==="POST")data=await cv.finish(owner,id,await readBody(req));
   else if(parts.length===5&&action==="feedback"&&last==="generate"&&req.method==="POST")data=await cv.generate(owner,id,eventId,await readBody(req));
   else throw new DomainError("NOT_FOUND","Route not found",404);
  }
  return Response.json({ok:true,data},{headers:responseHeaders});
 }catch(error){return cvError(error);}
}
