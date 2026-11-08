# MECE ownership — revision 4 / contract 2.0.0

MECE applies to the frozen MVP: every function below has exactly one accountable owner. Each owner implements its screens, routes, domain rules, storage, validation, failure states and tests in their own web app. Consumers call APIs; consuming a function does not transfer ownership or authorize reimplementing it.

## MVP function partition

| Complete function | Sole owner | Source of truth / paths | Consumers |
| --- | --- | --- | --- |
| Voice/text assistant, conversation, microphone, speech, prompts, AI routing, action proposals/confirmation | Ranveer | `apps/panda/**`, `packages/contracts/voice.ts`, `tests/voice*`, `tests/providers*` | Patient; links to Care/Rehab |
| Document import, extraction/review, approval and plan versions | Asmita | `apps/care/**`, `packages/contracts/care.ts`, `tests/care*`; care documents/plans | Voice and Rehab read approved plan |
| Daily checklist, patient-reported confirmation and revision rules | Asmita | Care task service and plan/checklist screens | Voice invokes the same confirmation API |
| Help requests, clinician roster/detail, request acknowledgement and report acknowledgement | Asmita | Care help/acknowledgement records and clinician UI | Voice creates help; Care reads Rehab reports |
| Camera permissions/preview, pose inference, calibration, rep logic and tracking states | Yuvraj | `apps/rehab/**`, `packages/contracts/rehab.ts`, `tests/rehab*`; model/WASM assets | Patient exercise web app |
| Exercise session lifecycle, measurements, report creation/storage/history | Yuvraj | Rehab sessions/reports API and repositories | Care fetches reports, stores acknowledgement references |

No role is called "all frontend" or "all backend". Asmita does not build Yuvraj's session APIs; Ranveer does not build Asmita's care backend; Yuvraj does not build another voice agent.

## Single owners for shared setup

| Shared item | Accountable owner | Rule |
| --- | --- | --- |
| Root scripts, gateway rewrites, dependency lock, CI, environment/deploy setup, future sign-in/identity helper | Ranveer | One-time infrastructure work; does not make him everyone's backend developer |
| `packages/ui/**`, design tokens, navigation labels, accessibility conventions, product/demo story | Asmita | Each person builds/styles their own app using the shared system |
| `packages/contracts/common.ts` and fixed `index.ts` | Ranveer stewards | A change affecting consumers requires their review before merge |
| `contracts/care.ts`, `voice.ts`, `rehab.ts` | Asmita, Ranveer, Yuvraj respectively | Each schema has one editor/owner; no duplicate types |
| Integration harness and final release assembly | Ranveer coordinates | All three provide passing producer/consumer checks and actual-device evidence |

## Data ownership

Care owns patient/clinical context, source documents, plan versions, checklist state, help records and acknowledgement records. Voice owns conversation/proposal/session records; it stores a plan reference, not a second authoritative plan. Rehab owns exercise sessions and immutable measurements/reports; it stores captured plan/version references, not a second care-plan database.

A report acknowledgement is not a report edit. Asmita stores `{sessionId, by, at}` and reads the original report from Yuvraj's API. A voice "done" action is patient-reported, never camera-verified. A saved report does not automatically complete a checklist task in this MVP; a later completion integration needs an explicit evidence-specific contract.

## All remaining product workflows have an owner — after the core loop

| Later complete function | Owner | Boundary |
| --- | --- | --- |
| PDF/OCR + assisted extraction | Asmita | Draft/source provenance; approval remains a clinician action |
| Appointments | Asmita | Request, availability adapter contract, review/confirmed status, patient calendar; never claim a request is booked |
| Server reminders and consented outbound calls | Ranveer | Preferences/consent for notifications, scheduler/jobs, retries, provider callbacks and delivery status; read care tasks/appointments |
| CRM/EHR integration | Ranveer | Connection/OAuth, FHIR adapter, mapping, import/export/sync status UI and services; imports enter Asmita's draft-review API |
| Refill or treatment-change requests | Asmita | Review workflow only; no AI prescribing or automatic medication change |
| Caregiver invitations and shared status | Asmita | Relationship/access grant, consent and portal; use original domain APIs |
| Wearable/sensor integration | Yuvraj | Device/provider authorization, normalization, sensor evidence/history; require a separate supported-provider contract |
| Installable-app experience | Asmita | Manifest/assets/install/offline states; all three verify their own route behavior |
| Exercise-feedback Gemini text and secure Rehab-to-Voice bridge | Yuvraj | Camera-to-text is implemented; secure transport to Voice is a later reviewed integration |
| TTS and playback during camera sessions | Ranveer | Owns synthesis, player, audio consent and interruptions; consumes Yuvraj's validated text/bridge |

## Production migration ownership

Use one managed PostgreSQL instance if convenient, with separate domain schemas: `voice.*` (Ranveer), `care.*` (Asmita), `rehab.*` (Yuvraj). This is a proposed replacement for demo JSON files, not an implemented database. Each person writes their own migration and access policies; services do not write each other's tables. Reserve migration names by domain to avoid collisions. Shared identity/bootstrap migrations are coordinated by Ranveer. Do not expose database credentials to browsers.

For real accounts, Ranveer supplies verified identity/session helpers; every owner authorizes their own API operations and patient relationships. Fixed demo identities are not authorization. Care must split patient and clinician responses; the current synthetic `/state` response is deliberately not suitable for real patient access.

## Working rules

- All start from this exact v0.2 repo. Do not mix old v1 guides/components with these apps.
- One shared Git repository, three app folders and branches. Not three unrelated repos merged on the last night.
- No app imports another app's UI, service or database. Shared imports are contracts/platform/UI only. Tests may compose services for verification.
- Keep all app dependencies in the locked workspace; each owner proposes SDK additions, Ranveer merges root/lock changes in sequence.
- Standalone fixtures are explicit. Connected failures stay failures. No silent fake success.
- Use small PRs with producer/consumer tests. Broken contracts block merge; unfinished integrations stay visibly pending.
