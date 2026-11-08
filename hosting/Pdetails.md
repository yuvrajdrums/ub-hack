## Summary

Owner-private Panda Care phone deployment. Reuses the verified Rehab client/engine/service from the main repository under shared/. Sites provides ChatGPT identity, HTTPS and D1 storage. Camera frames remain on the device; Gemini credentials remain in server secrets.

- Source is synchronized from ../ub-hack; never edit shared/ directly.
- `scripts/prepare-phone-host.mjs` copies the Rehab Gemini calibration and rep-analysis skill files into shared/ so the server imports resolve in the hosted build.
- API: server/api.ts; durable optimistic-concurrency store: server/d1-store.ts.
- Migration: db/schema.ts -> npm run db:generate. Apply local migrations separately; Sites applies production migrations.
- Auth headers are supplied by Sites dispatch. Local mock identity is loopback only. CSRF and same-origin checks apply to writes.
- Build with the Sites build helper. Publish only owner-private; keep .openai/hosting.json project identity unchanged.

- Current camera client uses exercise/side tracking profiles and a shared 750 ms valid-cadence policy with frame-delivery freshness; seated exercises require only the working hip, knee and ankle. See the main repository runbook for all detector settings.
