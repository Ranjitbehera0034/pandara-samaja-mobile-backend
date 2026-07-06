import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import * as communityModel from '../models/communityModel';

export default async function eventsRoutes(fastify: FastifyInstance) {
  // Require portal authentication for all events routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/events ──
  // Fetch all community events, mapping rsvp_count to attendees_count and attaching registered_by_me boolean.
  fastify.get('/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const memberId = req.user.membership_no;
    try {
      const res = await pool.query(
        `SELECT e.*, 
                COUNT(DISTINCT r.member_id) as rsvp_count, 
                m.name as creator_name,
                EXISTS (
                  SELECT 1 FROM portal_community_event_rsvps 
                  WHERE event_id = e.id AND member_id = $1
                ) as registered_by_me
         FROM portal_community_events e
         LEFT JOIN portal_community_event_rsvps r ON e.id = r.event_id
         LEFT JOIN members m ON e.created_by = m.membership_no
         GROUP BY e.id, m.name
         ORDER BY e.event_date ASC`,
        [memberId]
      );

      const events = res.rows.map(row => ({
        ...row,
        attendees_count: parseInt(row.rsvp_count, 10),
        registered_by_me: row.registered_by_me,
      }));

      return reply.send({
        success: true,
        events,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch events' });
    }
  });

  // ── POST /api/portal/events/:id/register ──
  // Register RSVP for an event
  fastify.post('/events/:id/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const memberId = req.user.membership_no;

    try {
      // Check if event exists
      const eventRes = await pool.query('SELECT 1 FROM portal_community_events WHERE id = $1', [id]);
      if (eventRes.rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Event not found' });
      }

      await communityModel.rsvpEvent(id, memberId);

      return reply.send({
        success: true,
        message: 'RSVP registered successfully',
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to register RSVP' });
    }
  });
}
