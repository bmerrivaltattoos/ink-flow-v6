# Remaining production work

This is a private-beta foundation. Complete before public multi-tenant SaaS launch:

- Supabase Auth for artist/staff identities, password recovery, workspace membership enforcement, and distributed sessions.
- Authenticated tenant RLS and narrowly scoped storage policies if direct client access is ever introduced.
- Tenant-aware rate limiting, login abuse controls, upload quotas, and operational request limits.
- Audit logs, alerting, database/storage backup and restore exercises, and orphan-photo reconciliation.
- Per-artist calendar conflicts and artist availability within shared workspaces.
- Payment reconciliation/refund tools, late webhook handling runbook, and broader concurrent integration tests against hosted Supabase/Stripe.
- Durable notification delivery reconciliation, retry controls, provider compliance/configuration, and email delivery if required.
- Shop-specific consent/waiver and cancellation language review; privacy and retention settings for sensitive client records.
- SaaS subscriptions, billing, customer onboarding, and workspace owner/member provisioning.
- Live Supabase/Stripe/SMS acceptance checks and hosting verification from README.

Current operating limits: one server-configured workspace per deployment, one shared calendar per workspace, one in-memory artist login system, USD payments, no automated historical SQLite importer, and no automatic refunds.
