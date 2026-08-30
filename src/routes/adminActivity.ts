import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';
import { resolveActorNames } from '../utils/activityLog';

/**
 * GET /api/admin/activity
 * Audit trail tracker over `activity_log` (see
 * migrations/002_admin_dashboard_expansion.sql). 42P01-safe: returns an
 * empty, non-crashing response if the migration hasn't run yet.
 *
 * Critical access rule: plain 'admin' role can only ever see member
 * activity — never other admins'/superadmins' activity. Only 'superadmin'
 * can see admin/superadmin rows (or everything, if actorType is omitted).
 */
export default async function adminActivityRoutes(fastify: FastifyInstance) {
  fastify.get('/activity', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', actorType, actorId, action, startDate, endDate } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    const requesterRole = (req.user as any).role;

    // Plain admins may only ever see member activity — silently force this
    // regardless of what the query string asked for. Only superadmin may
    // request 'admin'/'superadmin' rows (or omit actorType for everything).
    let effectiveActorType = actorType;
    if (requesterRole !== 'superadmin') {
      effectiveActorType = 'member';
    }

    const conditions: string[] = [];
    const params: any[] = [];
    if (effectiveActorType) {
      params.push(effectiveActorType);
      conditions.push(`actor_type = $${params.length}`);
    }
    if (actorId) {
      params.push(actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (action) {
      params.push(action);
      conditions.push(`action = $${params.length}`);
    }
    if (startDate) {
      params.push(startDate);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (endDate) {
      // Inclusive of the whole end day — endDate is a plain 'YYYY-MM-DD',
      // so add a day and use < rather than trying to splice in 23:59:59.
      params.push(endDate);
      conditions.push(`created_at < ($${params.length}::date + interval '1 day')`);
    }
    const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const listParams = [...params, pLimit, offset];
      const res = await pool.query(
        `SELECT * FROM activity_log
         ${wherePart}
         ORDER BY created_at DESC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      );

      const activities = await resolveActorNames(res.rows);

      let total: number | null = null;
      try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM activity_log ${wherePart}`, params);
        total = parseInt(countRes.rows[0].count, 10);
      } catch {
        // non-fatal — page/limit still work without a total
      }

      return reply.send({
        success: true,
        activities,
        page: pPage,
        limit: pLimit,
        total,
        totalPages: total !== null ? Math.ceil(total / pLimit) : null,
      });
    } catch (err: any) {
      if (err.code === '42P01') {
        return reply.send({ success: true, activities: [], migrationPending: true });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch activity log' });
    }
  });

  // ── GET /api/admin/activity/actions ── distinct action values present in
  // the log, for the filter picker's option list. Queried dynamically
  // (rather than hardcoded) so a newly-added action type shows up here
  // automatically once it's actually been logged once, no app update
  // needed. Same actorType restriction as the main list — a plain admin
  // shouldn't see action types that only ever apply to other admins.
  fastify.get('/activity/actions', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const requesterRole = (req.user as any).role;
    try {
      const params: any[] = [];
      let wherePart = '';
      if (requesterRole !== 'superadmin') {
        params.push('member');
        wherePart = `WHERE actor_type = $1`;
      }
      const res = await pool.query(
        `SELECT DISTINCT action FROM activity_log ${wherePart} ORDER BY action`,
        params
      );
      return reply.send({ success: true, actions: res.rows.map(r => r.action) });
    } catch (err: any) {
      if (err.code === '42P01') {
        return reply.send({ success: true, actions: [] });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch action types' });
    }
  });
}
