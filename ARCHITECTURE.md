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

## Courses (`courses` / `course_lessons`, migration 025)

Free skill-building + govt-exam-prep content, curated by admins from
existing external platforms (YouTube, Udemy, Coursera, etc.) rather than
video this app hosts itself. A "lesson" is a title + platform + external
URL; tapping one opens that platform's own app/browser — the same
"leave the app for the real thing" shape already used for job
application links and news articles. Two decisions this rules out, worth
recording so they aren't relitigated silently by a future change:

- **No self-hosted video.** Firebase Storage bills egress per view, which
  scales badly for long-form course video watched repeatedly — unlike a
  feed post/story, which is watched once by a scrolling audience.
- **No YouTube embedding with ad-blocking.** Interfering with ads on
  embedded YouTube content — even to make the experience consistent
  across devices — violates YouTube's Terms of Service and risks the
  app's API access/channel. Linking out entirely sidesteps this: this
  app never renders the video or its ads at all, so it's also never the
  one deciding whether an ad shows.

Content shape follows **Announcements**, not **Jobs**, for anything an
admin adds by hand: admin-authored only, no member-submission queue, no
`moderation_status`/reports table. An admin curating a link to an
existing public course is the same trust level as an admin writing an
announcement.

**Update (migration 029):** that stopped being the whole picture once an
automated source was added — `course_lesson_submissions` is a genuine
Jobs-shape review queue, just fed by a daily YouTube-channel check
(`scraper/src/sources/youtubeChannels.ts`) instead of member submissions
or OCR'd PDFs. Same reasoning as Jobs': an off-topic or wrongly-classified
video reaching members with no human check is the same failure mode a
misread job deadline is, so nothing the scraper finds is auto-published —
`courseLessonSubmissionModel.approveSubmission()` creates the real
`course_lessons` row (attached to an existing course or a fresh one)
only once an admin approves it in `AdminCourseLessonSubmissionsScreen`.
Hand-added courses/lessons via the admin panel still skip this queue
entirely — the split is by *source* (admin-typed vs. scraper-discovered),
not by feature.

## Song Competition (`song_contests` / `song_contest_entries` / `_likes` / `_comments`, migration 027)

Admin launches a contest (draft -> active -> closed); once active, members
register solo or as a group and upload a performance video; every video is
admin-approved before it's visible for the community to like/comment on.
This is genuinely member-submitted public content (unlike Courses), so it
follows the **Jobs shape** from the pattern above: `moderation_status`
gates visibility, same as `job_postings`/`portal_posts`.

Decisions worth recording so they aren't relitigated silently:

- **One group entry per village, enforced by a partial unique index**
  (`contest_id, LOWER(TRIM(village))`) rather than application-code
  checking — a race between two near-simultaneous submissions from the
  same village can't both succeed. Case/whitespace-insensitive because
  real village data in this DB has known inconsistencies (`Gothagam` vs
  `GOTHAGON`, flagged during an earlier "list all villages" task) — an
  exact-match constraint would let a typo silently bypass the rule. A
  rejected entry frees the village's slot back up; a pending one doesn't.
- **One entry per person per contest** (captain or individual, same
  constraint pattern) — prevents one member submitting multiple entries.
  Not explicitly requested; revisit if a real need for multiple entries
  per person comes up.
- **Rounds are deliberately not modeled yet.** The number/structure of
  further rounds depends on how many people actually register — only
  registration, upload, moderation, and the public like/comment round are
  built now. Don't add round/advancement schema speculatively; wait for
  the real registration numbers to shape what "next step" means.
- **Video hosting is Firebase Storage**, same as Courses' decision and
  for the same reason (matches existing infra, ships fastest) — but this
  feature is a much heavier bandwidth case than Courses (potentially many
  participants, each video rewatched repeatedly by voters comparing
  entries), so it's the more likely of the two to actually need
  revisiting if real usage makes the cost show up.
- **Likes are the public signal, not necessarily the sole judging
  criterion** — `song_contest_likes` records who liked what (one per
  person, membership_no + mobile scoped like every other per-person
  interaction table here), but nothing in this schema forces advancement
  to be purely vote-count-driven; that decision lives wherever "next
  step" logic eventually gets built.

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
