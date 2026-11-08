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
- Verified: 68 unit/domain tests, seven browser scenarios, all three production builds, 16 production gateway integration checks and all three standalone starts. Real Gemini wording succeeded on synthetic evidence using the existing local environment credential. No credential appeared in browser assets.
- Browser tests exercise the real bundled pose model on a virtual camera; movement traces are explicitly simulated. Physical laptop/phone exercise observations remain manual validation, and no clinical accuracy is claimed.
- Key local setting is configured in ignored root `.env.local`; never print or commit it. Existing v2 APIs stay separate from CV report storage. Ranveer TTS/playback and Care acknowledgement remain later integrations.

## Private phone hosting

- GitHub fork: https://github.com/yuvrajdrums/ub-hack (`main` and `yuvraj/camera-to-text`).
- Deployment profile: `hosting/`; hydrate a separate source checkout with `node scripts/prepare-phone-host.mjs`. See `docs/PHONE_HOSTING.md`.
- D1 replaces local report files; Sites supplies owner-private ChatGPT identity. Generation uses persisted leases across requests. 49 tests, hosted-runtime HTTP checks, real Gemini and virtual-camera model startup passed.

- Live owner-private phone URL: https://panda-care-rehab-yuvraj-20261107.yuvrajmu160398.chatgpt.site/rehab (ChatGPT sign-in required).

## Live counter and tracking profiles

- Reproduced zero-count failures at 300–500 ms valid cadence and from excessive filter lag. Live policy is centralized in features/exercise/live.ts: 750 ms gaps, arrival freshness, EMA 0.65/window 1, target-release hysteresis. Seated extension accepts reaching or exceeding the comfortable target up to geometric 180°.
- Exercise/side profiles in features/camera/tracking-profile.ts drive required joints, overlay, continuity and model options. Seated exercises use selected hip/knee/ankle only; SLR adds selected shoulder; guided quads needs no pose. Changing the selection stops and recalibrates the camera.
- UI gives phase-specific counting guidance and explicit gate failures. Regression traces are synthetic; do not claim physical-device validation.
