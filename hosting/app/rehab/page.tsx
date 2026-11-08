import Rehab from "../../shared/apps/rehab/src/app/page";
import { requireChatGPTUser } from "../chatgpt-auth";
export const dynamic="force-dynamic";
export default async function Page(){await requireChatGPTUser("/rehab");return <Rehab/>;}
