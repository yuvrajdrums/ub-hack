## Summary

The standalone Rehab demo now runs live camera → local pose inference → deterministic exercise evaluation → validated text/Gemini wording → saved reports. It does not need Care or Voice. Its exercise references are synthetic demonstrations; camera estimates, simulated traces and patient confirmations retain different evidence labels.

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
REHAB_GEMINI_API_KEY=your_local_key
REHAB_GEMINI_MODEL=an_account_available_text_model
REHAB_GEMINI_TIMEOUT_MS=2000
```

This build verified `gemini-3.5-flash-lite` using the user's existing environment credential. Do not commit credentials, use `NEXT_PUBLIC_` or paste them into logs. Root scripts load `.env.local` for the app; restart after changing it. With mode off or an unavailable provider, immediate deterministic text still works and identifies its actual source.

## Live camera flow

1. Choose the exercise and anatomical working leg.
2. Enable camera and position it side-on. Keep hip, knee and ankle visible; SLR also needs the torso. Only one person should be in view.
3. Keep the start position stable for one second and capture it. Capture a separate comfortable target position. These are demonstration references, not a prescription.
4. Start the set, move toward the target, hold, and return. Full movements and target-complete repetitions are shown separately.
5. Pause, stop or report discomfort at any time. Missing landmarks or a stalled frame invalidates partial movement and pauses active timing; absent observations do not complete holds.
6. Finish and save. Reports keep evidence, timing, hold outcomes and captured configuration. Retry save after network failure; do not create a new session to retry the old report.

Static quads uses Start guided hold → Confirm this hold and `patient_reported` evidence. The camera never verifies muscle contraction. Combined seated flexion/extension requires its second hold. SLR estimates torso-relative elevation and knee straightness, not lift inches.

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

## API and protection

The scoped contract is `rehab-cv/1.0`, under `/rehab/api/cv/v1`. Existing global v2 routes remain unchanged. GET context bootstraps a signed HttpOnly demo cookie and returns a CSRF token. POST requests require the cookie, matching Origin and `x-cv-csrf`. The server owns configuration/target values and validates observed candidates.

Events are admitted in contiguous sequence with stable request IDs. Finish waits through its high-water mark. Feedback changes have a separate cursor so a late wording result remains visible without a new movement event. Gemini runs outside the store lock and can only select a reviewed phrase ID.

A remotely accessible phone demo needs an access-controlled HTTPS entry. Set `REHAB_DEMO_ALLOWED_ORIGIN` to its exact public origin, `PANDA_DEV_ORIGIN` to its hostname, and `REHAB_DEMO_ACCESS_KEY` to a separate access secret. The context endpoint requires `x-cv-demo-access` to bootstrap on a remote host; a public bootstrap form is not included. Configure that access through a controlled entry/proxy before exposing paid endpoints. Local synthetic identity is not clinical account authorization.

TTS/playback remains Ranveer's later integration. Secure voice transport remains Yuvraj's later integration; this build's finish line is validated visible text. Care report consumption/acknowledgement remains a separate adapter milestone.
