import { FastifyRequest } from 'fastify';
import pool from '../config/db';

// Log this once, not on every call — the table is either migrated or it
// isn't, and this fires on nearly every authenticated request.
let warnedMissingTable = false;

export interface LogActivityParams {
  actorType: 'member' | 'admin' | 'superadmin';
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, any>;
  req?: FastifyRequest; // used to pull ip_address/user_agent, best-effort
}

function extractIp(req?: FastifyRequest): string | null {
  if (!req) return null;
  try {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0];
    }
    return req.ip || null;
  } catch {
    return null;
  }
}

function extractUserAgent(req?: FastifyRequest): string | null {
  if (!req) return null;
  try {
    const ua = req.headers['user-agent'];
    return typeof ua === 'string' ? ua : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget activity/audit log insert. This is observability, not
 * critical-path business logic — it must NEVER throw or reject, so a
 * missing `activity_log` table (pre-migration) or any other insert failure
 * is swallowed here rather than bubbling up and breaking the calling
 * request. Always `await` this at call sites so the insert has a chance to
 * complete before the response is sent, but its failure can never fail the
 * outer handler.
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  const { actorType, actorId, action, targetType, targetId, metadata, req } = params;
  try {
    await pool.query(
      `INSERT INTO activity_log (actor_type, actor_id, action, target_type, target_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actorType,
        actorId,
        action,
        targetType || null,
        targetId || null,
        metadata ? JSON.stringify(metadata) : null,
        extractIp(req),
        extractUserAgent(req),
      ]
    );
  } catch (err: any) {
    if (err?.code === '42P01') {
      // undefined_table — migrations/002_admin_dashboard_expansion.sql hasn't run yet.
      if (!warnedMissingTable) {
        console.warn('[activityLog] activity_log table missing — run migrations/002_admin_dashboard_expansion.sql. Suppressing further warnings.');
        warnedMissingTable = true;
      }
      return;
    }
    // Any other failure: never throw, just warn. Losing an audit row is
    // always preferable to breaking the feature that triggered it.
    console.warn(`[activityLog] Failed to record activity "${action}":`, err?.message || err);
  }
}
