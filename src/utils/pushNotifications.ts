import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import pool from '../config/db';

// Fire-and-forget OS-level push notification sending, mirroring the exact
// convention used by `logActivity` in `src/utils/activityLog.ts`: this must
// NEVER throw or reject in a way that reaches the caller, since a push-send
// failure (bad token, Expo outage, missing push_token column pre-migration,
// etc.) must never break the request that triggered it (posting, liking,
// commenting, following, messaging, or announcing).
let warnedMissingColumn = false;

const expo = new Expo();

/**
 * Shared internal helper: given a list of {membershipNo, token} rows, build
 * Expo push messages and send them in Expo's recommended chunks (~100 per
 * batch), checking tickets for immediate DeviceNotRegistered errors so a
 * dead token doesn't fail the whole batch. Never throws.
 */
async function sendToTokens(
  rows: { membership_no: string; push_token: string }[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  if (rows.length === 0) return;

  const messages: ExpoPushMessage[] = [];
  for (const row of rows) {
    const token = row.push_token;
    if (!token || !Expo.isExpoPushToken(token)) {
      continue;
    }
    messages.push({
      to: token,
      sound: 'default',
      title,
      body,
      data: data || {},
    });
  }

  if (messages.length === 0) return;

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (err: any) {
        // A single chunk failing (network blip, Expo outage) should not
        // stop the remaining chunks from being attempted.
        console.warn('[pushNotifications] Failed to send a push chunk:', err?.message || err);
      }
    }
  } catch (err: any) {
    console.warn('[pushNotifications] Failed to chunk/send push notifications:', err?.message || err);
  }
}

/**
 * Send a push notification to a specific set of members, identified by
 * membership_no. Looks up their currently-stored Expo push token and skips
 * anyone without one (never registered, logged out, or on a simulator).
 *
 * Fire-and-forget / failure-isolated: never throws.
 */
export async function sendPushToMembers(
  membershipNos: string[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  if (!membershipNos || membershipNos.length === 0) return;

  try {
    const res = await pool.query(
      `SELECT membership_no, push_token FROM members WHERE membership_no = ANY($1) AND push_token IS NOT NULL`,
      [membershipNos]
    );
    await sendToTokens(res.rows, title, body, data);
  } catch (err: any) {
    if (err?.code === '42703') {
      // undefined_column — migrations/005_push_notifications.sql hasn't run yet.
      if (!warnedMissingColumn) {
        console.warn('[pushNotifications] members.push_token column missing — run migrations/005_push_notifications.sql. Suppressing further warnings.');
        warnedMissingColumn = true;
      }
      return;
    }
    console.warn('[pushNotifications] Failed to send push to members:', err?.message || err);
  }
}

/**
 * Broadcast a push notification to every member with a registered push
 * token (used for community-wide announcements, and for new post/story
 * pushes — see feed.ts). Excludes banned members, and optionally the
 * actor themselves so posting/adding a story doesn't push-notify the
 * person who just did it.
 *
 * Fire-and-forget / failure-isolated: never throws.
 */
export async function broadcastPushToAllMembers(
  title: string,
  body: string,
  data?: Record<string, any>,
  excludeMembershipNo?: string
): Promise<void> {
  try {
    const res = await pool.query(
      `SELECT membership_no, push_token FROM members
       WHERE push_token IS NOT NULL AND (is_banned IS NULL OR is_banned = false)
         AND ($1::text IS NULL OR membership_no != $1)`,
      [excludeMembershipNo || null]
    );
    await sendToTokens(res.rows, title, body, data);
  } catch (err: any) {
    if (err?.code === '42703') {
      if (!warnedMissingColumn) {
        console.warn('[pushNotifications] members.push_token column missing — run migrations/005_push_notifications.sql. Suppressing further warnings.');
        warnedMissingColumn = true;
      }
      return;
    }
    console.warn('[pushNotifications] Failed to broadcast push to all members:', err?.message || err);
  }
}
