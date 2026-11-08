## Summary

The Cloudflare release runs the Rehab demo on a public Workers URL, backed by a dedicated D1 database. Each browser receives a signed, HTTP-only visitor identity; the Worker replaces client-supplied identity headers before requests reach the app so visitor reports are kept in separate D1 documents.

The public demo runs without Cloudflare Access, as requested. Do not collect names or other personal details. Camera frames are processed in the browser and are not stored or uploaded.

## Release configuration

- Worker: `panda-care-rehab-demo`
- Public route: the account's `workers.dev` subdomain
- Database binding: `DB`, using a new database dedicated to this demo
- Required secrets: `REHAB_GEMINI_API_KEY`, `REHAB_CV_AUTH_SECRET`
- Public demo var: `PANDA_CF_PUBLIC_DEMO=true`
- Gemini mode/model/timeout: `controlled`, `gemini-3.5-flash-lite`, `2000`

The Worker creates a signed visitor cookie from `REHAB_CV_AUTH_SECRET`, maps its subject to the app's authenticated-user headers, and sets a 30-day expiry. It replaces any matching headers supplied by the browser. The demo page labels itself public and says not to enter personal details.

## Deployment and verification

Build the isolated Cloudflare source checkout from the `yuvraj/cloudflare-public-demo` branch. Configure the new D1 database ID in the generated Worker deployment config, apply `hosting/drizzle/` migrations, set the secrets with Wrangler, run a dry-run, then deploy. Keep secret values out of source, shell output, and Git.

Verify that the `/rehab` page loads, Lite/Full/Heavy models are selectable, the camera starts over HTTPS, context and feedback APIs work, Gemini status is configured, and reports saved from two separate browser profiles do not share history. The virtual-camera tests do not establish physical-device repetition accuracy.
