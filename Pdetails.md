## Summary

Build Yuvraj's standalone Rehab camera-to-text demo. Current work is on branch `yuvraj/camera-to-text`; the approved implementation spec is `../../outputs/Panda Care/spec.md`. Camera, server-side Gemini landmark rep estimates and natural-language feedback, and saved reports are required; Care/Voice are later integrations.

- Baseline commit: `ce405fd027e6d8b1d872d00501353c1c21a2a456`.
- Existing v2 routes/contracts remain operational. New scoped contracts live in `packages/contracts/rehab-cv.ts`, with routes `/rehab/api/cv/v1/*`.
- Engine: `apps/rehab/src/features/exercise/`; server: `apps/rehab/src/server/cv/`; browser camera/pose/feedback/report modules and Rehab page are feature-owned.
- Demo config is synthetic; actual camera evidence is `camera_estimated`, traces are `simulated`, static-quads completion is `patient_reported`.
- Raw camera frames stay on device. For camera-counted sets, batches of 33 MediaPipe landmarks with timestamps/confidence are sent to server-side Gemini every 1–2 seconds; raw landmarks are transient and not persisted. Gemini keys are server-only; rep output is schema-validated and labeled estimated.
- Preserve measurement sequence versus feedback-change cursor separation and flush through the final sequence before immutable report finalization.
- Root owns dependency/asset setup, integration, review and checkpoints. Sub-agents own disjoint engine, server/contracts and camera/UI files.
- User explicitly authorized implementation, sub-agents and checkpoints every two minutes. Recovery snapshots are outside the checkout under `../../work/checkpoints/` while work is active; meaningful verified milestones are local Git commits.
- Run `npm run check`, `npm run build`, `npm run test:integration`, scoped CV tests and browser verification. Actual camera/mobile/Gemini results must be distinguished from synthetic/mocked tests.

## Current implementation and verification

- Camera/model loading, live overlay, Gemini-assisted rest/comfortable-target angle capture with independent manual override, four exercise protocols, immediate/validated text, server-side Gemini, ordered event recovery, Finish barrier and immutable report/history are implemented. Camera rep counts come from Gemini's incremental landmark analysis; the deterministic evaluator remains for the explicitly simulated trace and patient-confirmed static-quads flow only. Standalone navigation stays inside Rehab.
- Commands: `npm run dev:yuvraj`, `npm run cv:assets`, `npm run test:cv`, `npm run test:browser`, `npm run test:cv:http`. Runbook: `docs/YUVRAJ_CAMERA_TO_TEXT.md`.
- Verified: 48 unit/domain tests, six browser scenarios, all three production builds, 16 production gateway integration checks and all three standalone starts. Real Gemini wording succeeded on synthetic evidence using the existing local environment credential. No credential appeared in browser assets.
- Browser tests exercise the real bundled pose model on a virtual camera; movement traces are explicitly simulated. Physical laptop/phone exercise observations remain manual validation, and no clinical accuracy is claimed.
- Gemini uses the server-only `PANDA_GEMINI_API_KEY`; Rehab requests use `REHAB_GEMINI_MODEL=gemini-3.6-flash` with minimal/low thinking budgets for short structured responses. Local settings stay in ignored root `.env.local`; never print or commit credentials. A direct structured request returned `modelVersion=gemini-3.6-flash`; a later local calibration attempt received HTTP 429 from Gemini quota. Existing v2 APIs stay separate from CV report storage. Ranveer TTS/playback and Care acknowledgement remain later integrations.

## Private phone hosting

- GitHub fork: https://github.com/yuvrajdrums/ub-hack (`main` and `yuvraj/camera-to-text`).
- Deployment profile: `hosting/`; hydrate a separate source checkout with `node scripts/prepare-phone-host.mjs`. See `docs/PHONE_HOSTING.md`.
- The source preparation script also syncs `apps/rehab/src/server/cv/skills/`; this is required by the Gemini-backed calibration and rep-analysis server modules. The private-site bundle built successfully from the prepared checkout.
- D1 replaces local report files; Sites supplies owner-private ChatGPT identity. Generation uses persisted leases across requests. 49 tests, hosted-runtime HTTP checks, real Gemini and virtual-camera model startup passed.

- Live owner-private phone URL: https://panda-care-rehab-yuvraj-20261107.yuvrajmu160398.chatgpt.site/rehab (ChatGPT sign-in required).

## Live counter and tracking profiles

- Reproduced zero-count failures at 300–500 ms valid cadence and from excessive filter lag. Live policy is centralized in features/exercise/live.ts: 750 ms gaps, arrival freshness, EMA 0.65/window 1, target-release hysteresis. Seated extension accepts reaching or exceeding the comfortable target up to geometric 180°.
- Exercise/side profiles in features/camera/tracking-profile.ts drive required joints, overlay, continuity and model options. Seated exercises use selected hip/knee/ankle only; SLR adds selected shoulder; guided quads needs no pose. Changing the selection stops and recalibrates the camera.
- UI gives phase-specific counting guidance and explicit gate failures. Regression traces are synthetic; do not claim physical-device validation.

## Selectable pose models

- Setup now offers Lite (default), Full and Heavy. Registry: apps/rehab/src/features/camera/pose-models.ts. Full/Heavy download versioned float16/1 files from Google on camera enable; inference remains local. Model changes stop the old camera and clear calibration; selection is locked during a set.
- See docs/POSE_MODEL_SELECTION.md. The targeted browser check passed with all three real models on a virtual camera; set CV_TEST_ALL_POSE_MODELS=1 to opt into Full/Heavy network checks. This side-chat change was not committed, synced to the hosting checkout or deployed.

## Gemini landmark rep analysis

- The `apps/rehab/src/server/cv/skills/gemini-rep-analysis/` subfolder contains the Gemini analysis skill and active prompt. The authenticated `/sessions/[id]/analyze` endpoint receives compact raw landmark batches, forwards them to Gemini with prior cumulative state and captured angle references, validates the structured result, and persists counts/state only (never raw frames).
- Browser camera images remain local. Live set start requires controlled Gemini configuration. Gemini response delay can make counts lag by several seconds; failed analysis preserves the last accepted counts instead of using deterministic camera-count fallback.
- Capture buttons record the current filtered angle when pressed at rest and full comfortable extension. Camera rep counts are estimates and have not been clinically validated.
- Before a set, the authenticated `POST /api/cv/v1/calibrate` endpoint receives eight fresh frames (about two seconds) every 1–2 seconds. The separate `skills/gemini-calibration/` skill classifies rest/comfortable-target poses, tolerates small natural movement, and maintains compact state; automatic capture requires three consecutive accepted, stable, high-confidence estimates over about 2.4 seconds and uses their median angle/confidence. UI prompts the user to start at rest and then move to a comfortable end position. Manual current-angle overrides are in a collapsed setup section. Calibration frames are transient; chosen references become session configuration when the set begins.
- The Google structured response schema uses a nullable numeric field for `angleDeg`; the local synthetic calibration request returned a valid Gemini result after correcting this schema. Physical-camera behavior still requires in-browser validation.
