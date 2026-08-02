# Managed auth for invite-only shared CRM (ticket #11)

## Question

Which managed authentication provider best fits an invite-only TanStack Start CRM where one external identity maps directly to one Owner? Compare passwordless email, server-side session verification, invite/disable/delete administration, TanStack Start integration, pricing near 5,000 MAU, operational burden, data portability, lock-in.

Context: one Render Web Service + Render Postgres; server verifies identity per request, then sets transaction-local Owner context for RLS. Real scale = tens of users; 5,000 MAU is an upper-bound sanity check.

## TL;DR

**Clerk.** Only candidate with a first-party TanStack Start SDK (`@clerk/tanstack-react-start`: `clerkMiddleware()` + `auth()` in server functions), invite-only via free-plan Restricted mode, free magic links, Clerk-sent invitation emails, and networkless JWT verification. Free tier (50k monthly retained users) covers both real scale and the 5k hypothetical; $0 config email. Integration boundary: trust only the verified session's `userId`; everything else (email delivery, sessions, invites) stays in Clerk.

## Per-provider findings

### Clerk

- **Passwordless email**: email links (magic links) available on free tier ([pricing](https://clerk.com/pricing)). Email codes also exist; SMS costs extra.
- **Server-side verification**: session token = JWT signed per-instance; `authenticateRequest()` with `jwtKey` env = "networkless authentication" — local verify, no per-request network call; manual path = cached JWKS + RS256 + `exp`/`nbf`/`azp` checks ([manual JWT docs](https://clerk.com/docs/backend-requests/handling/manual-jwt)).
- **Invite-only**: **Restricted mode**, available on all plans incl. free — public signup disabled entirely; access only via invitation, manual creation, or enterprise connection ([restrictions docs](https://clerk.com/docs/authentication/configuration/restrictions)). Allowlist is paid-only in production but not needed given Restricted mode.
- **Admin ops**: invitations via Dashboard + Backend API (`createInvitation()` / `POST /v1/invitations`, 100 req/h); Clerk sends the invitation email itself; invites expire after 1 month ([invitations docs](https://clerk.com/docs/users/invitations)). User **bans gated to Pro** ([pricing](https://clerk.com/pricing)); free-tier "disable" ≈ delete the user (Backend API) or revoke invite.
- **TanStack Start**: official SDK `@clerk/tanstack-react-start` — `clerkMiddleware()` in `src/start.ts`, `auth()` from `/server` in server functions returns `{isAuthenticated, userId}`; `<ClerkProvider>` + prebuilt components client-side ([quickstart](https://clerk.com/docs/quickstarts/tanstack-react-start)). Not flagged beta.
- **Pricing**: free to **50,000 MRU** (monthly *retained* users — users count only if active ≥24h after signup); Pro $25/mo for gated features; $0.02/MRU past 50k ([pricing](https://clerk.com/pricing)). Tens of users and 5k MAU both → $0 unless bans/MFA needed.
- **Portability/lock-in**: Dashboard CSV export of all users incl. password hashes; Backend-API export; open-source [migration-tool](https://github.com/clerk/migration-tool) (import side) and [migration guides](https://clerk.com/docs/guides/development/migrating/overview). Moderate lock-in: prebuilt UI + invitation flow are Clerk-shaped, but user data (email, id) exits cleanly. Password hashes irrelevant (passwordless).
- **Ops burden**: near zero — Clerk sends all email (invites, magic links); no domain/SMTP config required at tiny scale.

### WorkOS AuthKit

- **Passwordless email**: Magic Auth = six-digit one-time email code (not a link), 10-min expiry; WorkOS sends the email by default, opt-out to send yourself ([magic auth docs](https://workos.com/docs/user-management/magic-auth)).
- **Server-side verification**: access token = JWT verified locally against JWKS (`api.workos.com/sso/jwks/<clientId>`) via e.g. `jose` — no per-request network call; refresh tokens rotate ([sessions docs](https://workos.com/docs/user-management/sessions)). Framework session helpers exist for Next.js/Remix, **not** TanStack Start — hand-roll with `jose` + workos-node.
- **Invite-only**: yes — signup can be disabled; registration opens only when a valid invitation code is present; invitations via Dashboard + Invitation API ([invitations docs](https://workos.com/docs/user-management/invitations)).
- **Pricing**: AuthKit free to **1M MAU**; paid = SSO connections ($125/ea), custom domain $99/mo, etc. ([pricing](https://workos.com/pricing)). $0 at any relevant scale.
- **Portability**: export via API to JSON/CSV; migration guides both directions ([migrations](https://workos.com/docs/migrate/other-services)).
- **Ops burden**: low, but auth emails come from WorkOS's domain unless paying $99/mo custom domain; no TanStack Start SDK = more integration glue.

### Auth0

- **Passwordless** included in free plan; free to **25,000 MAU**; but first paid tier at 5k MAU = **B2C Essentials $350/mo** (B2B $1,300/mo) ([pricing](https://auth0.com/pricing)).
- No TanStack Start SDK (generic SPA/node SDKs). Heaviest machinery of the set for a tiny app; free tier would suffice at real scale but the paid cliff is the steepest here. Not pursued further.

### Supabase Auth (auth-only; DB stays Render Postgres)

- **Passwordless**: magic link + email OTP core features. Admin API server-side with `service_role`: `createUser`, `inviteUserByEmail`, `deleteUser`, `updateUserById` ([admin API docs](https://supabase.com/docs/reference/javascript/auth-admin-createuser)); project-wide "Allow new users to sign up" toggle — "If this config is disabled, only existing users can sign in" ([general configuration](https://supabase.com/docs/guides/auth/general-configuration)).
- **Pricing**: free 50k MAU, **but free projects pause after 1 week of inactivity** — disqualifying for an auth-only dependency; Pro $25/mo, 100k MAU included ([pricing](https://supabase.com/pricing)).
- Awkward shape: a second Postgres (Supabase's) just to hold auth users, JWTs verified against Supabase keys. Split-brain infra for no gain over Clerk/WorkOS.

### Better Auth (baseline: library, not managed)

- Self-hosted TS library; users live in **our own Render Postgres** (drizzle adapter) — best possible portability, zero external dependency.
- Official TanStack Start integration: mount handler at `/api/auth/$`, `getSession()`/`ensureSession()` in server functions, `tanstackStartCookies()` plugin ([tanstack docs](https://www.better-auth.com/docs/integrations/tanstack)).
- [Magic-link plugin](https://www.better-auth.com/docs/plugins/magic-link): **operator must supply `sendMagicLink`** (i.e. bring an email provider — Resend/Postmark + domain setup); `disableSignUp: true` gives invite-only. [Admin plugin](https://www.better-auth.com/docs/plugins/admin): create/list/ban/unban/remove users, session revocation, impersonation.
- Cost $0 + email provider. Trade: we own email deliverability, token storage, and auth-table migrations — exactly the ops the ticket wants outsourced. Strong post-v1 escape hatch if lock-in ever bites (Clerk CSV export → Better Auth import).

### Brief mentions

- **Stack Auth**: open-source managed auth, newer/smaller; not evaluated in depth (unverified beyond existence).
- **Kinde**: free tier ~10.5k MAU historically; no TanStack Start SDK; nothing it does better than Clerk/WorkOS here (pricing not re-verified).

## Comparison

| | Clerk | WorkOS AuthKit | Auth0 | Supabase Auth | Better Auth |
|---|---|---|---|---|---|
| Passwordless email | magic link, free | 6-digit code, free | yes, free tier | magic link/OTP | plugin, BYO email |
| Server verify | local JWT (networkless) | local JWT (JWKS) | JWT | JWT | own DB session |
| Invite-only | Restricted mode (free) | signup-disabled + invites | configurable | signup toggle + admin invite | `disableSignUp` |
| TanStack Start SDK | **official** | none | none | none | official guide |
| Cost @ tens of users | $0 | $0 | $0 | $0 risky (pause) / $25 | $0 + email svc |
| Cost @ 5k MAU | $0 (50k MRU free) | $0 (1M free) | $0–$350/mo | $25/mo | $0 + email svc |
| Ops burden | ~none | low (no SDK glue, domain $99) | medium | medium (2nd project) | highest (email, tables) |
| Portability | CSV/API export | API export | export | own-ish (their PG) | **total** (our PG) |

## Recommendation: Clerk

Boring, free at both scales, and the only one where the TanStack Start seam is first-party. WorkOS AuthKit is the runner-up (freest tier, clean invite-only) but costs hand-rolled session glue and third-party-domain auth emails. Better Auth is the documented exit path, not the v1 pick — v1 outsources email + user store.

### Integration boundary

- **What the CRM trusts**: only the output of `auth()` (backed by `clerkMiddleware()` networkless JWT verification with `jwtKey`) at a single server chokepoint — yielding Clerk `userId`. Nothing client-supplied.
- **Identity mapping**: `owners.external_id = clerk userId` (unique, not null). Lookup at the chokepoint → `owner_id` → `SET LOCAL` Owner context inside the transaction (RLS shape already proven in the pooled-RLS prototype). Agent tools remain identity-blind.
- **Owner provisioning**: JIT — first verified session with no matching `owners` row creates one (invite-only means any verified stranger was, by construction, invited). Store `external_id` + email snapshot; nothing else mirrored from Clerk.
- **Stays outside the app**: invitation emails, magic-link delivery, session storage/refresh, sign-in UI (Clerk prebuilt components in Restricted mode).
- **Admin ops**: operator invites via Clerk Dashboard; whole-Owner purge = app-side cascade (already specced) + Clerk Backend API user delete.

## Open questions

- Free-tier "disable user" is delete-only (bans are Pro): acceptable at friend-scale, or budget $25/mo Pro?
- JIT Owner provisioning vs pre-created Owner rows at invite time — belongs to the onboarding-story ticket (#7).
- Verify Clerk `azp`/authorized-parties config on Render domain at implementation time (checklist item, not a decision).
