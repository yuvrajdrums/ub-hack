> Current testbench measurement update (2026-11-08): live camera reps, phase and hold duration now come from the local state machine, with a 200 ms target dwell and direction-aware −15°/+30° tolerance. Gemini is optional feedback wording only; historical Gemini-analysis descriptions below describe earlier revisions. See `docs/REHAB.md` and `Pdetails.md`.

> The latest upstream revision is now integrated through a separate adapter, with a complete unchanged reference copy. See [YUVRAJ_LATEST_INTEGRATION.md](YUVRAJ_LATEST_INTEGRATION.md). The details below describe the earlier integration and its history.

# Circular companion and guided exercise integration

## Source and scope

Imported Yuvraj's guided camera/exercise implementation from [yuvrajdrums/ub-hack](https://github.com/yuvrajdrums/ub-hack/tree/165d7b74fe67e972389e59dd981ef984ebccacbb), commit `165d7b74fe67e972389e59dd981ef984ebccacbb` (main, rep-counting fix). Imported the exercise engine, camera pipeline, feedback service, versioned contract, pinned assets and regression tests. His alternative hosting/Cloudflare configurations and unrelated root changes were excluded. Existing Supabase/Render preparation remains intact. No deployment or EHR changes were performed.

`packages/rehab-bridge/GuidedWorkspace.tsx` is embedded by Panda at `/exercise`; `/rehab` redirects to that single patient experience. The camera/features and canonical session/report service remain owned by Rehab. Four synthetic exercise demonstrations are available: knee extension, knee flexion/extension, straight leg raise and patient-confirmed static quads. The working leg, calibration, tracking gaps, hold/return criteria and simulated traces use Yuvraj's evaluator.

The configurations remain **synthetic demonstration references**, not approved exercise prescriptions. A server-captured Care reference binds a result to the patient's plan context; it does not authorize a particular demonstration or claim clinical validation. Mapping reviewed structured exercise prescriptions is still needed before clinical use.

## Connected boundaries

- `/rehab/api/cv/v1/context` returns `connected_demo` or `authenticated` and a patient-specific browser recovery scope. Standalone operation retains its signed demo identity and CSRF checks.
- `POST /rehab/api/cv/v1/sessions` captures the current approved Care plan reference on the server. Production writes require the patient role; data uses the current authenticated patient scope and forced database row policies.
- `guided_session_started`, `guided_feedback` and `guided_report_saved` are additive events in `RehabBridgeEvent`. The client sends IDs, not trusted report/cue text. Panda fetches and validates the canonical session/feedback from Rehab, checks the captured patient and plan version, and deduplicates memory events.
- Feedback must belong to the active running session/control revision and remain unexpired. Speech is queued while the patient speaks/transcribes or Panda is answering. Saved reports prompt the post-exercise review without replacing a pending care concern. A discomfort stop holds further exercise.
- Patient memory attributes the report to Rehab and retains its evidence plus canonical session reference. Camera estimates, simulations and patient confirmations remain distinct.
- Care reads canonical reports via `/care/api/guided-reports`; existing acknowledgement accepts the canonical session ID. No second editable exercise report store was created.

## Voice and interface

The new Panda home follows the supplied slate/taupe reference: a rounded blurred card, small daily actions, inline typing and a circular visualizer. The SVG contour samples a Web Audio playback analyser or captured microphone level. Quiet states breathe gently; reduced-motion settings disable animation. Voice activation/typing remains on the same route. The home has no document scrolling at tested sizes 320×568, 390×667, 390×844, 430×932 and 1440×900. Exercise and long history panels can scroll independently.

ElevenLabs TTS streams bounded 24kHz signed 16-bit mono PCM through `/api/voice/speak` when requested with `Accept: audio/pcm`. Existing MP3 clients remain supported. Playback begins before EOF. Stop cancels the upstream reader and queued audio nodes. AudioWorklet capture preserves the start of utterances, ends after a 650ms pause, and supports sustained speech interruption when echo cancellation is reported. Other browsers retain recording/native fallbacks and tap-to-interrupt. No play-audio button is required. Per-utterance model calls receive retained patient context; this is not an always-open realtime model session.

Panda and connected Rehab use `gemini-3.5-flash-lite` with separate server-only `PANDA_GEMINI_API_KEY` and `REHAB_GEMINI_API_KEY` credentials. Neither silently switches models. An explicit `REHAB_GEMINI_MODE=off` remains respected; standalone defaults remain off. Gemini selects a validated wording variant, and unavailable/rate-limited generation completes with the deterministic cue. No pending phrase is marked spoken: only finalized feedback is forwarded to Panda, attributed in patient memory and played through the existing ElevenLabs voice.

## Storage and release

The local migration `supabase/migrations/20261108060015_guided_rehab_storage.sql` creates the patient-scoped `rehab.cv_state` store and a release marker. It was tested in the isolated Postgres-compatible test database, **not applied to hosted Supabase**. Production health requires the marker and fails closed until the migration is applied as part of the future deployment. The existing Render plan was not approved or applied.

## Verification on this revision

- `npm run check`: 168 tests, including imported evaluator tests and new streaming, interruption, owner-report integration and authenticated patient-isolation regressions.
- `npm run build`: all three apps.
- `npm run test:integration`: 32 connected checks plus three standalone app checks. Includes real HTTP calls through the gateway for the guided owner API, verified feedback, Panda review, Care report retrieval and acknowledgement.
- `npm run test:browser`: isolated Chrome with fake media devices and synthetic PCM. Checks the full agenda, full-height camera, corner Panda, microphone/typing switches, local pose initialization with fake video, embedded patient-confirmed hold, saved result, post-exercise review, no-scroll responsive home, inline typing, voice playback, circular visualizer and tap interruption.
- One live fictional ElevenLabs greeting returned PCM: first chunk 542ms, complete response 619ms, 258578 bytes. This is a single provider/network measurement, not full microphone-to-response latency or a guarantee.

Human listening, real microphone echo/interruption on phones and physical camera/rep-counting acceptance remain pending. Browser tests do not substitute for those checks. Doctor availability/booking and EHR are still pending as requested.

## Camera-first exercise view

The embedded workspace uses `presentation="camera"`. Live video and the aligned pose overlay fill the screen; Panda's circular visualizer and mic/keyboard controls remain in the top-right corner. Centered text gives the current guidance or Panda's spoken/review response. Care supplies the exercise and side; manual calibration controls appear directly on the camera view. Automatic calibration and its Gemini requests are disabled. Patient entry is `/exercise`, and Care entry retains the return destination with `?from=care`.

The same engine and canonical owner APIs drive both presentations. Exit attempts to save an interrupted session before closing. A Panda discomfort request stops and saves the current set while keeping the companion mounted; the owner report does not override the pending care concern. Starting another set is disabled while Panda is reviewing the result.

Finalized Gemini feedback retains text source/revision in patient memory and is included among the model's remembered topics. Immediate display can use the fallback while generation is pending; voice waits for the final revision, avoiding duplicate fallback/generated speech. Regression checks cover this handoff and reuse of the existing server-only Panda key.

The live Gemini feedback check on this revision returned `rate_limited`. The connection is configured, but current live Gemini-generated conversation/wording is limited by the provider account. Built-in exercise cues remain available; no live Gemini success is claimed for this check.

## Opening rehab

The whole “Move a little” action opens the embedded camera view directly. `POST /api/voice/checkin/open-exercise` creates or resumes the patient-scoped exercise context without an AI provider call. Explicit requests such as “open rehab”, “start the exercise module” and “let’s exercise” use that same path from Panda’s speech transcript or typing; direct `/checkin/answer` clients also recognize the request before model generation. Questions, negative answers and symptom concerns are not navigation commands.

Opening the view never completes medicine, meal or follow-up checks. If exercise is requested first, the prior agenda position is retained and resumed after the owner report, feelings review and pain check. Existing pending confirmations remain unresolved and prevent a set from starting; care concerns continue to hold exercise. Resuming an already-open exercise view does not require Gemini. Browser checks click the row with general conversation start deliberately unavailable, and verify a typed request opens the same view.
