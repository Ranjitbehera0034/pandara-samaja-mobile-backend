import db from '../config/db';

/* ─────────────── READ / BROWSE ─────────────── */

interface BrowseFilters {
  viewerMembershipNo: string;
  gender?: string; // plain optional display filter — NOT forced opposite-gender-only
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
    // Don't show the viewer their own submitted profile(s).
    'author_id IS DISTINCT FROM $1',
    // Matched/married candidates must never reappear in the active,
    // browsable directory — they live on in the history/archive view
    // (getHistory below) instead.
    'is_matched = false',
  ];

  if (filters.gender) {
    params.push(filters.gender);
    conditions.push(`gender = $${params.length}`);
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

/* ─────────────── CREATE / UPDATE (self-service / admin) ────────────── */

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
    address, phone, email, photo, photos, formUrl, submittedBy, status
  } = data;

  return db.query(
    `INSERT INTO candidates
      (name, gender, dob, age, height, blood_group, gotra, bansha, education,
       technical_education, professional_education, occupation, father, mother,
       address, phone, email, photo, photos, manual_form, author_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [name, gender, sanitizeDob(dob), sanitizeAge(age), height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo || null, photos || [], formUrl || null, submittedBy,
      status || 'approved']
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

// Moves one existing photo out of `photos` and into `manual_form` — the
// admin-support fix for a candidate who uploaded their biodata form scan
// into the personal-photos section by mistake. Deliberately its own narrow
// query rather than a call through updateCandidate(), which unconditionally
// overwrites every other field (name, gender, ...) from whatever's passed
// in data — this operation only ever touches these two columns.
export const reassignPhotoToForm = (id: number | string, newPhotos: string[], formPath: string): Promise<any> =>
  db.query(
    'UPDATE candidates SET photos = $1, manual_form = $2 WHERE id = $3 RETURNING *',
    [newPhotos, formPath, id]
  );

export const remove = (id: number | string): Promise<any> =>
  db.query('DELETE FROM candidates WHERE id = $1', [id]);

/* ─────────────── MATCH CONFIRMATION / HISTORY ────────────── */

interface ConfirmMatchInput {
  matchedPartnerName: string;
  matchedPartnerGender: string;
  matchedPartnerMemberId?: string | null;
  matchDate?: string | null;
  evidenceUrl: string;
  verifiedBy: string;
}

// Confirms a marriage/engagement: marks the candidate matched (removing it
// from the active browse() directory via the is_matched = false condition
// above) and records the evidence + who verified it. See
// src/routes/adminMatrimony.ts's POST /matrimony/:id/confirm-match, which
// also pushes a new family_members entry onto the matched member's own
// record when matchedPartnerMemberId is provided.
export const confirmMatch = (id: number | string, data: ConfirmMatchInput): Promise<any> => {
  const { matchedPartnerName, matchedPartnerGender, matchedPartnerMemberId, matchDate, evidenceUrl, verifiedBy } = data;
  return db.query(
    `UPDATE candidates
     SET is_matched = true,
         matched_partner_name = $1,
         matched_partner_gender = $2,
         matched_partner_member_id = $3,
         matched_status = 'married',
         match_date = COALESCE($4, CURRENT_DATE),
         match_evidence_url = $5,
         verified_by = $6,
         verified_at = NOW()
     WHERE id = $7
     RETURNING *`,
    [matchedPartnerName, matchedPartnerGender, matchedPartnerMemberId || null, matchDate || null, evidenceUrl, verifiedBy, id]
  );
};

interface HistoryFilters {
  limit?: number;
  offset?: number;
}

// Matched/archived candidates — preserved for a history/archive view rather
// than deleted, per the new spec. Newest match first.
export const getHistory = (filters: HistoryFilters): Promise<any> => {
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  return db.query(
    `SELECT * FROM candidates
     WHERE is_matched = true
     ORDER BY match_date DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
};

export const getHistoryCount = async (): Promise<number> => {
  const res = await db.query("SELECT COUNT(*) FROM candidates WHERE is_matched = true", []);
  return parseInt(res.rows[0].count, 10);
};

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
// has no viewer-relative exclusions (no gender/self/matched filtering) so
// admins can see and manage everything, including matched/archived rows.
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
