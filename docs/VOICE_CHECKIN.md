# Patient context and continuous check-in

Implemented November 7, 2026. This document supersedes the original guide's deferred continuous-voice scope following Ranveer's explicit request. Shared clinical contracts remain v2.0.0; the additive React exercise event bridge is v1.0.0.

## Patient experience

**Conversation redesign:** the fixed question strings described in the original implementation have been replaced by contextual model-generated dialogue. Panda opens with wellbeing, follows interruptions and concerns, and speaks routine medicine names/dayparts without reciting strength/time. See [CONVERSATION_DESIGN.md](CONVERSATION_DESIGN.md) for the current behavior, transcript and additive contracts.


The home page has three compact actionables: medicines from the approved plan, exercise, and follow-up availability pending. Panda occupies the center. Tapping Panda starts the voice check-in inline, with permission handled by the browser. Keyboard replaces Panda with the text conversation in the same center slot; its bottom button becomes a microphone icon. Switching modes stops active recording/playback and preserves check-in context. Talking and typing do not open a dialog or navigate to a different page.

The guided flow refers to each medicine in Care's approved task; exact clinical text is preserved while routine speech uses a concise name/daypart. A positive self-report creates a proposal; only a separate explicit confirmation writes through Care (button or a clear spoken confirmation after Panda reads the proposal). No/unsure is remembered without marking the task completed. Each new call also reviews earlier completed medicines without recording duplicate completions. Next it reviews food in the patient's words, notes a follow-up preference with booking explicitly pending, asks exercise readiness, and opens the exercise workspace if ready. It asks how exercise felt after Rehab saves a report, then asks about pain/discomfort. A discomfort report can prepare an exact-quote care-team request, again requiring a separate confirmation. Recorded help is not clinician acknowledgement or emergency dispatch.

Questions during a check-in can use the existing assistant without advancing the check-in stage. General medical question answering is not a validated feature: the current allowlist reads the approved plan and patient memory, proposes task/help actions, and opens exercise. No medical reference corpus or August integration has been connected.

## Persistent memory

Panda owns `patient-memory.sqlite` alongside its voice database. It records medication reports, food, scheduling-pending status, readiness, exercise feedback, verified report references/summaries, post-exercise feelings and pain. Patient quotes and module evidence retain their source. This memory has no automatic expiry: it persists until explicitly deleted. Recent/per-topic recall provides a bounded provider context, not an unlimited prompt.

This is separate from short-lived voice turns/proposals/receipts (24-hour retention). The memory API returns the latest 50 events, count and current check-in; older events remain stored. Deleting Panda memory does not delete Care's plan/tasks/help or Rehab's canonical reports. Backups and physical disk erasure need separate operational policies.

Repositories scope memory, histories, receipts and proposals by trusted server patient identity. The demo still has one fixed synthetic identity and no login. Scoping is tested but is not production authentication or authorization.

## Additive APIs

All JSON uses `{ok:true,data}` or `{ok:false,error:{code,message}}`.

- POST `/api/voice/checkin/start`: `{requestId}`. Creates/resumes the workflow; safely re-asks expired confirmation questions.
- POST `/api/voice/checkin/answer`: `{requestId,checkinId,text,expectedStage?}`. Retries replay; stale-stage answers fail instead of being recorded as a different answer.
- POST `/api/voice/checkin/continue`: `{requestId,checkinId,proposalId}`. Requires the actual saved result of confirmation/dismissal. It cannot execute an action.
- GET `/api/voice/memory`: patient-scoped event snapshot and active check-in.
- DELETE `/api/voice/memory`: `{confirm:true}`. Explicitly deletes this patient's Panda memory/check-ins/receipts only.
- POST `/api/voice/exercise-feedback`: `{requestId,checkinId,event}`. Validates bridge events and owner session/report before accepting report evidence.
- POST `/api/voice/transcribe`: multipart `file` audio, maximum 10 MB. Returns validated transcription text. Remote URLs and extra form fields are rejected.
- GET `/rehab/api/sessions/:id`: read-only captured Session, checked against the current Care patient.

Workflow replies include `checkin:{id,stage}`, `engine:'checkin_workflow'`, and optional `exerciseSessionId`. `VoiceContext` adds optional `sttConfigured`. The regular assistant adds `read_patient_context` with topic `all|food|medications|exercise|checkins`.

## Exercise ownership and integration

`packages/rehab-bridge/GuidedWorkspace.tsx` is the camera adapter embedded by Panda at `/exercise`. The old `/rehab` patient page redirects there; Rehab APIs keep their original paths. It continues calling Rehab's own session/report APIs through the gateway. Panda owns neither exercise measurements nor authoritative report storage. This extraction avoids divergent copies of the camera UI.

The optional callback receives schema-validated v1.0.0 events: `session_started`, `camera_status`, `tracking_status`, `report_saved`. `resumeSessionId` restores an owner session; `onAskPanda` preserves the mounted voice hook. Panda verifies sessions/reports by HTTP before storing references, rejects foreign patients and mismatched plans, and queues feedback with retry IDs. Repeated saved-report events do not rewind a completed review.

The guided exercise flow remains within Panda's mounted React tree, so audio can continue. Ordinary links to `/care` or the standalone `/rehab` still unload the page and stop resources. Do not replace the guided callback with hard navigation. Yuvraj's future pose engine should emit tracking events and save its report through the existing owner API. Camera preview and explicit simulated reports currently work; real pose inference is not implemented.

## Provider setup

Keep existing root `.env.local`; never overwrite it when following a quickstart.

- Gemini: `PANDA_AI_MODE=gemini` and `PANDA_GEMINI_API_KEY`. Panda and connected Rehab use `gemini-3.5-flash-lite` with separate API keys. Neither switches models automatically.
- ElevenLabs: `PANDA_TTS_MODE=elevenlabs`, `PANDA_ELEVENLABS_API_KEY`, `PANDA_ELEVENLABS_VOICE_ID`, `PANDA_ELEVENLABS_MODEL_ID`.
- Recorded STT uses that same ElevenLabs key; `PANDA_STT_MODEL` defaults to `scribe_v2`.

When ElevenLabs transcription is configured and recording is supported, MediaRecorder sends bounded audio to Panda's server directly. Native browser speech recognition is used only when that route is not configured/available; an exposed browser API does not establish that its recognition service works. The recorder stops after800ms of silence following speech or a maximum30 seconds. Capture nodes/timers are released each turn; the input device is reused during the active call and released on stop/cancel. This is turn-based listening and speech, not full-duplex interruption handling or an ElevenLabs Agents session. Actual device/browser capture still needs a human test.

Run `npm run doctor` to see configured/missing field names without secret values. `npm run dev` runs the connected three-app product; standalone `npm run dev:ranveer` uses fixtures, so exercise peers are not available.

Doctor availability/booking remains deliberately pending. No appointment is booked, no availability is invented, and no new provider key is needed for the implemented flow.

## Flowing conversation update

Tap Panda once to start. Replies speak automatically, then recognition resumes without another tap. Silence restarts listening; mute/end, keyboard mode, hidden page or navigation stops it. A separate spoken “confirm”/“cancel” (or clear yes/no to the just-read proposal) resolves the exact pending action. Ambiguous replies re-ask, and ordinary medication reports cannot be interpreted as confirmation. Listening continues after the structured check-in finishes for further questions; an explicit goodbye ends listening without marking unanswered topics complete. The initial tap unlocks one Web Audio context for subsequent reply buffers; Stop invalidates pending decoding so late audio cannot restart the conversation. Physical playback/microphone testing is still required; this remains alternating turns without voice barge-in.

Speech service recovery: configured transcription now takes precedence even when an embedded browser exposes a broken native recognizer. Microphone metering reuses the context unlocked by the initial tap, disconnects capture nodes after each turn, and leaves that context available for replies. Permission, capture and transcription errors have distinct messages; the UI points to the actual Keyboard control. Regression tests cover service selection, recorded-turn delivery, cancellation and capture cleanup.
