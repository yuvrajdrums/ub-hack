import { cv } from "@/server/cv/service";
import { cvRespond,readBody } from "@/server/cv/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export function GET(req:Request){return cvRespond(req,identity=>cv.reports(identity.subject));}
export function POST(req:Request){return cvRespond(req,async identity=>cv.start(identity.subject,await readBody(req)));}
