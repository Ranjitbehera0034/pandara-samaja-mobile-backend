import cron from 'node-cron';
import { broadcastPushToAllMembers } from './pushNotifications';

// Recurring engagement pushes for Jobs and Matrimony — requested as a
// "shaadi.com style" reminder that keeps showing up even when nothing new
// has necessarily been posted since the last one, so message wording
// rotates through a pool instead of repeating the same line every time.
// Deliberately NOT diffed against real new content — that's a different,
// more complex feature (tracking "last notified" state) than what was
// asked for here.
//
// Runs every 2 hours, but only within 8am-8pm IST (last firing at 8pm,
// comfortably inside a 9pm cutoff) — a deliberate scope decision, not the
// literal "24/7 every 2 hours" originally described, to avoid waking
// members up or notification-fatiguing them into disabling push entirely.
const SCHEDULE_CRON = '0 8,10,12,14,16,18,20 * * *';
const SCHEDULE_TIMEZONE = 'Asia/Kolkata';

const JOB_MESSAGES: { title: string; body: string }[] = [
  { title: 'New jobs waiting for you', body: 'Check out the latest government & private job postings on Pandara Samaja.' },
  { title: "Don't miss out on new openings", body: 'Fresh job postings have been added — take a look before the deadline.' },
  { title: 'Your next opportunity could be here', body: 'Browse the latest job postings shared with the Samaja.' },
  { title: 'Job alerts', body: 'New positions posted recently — open the Jobs section to see what’s new.' },
];

const MATRIMONY_MESSAGES: { title: string; body: string }[] = [
  { title: 'New profiles added', body: 'Your perfect match could be waiting — check the latest matrimony profiles.' },
  { title: 'Find your life partner', body: 'New matrimony profiles have joined Pandara Samaja recently.' },
  { title: 'Someone new is waiting to be found', body: 'Browse the latest bride & groom profiles on Pandara Matrimony.' },
  { title: 'Take a look today', body: 'New matrimony candidates have been added — your search starts here.' },
];

// Picks a pool entry by the current hour rather than a persistent counter,
// so it stays varied across firings without needing state that would
// otherwise reset every time this always-on process redeploys/restarts.
function pickByHour<T>(pool: T[]): T {
  const hour = new Date().getHours();
  return pool[hour % pool.length];
}

export function initScheduledNotifications() {
  cron.schedule(SCHEDULE_CRON, () => {
    const jobMsg = pickByHour(JOB_MESSAGES);
    broadcastPushToAllMembers(jobMsg.title, jobMsg.body, { type: 'new_job' })
      .catch(() => { /* never throws, defensive only */ });

    const matrimonyMsg = pickByHour(MATRIMONY_MESSAGES);
    broadcastPushToAllMembers(matrimonyMsg.title, matrimonyMsg.body, { type: 'new_candidate' })
      .catch(() => { /* never throws, defensive only */ });
  }, { timezone: SCHEDULE_TIMEZONE });

  console.log(`[scheduledNotifications] Recurring jobs/matrimony reminders scheduled: "${SCHEDULE_CRON}" (${SCHEDULE_TIMEZONE})`);
}
