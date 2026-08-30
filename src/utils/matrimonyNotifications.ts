import { FastifyInstance } from 'fastify';
import pool from '../config/db';
import { broadcastPushToAllMembers } from './pushNotifications';

// Mirrors adminJobs.ts's broadcastNewJob — in-app notification row per
// member (actor_id-is-the-recipient workaround, since portal_notifications
// .actor_id is NOT NULL with a members FK and there's no admin row to point
// at) + a push notification. actor_name is set explicitly to a fixed
// system label — see broadcastNewJob's comment for why leaving it unset
// made every member see their OWN head of family credited with adding the
// candidate. Wrapped so a failure here can never fail the candidate
// creation/approval that triggered it. Shared between adminMatrimony.ts
// (direct create) and adminMatrimonyApplications.ts (approve-from-
// application), the two paths a new candidate can appear from.
export async function broadcastNewCandidate(fastify: FastifyInstance, candidate: any) {
  try {
    const label = candidate.gender?.toLowerCase() === 'male' ? 'groom' : 'bride';
    await pool.query(
      `INSERT INTO portal_notifications (recipient_id, actor_id, type, message, actor_name)
       SELECT membership_no, membership_no, 'new_candidate', $1, 'New Matrimony Profile'
       FROM members
       WHERE is_banned IS NULL OR is_banned = false`,
      [candidate.name]
    );
    broadcastPushToAllMembers(
      'New matrimony profile added',
      `${candidate.name} — a new ${label} profile is now on Pandara Matrimony`,
      { type: 'new_candidate', candidateId: String(candidate.id) }
    ).catch(() => { /* never throws, defensive only */ });
  } catch (broadcastErr) {
    fastify.log.error(broadcastErr as any, '[MATRIMONY] Failed to broadcast new candidate');
  }
}
