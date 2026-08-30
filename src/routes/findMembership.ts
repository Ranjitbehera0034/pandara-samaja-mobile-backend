import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import * as memberModel from '../models/memberModel';

// Pre-login "find my membership" flow — a member who's forgotten their
// membership number can look it up by a name (their own, or a family
// member's — see the search query's OR clause) plus their district and
// taluka; panchayat and village are optional narrowing filters, not
// required. Returns a masked hint of the mobile number registered
// against the matched person so they can confirm it's really theirs
// before proceeding to the real login screen.
//
// This is a genuinely sensitive surface: it's the only unauthenticated
// endpoint in the app that can reveal a real membership_no (a core login
// credential) tied to a real name, correlated with even a masked mobile
// number. The safeguards below are deliberate, not incidental:
//   - name + district + taluka are required together — no partial/loose
//     search that would let someone browse by location alone.
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
function buildNameMatchQuery(hasPanchayat: boolean, hasVillage: boolean) {
  let idx = 3; // $1 = district, $2 = taluka
  const conditions = [
    `LOWER(TRIM(district)) = LOWER(TRIM($1))`,
    `LOWER(TRIM(taluka)) = LOWER(TRIM($2))`,
  ];
  let panchayatIdx = -1;
  let villageIdx = -1;
  if (hasPanchayat) { panchayatIdx = idx++; conditions.push(`LOWER(TRIM(panchayat)) = LOWER(TRIM($${panchayatIdx}))`); }
  if (hasVillage) { villageIdx = idx++; conditions.push(`LOWER(TRIM(village)) = LOWER(TRIM($${villageIdx}))`); }
  const nameIdx = idx++;
  conditions.push(`(
      LOWER(TRIM(name)) = LOWER(TRIM($${nameIdx}))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END
        ) AS fm
        WHERE LOWER(TRIM(fm->>'name')) = LOWER(TRIM($${nameIdx}))
      )
    )`);

  const sql = `
    SELECT membership_no, name, mobile, family_members
    FROM members
    WHERE (is_banned IS NULL OR is_banned = false)
      AND ${conditions.join('\n      AND ')}
    ORDER BY membership_no
    LIMIT 5
  `;
  return { sql, nameIdx, panchayatIdx, villageIdx };
}

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

    if (!name?.trim() || !district?.trim() || !taluka?.trim()) {
      return reply.status(400).send({
        success: false,
        message: 'name, district and taluka are required',
      });
    }

    const hasPanchayat = !!panchayat?.trim();
    const hasVillage = !!village?.trim();
    const { sql, nameIdx, panchayatIdx, villageIdx } = buildNameMatchQuery(hasPanchayat, hasVillage);

    const params: string[] = [district.trim(), taluka.trim()];
    if (hasPanchayat) params[panchayatIdx - 1] = panchayat.trim();
    if (hasVillage) params[villageIdx - 1] = village.trim();
    params[nameIdx - 1] = name.trim();

    try {
      const result = await pool.query(sql, params);

      const searchNameLower = name.trim().toLowerCase();

      // The WHERE clause matches on EITHER the head's own name or a family
      // member's name — but a household row's own name/mobile columns are
      // always the HEAD's, regardless of which identity actually matched.
      // Resolve to whichever person really matched: if it's a family member
      // who has their own mobile on file, surface THEIR name+mobile, not
      // the head's. Only fall back to the head's when the matched family
      // member has no mobile of their own registered (nothing else to show).
      const matches = result.rows.map((row) => {
        const headMatches = (row.name || '').trim().toLowerCase() === searchNameLower;

        let resultName = row.name;
        let resultMobile = row.mobile;

        if (!headMatches) {
          const familyArray = Array.isArray(row.family_members)
            ? row.family_members
            : JSON.parse(row.family_members || '[]');
          const matchedMember = familyArray.find(
            (fm: any) => (fm?.name || '').trim().toLowerCase() === searchNameLower
          );
          if (matchedMember?.mobile?.trim()) {
            resultName = matchedMember.name;
            resultMobile = matchedMember.mobile;
          }
          // else: matched family member has no mobile of their own —
          // fall back to the head's name+mobile (already set above).
        }

        return {
          membershipNo: row.membership_no,
          name: resultName,
          maskedMobile: maskMobile(resultMobile),
        };
      });

      return reply.send({ success: true, matches });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Search failed' });
    }
  });
}
