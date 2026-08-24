# Database safety

This database holds real, live community data — thousands of real
members, and (as of this writing) 3 real posts already had to be
recovered from a Render point-in-time-recovery snapshot after 21 posts
were lost with no trace of who deleted them or when, because delete
actions were never logged and there's no soft-delete anywhere. These
rules exist specifically because of that incident, and because this
session's own working pattern (writing one-off Node scripts against
`DATABASE_URL` for diagnostics/migrations, then deleting the script) is
itself a real risk if a query is ever wrong — not just a hypothetical.

1. **Read before write, every time.** Before any `DELETE`, `UPDATE`, or
   `TRUNCATE` against production, run the equivalent `SELECT` first, show
   the exact rows and count that would be affected, and get explicit
   confirmation of that specific scope — not a general "ok to clean up
   old posts," but confirmation of the literal list.

2. **Mutations are scoped to explicit IDs, never a pattern.** No
   `WHERE text_content ILIKE '%test%'`-style conditions against real
   content tables (`portal_posts`, `candidates`, `matrimony_applications`,
   `job_postings`, etc.) — only `WHERE id IN (...)` against a list
   that's already been shown and confirmed.

3. **Destructive scripts run inside a transaction with a verify step
   before commit** — `BEGIN`, do the mutation, `SELECT` to confirm the
   result looks right, only then `COMMIT`; `ROLLBACK` on anything
   unexpected. This is how the actual post-recovery insert was done —
   make it the default, not the exception.

4. **No bulk cleanup or "delete test data" action on production without
   a fresh export first.** Render's Recovery page → Create export takes
   seconds and costs nothing. Do it before, not after something goes
   wrong.

5. **Flag structural gaps, don't silently route around them.** Two
   concrete ones already known: `portal_posts` (and other content
   tables) have no soft-delete (`deleted_at`) column, and neither member
   nor admin delete routes call `logActivity` the way `post_created` etc.
   already do. Either is a reasonable follow-up to actually build, but
   propose it explicitly rather than assume it's out of scope.

6. **When genuinely unsure whether an action is reversible, stop and say
   so** rather than proceed on the assumption it's probably fine.

# Design documentation (HLD/LLD)

For genuinely new features (a new table/domain, a new external
integration, a new ingestion pipeline — the kind of thing with real
architectural decisions behind it), write a short HLD (what it does, how
it fits the existing system, key tradeoffs) and LLD (schema, API
contracts, edge cases) before or alongside building it, and keep it in
the repo alongside `ARCHITECTURE.md`. Small fixes and route-level tweaks
don't need this.

# Release discipline

Render deploys straight from `main` on push, so a push here is already a
production deploy — there's no separate publish step to forget, unlike
the mobile app's OTA flow (see `Pandara_mobile/AGENTS.md` for the mobile
side of this: commit-before-OTA, blast-radius checks before shipping).
The same "state what was actually checked, not just that it compiled"
expectation applies here too before pushing anything non-trivial.
