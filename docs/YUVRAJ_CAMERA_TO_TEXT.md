## Summary

The standalone Rehab demo now runs live camera → local pose inference → server-side Gemini landmark analysis → validated text/Gemini wording → saved reports. It does not need Care or Voice. Its exercise references are synthetic demonstrations; camera estimates, simulated traces and patient confirmations retain different evidence labels.

# Run the camera-to-text demo

From the repository root, use Node 22+:

```bash
npm ci
npm run cv:assets
npm run dev:yuvraj
```

Open http://localhost:3002/rehab (http://127.0.0.1:3002/rehab also works). The server binds loopback. Camera access needs localhost or HTTPS. The pinned pose model and runtime files are already bundled; `cv:assets` checks their SHA-256 checksums and package version.

For the integrated three-app gateway, `npm run dev` uses http://localhost:3000/rehab and supplies that exact CV allowed origin. Override `REHAB_DEMO_ALLOWED_ORIGIN` if using a different gateway origin; standalone operation needs no override.

For actual server-side Gemini wording, configure the ignored root `.env.local` before starting:

```dotenv
REHAB_GEMINI_MODE=controlled
PANDA_GEMINI_API_KEY=your_local_key
REHAB_GEMINI_MODEL=gemini-3.6-flash
REHAB_GEMINI_TIMEOUT_MS=5000
```

This build uses the stable `gemini-3.6-flash` model ID. Do not commit credentials, use `NEXT_PUBLIC_` or paste them into logs. Root scripts load `.env.local` for the app; restart after changing it. With mode off or an unavailable provider, immediate deterministic text still works and identifies its actual source.

## Live camera flow

1. Choose the exercise and anatomical working leg.
2. Enable camera and position it side-on. Keep hip, knee and ankle visible; SLR also needs the torso. Only one person should be in view.
3. Once tracking starts, hold your comfortable resting position still. Gemini detects it automatically, then prompts you to move to and hold your comfortable end position. Manual overrides remain under **Manual override**. These are demonstration references, not a prescription.
4. Start the set, move toward the target, hold, and return. Full movements and target-complete repetitions are shown separately.
5. Pause, stop or report discomfort at any time. Missing landmarks or a stalled frame invalidates partial movement and pauses active timing; absent observations do not complete holds.
6. Finish and save. Reports keep evidence, timing, hold outcomes and captured configuration. Retry save after network failure; do not create a new session to retry the old report.

Static quads uses Start guided hold → Confirm this hold and `patient_reported` evidence. The camera never verifies muscle contraction. Combined seated flexion/extension requires its second hold. SLR estimates torso-relative elevation and knee straightness, not lift inches.

## Exercise-specific live tracking

The live detector profile is selected by exercise and anatomical working side. Seated knee extension and seated flexion/extension require only the working hip, knee and ankle; their overlay and continuity checks use that leg, without requiring shoulders, face, arms or the opposite leg. Straight-leg raise additionally requires the working-side shoulder for its torso-relative elevation reference. Guided static quads does not run pose inference to verify a contraction. Changing exercise or side stops the camera and clears calibration before the next profile starts.

MediaPipe itself still estimates 33 full-body landmarks. Its supported options do not include disabling selected body joints; the application selects the relevant measurements and overlay. Confidence thresholds, two-pose ambiguity detection and disabled segmentation masks are centralized in the profile. This does not guarantee that the underlying person detector will work with every tightly cropped leg-only image.

The current live policy uses a **750 ms maximum valid-sample gap**, an EMA factor of **0.65**, a one-sample median window and the existing **200 ms phase dwell**. Calibration, smoothing, counting and the arrival watchdog share that policy. Freshness is measured from frame delivery after inference; observation order uses capture time. Invalid required landmarks still reset immediately, and gaps above 750 ms cannot complete an unseen hold. The strict 250 ms legacy fixture default remains separately testable.

A seated target is a captured comfortable minimum: its accepted extension interval starts six degrees below that reference and ends at the geometric maximum of 180 degrees. Returning to the start interval still completes the movement. A three-degree release hysteresis prevents small target-angle noise from splitting an otherwise continuous hold. The faster live filter avoids hiding a normal return to start. Full movements and repetitions meeting the five-second hold remain separate counts.

The counting guide now shows the exact phase instruction, start/target intervals and selected leg, and explains delayed frames or missing required joints. It also distinguishes a counted movement with a short hold from a movement that met the hold target. Physical phone performance remains a manual test; automated regressions use explicitly synthetic observations.

## Reproducible example and recovery

Open “Try a clearly labeled example trace” and run sample movements. It feeds two deterministic cycles into the same engine: one short hold and one qualifying hold. Save the report and verify `simulated` evidence. It is not a replacement for observing physical-camera performance.

Pending measurements and a frozen Finish request are retained in this browser's local recovery record. After reload, use “Save recovered set”; missing time is marked partial/interrupted rather than fabricated. Reports live in the Rehab app's `.data/rehab-cv.json` by default, or `PANDA_DATA_DIR` when set. A persistent signing secret is generated in the same data directory; preserve it with the demo store to preserve browser identity across restarts.

For a fresh synthetic demonstration, choose a new dedicated absolute `PANDA_DATA_DIR` and restart, then open a fresh browser profile/context. Do not delete teammate or user data to reset the demo.

## Verification

```bash
npm run check
npm run cv:assets
npm run test:browser
npm run build
npm run test:integration
```

`test:browser` uses an installed Chromium/Brave executable on this Windows machine, a virtual camera, mocked wording responses and fresh browser contexts. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` elsewhere or install the Playwright Chromium browser. It does not open a personal browser profile or claim physical-camera QA.

With the standalone server running:

```bash
npm run test:cv:http
node scripts/cv-http-smoke.mjs --live-gemini
```

The first HTTP smoke does not request Gemini. The explicit second command requests one real bounded wording response on synthetic evidence; its output reports actual source/fallback status without displaying a key. Do not claim provider success if it returns a fallback.

## Gemini position calibration

- While the camera tracks and before a set, the page sends eight recent ordered landmark frames (about two seconds) to the authenticated `POST /rehab/api/cv/v1/calibrate` endpoint every 1–2 seconds. Gemini classifies the current pose as rest or comfortable target, using prior compact state and accepted references.
- The separate `apps/rehab/src/server/cv/skills/gemini-calibration/` skill allows small natural movement, estimates a robust median angle across frames, and rejects unclear or low-confidence poses. The browser requires three consecutive accepted, stable, high-confidence phase estimates over about 2.4 seconds and settles the angle from their median; median model confidence must be at least 72%.
- Users start in their comfortable resting position; after Gemini captures it, the page prompts them to move to a comfortable end position. **Manual override** uses the app's current local filtered angle and replaces only that reference. Calibration snapshots are not persisted; only the accepted configuration is included in the session/report.
- Gemini estimates from landmarks, so its numeric angle can differ from manual local geometry. If the references are too close or an estimated position is wrong, recapture manually or retry the Gemini position.

## API and protection

The scoped contract is `rehab-cv/1.0`, under `/rehab/api/cv/v1`. Existing global v2 routes remain unchanged. GET context bootstraps a signed HttpOnly demo cookie and returns a CSRF token. POST requests require the cookie, matching Origin and `x-cv-csrf`. The server owns configuration/target values and validates observed candidates.

Events are admitted in contiguous sequence with stable request IDs. Finish waits through its high-water mark. Feedback changes have a separate cursor so a late wording result remains visible without a new movement event. Gemini runs outside the store lock and can only select a reviewed phrase ID.

A remotely accessible phone demo needs an access-controlled HTTPS entry. Set `REHAB_DEMO_ALLOWED_ORIGIN` to its exact public origin, `PANDA_DEV_ORIGIN` to its hostname, and `REHAB_DEMO_ACCESS_KEY` to a separate access secret. The context endpoint requires `x-cv-demo-access` to bootstrap on a remote host; a public bootstrap form is not included. Configure that access through a controlled entry/proxy before exposing paid endpoints. Local synthetic identity is not clinical account authorization.

TTS/playback remains Ranveer's later integration. Secure voice transport remains Yuvraj's later integration; this build's finish line is validated visible text. Care report consumption/acknowledgement remains a separate adapter milestone.

Synchronous Web inference leaves a bounded 32–100 ms idle interval before scheduling the next pose frame so controls and rendering can run between detections; Stop also cancels this pending callback.
