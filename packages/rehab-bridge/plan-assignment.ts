import type { Plan } from "../contracts/care";
import type {
  CvExerciseId,
  CvPlanExerciseResolution,
} from "../contracts/rehab-cv";

const labels: Record<CvExerciseId, string> = {
  "seated-knee-extension": "Seated knee extension",
  "seated-knee-flexion-extension": "Seated knee flexion and extension",
  "straight-leg-raise": "Straight-leg raise",
  "static-quads": "Guided static quads",
};

function exerciseId(text: string): CvExerciseId | null {
  const value = text.toLowerCase().replace(/[–—]/g, "-");
  if (/\bseated\s+knee\s+flexion\s*(?:and|&|\/|-)\s*extension\b/.test(value))
    return "seated-knee-flexion-extension";
  if (/\bseated\s+knee\s+extension\b/.test(value))
    return "seated-knee-extension";
  if (/\b(?:straight[\s-]+leg\s+raise|slr)\b/.test(value))
    return "straight-leg-raise";
  if (/\b(?:static\s+quads?|quadriceps?\s+sets?|quad\s+sets?)\b/.test(value))
    return "static-quads";
  return null;
}

function sidesIn(text: string, exerciseLine: boolean): Array<"left" | "right"> {
  const sides = new Set<"left" | "right">();
  const explicit = text.matchAll(
    /\b(?:working|affected|operative|target)\s+(?:leg|side)\s*[:=\-]?\s*(left|right)\b/gi,
  );
  for (const match of explicit) sides.add(match[1].toLowerCase() as "left" | "right");
  for (const match of text.matchAll(/\b(left|right)\s+(?:leg|side)\b/gi))
    sides.add(match[1].toLowerCase() as "left" | "right");
  if (exerciseLine)
    for (const match of text.matchAll(/\b(left|right)\b/gi))
      sides.add(match[1].toLowerCase() as "left" | "right");
  return [...sides];
}

type UnavailableReason = Exclude<
  CvPlanExerciseResolution["reason"],
  "assigned"
>;

function unavailable(reason: UnavailableReason): CvPlanExerciseResolution {
  const message = {
    no_approved_plan:
      "Panda needs the current approved plan before opening a guided exercise.",
    no_supported_exercise:
      "There is no supported Rehab exercise with a working side in the approved plan. Please ask your care team to update the plan.",
    multiple_exercises:
      "The approved plan lists more than one Rehab exercise. Please ask your care team to select the exercise for this session.",
    missing_side:
      "The approved plan does not specify which side to track. Please ask your care team to update the plan.",
    conflicting_sides:
      "The approved plan has conflicting working sides for this exercise. Please ask your care team to review it.",
  }[reason];
  return { assignment: null, reason, message };
}

/** Resolve only a single, explicitly named supported exercise from Care's approved plan. */
export function resolvePlanExercise(
  plan: Plan | null | undefined,
): CvPlanExerciseResolution {
  if (!plan || plan.status !== "approved")
    return unavailable("no_approved_plan");

  const sourceLines = plan.instructions.length
    ? plan.instructions.map((instruction) => ({
        text: instruction.text,
        sourceRef: instruction.sourceRef,
      }))
    : plan.sourceText.split(/\r?\n/).map((text, index) => ({
        text,
        sourceRef: `plan:${index + 1}`,
      }));
  const assignedLines = sourceLines.flatMap((line) => {
    if (/\b(?:do\s+not|don't|avoid|not\s+(?:perform|prescribed|assigned)|discontinue(?:d)?)\b/i.test(line.text))
      return [];
    const id = exerciseId(line.text);
    return id ? [{ ...line, exerciseId: id }] : [];
  });
  const exerciseIds = [...new Set(assignedLines.map((line) => line.exerciseId))];
  if (!exerciseIds.length) return unavailable("no_supported_exercise");
  if (exerciseIds.length !== 1) return unavailable("multiple_exercises");

  const selectedExercise = exerciseIds[0];
  const sides = new Set<"left" | "right">();
  for (const line of sourceLines) {
    const isSelectedExercise =
      !/\b(?:do\s+not|don't|avoid|not\s+(?:perform|prescribed|assigned)|discontinue(?:d)?)\b/i.test(line.text) &&
      exerciseId(line.text) === selectedExercise;
    const explicitSideLine =
      /\b(?:working|affected|operative|target)\s+(?:leg|side)\s*[:=\-]?\s*(?:left|right)\b/i.test(
        line.text,
      );
    if (!isSelectedExercise && !explicitSideLine) continue;
    for (const side of sidesIn(line.text, isSelectedExercise)) sides.add(side);
  }
  if (!sides.size) return unavailable("missing_side");
  if (sides.size !== 1) return unavailable("conflicting_sides");

  const source = assignedLines.find((line) => line.exerciseId === selectedExercise)!;
  const side = [...sides][0];
  return {
    assignment: {
      exerciseId: selectedExercise,
      label: labels[selectedExercise],
      side,
      sourceRef: source.sourceRef,
      planId: plan.id,
      planVersion: plan.version,
    },
    reason: "assigned",
    message: "",
  };
}
