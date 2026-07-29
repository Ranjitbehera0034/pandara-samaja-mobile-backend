import db from '../config/db';

/* ─────────────── READ / BROWSE ─────────────── */

interface BrowseFilters {
  viewerMembershipNo: string;
  genderNotEqual?: string; // browse candidates of the opposite gender by default
  search?: string;
  minAge?: number;
  maxAge?: number;
  education?: string;
  gotra?: string;
  sort?: 'newest' | 'age_asc' | 'age_desc' | 'name';
  limit?: number;
  offset?: number;
}

export const browse = (filters: BrowseFilters): Promise<any> => {
  const params: any[] = [filters.viewerMembershipNo];
  const conditions = [
    "status = 'approved'",
    // Don't show the viewer their own submitted profile(s), and hide
    // anything they've already swiped on.
    'author_id IS DISTINCT FROM $1',
    `NOT EXISTS (SELECT 1 FROM portal_matrimony_interests i WHERE i.candidate_id = candidates.id AND i.member_id = $1)`,
  ];
  // NOTE: an `is_matched = false` exclusion used to live here, but
  // `is_matched` is not a real column on the production `candidates` table
  // (see migrations/003_matrimony_real_schema_fix.sql investigation notes —
  // only `matched_status`/`matched_partner_member_id`/`match_date` exist,
  // and those belong to a separate web-app admin-review workflow this task
  // was told not to touch). Keeping the phantom condition would have kept
  // browse() 500ing exactly like submitted_by/form_url did, so it's removed
  // here rather than guessed at. Flagged for follow-up in the task report.

  if (filters.genderNotEqual) {
    params.push(filters.genderNotEqual);
    conditions.push(`gender != $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(gotra) LIKE LOWER($${idx}) OR LOWER(occupation) LIKE LOWER($${idx}) OR LOWER(education) LIKE LOWER($${idx}))`);
  }
  if (filters.minAge !== undefined) {
    params.push(filters.minAge);
    conditions.push(`age >= $${params.length}`);
  }
  if (filters.maxAge !== undefined) {
    params.push(filters.maxAge);
    conditions.push(`age <= $${params.length}`);
  }
  if (filters.education) {
    params.push(`%${filters.education}%`);
    conditions.push(`LOWER(education) LIKE LOWER($${params.length})`);
  }
  if (filters.gotra) {
    params.push(filters.gotra);
    conditions.push(`gotra = $${params.length}`);
  }

  const sortMap: Record<string, string> = {
    newest: 'created_at DESC',
    age_asc: 'age ASC',
    age_desc: 'age DESC',
    name: 'name ASC',
  };
  const orderBy = sortMap[filters.sort || 'newest'] || sortMap.newest;

  const limit = Math.min(filters.limit ?? 20, 50);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return db.query(
    `SELECT * FROM candidates
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getById = (id: number | string): Promise<any> =>
  db.query('SELECT * FROM candidates WHERE id = $1', [id]);

export const getBySubmitter = (membershipNo: string): Promise<any> =>
  db.query('SELECT * FROM candidates WHERE author_id = $1 ORDER BY created_at DESC', [membershipNo]);

/* ─────────────── CREATE / UPDATE (self-service) ────────────── */

// `age` (integer) and `dob` (date) reject empty strings with Postgres
// 22P02 (invalid_text_representation) -> uncaught 500. Sanitize here so
// both the member self-service route and the admin routes are covered by
// a single fix, regardless of what a request body happens to send.
const sanitizeAge = (age: any): number | null => {
  if (age === undefined || age === null || age === '') return null;
  const parsed = parseInt(age, 10);
  return isNaN(parsed) ? null : parsed;
};

const sanitizeDob = (dob: any): string | null => dob || null;

export const createCandidate = (data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo, photos, formUrl, submittedBy
  } = data;

  return db.query(
    `INSERT INTO candidates
      (name, gender, dob, age, height, blood_group, gotra, bansha, education,
       technical_education, professional_education, occupation, father, mother,
       address, phone, email, photo, photos, manual_form, author_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'approved')
     RETURNING *`,
    [name, gender, sanitizeDob(dob), sanitizeAge(age), height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo || null, photos || [], formUrl || null, submittedBy]
  );
};

export const updateCandidate = (id: number | string, data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo, photos, formUrl
  } = data;

  return db.query(
    `UPDATE candidates SET
       name=$1, gender=$2, dob=$3, age=$4, height=$5, blood_group=$6,
       gotra=$7, bansha=$8, education=$9, technical_education=$10,
       professional_education=$11, occupation=$12, father=$13, mother=$14,
       address=$15, phone=$16, email=$17,
       photo=COALESCE($18, photo), photos=COALESCE($19, photos), manual_form=COALESCE($20, manual_form)
     WHERE id=$21
     RETURNING *`,
    [name, gender, sanitizeDob(dob), sanitizeAge(age), height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo || null, photos || null, formUrl || null, id]
  );
};

// NOTE: unused/uncalled by any route today. Kept for potential future use,
// but flagged: `is_matched`/`matched_partner_name`/`matched_partner_gender`
// are NOT real columns on the production `candidates` table (same category
// of bug as submitted_by/form_url — see migrations/003 investigation
// notes). The real analogues are `matched_status`/`matched_partner_member_id`,
// which belong to an existing web-app admin-review workflow this task was
// told to leave alone. Left as-is (not deleted, not migrated) rather than
// guessing at how it should map — see task summary for the flag.
export const markMatched = (id: number | string, partnerName: string, partnerGender: string): Promise<any> => {
  return db.query(
    `UPDATE candidates
     SET is_matched = true, matched_partner_name = $1, matched_partner_gender = $2
     WHERE id = $3
     RETURNING *`,
    [partnerName, partnerGender, id]
  );
};

export const remove = (id: number | string): Promise<any> =>
  db.query('DELETE FROM candidates WHERE id = $1', [id]);

/* ─────────────── ADMIN MANAGEMENT ────────────── */

// Permanent delete, used by the admin matrimony management routes.
export const deleteCandidate = (id: number | string): Promise<any> =>
  db.query('DELETE FROM candidates WHERE id = $1 RETURNING id', [id]);

// Used by the admin ban/unban toggle — 'banned' hides a candidate from
// browse() with zero migration needed since browse() already filters on
// status = 'approved'.
export const setStatus = (id: number | string, status: string): Promise<any> =>
  db.query('UPDATE candidates SET status = $1 WHERE id = $2 RETURNING *', [status, id]);

// Admin listing: any status, searchable, paginated — unlike browse() this
// has no viewer-relative exclusions (no gender/self/swiped filtering).
interface AdminListFilters {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export const adminList = (filters: AdminListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(gotra) LIKE LOWER($${idx}) OR LOWER(occupation) LIKE LOWER($${idx}) OR LOWER(education) LIKE LOWER($${idx}) OR phone LIKE $${idx})`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return db.query(
    `SELECT * FROM candidates
     ${wherePart}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const adminCount = async (filters: Omit<AdminListFilters, 'limit' | 'offset'>): Promise<number> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(gotra) LIKE LOWER($${idx}) OR LOWER(occupation) LIKE LOWER($${idx}) OR LOWER(education) LIKE LOWER($${idx}) OR phone LIKE $${idx})`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(`SELECT COUNT(*) FROM candidates ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

/* ─────────────── SWIPE / INTEREST TRACKING ────────────── */

// Records a like/pass and, on 'like', checks whether it's a mutual match:
// the viewer's own submitted candidate must have also been liked by
// someone from the target candidate's submitting member.
export const recordSwipe = async (
  memberId: string,
  candidateId: number | string,
  direction: 'like' | 'pass'
): Promise<{ matched: boolean }> => {
  await db.query(
    `INSERT INTO portal_matrimony_interests (candidate_id, member_id, direction)
     VALUES ($1, $2, $3)
     ON CONFLICT (candidate_id, member_id) DO UPDATE SET direction = $3, created_at = NOW()`,
    [candidateId, memberId, direction]
  );

  if (direction !== 'like') return { matched: false };

  // Who submitted the candidate the viewer just liked?
  const targetRes = await db.query('SELECT author_id FROM candidates WHERE id = $1', [candidateId]);
  const targetOwner = targetRes.rows[0]?.author_id;
  if (!targetOwner) return { matched: false };

  // Did that owner's own candidate profile(s) already like one of the
  // viewer's submitted candidate profiles?
  const mutualRes = await db.query(
    `SELECT 1
     FROM portal_matrimony_interests i
     JOIN candidates viewerCandidate ON viewerCandidate.id = i.candidate_id
     WHERE i.member_id = $1 AND i.direction = 'like' AND viewerCandidate.author_id = $2
     LIMIT 1`,
    [targetOwner, memberId]
  );
  return { matched: mutualRes.rows.length > 0 };
};

// A mutual match: I liked `target` (submitted by some other member), AND
// that member separately liked one of my own submitted candidate profiles.
export const getMatches = (memberId: string): Promise<any> =>
  db.query(
    `SELECT DISTINCT target.*
     FROM portal_matrimony_interests myLikes
     JOIN candidates target ON target.id = myLikes.candidate_id
     JOIN candidates myCandidate ON myCandidate.author_id = $1
     JOIN portal_matrimony_interests theirLikes
       ON theirLikes.candidate_id = myCandidate.id
       AND theirLikes.member_id = target.author_id
       AND theirLikes.direction = 'like'
     WHERE myLikes.member_id = $1 AND myLikes.direction = 'like'
     ORDER BY target.created_at DESC`,
    [memberId]
  );
