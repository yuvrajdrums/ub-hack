# Panda Care — three-app team starter, v0.2

## New: standalone camera-to-text Rehab demo

Yuvraj's `/rehab` now includes actual pinned MediaPipe inference, stable reference calibration, separate movement/qualifying counts, continuous holds, session timing, immediate text, server-side Gemini wording and immutable CV reports/history. Run `npm run dev:yuvraj` and open http://localhost:3002/rehab. Care and Voice are not required for this flow.

Read [the camera-to-text runbook](docs/YUVRAJ_CAMERA_TO_TEXT.md) for setup, tests, scope and evidence limitations. Scoped routes use `/rehab/api/cv/v1`; old v2 APIs remain available separately. Browser verification uses virtual-camera/synthetic evidence; physical phone/laptop exercise QA remains a manual validation step.

One phone/browser product, three independently runnable web apps. Responsibilities are split by complete product functions. This revision supersedes the previous single-app starter and contract v1.

| Person | App | Owns the complete function | Standalone URL |
| --- | --- | --- | --- |
| Ranveer | `apps/panda` | Panda voice/text assistant, AI tool routing, audio, confirmation and conversation state | http://localhost:3000 |
| Asmita | `apps/care` | Document → reviewed/approved plan, checklist rules, clinician requests/acknowledgements | http://localhost:3001/care |
| Yuvraj | `apps/rehab` | Camera, pose estimation, rep logic, exercise sessions, saved reports/history | http://localhost:3002/rehab |

Every app includes its own UI, server routes, domain services and persistence. Each consumes the other apps through versioned HTTP contracts. Nobody hands their backend or frontend to another teammate.

## Start the integrated product

Node 22+ and npm. From the repository root:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open **http://localhost:3000**. `/` is Ranveer's app; `/care` and `/rehab` are proxied to the other two Next.js apps, including their assets and API routes. Use ordinary anchor navigation between zones. All apps remain separate build/deployment units; no copying React components between them, no iframes, no fourth product app.

Defaults need no keys. Connected mode uses real local inter-app HTTP and JSON-file persistence; it does not mean connected to a real clinic. Browser microphone support varies; text is always available.

## Work independently

Each person clones the SAME repo, runs `npm ci` from the root, and chooses their command:

```bash
npm run dev:ranveer
npm run dev:asmita
npm run dev:yuvraj
```

These commands start only that person's app and default to explicit fixture mode. Ranveer gets approved-plan fixtures and dry-run write proposals; Yuvraj gets an approved-plan fixture and his own saved session data; Asmita gets her real local care workflow and an empty fixture report list. The other apps do not have to run. A fixture write is labelled simulated and never claims to update a colleague's app.

For cross-app navigation and integration, use `npm run dev` and port 3000. Standalone Care/Rehab run at their base paths; links to other apps are intended for the shared gateway. Remove a `PANDA_INTEGRATION=connected` override from `.env.local` if you want standalone fixtures.

## What works in this starter

- Three responsive web apps and same-origin path routing.
- Text/file import (`.txt`), line/source references, draft review, explicit demo-clinician approval and versioned tasks.
- Patient-reported task confirmation with revision checks; help recording and separate clinician acknowledgement.
- Voice command tool dispatcher, server-persisted proposals, explicit user confirmation, idempotent writes through Care APIs.
- Optional Gemini/OpenAI intent-routing adapters; optional ElevenLabs speech adapter. All secrets stay server-side.
- Browser speech recognition where available, with consent; browser read-aloud fallback and text input.
- Camera preview/lifecycle, start/finish session APIs, immutable saved reports and report acknowledgement through Care.
- A clearly labelled simulated exercise report for verifying integration; it is not measured camera progress.
- Local persistence, runtime contract validation, domain tests and an integration test against all three production builds.

## Work still to build

**This is a working integration starter, not the completed care product.** The standalone camera-to-text feature is implemented under its scoped contract; physical-device exercise validation remains required. PDF/OCR extraction is pending. Paid AI/speech calls are wired but were not tested with real credentials; browser microphone/camera behavior needs actual-device testing. Full-duplex ElevenLabs Agents is an optional upgrade; the supplied speech adapter is text-to-speech, not a realtime agent.

Identities are fixed synthetic demo identities. There is no real authentication/authorization, patient isolation, durable production database, production job runner, actual clinician delivery, EHR connection, appointments, outbound calls, wearables, caregiver sharing, PWA/offline support or native app. A local JSON store supports one server process per app and is unsuitable for serverless replicas. Do not publish this demo with real patient data or paid unauthenticated endpoints.

## Optional AI and speech configuration

Edit root `.env.local`; the root runner loads it for all apps. Never use `NEXT_PUBLIC_` for credentials.

- Gemini track: `PANDA_AI_MODE=gemini`, `PANDA_GEMINI_API_KEY`, `PANDA_GEMINI_MODEL` (an available model ID, without `models/`).
- Optional OpenAI alternative: `PANDA_AI_MODE=openai`, `PANDA_OPENAI_API_KEY`, `PANDA_OPENAI_MODEL`.
- ElevenLabs track: `PANDA_TTS_MODE=elevenlabs`, `PANDA_ELEVENLABS_API_KEY`, `PANDA_ELEVENLABS_VOICE_ID`, `PANDA_ELEVENLABS_MODEL_ID`.
- No credentials: `PANDA_AI_MODE=demo`, `PANDA_TTS_MODE=browser`; the UI labels demo rules and browser speech.

Configured provider failures surface as failures; they never silently turn into a successful mock. Use synthetic data for external-provider tests. Model availability and account access must be checked in your own provider account.

## Check and run builds

```bash
npm run check
npm run build
npm run test:integration
npm start
```

Stop dev servers before integration tests: tests reserve ports 3000–3002, use a fresh temporary data directory, start the three built apps, exercise the loop and clean up. Production-style `npm start` is only for testing the demo build; it is not production clinical readiness.

For phone testing, put the single port-3000 entry behind HTTPS and set `PANDA_DEV_ORIGIN` for a development tunnel. Peer URLs stay private server addresses. Do not replace browser URLs with the phone's `localhost`. Camera/mic need a secure context; real-device tests remain required. On deployment, rebuild Panda with actual private `PANDA_CARE_ORIGIN` and `PANDA_REHAB_ORIGIN`: its rewrites are build-time configuration. Deploy all three services; one static-site upload cannot run the APIs.

## Upload and collaborate

The ZIP contains source, lockfile and docs, without dependencies, builds, secrets or patient data. Extract it first. The event guide asks ONE team member to create a GitHub Classroom team at https://ubh.ac/github-classroom; the others join that same team. Ranveer coordinates the initial source upload to that classroom repository.

If the Classroom repo already contains starter files, clone it, copy this source into it, review and commit. Do not force-push or overwrite teammate work. For an empty local repo, initialize Git, commit the extracted source, add the URL supplied by Classroom and push. This deliverable does not create a remote repository.

Branches: `ranveer/voice`, `asmita/care`, `yuvraj/vision`. Merge contracts/scaffold first, then small working function slices. Root lock/config edits are serialized through Ranveer; Asmita maintains shared design tokens; Yuvraj maintains model assets. See `docs/OWNERSHIP.md` for all boundaries and deferred work.

Read your guide: `docs/RANVEER.md`, `docs/ASMITA.md`, `docs/YUVRAJ.md`. Product diagram: `docs/PANDA_PRODUCT_DIAGRAM.svg`. Exact API contract: `docs/SHARED_CONTRACT.md`. Build order and demo: `docs/BUILD_ORDER.md` and `docs/DEMO_SCRIPT.md`. Track guidance: `docs/TRACK_STRATEGY.md`.

Private phone testing and deployment: see [PHONE_HOSTING.md](docs/PHONE_HOSTING.md).
