import handler from "vinext/server/fetch-handler";
import { createHmac,randomUUID,timingSafeEqual } from "node:crypto";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const VISITOR_COOKIE="panda_rehab_demo_visitor";
const VISITOR_TTL_SECONDS=30*24*60*60;
type PublicDemoEnv={PANDA_CF_PUBLIC_DEMO?:string;REHAB_CV_AUTH_SECRET?:string};

function equal(a:string,b:string){const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function sign(payload:string,secret:string){return createHmac("sha256",secret).update(payload).digest("base64url");}
function visitor(request:Request,secret:string){
  const existing=request.headers.get("cookie")?.split(";").map(part=>part.trim()).find(part=>part.startsWith(`${VISITOR_COOKIE}=`))?.slice(VISITOR_COOKIE.length+1);
  if(existing&&existing.length<512){
    const [payload,signature,...extra]=existing.split(".");
    if(payload&&signature&&!extra.length&&equal(signature,sign(payload,secret))){
      try{
        const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as {sub?:unknown;exp?:unknown};
        if(typeof data.sub==="string"&&/^[0-9a-f-]{36}$/i.test(data.sub)&&typeof data.exp==="number"&&data.exp>Date.now()&&data.exp<Date.now()+31*24*60*60*1000)return {subject:data.sub,setCookie:null as string|null};
      }catch{/* Invalid visitor cookie: start a fresh anonymous demo session. */}
    }
  }
  const subject=randomUUID();
  const payload=Buffer.from(JSON.stringify({sub:subject,exp:Date.now()+VISITOR_TTL_SECONDS*1000})).toString("base64url");
  const token=`${payload}.${sign(payload,secret)}`;
  return {subject,setCookie:`${VISITOR_COOKIE}=${token}; Path=/; Max-Age=${VISITOR_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`};
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env & PublicDemoEnv, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let visitorCookie:string|null=null;
    if(env.PANDA_CF_PUBLIC_DEMO==="true"){
      const secret=env.REHAB_CV_AUTH_SECRET;
      if(!secret)return Response.json({ok:false,error:{code:"CONFIGURATION_REQUIRED",message:"Demo identity configuration is unavailable"}},{status:503,headers:{"Cache-Control":"no-store"}});
      const identity=visitor(request,secret);
      visitorCookie=identity.setCookie;
      const headers=new Headers(request.headers);
      // The browser cannot supply its own identity; bind each anonymous visitor to
      // a signed, HTTP-only cookie so D1 reports remain separate between visitors.
      headers.set("oai-authenticated-user-id",`panda-public:${identity.subject}`);
      headers.set("oai-authenticated-user-email",`visitor-${identity.subject}@demo.invalid`);
      headers.set("oai-authenticated-user-full-name",encodeURIComponent("Demo visitor"));
      headers.set("oai-authenticated-user-full-name-encoding","percent-encoded-utf-8");
      request=new Request(request,{headers});
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    const response=await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    if(!visitorCookie)return response;
    const headers=new Headers(response.headers);headers.append("Set-Cookie",visitorCookie);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  },
};

export default worker;
