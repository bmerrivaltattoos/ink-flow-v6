# v6 test results

Tested locally on September 11, 2026. **20 tests passed; 0 failed; 0 skipped.**

Command: `node --test test/workflow.test.js test/security.test.js`

The count includes the workflow parent test. Tests use Node's native test runner and PGlite 0.5.8 to execute PostgreSQL SQL/PLpgSQL locally. The foundation schema is executed with only the `CREATE EXTENSION pgcrypto` statement omitted because PGlite already provides the `gen_random_uuid` function used here. The actual v6 migration runs unchanged, twice, to verify rerun safety. A local fake Supabase HTTP boundary translates read filters into SQL and executes the real mutation function. Storage and external services are simulated.

## Passing coverage

- Full request → quote → consent → approved slot → deposit → booked HTTP flow.
- Private image upload metadata, random workspace paths, authenticated retrieval, missing image handling, and 60-second signed URL refresh requests.
- Required consent, duplicate booking rejection, overlap rejection, and transaction rollback after a conflicting quote.
- Zero-deposit confirmation, partial/full manual deposits, fractional manual payment amounts, and multi-session project linkage.
- Client change requests, unchanged confirmed appointments, cancellation, and project completion.
- Expired hold release; late paid Stripe callback recorded for review without resurrecting a reservation.
- Valid signed Stripe callback, unpaid callback handling, wrong amount rejection, tampered signature rejection, and duplicate payment idempotency.
- Notification enqueue/deduplication, unconfigured SMS preserving the queue, exclusive claims, and sent/failed result recording.
- Workspace-scoped reads and mutations, cross-tenant record/photo rejection, RLS flags, and denied function privileges for anon/authenticated roles.
- Missing configuration, safe error messages, legacy/new API-key headers, explicit pagination, and forced workspace filters.
- Unsupported, spoofed, oversized and failed photo uploads; cross-site POST rejection.

## Browser checks

Headless Chrome rendered desktop intake and artist project pages and a 390px mobile client page. Artist login was exercised through the actual form. Screenshots were visually inspected; the mobile client page had no horizontal overflow. This caught and fixed a referrer-policy interaction that caused form POST origins to become `null`: the app now uses `Referrer-Policy: same-origin`, which preserves same-site form origins and suppresses referrers to external sites.

## Not tested against live services

- No connection to the user's Supabase project, hosted PostgREST gateway, or real Storage bucket.
- No real Stripe Checkout payment or Twilio message. Webhook signatures and payment state transitions were exercised locally with test values.
- No Docker build/run: Docker is unavailable in this workspace. The Dockerfile uses the same dependency-free Node entry point that was syntax-checked and exercised by the local HTTP tests.
- No multi-connection hosted PostgreSQL race/load test. PGlite has a single connection; production workspace locking still needs a live concurrency acceptance check.
- No historical SQLite/client-data import, because no database or upload files were supplied.

Follow README's live acceptance checks before inviting clients. A passing local suite and `/health` response do not replace those checks.
