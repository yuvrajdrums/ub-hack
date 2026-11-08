# Rehab Module

## Summary

Rehab owns the guided exercise camera flow, pose tracking, calibration, repetition estimates, session history, and canonical exercise reports. In the connected Panda experience, Care supplies the approved exercise and side; Panda owns the conversation and voice playback. Rehab sends validated session events and report references back through the typed bridge.

## Ownership and boundaries

- **Care** owns the approved patient plan, exercise assignment, working side, and clinical checklist. Rehab reads the current assignment; it does not ask the patient to select or change it.
- **Rehab (Yuvraj)** owns camera access, pose inference, calibration, movement evaluation, exercise session lifecycle, and canonical reports.
- **Panda (Ranveer)** owns text/voice conversation, speech recognition and playback, and the patient's post-exercise review.
- **Rehab reports** are the source of exercise measurements. Panda and Care consume those reports by session/reference ID; they do not maintain editable copies of the report.

The exercise references and pose-based values are demonstration estimates. They are not a clinical assessment or a validated prescription. The local Care fixture is synthetic and must not be treated as patient data.

## Patient flow

1. Panda opens `/exercise` after the patient reaches the exercise step or explicitly requests exercise. Care launches `/exercise?from=care`, so Exit returns to Care. Legacy `/rehab` redirects to `/exercise`; owner APIs and model assets stay under `/rehab/`.
2. Rehab loads the current approved Care assignment from its context endpoint. The connected patient flow does not show exercise, side, or pose-model selectors.
3. The patient enables the camera and positions the assigned body region in view. The integrated flow uses the Heavy pose model by default.
4. The patient saves Starting position and Comfortable target using the visible manual buttons after holding each position still for one second. These references come from the current local camera angle; calibration makes no Gemini request. Set up & start remembers the start request and begins once both valid references are saved.
5. Panda understands explicit start, pause, resume and finish/save controls without a general conversation request. Rehab automatically saves at the configured rep target and also supports manual finish. Panda summarizes the canonical evidence and asks how the set felt; the review must complete before another set starts. Care retrieves the same report and records its acknowledgement separately.

Camera observations now run through the local exercise state machine on every valid delivered frame. A continuous 200 ms dwell enters holding and includes those 200 ms in the elapsed hold. Seated knee extension accepts the captured target minus 15° through plus 30°, capped to 0°–180°: a 170° target accepts 155°–180°. Decreasing-angle targets mirror the approach/past tolerances, and target/start bands remain separated beyond release hysteresis.

The numerical timer uses camera observation timestamps only; it does not predict elapsed hold between frames. Invalid tracking, excessive sample gaps and pauses invalidate the in-progress attempt rather than crediting unobserved time. A qualifying repetition requires the configured continuous hold and return to the starting region; full movements, short holds and qualifying reps remain separate counters. Gemini is optional wording only and cannot write measurements.

New camera sets and reports retain `evidence=camera_estimated` and add `measurementMethod=local_pose_engine` (configuration version 2). Simulated and patient-confirmed holds keep their own evidence labels. Historical Gemini-produced reports are retained without rewriting their evidence or counts; recover an older unfinished set before starting a fresh local set.

Technical error banners are hidden in the patient interface. Failures are written to the browser developer console with scope labels and basic credential/URL redaction. Validation, pause rules, partial-result handling and saved counts still apply. No successful measurement or save is invented after a failure.

Exercise guidance, counting instructions, camera status and live text cues stay displayed for at least 500 ms before changing; rapid pending updates are coalesced to the newest text. Pause/stop, saved-set and exercise-session changes take priority over that delay so stale movement instructions clear promptly. The numeric hold timer continues to update live. No browser-camera timing acceptance has been run for this change.

## Runtime map

- `apps/rehab/` — standalone Rehab app and its CV HTTP adapter.
- `packages/yuvraj-integration/session-runtime.ts` — maintained adaptation of the archived owner service: validates local camera attempt events, ordered/idempotent writes, feedback and immutable reports. The adapter in `service.ts` adds patient/Care binding and storage/provider isolation. The original archive remains unchanged.
- `packages/rehab-bridge/GuidedWorkspace.tsx` — shared camera presentation inside Panda's `/exercise` route.
- `packages/contracts/rehab-cv.ts` — versioned CV session, report, context, and event contracts.
- `docs/GUIDED_VOICE_INTEGRATION.md` and `docs/YUVRAJ_LATEST_INTEGRATION.md` — detailed ownership, integration, and validation records.

## Connected API and bridge

Connected CV routes use `/rehab/api/cv/v1`:

| Route | Purpose |
| --- | --- |
| `GET /context` | Resolve the patient-scoped context and current Care assignment. |
| `POST /sessions` | Start a session against the approved exercise and side. |
| `POST /calibrate` | Disabled: returns `409 MANUAL_CALIBRATION_REQUIRED` without contacting a provider. |
| `GET /calibrations/:id` | Read a historical calibration result, if one exists. |
| `GET /sessions/:id` | Read or resume a session. |
| `POST /sessions/:id/events` | Save ordered local camera attempts, tracking, controls and timing checkpoints. |
| `POST /sessions/:id/analyze` | Disabled for measurement writes: returns `409 LOCAL_MEASUREMENTS_ONLY`. |
| `GET /sessions/:id/analysis` | Read historical Gemini analysis, when present. |
| `POST /sessions/:id/finish` | Finish the session and save its canonical report. |

The owner service checks the current approved Care plan when a session starts. The manually captured angles are sent in that session's `calibration` fields. A missing supported assignment or a mismatch is rejected server-side. Bridge messages carry server-owned IDs; Panda fetches and validates canonical cue, analysis, and report data before speaking or saving related context.

The report acknowledgement is a Care record that points to the canonical Rehab session. It does not edit the report or automatically mark an exercise checklist task complete.

## Provider configuration and privacy

Panda conversation/action classification and optional Rehab feedback wording use `gemini-3.5-flash-lite`, with separate server-only `PANDA_GEMINI_API_KEY` and `REHAB_GEMINI_API_KEY` credentials. Camera measurements need neither key nor a provider response. The apps do not silently switch models. Keep keys in ignored server environment files; never expose them through browser variables, source control, or logs.

| Operation | Credential / execution |
| --- | --- |
| Panda conversation and voice-agent decisions | `PANDA_GEMINI_API_KEY` |
| Panda allowlisted action/tool classification | `PANDA_GEMINI_API_KEY` |
| Camera rep counts, movement cycles, short holds, phase and hold duration | Local exercise engine; no Gemini batch requests. |
| Rehab feedback phrase selection | `REHAB_GEMINI_API_KEY` |
| Calibration, camera pose inference, session timing, saved-report summaries and bridge verification | Local computation/storage; no Gemini measurement dependency. |
| Speech transcription and playback | ElevenLabs or browser/device speech, using the existing voice configuration. |

The Rehab process maps the preserved provider's legacy Panda-named variable to the Rehab key at startup. Panda's own process keeps the Panda key. The adapter also sets the Rehab key on every outgoing Rehab provider request and rejects a missing Rehab key rather than falling back to Panda's key.

Google model requests are serialized per API key across Panda and Rehab on the same host/data directory. Requests using the Panda key share one slot; requests using the Rehab key share another, so the two keys can run at the same time. The short SQLite transactions coordinate claims, and each key slot remains occupied until the full response arrives. Queued requests respect their timeouts; expired claims recover automatically. This coordinates local app processes; separate deployment hosts would need shared coordination.

Camera landmarks stay local. Ordered attempt summaries, timing and tracking events are saved to the owner service. Optional Gemini wording receives an approved feedback code and phrase choices, without raw frames or landmark batches. Stored sessions/reports remain patient-scoped. Local synthetic identity is for development only and is not production authorization.

## Local development

From the repository root, install the locked dependencies and start the integrated apps:

```bash
npm ci
npm run dev
```

The integrated Rehab workspace is available at `/exercise` on the Panda gateway, currently configured for localhost:8001. Legacy `/rehab` redirects there. Camera access requires localhost or HTTPS. The servers remain stopped until explicitly started.

Use `docs/YUVRAJ_CAMERA_TO_TEXT.md` for standalone setup and asset details. Do not infer physical-camera or phone acceptance from a successful page load or synthetic browser test. Real-device camera, microphone/echo behavior, provider availability, and clinical review remain separate acceptance work.

## Troubleshooting Panda feedback

Panda may report a reply, context-refresh, speech-playback, or Rehab-feedback problem. These are separate operations:

- **Retry reply** resends the pending conversation request with its original request ID.
- **Retry refresh** reloads Panda's context after a reply was already saved.
- **Retry sync** resubmits a queued Rehab event to Panda; the Rehab report itself remains saved.
- Speech playback failures use their own recovery path and do not imply that a Rehab session or report was lost.

For diagnosis, check the failing route and status in the local server output. A conversation route failure points to Panda's provider path; a `/voice/speak` failure is TTS; a Rehab CV route failure belongs to calibration, analysis, or session storage. A configured API key only means a value is present and does not guarantee the provider accepts it or has available quota.
