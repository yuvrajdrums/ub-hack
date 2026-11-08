import type { ExerciseId } from "../exercise/engine";
import type { PoseLandmark, Side } from "../exercise/geometry";

export interface TrackingProfile {
  requiredJoints: number[];
  connections: [number, number][];
  requireTorso: boolean;
  requiresPose: boolean;
  framingInstruction: string;
  minimumVisibility: number;
  minimumPresence: number;
  modelOptions: {
    numPoses: 2;
    minPoseDetectionConfidence: 0.6;
    minPosePresenceConfidence: 0.6;
    minTrackingConfidence: 0.6;
    outputSegmentationMasks: false;
  };
}

/** Selects measurement and overlay joints; the native model still predicts 33 landmarks. */
export function exerciseTrackingProfile(exerciseId: ExerciseId, side: Side): TrackingProfile {
  const offset = side === "left" ? 0 : 1;
  const shoulder = 11 + offset, hip = 23 + offset, knee = 25 + offset, ankle = 27 + offset;
  const requiresPose = exerciseId !== "static-quads";
  const requireTorso = exerciseId === "straight-leg-raise";
  const requiredJoints = requiresPose ? [hip, knee, ankle, ...(requireTorso ? [shoulder] : [])] : [];
  const connections: [number, number][] = requiresPose
    ? [...(requireTorso ? [[shoulder, hip] as [number, number]] : []), [hip, knee], [knee, ankle]]
    : [];
  return {
    requiredJoints,
    connections,
    requireTorso,
    requiresPose,
    framingInstruction: !requiresPose
      ? "This exercise uses a guided timer and your confirmation. No camera tracking is required."
      : requireTorso
        ? `Use a side view that includes your ${side} shoulder, hip, knee and ankle so the leg raise can be measured relative to your torso.`
        : `Use a side view with your ${side} hip, knee and ankle visible. Your upper body and opposite leg are not required for this exercise.`,
    minimumVisibility: 0.6,
    minimumPresence: 0.6,
    modelOptions: {
      numPoses: 2,
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      outputSegmentationMasks: false,
    },
  };
}

/** Continuity uses only the selected hip/knee, in normalized image units, not metric body size. */
export function continuityAnchor(
  landmarks: readonly (PoseLandmark | undefined)[],
  profile: TrackingProfile,
): { x: number; y: number; scale: number } | null {
  if (!profile.requiresPose) return null;
  const hipIndex = profile.requiredJoints.find(index => index === 23 || index === 24);
  const kneeIndex = profile.requiredJoints.find(index => index === 25 || index === 26);
  if (hipIndex === undefined || kneeIndex === undefined) return null;
  const hip = landmarks[hipIndex], knee = landmarks[kneeIndex];
  const usable = (point: PoseLandmark | undefined): point is PoseLandmark => !!point &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 &&
    Number.isFinite(point.visibility) && point.visibility! >= profile.minimumVisibility &&
    (point.presence === undefined ||
      (Number.isFinite(point.presence) && point.presence >= profile.minimumPresence));
  if (!usable(hip) || !usable(knee)) return null;
  const scale = Math.hypot(hip.x - knee.x, hip.y - knee.y);
  if (!Number.isFinite(scale) || scale <= 1e-8) return null;
  return { x: hip.x, y: hip.y, scale };
}
