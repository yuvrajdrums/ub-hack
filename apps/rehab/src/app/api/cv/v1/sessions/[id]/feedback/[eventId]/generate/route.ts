import { cv } from "@/server/cv/service";
import { cvRespond,readBody } from "@/server/cv/http";
export const runtime="nodejs";
export function POST(req:Request,ctx:{params:Promise<{id:string;eventId:string}>}){return cvRespond(req,async identity=>{const p=await ctx.params;return cv.generate(identity.subject,p.id,p.eventId,await readBody(req));});}
