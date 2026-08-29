import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import * as memberModel from '../models/memberModel';

// Pre-login "find my membership" flow — a member who's forgotten their
// membership number can look it up by a name (their own, or a family
// member's — see the search query's OR clause) plus their exact
// district/taluka/panchayat/village, and gets back a masked hint of the
// mobile number registered against that household so they can confirm
// it's really theirs before proceeding to the real login screen.
//
// This is a genuinely sensitive surface: it's the only unauthenticated
// endpoint in the app that can reveal a real membership_no (a core login
// credential) tied to a real name, correlated with even a masked mobile
// number. The safeguards below are deliberate, not incidental:
//   - ALL of name + district + taluka + panchayat + village are required
//     together — no partial/loose search that would let someone browse.
//   - Exact (case-insensitive, trimmed) name match, not "contains" — a
//     fuzzy match would make scripted enumeration far cheaper.
//   - Aggressively rate-limited per IP.
//   - Capped at a handful of results even if several households
//     genuinely match the same criteria.
//   - A miss is never distinguishable from "wrong name" vs "wrong
//     location" vs "no such member" — always the same generic empty
//     result, so a script can't use the response to narrow down which
//     part of a guess was correct.
//   - Mobile number is always masked to its last 4 digits; the full
//     number is never returned here under any circumstance.
const NAME_MATCH_SQL = `
  SELECT membership_no, name, mobile
  FROM members
  WHERE (is_banned IS NULL OR is_banned = false)
    AND LOWER(TRIM(district)) = LOWER(TRIM($1))
    AND LOWER(TRIM(taluka)) = LOWER(TRIM($2))
    AND LOWER(TRIM(panchayat)) = LOWER(TRIM($3))
    AND LOWER(TRIM(village)) = LOWER(TRIM($4))
    AND (
      LOWER(TRIM(name)) = LOWER(TRIM($5))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END
        ) AS fm
        WHERE LOWER(TRIM(fm->>'name')) = LOWER(TRIM($5))
      )
    )
  ORDER BY membership_no
  LIMIT 5
`;

function maskMobile(mobile: string | null | undefined): string {
  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length < 4) return '••••••';
  const lastFour = digits.slice(-4);
  return `${'•'.repeat(Math.max(digits.length - 4, 6))}${lastFour}`;
}

export default async function findMembershipRoutes(fastify: FastifyInstance) {
  // ── GET /api/portal/find-membership/location-options ── public —
  // same district/taluka/panchayat/village data the logged-in member
  // directory filter already exposes (aggregate location metadata, not
  // tied to any individual), just without requiring login first.
  fastify.get('/find-membership/location-options', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const filters = await memberModel.getMemberFilterOptions();
      return reply.send({ success: true, filters });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch location options' });
    }
  });

  // ── POST /api/portal/find-membership/search ──
  fastify.post('/find-membership/search', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '5 minutes',
        keyGenerator: (req: any) => req.ip,
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { name, district, taluka, panchayat, village } = (req.body as any) || {};

    if (!name?.trim() || !district?.trim() || !taluka?.trim() || !panchayat?.trim() || !village?.trim()) {
      return reply.status(400).send({
        success: false,
        message: 'name, district, taluka, panchayat and village are all required',
      });
    }

    try {
      const result = await pool.query(NAME_MATCH_SQL, [
        district.trim(), taluka.trim(), panchayat.trim(), village.trim(), name.trim(),
      ]);

      const matches = result.rows.map((row) => ({
        membershipNo: row.membership_no,
        name: row.name,
        maskedMobile: maskMobile(row.mobile),
      }));

      return reply.send({ success: true, matches });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Search failed' });
    }
  });
}
