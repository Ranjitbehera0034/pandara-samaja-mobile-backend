import nodemailer from 'nodemailer';

// Fire-and-forget email sending, mirroring the exact convention used by
// `logActivity` (src/utils/activityLog.ts) and `sendPushToMembers`
// (src/utils/pushNotifications.ts): this must NEVER throw or reject in a
// way that reaches the caller, since a missing/wrong SMTP config or a send
// failure must never break the request that triggered it (creating or
// removing an admin account).
let warnedNotConfigured = false;

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Send a single HTML email. Fire-and-forget / failure-isolated: never
 * throws. No-ops silently (after a single one-time warning) when SMTP env
 * vars (SMTP_HOST/SMTP_USER/SMTP_PASS) aren't configured, so this can be
 * left unconfigured in any environment without breaking anything.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!to) return;
  const transporter = getTransporter();
  if (!transporter) {
    if (!warnedNotConfigured) {
      console.warn('[email] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS env vars missing) — skipping email send. Set these on Render to enable.');
      warnedNotConfigured = true;
    }
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });
  } catch (err: any) {
    console.warn('[email] Failed to send email:', err?.message || err);
  }
}
