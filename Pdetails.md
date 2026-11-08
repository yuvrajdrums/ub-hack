## Summary

Build Yuvraj's standalone Rehab camera-to-text demo. Current release work is on branch `yuvraj/cloudflare-public-demo`; the approved implementation spec is `../../outputs/Panda Care/spec.md`. Camera, deterministic exercise evaluation, server-side Gemini text and saved reports are required; Care/Voice are later integrations.

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

## Private phone hosting

- GitHub fork: https://github.com/yuvrajdrums/ub-hack (`main` and `yuvraj/camera-to-text`).
- Deployment profile: `hosting/`; hydrate a separate source checkout with `node scripts/prepare-phone-host.mjs`. See `docs/PHONE_HOSTING.md`.
- D1 replaces local report files; Sites supplies owner-private ChatGPT identity. Generation uses persisted leases across requests. 49 tests, hosted-runtime HTTP checks, real Gemini and virtual-camera model startup passed.

- Live owner-private phone URL: https://panda-care-rehab-yuvraj-20261107.yuvrajmu160398.chatgpt.site/rehab (ChatGPT sign-in required).

## Current model-selector revision

- This isolated change starts from baseline `a6065d749a0d763caa70d462745db166f96e344e`, the same version 1 code restored on the private phone Site. It does not include the counter/tracking-profile rewrite.
- Rehab setup selects Lite (default), Full or Heavy through `apps/rehab/src/features/camera/pose-models.ts`. Lite is bundled; Full/Heavy load versioned Google model files on camera start. Model choice only changes pose weights: exercise geometry, landmark thresholds, frame cadence and repetition rules stay at baseline.
- Changing model closes the camera tracker and clears calibration/measurement state. Selection is locked during sets and disabled for guided static quads.
- Verification: Rehab production build and typecheck passed. The focused virtual-camera browser tests passed with the actual Lite, Full and Heavy weights; each model loaded, then switched off with the camera stopped and calibration cleared. These tests do not establish physical-device rep-count accuracy.
- Local phone Site still points to the restored version 1 until this isolated model-only revision is published.

## Cloudflare public demo deployment

- Current release branch: `yuvraj/cloudflare-public-demo`, based on the model-selector-only branch. Cloudflare Workers serves the full app and API; D1 stores demo reports. The public Worker middleware assigns each browser a signed, HTTP-only visitor identity so D1 records remain isolated by visitor.
- Source branch `yuvraj/cloudflare-public-demo` is pushed to https://github.com/yuvrajdrums/ub-hack; immediate 0.2s timer-start commit `1ce0427` is included.
- `PANDA_CF_PUBLIC_DEMO=true` enables public identity translation in `hosting/worker/index.ts`. It overwrites browser-supplied OpenAI identity headers and uses a 30-day signed visitor cookie; `REHAB_CV_AUTH_SECRET` must be a Worker secret. `nodejs_compat_populate_process_env` exposes configured runtime secrets to the existing server handlers.
- The public page says not to enter personal details; camera frames stay on the device. Gemini/auth credentials are stored as Cloudflare Worker secrets, not in config or source. The dedicated D1 database and migration are deployed.
- Public Worker URL: https://panda-care-rehab-demo.yuvrajmunjal1.workers.dev/rehab
- Deployed to Cloudflare Workers with D1 storage and Worker secrets for Gemini and visitor signing. The public /rehab page, CV context endpoint and empty session report endpoint returned 200; Gemini reports configured, four exercise configs loaded and Lite/Full/Heavy selector is present.
- Verified two independent HTTPS browser sessions each received a different signed Secure visitor cookie and an isolated empty report list. The camera pipeline remains client-side; actual phone movement, rep counting and live Gemini wording still need hands-on validation from Yuvraj's phone.
- Redeployed the current built release on 2026-11-08; Worker version `b8cc5d6e-df74-489d-99ce-2dad9158a14d`. Post-deploy `/rehab` and CV context checks returned 200, and Gemini remains configured.

## Live hold duration overlay

- Added a compact, half-preview-width timer overlay inside the camera stage. It displays the active measured hold, target duration, exercise phase, and progress. Static quad guided holds use the patient-controlled timer; paused or confirmed duration remains visible.
- Camera-tracked holds now show `0.2s` on the first target-range frame and label the 200 ms validation window “Stabilizing target”; the exercise engine still validates the full dwell before confirming the hold.
- The metric row now shows the current phase's target hold, since the live duration is displayed over the preview.
- Typecheck and production builds for Panda, Rehab, and Voice passed. Deployed to Cloudflare Worker version `d2eeab09-5f26-494c-8341-a06ae17e3f75`; `/rehab` and CV context returned 200, and the published JavaScript contains the immediate 0.2s display and “Stabilizing target” state.

## Camera continuity behavior

- A detected camera-view or tracked-person jump shows a one-time advisory: “Tracking view changed. If tracking looks off, stop and restart the camera.” The camera stream, preview, pose frame loop and exercise callbacks continue; continuity changes no longer stop the camera or interrupt the session. Starting again clears the advisory.
