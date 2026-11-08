# Ranveer — Panda voice app / complete-function guide, revision 4

You now own **Voice AI**. Your primary app is `apps/panda`, the patient companion at `/`. You build its UI, audio, prompts, provider adapters, routes, services, persistence and tests. This replaces every earlier assignment of voice to Asmita.

## 1. Scope and boundaries

| You own end to end | You consume, without rebuilding |
| --- | --- |
| Voice/text conversation, microphone, speech output, prompts, AI intent routing, tool dispatcher | Asmita's approved plan and task/help APIs |
| Action proposals, explicit confirmation, retries, conversation/proposal storage | Asmita's authoritative checklist state and clinician acknowledgement |
| Patient companion voice/context UI and safe error/fallback states | Yuvraj's exercise app/session/report APIs |
| Gateway, root workspace/CI/lock, environment/deploy coordination; future identity setup | Asmita's shared UI tokens and each owner's domain schemas |
| After MVP: CRM/EHR adapter; server reminders and consented calls | Clinical approval and appointment state remain Asmita's |

Do not implement clinical plan approval, checklist rules, report storage or pose tracking in Panda. Your tool calls the owner's API. Do not assign your voice backend to Asmita.

Owned files: `apps/panda/**`, `packages/contracts/voice.ts`, `tests/voice*`; shared setup `packages/platform/**`, `scripts/**`, root manifests/lock/config/CI. Asmita owns `packages/ui/**`; propose visual changes there rather than forking tokens. All three review cross-app contracts.

## 2. Start in your own editor

One team repo: Ranveer creates the Classroom team once; Asmita/Yuvraj join. Upload the extracted source to that repository. Do not give each person an unrelated repo.

```bash
git clone <SHARED_CLASSROOM_REPO_URL> panda-care
cd panda-care
npm ci
cp .env.example .env.local
git switch -c ranveer/voice
npm run dev:ranveer
```

Open http://localhost:3000. This runs only your app in explicit fixture mode; writes are labelled dry runs. To test with the real local Care/Rehab apps, stop it and run `npm run dev` from the root. All three apps share one public origin through port 3000. Your `.env.local` can override modes; don't accidentally force connected mode when working alone.

Read `docs/OWNERSHIP.md`, `SHARED_CONTRACT.md`, `API_STATUS.md`, `BUILD_ORDER.md`. Start from v0.2 / contract 2.0.0, not older single-app code.

## 3. What already works versus your build

Working scaffold: text input, browser STT feature detection/consent, browser read-aloud, typed tool proposals, explicit confirmation, source-line plan reads, current context, voice JSON persistence, same-origin routing. Optional server Gemini/OpenAI routing and ElevenLabs TTS are wired but have not been exercised with real credentials. There is no realtime full-duplex agent or production auth.

### Your exact build sequence

1. Run the solo app and verify the fixture badge and dry-run wording. Run the integrated loop with `npm run dev`; ensure a voice help request changes the Care app only after confirmation.
2. Configure **one** AI provider, preferably Gemini if pursuing that MLH track. In root `.env.local`, set `PANDA_AI_MODE=gemini` and `PANDA_GEMINI_API_KEY`. Panda and connected Rehab use `gemini-3.5-flash-lite` with separate API keys. Neither silently switches models. The adapter lives in `src/server/provider.ts`. Keep model output restricted to the allowlisted command schema.
3. Configure ElevenLabs natural speech: `PANDA_TTS_MODE=elevenlabs` plus API key, voice ID and model ID in `.env.local`. The `/api/voice/speak` endpoint returns MP3; the UI plays it on an explicit click with consent. Test actual audio and failure states. This is TTS, not ElevenLabs Agents; don't claim realtime agent integration unless you build it.
4. Improve turn-taking: clear listening/thinking/confirmation/speaking states, stop/cancel, mic denial, unsupported browser, provider timeout, no autoplay assumptions. Ensure only one audio source plays. Stop recognition/synthesis/network/audio and revoke URLs on route exit.
5. Keep tool execution tied to current approved plan/context. Never trust model-invented task IDs/revisions. Preserve a user help quote verbatim. On changed plan/revision, ask for refreshed confirmation rather than silently applying stale intent.
6. Persist conversation/proposal/session state with your own repository. Replace JSON with `voice.*` tables after the demo loop works. Use transactions/idempotency for writes and a bounded retention policy. A proposal ID is a stable downstream request ID.
7. Integrate Yuvraj's app by ordinary navigation to `/rehab`. MVP voice stops on navigation; do not promise continuous speech during exercise. A later persistent voice/camera bridge is your feature and needs a reviewed interface with Yuvraj, not global DOM events.
8. Coordinate shared sign-in/session helpers and HTTPS deployment. Each owner still implements authorization in their own APIs. This starter is fixed synthetic identities; it must not be presented as real patient access control.
9. Run actual phone/desktop voice checks, then the root check/build/integration commands. Give teammates exact endpoint/payload/response examples and working commit IDs.

## 4. Public API you own

| Route | Behavior |
| --- | --- |
| GET `/api/context` | Read A's approved plan/current tasks/help; include integration/TTS mode |
| POST `/api/voice/turn` | `{requestId,text}` → sourced reply, navigation or stored proposal |
| POST `/api/voice/confirm` | `{proposalId}` → original proposal executed once, or explicit error |
| POST `/api/voice/speak` | `{text}` → optional ElevenLabs audio; never expose the key |

Tools: `read_plan`, `confirm_task`, `request_help`, `open_exercise`. Unknown tools, extra args, missing tasks and stale revisions fail validation. Proposals expire after five minutes. Reads quote approved source lines; do not generate medication or diagnostic advice. A human reviews care plans. No automatic dose changes, treatment changes or emergency dispatch.

Voice writes call A's `/care/api/tasks/:id/confirm` or `/care/api/help`. No direct Care table access. A successful help record means “recorded, awaiting acknowledgement”, not “the doctor was contacted”. A report belongs to Yuvraj even if your assistant describes it later.

## 5. Integration handoffs

With Asmita: agree v2 fixture; confirm her current plan/version and task revisions; execute writes through her APIs; verify clinician acknowledgement independently. Her patient/clinician data filtering is her domain; your identity helpers don't replace it.

With Yuvraj: agree exercise launch path and approved config reference. He owns camera and report save; don't save his report a second time. MVP uses a hard navigation, so audio cleanup is part of your handoff. Future continuous voice/camera control must be versioned and explicitly designed.

Shared setup: serialize root dependency/lock/config changes. Add a provider SDK only if needed; existing adapters use server-side fetch. Do not add API keys to git, browser env or URLs. Don't move another app into your folder or import its server code.

## 6. Remaining workflows after core demo

You own CRM/EHR as a complete function in `apps/panda/src/integrations/ehr/**` (new folder when needed): connection UI, OAuth, sandbox adapter, mappings, import/export, sync jobs/errors and tests. Start with one SMART/FHIR sandbox. Imported clinical text goes to Asmita's draft API; exported exercise data comes from Yuvraj's report API. Don't claim universal healthcare-CRM support.

You own server reminders and consented outbound calls as one complete notification function: consent/preferences UI, scheduler/jobs, provider call execution, retries/webhooks and truthful delivery status. Consume A's care/appointment data. Do not rely on a browser tab or pretend a queued job was delivered. This is outside the hackathon MVP.

Yuvraj owns later wearables; Asmita owns appointment state, caregiver grants and PWA. Medication changes remain clinician decisions, not voice tools.

## 7. Acceptance / merge

- [ ] Actual Gemini or chosen AI call over validated tools; engine badge honest.
- [ ] Actual ElevenLabs audio if claiming that track; text/browser fallback usable.
- [ ] No mutation before explicit confirmation; retry yields one Care record.
- [ ] Plan changes invalidate outstanding proposals; unknown tools rejected.
- [ ] Mic/audio stop on exit; phone/desktop observations recorded.
- [ ] `npm run check`, `npm run build`, `npm run test:integration` pass.
- [ ] Secrets excluded, demo labels accurate, real versus pending features disclosed.

The baseline tests exercise the Care/Voice boundary, not a paid provider account or physical microphone. Add provider adapter tests with mocked HTTP and record live tests separately.

Branch `ranveer/voice`. Merge small functional slices; ask A/Y to review consuming contracts. Coordinate the initial/final release, but every person finishes their own app. Keep earlier baseline/AI assistance disclosed per the supplied Radial rules.

## Editor prompt

You are Ranveer's coding agent in the shared Panda Care v0.2 monorepo. Read docs/RANVEER.md, OWNERSHIP.md, SHARED_CONTRACT.md and API_STATUS.md. Own the complete Panda voice/text app in apps/panda: UI, mic/audio, prompts, Gemini/OpenAI routing, optional ElevenLabs speech, tool validation, confirmation, conversation persistence and tests. Coordinate gateway/root/identity setup. Consume Asmita's Care HTTP APIs and Yuvraj's Rehab routes/APIs; never duplicate their domain stores/rules or implement their functions for them. Preserve contract v2.0.0 and stable retries. Implement one working slice at a time, keep fixtures and untested provider/device features honest, and provide actual validation results. Do not expand to EHR/calls before the core physical-AI/report/acknowledgement demo works.
