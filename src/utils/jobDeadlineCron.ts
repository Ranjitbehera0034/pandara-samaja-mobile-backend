import cron from 'node-cron';
import pool from '../config/db';
import { broadcastPushToAllMembers } from './pushNotifications';

// Daily check for job postings whose application deadline (expires_at,
// auto-derived from the free-text last_date — see lastDateParse.ts) is
// about to pass. Sends one push + one in-app portal_notifications row per
// member, then marks reminder_sent_at so it never re-sends for the same
// deadline (jobModel.updatePosting clears reminder_sent_at if the deadline
// itself changes, so an extended deadline gets its own reminder later).
// Hiding the posting from members once the deadline has actually passed is
// NOT this job's responsibility — that already happens for free at read
// time via the existing `expires_at IS NULL OR expires_at > NOW()` filter
// in jobModel.listPublished/getPostingById.
const SCHEDULE_CRON = '30 9 * * *'; // 9:30am IST daily
const SCHEDULE_TIMEZONE = 'Asia/Kolkata';

async function sendDeadlineReminders() {
  const { rows: jobs } = await pool.query(
    `SELECT id, title, category FROM job_postings
     WHERE moderation_status = 'visible'
       AND expires_at IS NOT NULL
       AND expires_at > NOW()
       AND expires_at <= NOW() + INTERVAL '1 day'
       AND reminder_sent_at IS NULL`
  );

  for (const job of jobs) {
    try {
      await pool.query(
        `INSERT INTO portal_notifications (recipient_id, actor_id, type, post_id, message, actor_name)
         SELECT membership_no, membership_no, 'job_deadline_reminder', $1, $2, 'Job Deadline Reminder'
         FROM members
         WHERE is_banned IS NULL OR is_banned = false`,
        [String(job.id), job.title]
      );
      await broadcastPushToAllMembers(
        'Application deadline is tomorrow',
        job.title,
        { type: 'job_deadline_reminder', jobId: String(job.id) }
      ).catch(() => { /* never throws, defensive only */ });
      await pool.query(`UPDATE job_postings SET reminder_sent_at = NOW() WHERE id = $1`, [job.id]);
    } catch (err) {
      console.error('[jobDeadlineCron] Failed to send reminder for job', job.id, err);
    }
  }
}

export function initJobDeadlineReminders() {
  cron.schedule(SCHEDULE_CRON, () => {
    sendDeadlineReminders().catch(err => console.error('[jobDeadlineCron] Run failed:', err));
  }, { timezone: SCHEDULE_TIMEZONE });

  console.log(`[jobDeadlineCron] Job deadline reminders scheduled: "${SCHEDULE_CRON}" (${SCHEDULE_TIMEZONE})`);
}
