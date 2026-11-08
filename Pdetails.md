## Summary

Build Yuvraj's standalone Rehab camera-to-text demo. Current work is on branch `yuvraj/camera-to-text`; the approved implementation spec is `../../outputs/Panda Care/spec.md`. Camera, deterministic exercise evaluation, server-side Gemini text and saved reports are required; Care/Voice are later integrations.

- Baseline commit: `ce405fd027e6d8b1d872d00501353c1c21a2a456`.
- Existing v2 routes/contracts remain operational. New scoped contracts live in `packages/contracts/rehab-cv.ts`, with routes `/rehab/api/cv/v1/*`.
- Engine: `apps/rehab/src/features/exercise/`; server: `apps/rehab/src/server/cv/`; browser camera/pose/feedback/report modules and Rehab page are feature-owned.
- Demo config is synthetic; actual camera evidence is `camera_estimated`, traces are `simulated`, static-quads completion is `patient_reported`.
- Raw camera frames stay on device. Gemini keys are server-only; final text must be validated approved phrasing, with truthful fallback/source labels.
- Preserve measurement sequence versus feedback-change cursor separation and flush through the final sequence before immutable report finalization.
- Root owns dependency/asset setup, integration, review and checkpoints. Sub-agents own disjoint engine, server/contracts and camera/UI files.
- User explicitly authorized implementation, sub-agents and checkpoints every two minutes. Recovery snapshots are outside the checkout under `../../work/checkpoints/` while work is active; meaningful verified milestones are local Git commits.
- Run `npm run check`, `npm run build`, `npm run test:integration`, scoped CV tests and browser verification. Actual camera/mobile/Gemini results must be distinguished from synthetic/mocked tests.

## Current implementation and verification

- Camera/model loading, live overlay, stable calibration, four exercise protocols, immediate/validated text, server-side Gemini, ordered event recovery, Finish barrier and immutable report/history are implemented. Standalone navigation stays inside Rehab.
- Commands: `npm run dev:yuvraj`, `npm run cv:assets`, `npm run test:cv`, `npm run test:browser`, `npm run test:cv:http`. Runbook: `docs/YUVRAJ_CAMERA_TO_TEXT.md`.
- Verified: 48 unit/domain tests, six browser scenarios, all three production builds, 16 production gateway integration checks and all three standalone starts. Real Gemini wording succeeded on synthetic evidence using the existing local environment credential. No credential appeared in browser assets.
- Browser tests exercise the real bundled pose model on a virtual camera; movement traces are explicitly simulated. Physical laptop/phone exercise observations remain manual validation, and no clinical accuracy is claimed.
- Key local setting is configured in ignored root `.env.local`; never print or commit it. Existing v2 APIs stay separate from CV report storage. Ranveer TTS/playback and Care acknowledgement remain later integrations.
