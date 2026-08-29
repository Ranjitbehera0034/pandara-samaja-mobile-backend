# Admin OTP-gated login + mandatory onboarding fields

## HLD

**What**: Admin/superadmin accounts now require a mobile number (alongside
the already-required email + membership number) at creation time, and
every admin login becomes two-step: username+password, then an OTP sent
to that admin's own registered mobile via Firebase Phone Auth — exactly
the same mechanism the member app already uses, not a new SMS provider.
A first-ever successful login also triggers a welcome/onboarding email.

**Why**: The admin portal controls a live production community app with
real user data. Password-only access for staff accounts was the
remaining weak point once the email/membership_no identity rule was
already in place (see the `validateAdminIdentity` history in
`src/routes/admin.ts`). Reusing Firebase Phone Auth means zero new
infrastructure — the client-side Firebase SDK sends the real SMS, this
backend only ever verifies the resulting ID token, identical to
`POST /portal/login/firebase`.

**Rollout**: enforced immediately for all 4 existing admin accounts, not
just new ones going forward. Two of the four had neither email,
membership_no, nor a derivable mobile on file (pre-dating the
email/membership_no rule) — their mobiles were backfilled directly by
the superadmin as a one-time fix before this shipped, so nobody is locked
out. Going forward, `mobile` is enforced the same way email/membership_no
already are: required for new accounts, nag-and-self-service for
grandfathered ones (`needsMobilePrompt`).

**Key tradeoff**: no dev-console OTP bypass was built for the admin
flow (the member login has one, gated by `BYPASS_FIREBASE_OTP`). Building
a parallel non-Firebase OTP path (generate/store/print-to-console) for
local admin testing was judged not worth the added surface for a
staff-only, low-volume login path — admin login in dev goes through real
Firebase Phone Auth same as production.

## LLD

**Schema** (`migrations/023_admin_mobile.sql`): `users.mobile` (nullable
VARCHAR, app-enforced-required for new accounts — same shape as `email`/
`membership_no`, no DB-level NOT NULL/unique constraint, uniqueness
checked at the route layer via `UserModel.findByMobile`).

**Login is now two calls**:
1. `POST /api/admin/login` (existing route, changed behavior) —
   username+password+is_active checks as before, but on success issues a
   short-lived (5 min) `type: 'admin_otp_pending'` JWT instead of the real
   session token. Response: `{ success, requiresOtp: true, pendingToken,
   mobile, maskedMobile }`. `mobile` (full) is returned because the
   *client* needs it to call Firebase's `signInWithPhoneNumber` — it's
   the admin's own number, not exposing anyone else's data.
2. `POST /api/admin/login/verify-otp` (new) — body `{ pendingToken,
   idToken }`. Verifies the pending JWT, verifies the Firebase ID token
   via the same `firebaseAuth.verifyIdToken` used by member login, cross-
   checks the phone number against `users.mobile` (`endsWith` match,
   identical normalization to `auth.ts`'s existing Firebase login route).
   On match: issues the real 24h admin JWT (unchanged shape:
   `{id, username, role, type:'admin'}`), updates `last_login`, and — if
   `last_login` was previously `NULL` (this is literally their first
   successful login ever) — fires the onboarding email.

**Edge cases**:
- Pending token expires (5 min) or is tampered with → 401, admin must
  restart from step 1 (password) rather than resume mid-OTP.
- Firebase phone number doesn't match `users.mobile` → 401, same message
  shape as the member flow's mismatch case.
- An admin account somehow still has no `mobile` at login time (shouldn't
  happen post-backfill, but e.g. a future direct DB edit) → step 1
  returns a clear error rather than silently issuing a session or crashing
  on a null Firebase call.
- Onboarding email only fires once, keyed off `last_login IS NULL` at the
  moment OTP verification succeeds — no new "has been onboarded" column
  needed.

**Mobile app**: `AdminLoginScreen` becomes two screens/steps sharing one
flow (password step → OTP step), mirroring `LoginScreen`'s existing
member OTP UI shape. `AdminAuthContext` mounts its own `FirebaseRecaptcha`
instance (the component is already fully generic/reusable, not member-
specific) and exposes `adminLogin` (step 1), `adminVerifyOtp` (step 2).
`AdminUsersScreen`'s create-admin form gains a mandatory mobile field
alongside the existing email/membershipNo fields.
