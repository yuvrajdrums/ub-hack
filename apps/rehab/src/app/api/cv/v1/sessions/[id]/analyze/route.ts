import { cv } from "@/server/cv/service";
import { cvRespond,readBody } from "@/server/cv/http";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export function POST(req:Request,ctx:{params:Promise<{id:string}>}) {
  return cvRespond(req,async identity=>cv.analyze(identity.subject,(await ctx.params).id,await readBody(req)));
}
