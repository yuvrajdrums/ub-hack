import { cv } from "@/server/cv/service";
import { cvRespond } from "@/server/cv/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export function GET(req:Request,ctx:{params:Promise<{id:string}>}){return cvRespond(req,async identity=>cv.changes(identity.subject,(await ctx.params).id,Number(new URL(req.url).searchParams.get("after")||0)));}
