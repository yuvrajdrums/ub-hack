# Implemented versus pending

| Capability | Starter status | Owner's next work |
| --- | --- | --- |
| Three app build/run, base paths and gateway | Implemented; integration tested | R: deployment URLs/HTTPS and actual phone verification |
| Text/.txt import, source lines, draft approval, current plan version | Implemented with demo clinician | A: editable reviewed structured drafts, retained version history, PDF/OCR |
| Checklist confirmation / help / acknowledgements | Implemented; revision/idempotency checks | A: verified identities, organization/patient access, patient-safe responses |
| Voice tool proposal/confirmation and sourced-plan output | Implemented; demo rules tested | R: live provider/audio tests, prompt evaluation, latency and better turn-taking |
| Gemini/OpenAI model adapters | Configurable server code, not tested with real keys | R: select account-available model and record actual successful call |
| ElevenLabs speech | Configurable TTS endpoint/UI, not tested with real keys | R: live audio test, controls/error UI; full-duplex Agents optional |
| Browser microphone/read-aloud | Implemented browser feature detection and consent | R: actual phone/browser tests; browser STT availability varies |
| Camera preview / cleanup | Implemented | Y: actual permission/device/background checks |
| Pose inference / calibration / measured reps | Implemented in scoped Rehab camera-to-text feature; virtual-camera and synthetic trace tests pass | Y: actual physical-device exercise observations remain required |
| Session persistence / report fetch / acknowledgement | Implemented, integration tested with explicit simulated evidence | Y: real measurements; A: clinician report workflow polish |
| Auth / patient isolation / production DB | NOT implemented; fixed synthetic identities/local files | R: identity setup; every owner: domain authorization and repository migration |
| CRM/EHR, server jobs/reminders/calls | NOT implemented | R, after MVP |
| Appointments, caregiver, PWA | NOT implemented | A, after MVP |
| Wearables | NOT implemented | Y, after MVP |

No paid calls, emergency notifications, real clinician delivery, clinical correctness, HIPAA compliance or app-store release were validated by this starter. No camera-derived progress is fabricated. Use synthetic data only until the appropriate access and deployment work is complete.

## Scoped Rehab camera-to-text update

`/rehab/api/cv/v1/*` adds standalone synthetic context, protected session identity, ordered events, server-side Gemini approved-phrase selection, independent feedback cursor and immutable CV report/history. The old v2 session routes remain separate. Real Gemini was verified with synthetic evidence; no physical phone/laptop exercise accuracy or clinical validity is claimed. See `YUVRAJ_CAMERA_TO_TEXT.md`.
