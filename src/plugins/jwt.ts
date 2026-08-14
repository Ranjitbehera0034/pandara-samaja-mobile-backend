import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { JWT_SECRET } from '../config/secrets';
import pool from '../config/db';

export default fp(async (fastify) => {
  fastify.register(fastifyJwt, {
    secret: JWT_SECRET,
  });

  // Decorate with authenticate helper
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      // Ensure it's a member portal token
      if (request.user?.type !== 'member_portal') {
        return reply.status(403).send({ success: false, message: 'Invalid token type' });
      }
      touchActivity(request.user.membership_no);
    } catch (err) {
      reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
  });
});

// Two related but distinct signals, updated together in one query:
//
// 1. last_active_at — "was this member active today at all." Throttled
//    to at most one write per 5-minute window (self-contained via the
//    CASE below, no in-memory state) so a long browsing session doesn't
//    write on every single request.
//
// 2. daily_request_count — "how much did they actually do today,"
//    unthrottled, reset each day. A member who opens the app and closes
//    it immediately only ever triggers the one silent /refresh call, so
//    they land on exactly 1. Anyone who navigates anywhere else —
//    browsing the feed, opening a section, even briefly — generates a
//    second request and climbs above 1. This is what actually answers
//    "did they just open it, or did they use it," which last_active_at
//    alone can't distinguish.
//
// Both fire-and-forget: never awaited, never blocks the response, a
// failure here shouldn't affect the actual request being served.
function touchActivity(membershipNo: string) {
  pool
    .query(
      `UPDATE members SET
         last_active_at = CASE
           WHEN last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '5 minutes' THEN NOW()
           ELSE last_active_at
         END,
         daily_request_count = CASE
           WHEN daily_request_count_date = CURRENT_DATE THEN daily_request_count + 1
           ELSE 1
         END,
         daily_request_count_date = CURRENT_DATE
       WHERE membership_no = $1`,
      [membershipNo]
    )
    .catch((err) => console.warn('[jwt] Failed to update activity tracking:', err.message));
}
