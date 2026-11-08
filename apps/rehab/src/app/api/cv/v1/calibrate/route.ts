import { cv } from "@/server/cv/service";
import { cvRespond,readBody } from "@/server/cv/http";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export function POST(req:Request) {
  return cvRespond(req,async identity=>cv.calibrate(identity.subject,await readBody(req)));
}
