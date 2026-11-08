## Current build update

The camera-to-text feature is now implemented under `/rehab/api/cv/v1` without a Care/Voice runtime dependency. Read `YUVRAJ_CAMERA_TO_TEXT.md` for the current runbook and tests. The revision-4 baseline guide below remains useful for domain boundaries but its statements about missing pose inference are historical. Secure voice transport remains Yuvraj's later integration; TTS/playback remains Ranveer's.

# Yuvraj — Rehab / computer vision web app guide, revision 4

You own `apps/rehab`, the complete exercise/vision function served at `/rehab`. You build its camera screen, model/inference, calibration, rep logic, session API, persistence, reports/history, errors and tests. You also own later wearable/sensor extensions. **Ranveer owns voice. Asmita owns care plans and clinician acknowledgement.**

## 1. Scope — one complete app

| You own | You consume |
| --- | --- |
| Camera permissions/preview/lifecycle, pose model/assets, landmarks and tracking states | Asmita's approved care plan/version and later explicit exercise assignments |
| One calibrated movement, geometry, smoothing, confidence, rep counter and cues | Ranveer's gateway/identity infrastructure and Asmita's shared design tokens |
| Start/finish session APIs, measurement validation and durable report/history | Asmita's help and acknowledgement APIs; you don't create another clinical inbox |
| Report producer UI/API and your own feature tests | Ranveer's voice navigation; no second voice agent in Rehab |

Owned paths: `apps/rehab/**`, `packages/contracts/rehab.ts`, `tests/rehab*`; place model/WASM assets under `apps/rehab/public/models` and `public/mediapipe` when adding them. Ranveer serializes root dependency/lock edits. Asmita consumes reports over HTTP; she does not implement your session backend.

## 2. Start in your own editor

Join the shared Classroom team and clone its existing repo.

```bash
git clone <SHARED_CLASSROOM_REPO_URL> panda-care
cd panda-care
npm ci
cp .env.example .env.local
git switch -c yuvraj/vision
npm run dev:yuvraj
```

Open http://localhost:3002/rehab. Only your app runs. It uses an explicit approved-plan fixture and saves its own local sessions/reports; no teammate is needed. For connected tests, stop it and run `npm run dev`; enter http://localhost:3000/rehab. Cross-app links are designed for this single shared gateway.

Read `docs/OWNERSHIP.md`, `SHARED_CONTRACT.md`, `API_STATUS.md`, `BUILD_ORDER.md`. Use contract v2.0.0, not previous single-app props/widget contracts. No cross-app React imports: integrate with routes and HTTP.

## 3. Starter status and your priority

Camera preview/cleanup, context fetch, start/finish APIs, captured plan references, immutable local saved reports/history and Care report consumption/acknowledgement work. **There is no pose inference or measured rep counting yet.** The three-rep button creates an explicit simulated report. Don't claim it is camera measured or submit it as your physical-AI achievement.

The Radial brief permits a phone/laptop camera and public AI models. Your model must perform a useful interpretation: movement landmarks/confidence → estimated rep or pause → saved report. You don't need custom hardware. This is the core unfinished demo task, ahead of wearables or extra exercises.

## 4. Exact build sequence

1. Separate the current page into `src/features/camera`, `pose`, `exercise`, `reports` modules; keep public routes/contracts stable. Confirm start/stop/unmount/hidden-tab cleanup before model work.
2. Add one pinned `@mediapipe/tasks-vision` version with Ranveer's coordinated root lock change. Pin the matching WASM and Pose Landmarker model assets; document origin, version and licence. Serve assets from your `/rehab` base path, not a broken `/models` root URL. Avoid unpinned `latest` CDNs.
3. Dynamically import browser-only model code. Use VIDEO mode, one inference per new video frame and strictly increasing timestamps. Load/error states are explicit. Start at bounded 10–15 FPS, measure actual phone performance, and use a compatible CPU fallback if needed.
4. Show live landmarks and calibrated tracking state. Choose **one demonstration movement**, e.g. elbow flexion. This is not a prescribed clinical exercise; thresholds are demonstration parameters until reviewed by a qualified professional.
5. Write pure geometry and counter functions. Joint angle ABC = acos(clamped dot(BA,BC)/(normBA*normBC)); reject zero vectors. Pixel/pose angles are estimates sensitive to viewpoint. Prefer appropriate calibrated/world coordinates; don't call a 2D angle clinical range of motion.
6. Use a hysteresis/dwell state machine: extended → flexed → extended counts one. Smoothing/jitter must not create phantom cycles. Low confidence/out-of-frame pauses counting and resets a partial cycle; completed reps remain. Recalibrate before resuming.
7. Wire the actual measurement state into your existing session lifecycle. Only a real tracking pipeline may use camera-estimated progress. Unavailable tracking saves zero/null, and simulation remains separately labelled. Remove simulation from the main live-demo action once real tracking is ready, but keep deterministic fixtures for tests.
8. Save one immutable summary with captured plan/version, times, repetitions, nullable estimated angle/range, quality, evidence and termination reason. A cancelled or crashed session is not a successful completed workout. Persist once and retry the same ID/payload if response is lost.
9. Build clear report/history UI and API. Asmita reads your finished-report list and stores acknowledgement references. Verify the same report ID reaches her clinician browser; she doesn't get a copied report database.
10. Run actual phone/desktop, permission denial, background/orientation, tracking-loss and pause tests. Document observations rather than claiming device QA from a TypeScript build.

Suggested files: `src/features/vision/model.ts`, `camera.ts`, `geometry.ts`, `calibration.ts`, `rep-counter.ts`, `cue-policy.ts`, `src/features/reports/*`; `src/server/service.ts` remains the session-domain entry point. You own their backend/persistence too.

## 5. Camera and model specifics

Request camera only on user tap, with `audio:false`, front-facing preference and reasonable resolution. Use muted autoplay `playsInline`; wait for video readiness. Handle unsupported API, HTTPS requirement, denial, busy camera and model download failure. Stop tracks, inference callbacks/workers, event listeners and the model on exit; don't retain a camera from an abandoned permission request.

Keep raw frames on device by default. No video upload is needed for the MVP. Use confidence on all required joints and a clear positioning cue. Do not infer pain, clinical correctness, diagnosis, treatment efficacy or fall prevention from landmarks. Discomfort is reported by the patient and must stop/pause activity before a human-help handoff.

Ranveer owns voice/audio. MVP hard-navigation into Rehab stops his voice; your exercise UI uses text/visual cues. Don't independently add an agent or assume cross-app React callbacks exist. Continuous voice during exercise needs a new reviewed bridge owned by Ranveer; it is outside this MVP.

## 6. API/data contract

| Your API | Behavior |
| --- | --- |
| GET `/rehab/api/context` | Fetch A's approved context (fixture in solo mode) |
| POST `/rehab/api/sessions` | `{requestId,planId,planVersion,exerciseId:'demo-elbow'}`; reject stale/unapproved plans |
| POST `/rehab/api/sessions/:id/finish` | `{requestId,report}`; validate immutable session context and evidence; save once |
| GET `/rehab/api/sessions` | Finished reports, including interrupted/unmeasured summaries; no unfinished fake success |

The demonstration movement is currently available for every approved demo plan. For clinical use, Asmita supplies explicit reviewed assignments/configs and your start API enforces them. Never let an LLM invent exercise thresholds.

A report captures session ID, patient ID, plan ID/version, exercise ID, start/end, repetitions, nullable range, tracking quality, evidence and reason. Unavailable tracking cannot claim measured progress. Simulated evidence and simulated quality must match. A newer care plan never rewrites older reports.

Use a `rehab.*` schema when replacing JSON, with your own repository/migrations/authorization. Do not write Asmita's tasks or acknowledgements. Saving a report does not auto-complete a task in this MVP; an eventual integration needs a distinct evidence-aware completion contract. A's self-report endpoint only accepts patient-reported evidence.

For discomfort, stop/pause locally first, then create one help request through A's API with a stable ID and the patient's words. Don't claim a successful clinician contact if the request fails. Reconcile uncertain writes before creating a second alert.

## 7. Required tests and handoffs

- Known landmark sequence of 3 full cycles → exactly 3 reps.
- Stationary limb, jitter, repeated frames and partial cycles → no phantom reps.
- Lost confidence freezes counting, resets partial cycle and requires recalibration.
- Pause/background/orientation handling does not keep counting or leaking camera.
- Unknown/stale plan rejected at start; finished report retains original context.
- Double finish/retry saves once; mismatch patient/plan/timestamp is rejected.
- No-camera/model-failure state remains usable; unavailable tracking has zero/null measurements.
- Asmita sees your real saved report and acknowledges that session ID.

Give Asmita an actual report payload/session ID and a clear quality/evidence explanation. Give Ranveer the `/rehab` launch path and any future control proposal; don't ask him to write your API. All consumers use the v2 schema, not a custom incompatible copy.

Branch `yuvraj/vision`. Merge camera/model early, then counter and real measured save. Run root check/build/integration before merges. Actual live-camera evidence is separate from synthetic unit tests. Root SDK additions are coordinated to avoid lockfile conflicts.

## 8. Later extensions

You own wearables/sensors as a complete future function: connection/authorization UI, one supported provider/device, normalized measurements, provenance, storage/history, revocation and tests. Browser HealthKit access is not assumed. Do this after the live camera/AI/report/acknowledgement loop works.

The Radial guide requires disclosing prior components, public models and synthetic/mock data. Document the pretrained model, what you coded and what was genuinely measured. A simulated numeric report is not a physics simulation or a trained physical inference model.

## Editor prompt

You are Yuvraj's coding agent in Panda Care v0.2. Read docs/YUVRAJ.md, OWNERSHIP.md, SHARED_CONTRACT.md and API_STATUS.md. Own the full Rehab web app: camera/model/landmarks, calibration/confidence/rep counting, session API/storage, immutable reports/history, evidence labels and tests. Start from the existing preview/session scaffold; implement one real demonstration movement with a pinned public pose model. Consume Asmita's approved-plan and help APIs, expose reports for her acknowledgement, and use Ranveer's gateway/identity setup. Ranveer owns all voice; don't add a separate agent. Preserve v2 contracts, stable retries and honest measurement limits. Ship the actual camera-AI loop before wearables or extra exercises.
