import { redirect } from "next/navigation";
import { PATIENT_ROUTES } from "../../../../packages/ui/patient-navigation";

// Standalone service URLs must not expose a second, voice-less patient screen.
export default function RehabEntry() {
  const origin = process.env.PANDA_PUBLIC_ORIGIN || `http://localhost:${process.env.PANDA_PORT || "3000"}`;
  redirect(new URL(PATIENT_ROUTES.exercise, origin).toString());
}
