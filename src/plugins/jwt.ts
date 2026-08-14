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
      touchLastActive(request.user.membership_no);
    } catch (err) {
      reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
  });
});

// Real "active" signal — fires on every authenticated request (feed
// loads, member list, navigation, everything), not just explicit actions
// like posting or liking. Throttled server-side via the WHERE clause
// (self-contained, no in-memory state) so a member scrolling through the
// app for 20 minutes doesn't generate a write on every single request —
// at most one UPDATE per member per 5-minute window. Fire-and-forget:
// never awaited, never blocks the response, a failure here shouldn't
// affect the actual request being served.
function touchLastActive(membershipNo: string) {
  pool
    .query(
      `UPDATE members SET last_active_at = NOW()
       WHERE membership_no = $1 AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '5 minutes')`,
      [membershipNo]
    )
    .catch((err) => console.warn('[jwt] Failed to update last_active_at:', err.message));
}
