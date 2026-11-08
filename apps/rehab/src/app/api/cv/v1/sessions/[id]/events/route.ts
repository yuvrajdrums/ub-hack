import { cv } from "@/server/cv/service";
import { cvRespond,readBody } from "@/server/cv/http";
export const runtime="nodejs";
export function POST(req:Request,ctx:{params:Promise<{id:string}>}){return cvRespond(req,async identity=>cv.events(identity.subject,(await ctx.params).id,await readBody(req)));}
