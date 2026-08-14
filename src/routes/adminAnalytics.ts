import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';

/**
 * GET /api/admin/analytics
 * Higher-level, aggregated member-activity analytics derived entirely from
 * `activity_log` (see migrations/002_admin_dashboard_expansion.sql) and
 * `members` — no new data collection. This is a separate, additive view on
 * top of the same raw log the existing `GET /admin/activity` route (see
 * adminActivity.ts) exposes; that route/screen is untouched.
 *
 * 42P01-safe: if `activity_log` hasn't been migrated yet on some
 * environment, every query below either touches that table directly or is
 * bundled into the same Promise.all as ones that do, so a single 42P01
 * (undefined_table) failure degrades the WHOLE response rather than
 * 500-ing — mirrors the exact pattern in adminActivity.ts.
 */

interface TrendPoint {
  date: string;
  count: number;
}

function buildDateRange(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function fillTrend(rows: { date: any; count: string }[], days: number): TrendPoint[] {
  const counts = new Map<string, number>();
  rows.forEach(r => {
    const key = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    counts.set(key, parseInt(r.count, 10) || 0);
  });
  return buildDateRange(days).map(date => ({ date, count: counts.get(date) || 0 }));
}

function emptyAnalytics() {
  return {
    activeMembers: { today: 0, last7Days: 0, last30Days: 0 },
    dailyActiveTrend: buildDateRange(14).map(date => ({ date, count: 0 })),
    mostActiveMembers: [] as any[],
    actionBreakdown: [] as any[],
    inactiveMembers: 0,
    newSignupsTrend: buildDateRange(30).map(date => ({ date, count: 0 })),
  };
}

export default async function adminAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.get('/analytics', { preHandler: verifyAdmin }, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [
        activeMembersRes,
        dailyTrendRes,
        mostActiveRes,
        actionBreakdownRes,
        inactiveRes,
        newSignupsRes,
      ] = await Promise.all([
        // 1. activeMembers — today / last7Days / last30Days.
        //    Uses members.last_active_at (touched on every authenticated
        //    request — see fastify.authenticate), not activity_log, since
        //    activity_log only captures explicit actions (post/like/
        //    comment/etc.) and misses plain browsing/navigation, which
        //    should count as real activity. last_active_at is a single
        //    "most recent" timestamp, not a historical log — it can
        //    answer "active within this rolling window" but not "active
        //    on this specific past day," which is why the daily trend
        //    below still has to stay on activity_log.
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE last_active_at >= CURRENT_DATE) AS today,
             COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '7 days') AS last7days,
             COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '30 days') AS last30days
           FROM members`
        ),
        // 2. dailyActiveTrend — last 14 days, gaps filled in JS below.
        pool.query(
          `SELECT date_trunc('day', created_at)::date AS date, COUNT(DISTINCT actor_id) AS count
           FROM activity_log
           WHERE actor_type = 'member' AND created_at >= NOW() - INTERVAL '14 days'
           GROUP BY 1 ORDER BY 1`
        ),
        // 3. mostActiveMembers — top 10 actor_ids by activity count, last 30 days.
        //    Name/village/district resolved via a second best-effort query below
        //    (actor_id isn't a formal FK — mirrors adminActivity.ts convention).
        pool.query(
          `SELECT actor_id, COUNT(*) AS activity_count
           FROM activity_log
           WHERE actor_type = 'member' AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY actor_id ORDER BY activity_count DESC LIMIT 10`
        ),
        // 4. actionBreakdown — counts per action type, last 30 days.
        pool.query(
          `SELECT action, COUNT(*) AS count
           FROM activity_log
           WHERE actor_type = 'member' AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY action ORDER BY count DESC`
        ),
        // 5. inactiveMembers — non-banned members not active (per
        //    last_active_at, same definition as activeMembers above) in 30
        //    days. Kept consistent with the fix above — a member who logs
        //    in and browses daily but never posts/likes/comments should
        //    not be flagged inactive just because activity_log never saw
        //    an explicit action from them.
        pool.query(
          `SELECT COUNT(*) FROM members m
           WHERE (m.is_banned IS NULL OR m.is_banned = false)
           AND (m.last_active_at IS NULL OR m.last_active_at < NOW() - INTERVAL '30 days')`
        ),
        // 6. newSignupsTrend — last 30 days from members.created_at, gaps filled in JS below.
        pool.query(
          `SELECT date_trunc('day', created_at)::date AS date, COUNT(*) AS count
           FROM members
           WHERE created_at >= NOW() - INTERVAL '30 days'
           GROUP BY 1 ORDER BY 1`
        ),
      ]);

      // Best-effort display-name/location resolution for the top-10 actor_ids
      // — a missing member row (or the query itself failing) must never fail
      // the whole request, same defensive convention as adminActivity.ts.
      const actorIds: string[] = mostActiveRes.rows.map((r: any) => r.actor_id);
      let memberRows: any[] = [];
      if (actorIds.length > 0) {
        try {
          const m = await pool.query(
            `SELECT membership_no, name, village, district FROM members WHERE membership_no = ANY($1)`,
            [actorIds]
          );
          memberRows = m.rows;
        } catch {
          // best effort only — leave memberRows empty, names fall back below.
        }
      }
      const memberMap = new Map(memberRows.map((m: any) => [m.membership_no, m]));
      const mostActiveMembers = mostActiveRes.rows.map((r: any) => {
        const m = memberMap.get(r.actor_id);
        return {
          membership_no: r.actor_id,
          activity_count: parseInt(r.activity_count, 10) || 0,
          name: m?.name || null,
          village: m?.village || null,
          district: m?.district || null,
        };
      });

      const activeRow = activeMembersRes.rows[0] || { today: 0, last7days: 0, last30days: 0 };

      return reply.send({
        success: true,
        analytics: {
          activeMembers: {
            today: parseInt(activeRow.today, 10) || 0,
            last7Days: parseInt(activeRow.last7days, 10) || 0,
            last30Days: parseInt(activeRow.last30days, 10) || 0,
          },
          dailyActiveTrend: fillTrend(dailyTrendRes.rows, 14),
          mostActiveMembers,
          actionBreakdown: actionBreakdownRes.rows.map((r: any) => ({
            action: r.action,
            count: parseInt(r.count, 10) || 0,
          })),
          inactiveMembers: parseInt(inactiveRes.rows[0]?.count, 10) || 0,
          newSignupsTrend: fillTrend(newSignupsRes.rows, 30),
        },
      });
    } catch (err: any) {
      if (err.code === '42P01') {
        return reply.send({ success: true, analytics: emptyAnalytics(), migrationPending: true });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch analytics' });
    }
  });
}
