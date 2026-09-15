// scraper/src/courseIndex.ts
// Entry point for the daily course-video check — run via `npm run
// scrape:courses` (or the GitHub Action). Separate from index.ts (the job
// scraper): different data source (YouTube Data API, not OCR'd PDFs),
// different target queue (course_lesson_submissions, not job_submissions),
// no reason to couple their failure/retry behavior. For each channel in
// the registry: fetch already-ingested source_refs, list recent uploads,
// submit new ones into the review queue. One channel's API error must
// never block the rest — same "isolate failures, keep going" discipline
// as the job scraper's per-source try/catch.
import 'dotenv/config';
import { YOUTUBE_CHANNELS } from './sources/youtubeChannels';
import { fetchLatestUploads } from './youtube';
import { fetchSeenSourceRefs, submitCourseLesson } from './submitCourse';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MAX_RESULTS_PER_CHANNEL = 5;

async function run() {
  if (!YOUTUBE_API_KEY) {
    console.error('[courseScraper] YOUTUBE_API_KEY is not set — nothing to do.');
    process.exitCode = 1;
    return;
  }

  console.log('[courseScraper] Fetching already-ingested source_refs...');
  const seen = await fetchSeenSourceRefs();
  console.log(`[courseScraper] ${seen.size} already ingested`);

  let submitted = 0;
  let skipped = 0;
  const failedChannels: string[] = [];

  for (const channel of YOUTUBE_CHANNELS) {
    try {
      console.log(`\n[${channel.channelName}] Fetching recent uploads...`);
      const videos = await fetchLatestUploads(channel.channelId, YOUTUBE_API_KEY, MAX_RESULTS_PER_CHANNEL);
      console.log(`[${channel.channelName}] Found ${videos.length} recent upload(s)`);

      for (const video of videos) {
        const sourceRef = `youtube:${video.videoId}`;
        if (seen.has(sourceRef)) continue;

        const ok = await submitCourseLesson({
          title: video.title,
          externalUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
          category: channel.category,
          channelName: channel.channelName,
          sourceRef,
        });
        if (ok) {
          console.log(`[${channel.channelName}] Submitted "${video.title}"`);
          submitted++;
        } else {
          skipped++;
        }
      }
    } catch (err) {
      // A single channel's API call failing (rate limit, deleted channel,
      // transient network issue) must never take down the channels after
      // it in the registry.
      console.error(`[${channel.channelName}] Failed, skipping:`, (err as Error).message);
      failedChannels.push(channel.channelName);
    }
  }

  console.log(`\nDone. Submitted: ${submitted}, skipped: ${skipped}, failed channels: ${failedChannels.join(', ') || 'none'}`);
  if (failedChannels.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[courseScraper] Fatal error:', err);
  process.exit(1);
});
