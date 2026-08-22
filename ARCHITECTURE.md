# Architecture notes

Working notes on patterns this codebase actually follows, written down so
the next feature reuses them instead of reinventing them. Not a full
system design doc — just the parts that would otherwise only live in one
person's head or in old commit messages.

## Content features: the house pattern

Two structurally different approaches exist in this codebase for
"content that isn't authored by an admin typing into a form":

**News** (separate repo, `Pandara_news_backend`) — RSS feeds are parsed
and served directly, no human review at all. This is only safe because
it's a verbatim mirror of already-public wire content: the source
publication is the one accountable for accuracy, and there's no
user-generated or automatically-extracted content involved.

**Jobs** (this repo, `job_postings`/`job_submissions`) — the actual house
pattern for everything else. Three ways content enters, all funneled
through the same gate before anything is visible to members:

1. **Member submission** → `job_submissions` (status `pending`) →
   admin approves → copied into `job_postings` (published) or rejected
   with a required remark. Mirrors `matrimony_applications` →
   `candidates`, the original precedent for this split.
2. **Admin direct-create** → straight into `job_postings`, pre-approved
   (the admin *is* the review).
3. **Automated ingestion** (`scraper/`, OCR'd government notices) → also
   lands in `job_submissions`, tagged with a `source_ref` for dedup —
   **never publishes directly**, no matter how confident the extraction
   is. A misread deadline or eligibility detail is a real harm to a real
   applicant; the review queue is the safety net for that, not a
   formality.

Once published, content stays moderatable: `moderation_status` +
per-post `_reports` table (`job_reports`, mirrors `portal_story_reports`)
lets members flag a live listing, which sets `moderation_status =
'hidden_pending_review'` and routes it back to an admin queue —
`approve` restores it (report was unfounded), `reject` deletes it
permanently (mirrors `portal_stories`' existing moderation shape exactly,
see `migrations/011_story_likes_comments.sql`).

**For the next content feature**: if it involves anything a member
submits, anything scraped/OCR'd/automatically extracted, or anything
that could be reported as fraudulent/inappropriate — copy the jobs
shape (submissions queue + moderation_status + reports table), not
news's. News's zero-review shape is the deliberate exception, justified
specifically by "we're mirroring an already-public, already-accountable
source verbatim" — that justification doesn't transfer to a new feature
just because it's also "content."

## Reliability

**Render Hobby-tier hibernation**: both backends idle-sleep after 15
minutes with no traffic. Fixed with an in-process `setInterval`
self-pinging `/health` every 4 minutes (`Pandara_news_backend/src/server.ts`,
this repo's `src/server.ts`) — proven more reliable than a GitHub Actions
cron backup, which was measured landing 15-40 minutes apart against a
5-minute schedule (GitHub deprioritizes frequent scheduled workflows
under load). A new backend service should get this same self-ping from
day one, not after the first hibernation complaint.

**No monitoring exists beyond that.** Nothing alerts if a backend
actually goes down (self-ping only prevents idle sleep — it doesn't
detect a crash, a bad deploy, or a DB outage). External uptime
monitoring (UptimeRobot or similar, pinging `/health` on both backends)
closes this gap and is the recommended next step, not yet done as of
this writing.

## Shipping

**OTA vs. native build**: pure JS/TS changes ship via `eas update`;
anything touching a new/changed native module needs a real `eas build`.
Getting this wrong once (native-dependent code reachable from an
always-rendered component, shipped via OTA) crashed the app for every
user on launch — see git history around the `react-native-vision-camera`
integration for the incident and recovery.

**Two channels, one command**: `production` (real members) and
`preview` (test builds) are separate channels requiring separate
publishes — `npm run publish:ota -- "<message>"`
(`Pandara_mobile/scripts/publish-ota.sh`) publishes to both in one
step. Use it instead of calling `eas update` by hand, which is exactly
how a previous publish reached production but silently missed preview.
