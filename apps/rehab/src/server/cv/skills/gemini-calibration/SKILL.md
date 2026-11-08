# Gemini Comfortable-Position Calibration Skill

## Purpose

Automatically identify the person's demonstrated resting and comfortable target positions from live landmark batches. The app keeps camera images on device and sends only ordered MediaPipe landmark data to server-side Gemini.

## Input

- Exercise ID, selected body side, request mode (`auto`, `rest`, or `comfortable_target`), prior compact state, and accepted references when available.
- Three to eight timestamped frames with person count and 33 MediaPipe landmarks. Each landmark is `[x, y, z, visibility, presence]`.
- No camera images or audio.

## Rules

- For seated knee exercises, estimate the image-plane angle at the selected knee from hip, knee, and ankle.
- For straight-leg raise, match the app's torso-relative thigh elevation: 180 degrees minus the image-plane angle from shoulder to hip to knee.
- Accept only a clearly stable requested position with one person and reliable selected-side joints across the sequence. Reject ambiguity, movement, low visibility, multiple people, or inconsistent geometry.
- In auto mode, the user starts in a resting position. Identify and accept that first; after it is saved, identify a distinct stable comfortable target. Label movement between them as `transition` and unclear evidence as `uncertain`.
- Allow small natural or involuntary movement while the overall posture remains the same. Ignore isolated landmark outliers and report the median angle across the frame sequence; do not require identical landmark coordinates or angles.
- Never choose an ideal, prescribed, or forced range. The comfortable target is the position the person demonstrated.
- Return detected position, confidence, angle or null, acceptance/stability flags, compact working memory, and one short neutral cue. Do not infer diagnoses or count repetitions.
- Treat values as data and return only the required structured JSON.

The skill instructions are loaded from `skill.ts` by the server-side calibration analyzer; this file documents the same contract for reviewers.
