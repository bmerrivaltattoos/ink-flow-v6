# Ink Flow v6 — private beta

The v5 tattoo booking app now stores its data in Supabase PostgreSQL and its reference photos in private Supabase Storage. The original server-rendered intake, artist dashboard, calendar, client link, consent form, deposit checkout, payment history, multi-session projects, change requests, and message queue are retained.

**This package is locally tested source, not an already deployed service.** The live Supabase project has not been modified. No real credentials, client records, or uploaded reference photos are included.

## Start here

1. In the existing Supabase project's SQL editor, run `sql/002-ink-flow-v6.sql`. You already ran the foundation schema; do not rerun it just for this upgrade. `sql/001-foundation.sql` is included for a fresh test project only. The migration adds columns, indexes, service-only views, and one transactional server function. It does not add anonymous policies, disable RLS, or change bucket privacy.
2. Find your workspace UUID with:

   ```sql
   select id, name, timezone from public.workspaces;
   ```

   If you have no workspace yet, create one:

   ```sql
   insert into public.workspaces (name, business_name, timezone)
   values ('Beau Merrival Tattoo', 'Beau Merrival Tattoo', 'America/Denver')
   returning id;
   ```

   Use your business time zone if it differs. An existing owner and workspace membership remain intact. For a newly created private-beta workspace, owner/member assignment is part of the later authenticated staff setup; the current server login is scoped by its environment.
3. Keep `tattoo-reference-files` **private**, with the existing 15 MB and JPEG/PNG/WebP/HEIC/HEIF restrictions. No storage policies need to be added for this server-only implementation.
4. Copy `.env.example` to `.env`. Fill in `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WORKSPACE_ID`, and a strong `ADMIN_PASSWORD`. Set `TZ` to the workspace's business time zone. Never paste credentials into source code or send them in a client-facing URL.
5. Install Node.js 24 or newer. Start with `start-windows.bat`, `sh start-mac.command`, or:

   ```sh
   node --env-file-if-exists=.env server.js
   ```

   There are no runtime npm dependencies. The client form is at `http://127.0.0.1:8787`; artist login is `/admin`.

## Payments and messages

For local fake-data testing without Stripe, set `ALLOW_SIMULATED_PAYMENTS=true` and leave `STRIPE_SECRET_KEY` empty. Simulation is always disabled when `NODE_ENV=production`. Do not enable simulation against a database containing real bookings.

For Stripe, configure both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Deliver Checkout events to `https://YOUR_HOST/stripe/webhook`, including `checkout.session.completed` and `checkout.session.async_payment_succeeded`. The server validates signatures, paid status, USD currency, workspace, checkout session, appointment, and exact held deposit amount. A success-page visit does not confirm a booking. The beta continues v5's USD billing; non-USD workspaces are not supported yet.

Duplicate callbacks do not duplicate payments. A successful payment arriving after its hold expires is recorded with `requires_review=true` and an explicit review note in the payment history. It never reclaims an expired time. Resolve such charges with the client and refund/reconcile in Stripe as appropriate; this package does not issue automatic refunds.

Manual payments are entered in the artist project page. Enough recorded payment confirms an unexpired hold. A zero-deposit booking confirms immediately after consent. Additional sessions require consent and the project's deposit to have been satisfied.

Set `SMS_PROVIDER=twilio` and all three Twilio variables to enable delivery. Otherwise messages stay queued for manual use. The worker runs once per minute. Claims prevent concurrent workers from sending the same queued message. Rows left `sending` after a crash and rows marked `failed` need provider reconciliation before any manual requeue; automatic retry could duplicate an SMS. This beta retains v5's SMS queue; email delivery is not implemented.

## Deployment

Build the included Dockerfile, or deploy the folder to a Node 24 host with start command `node server.js`. No runtime install/build step is required. For Docker:

```sh
docker build -t ink-flow-v6 .
docker run --rm -p 8787:8787 --env-file .env.production ink-flow-v6
```

Create `.env.production` privately or use your host's environment settings. Set:

- `NODE_ENV=production`, `HOST=0.0.0.0`, and the host-assigned `PORT`.
- `APP_URL` to the exact public HTTPS origin, with no path.
- `ADMIN_PASSWORD` to at least 16 characters.
- The Supabase, workspace, business time zone, Stripe, and optional SMS variables above.

Run **one app instance** for the private beta: artist sessions currently live in process memory and are cleared on restart. Database commands themselves serialize workspace calendar/payment changes across processes, but distributed login sessions and multi-user authorization are future work. No persistent application disk is required for the v6 runtime.

`GET /health` returns version and configuration booleans/statuses only. It is a liveness/configuration endpoint, not a database or bucket connectivity probe. A running `/health` is not proof that migrations, workspace ID, bucket, or credentials are correct. Finish the live acceptance checks below before inviting clients.

## Live acceptance checks

Use a test workspace and Stripe test mode first:

1. Submit a fake request with a photo; verify its database metadata and private bucket object.
2. Log in, quote it, offer future times, and open Client view.
3. Sign consent, choose an approved slot, and pay through Stripe test Checkout.
4. Verify the webhook confirms exactly one appointment/payment and the queued messages appear.
5. Add another session, record a manual payment, and submit a client change request.
6. Verify photos require artist login and refresh to a new short-lived signed URL.
7. Let a hold expire; verify the slot is available again. Test a late successful webhook using test data and review its payment note.
8. If SMS is enabled, verify a test message with your permitted recipient and check provider delivery logs.

## Development tests

```sh
npm install
npm test
```

Only the test suite needs `@electric-sql/pglite`. The included `pnpm-lock.yaml` also supports `pnpm install --frozen-lockfile`. Tests execute the PostgreSQL schema and business function locally, then exercise HTTP routes through a simulated Supabase REST/Storage boundary. See `TEST-RESULTS.md` for coverage and limitations, `MIGRATION.md` for the data mapping, and `PRODUCTION-CHECKLIST.md` for remaining SaaS work.

Implementation references: [Supabase server API keys](https://supabase.com/docs/guides/getting-started/api-keys), [private Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals), and [PGlite local PostgreSQL testing](https://pglite.dev/docs/).
