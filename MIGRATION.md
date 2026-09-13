# v5 → v6 migration notes

## Code and data mapping

The supplied v5 ZIP contained application code and launch files only. It contained no SQLite database or upload directory. Therefore this deliverable migrates the application, **not historical customer records**. Keep any existing `tattoo-booking.sqlite`, `-wal`/`-shm` files and `uploads/` safely backed up before a cutover. No automatic historical-data importer is included.

| v5 | v6 |
| --- | --- |
| `requests` contact fields | `clients`, scoped by `workspace_id` |
| request design/intake | `tattoo_requests` |
| quote, deposit, estimate, private notes | one `projects` row per request |
| integer IDs | UUIDs; existing v5 admin URLs are not portable |
| `public_token` | added to `tattoo_requests`; random 192-bit client capability link |
| local `photos` | `reference_files` metadata + private Storage objects |
| `slots` | `approved_slots` with start/end and availability state |
| `appointments` | sessions linked to project/client/workspace |
| `payments` | project payments, external-ID deduplication, late-charge review flag |
| `consent_forms` | project/client consent, signature, policy version, photo choice |
| `change_requests` | project/client/session change requests with free-text preferred times |
| `notification_outbox` | scoped SMS messages, schedule, provider result and exclusive claims |

`lib/repository.js` owns data access. `lib/supabase.js` handles server-only HTTP authentication, timeouts, paging, and safe errors. Server routes use named repository methods. `ink_*` views project normalized records for the retained v5 screens. All read queries carry an explicit workspace filter; joins also match workspace IDs.

The service-only `ink_flow_command` function executes each business mutation atomically and locks the active workspace row before calendar/payment changes. It verifies related records within that workspace. The private beta uses one calendar per workspace, a deliberately conservative single-artist constraint. Concurrent artists within one workspace will need artist-specific conflict rules during the SaaS auth phase.

## Security and behavior changes

- `WORKSPACE_ID` is required server configuration. It is never selected through a browser parameter.
- Existing RLS remains enabled. No anonymous/public database or Storage policies are introduced.
- New `sb_secret` keys use the `apikey` header; legacy service-role JWTs also use Bearer authorization. Keys never enter HTML.
- Images use random workspace-prefixed object paths. Only an authenticated artist session can request a 60-second signed URL. Refresh the original `/uploads/UUID` link after expiry. Anyone holding a signed URL can use it until it expires.
- Uploads happen before an atomic intake write. Known failures clean up uploaded objects. Ambiguous network failures retain possible orphan objects rather than delete a committed request's photos; reconcile unreferenced objects when reviewing failures.
- Required consent and deposit cannot be bypassed by arbitrary status changes. `booked`/`pending_deposit` are derived from appointments and payments; completion and reopening a quote remain explicit actions. Requoting an active booking is blocked; cancel active sessions first.
- Zero-deposit bookings confirm without a payment. Recorded manual payments can satisfy a live hold. Late Stripe payments require review rather than rebooking an expired slot.
- Production refuses the default/short artist password and a non-HTTPS `APP_URL`. Payment simulation is local opt-in only.
- Cross-site browser POSTs are rejected. The in-memory artist session login remains the private-beta auth model.
- Amounts display cents, preserving fractional manual payments. Calendar inputs use the server's `TZ`; set it to the business time zone before entering dates.

## Existing-record cutover, if needed

Before importing real v5 data, stop v5 writes and take a complete backup. Build a reviewed importer that assigns UUIDs, creates clients/requests/projects, preserves client public tokens, maps foreign keys, uploads original photos with metadata, and reconciles existing payment IDs and appointment states. Verify row counts, totals, consent evidence, and links in a separate workspace first. This work needs the actual SQLite database and uploads, which were not supplied.

The additive migration is transactional and tested for repeat execution. Unique indexes intentionally reject incompatible duplicate existing data rather than silently discard it. Review a failure and resolve duplicates before retrying. For rollback after real v6 use, restore the reviewed database/storage backup; do not point v5 at the normalized v6 schema.
