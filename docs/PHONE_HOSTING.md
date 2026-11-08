## Summary

Panda Care's owner-private phone deployment reuses the Rehab camera-to-text implementation. HTTPS and ChatGPT sign-in are provided by Sites; D1 preserves reports across Worker restarts and devices signed into the same account. The deployment source is also backed up on Yuvraj's GitHub fork.

## Open on your phone

Open https://panda-care-rehab-yuvraj-20261107.yuvrajmu160398.chatgpt.site/rehab in Safari or Chrome and sign into the same ChatGPT account. Allow the camera, choose an exercise and working leg, capture two comfortable stable references, and start the set. Finish and save to review the report. The clearly labeled example trace can test text and saving without movement. Use the normal browser rather than a messaging app's embedded browser.

## Prepare source

From the repository root, run `node scripts/prepare-phone-host.mjs`. This creates or updates the separate `../hosted-phone` deployment checkout from `hosting/`, the current Rehab source and pinned camera assets. The target must stay outside this monorepo. Do not edit generated `shared/` files directly. Do not copy ignored local secrets or runtime data into source control.

In that checkout, use the installed Sites dependency/build/source helpers. `.openai/hosting.json` preserves the registered private Site identity. Native Sites publication deploys the pushed commit and matching archive; GitHub pushes alone do not automatically deploy this Site.

## Runtime settings

Configure `PANDA_GEMINI_API_KEY` and `REHAB_CV_AUTH_SECRET` as Site secrets. Set `REHAB_GEMINI_MODE=controlled`, `REHAB_GEMINI_MODEL=gemini-3.6-flash`, `REHAB_GEMINI_TIMEOUT_MS=5000` and `REHAB_DEMO_ALLOWED_ORIGIN` to the exact published origin. Never commit credentials. Local preview uses ignored `.dev.vars` and loopback-only mock ChatGPT identity. Production identity comes only from Sites dispatch.

## Persistence and limits

`cv_documents` has one authenticated owner's document with a revision checked on every write. Optimistic retries preserve concurrent writes and request receipts. Gemini leases persist with the data so separate Worker requests cannot generate the same cue twice. Provider calls happen outside database mutation callbacks. A bounded 1.8 MB document limit makes this a personal demo store; it is not the eventual clinical record system. No raw frames or video are stored or sent to Gemini.

Schema-only Drizzle migrations live under `hosting/drizzle/`. Sites applies production migrations before publishing. Local preview migrations use the generated `dist/server/wrangler.json` and `.wrangler/state`; local mock reports never seed the hosted database. The compatibility date matches the installed runtime's newest supported date, 2026-05-22.

## Verification

68 repository tests pass, including cross-instance Gemini deduplication. The hosting-runtime HTTP checks cover identity, CSRF, ordered measurements, concurrent starts, duplicate requests, Finish reconciliation and durable report history. Real Gemini returned `gemini_selected_approved_variant` using synthetic evidence. The real pinned pose model loaded and ran on a virtual camera in the hosting runtime; physical phone movement accuracy remains a manual test. A 390 px preview had no horizontal overflow. A camera button readiness gate prevents a first click during hydration from being lost.
