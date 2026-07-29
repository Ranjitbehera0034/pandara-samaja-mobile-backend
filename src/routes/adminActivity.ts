import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';

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
    const { page = '1', limit = '20', actorType, actorId, action } = req.query as any;
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

      // Best-effort display-name resolution per actor — a missed join must
      // never fail the whole request.
      const activities = await Promise.all(res.rows.map(async (row: any) => {
        let actorName: string | null = null;
        try {
          if (row.actor_type === 'member') {
            const m = await pool.query('SELECT name FROM members WHERE membership_no = $1', [row.actor_id]);
            actorName = m.rows[0]?.name || null;
          } else {
            const u = await pool.query('SELECT username FROM users WHERE id::text = $1', [row.actor_id]);
            actorName = u.rows[0]?.username || null;
          }
        } catch {
          // ignore — best effort only
        }
        return { ...row, actor_name: actorName };
      }));

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
}
