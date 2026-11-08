export type PoseModelId = "lite" | "full" | "heavy";

export const POSE_MODELS = [
  {
    id: "lite", label: "Lite", assetPath: "/rehab/models/pose_landmarker_lite.task",
    description: "Default model. Bundled with the app for a smaller download.",
  },
  {
    id: "full", label: "Full",
    assetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    description: "Larger model. Downloads from Google when you enable the camera.",
  },
  {
    id: "heavy", label: "Heavy",
    assetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
    description: "Largest model. Downloads from Google and may run more slowly on a phone.",
  },
] as const;

export function poseModelFor(id:PoseModelId) {
  return POSE_MODELS.find(model=>model.id===id) ?? POSE_MODELS[0];
}
