import pool from '../config/db';

/**
 * Model for the job board — split across two tables:
 * - `job_postings`: published, public, what members browse.
 * - `job_submissions`: the pending-review queue for member submissions.
 *   Approval reads a submission and writes a new job_postings row; the
 *   submission itself never becomes "approved", it's superseded (mirrors
 *   matrimony_applications -> candidates in matrimonyApplicationModel.ts).
 */

const JOB_POSTING_COLUMNS = `id, title, organization, category, description, location,
  application_info, posted_by_admin, submitted_by, created_at, expires_at`;

interface PublishedListFilters {
  category?: string;
  limit?: number;
  offset?: number;
}

export const listPublished = (filters: PublishedListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())'];

  if (filters.category) {
    params.push(filters.category);
    conditions.push(`category = $${params.length}`);
  }

  const limit = Math.min(filters.limit ?? 20, 50);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return pool.query(
    `SELECT ${JOB_POSTING_COLUMNS} FROM job_postings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getPostingById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${JOB_POSTING_COLUMNS} FROM job_postings WHERE id = $1`, [id]);

// Admin list — same shape as member-facing listPublished but without the
// expiry filter (admins should still see expired postings) and no cap
// beyond the usual pagination ceiling.
interface AdminPostingListFilters {
  category?: string;
  limit?: number;
  offset?: number;
}

export const adminListPostings = (filters: AdminPostingListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.category) {
    params.push(filters.category);
    conditions.push(`category = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return pool.query(
    `SELECT ${JOB_POSTING_COLUMNS} FROM job_postings
     ${wherePart}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

interface CreatePostingInput {
  title: string;
  organization: string;
  category: 'govt' | 'private';
  description: string;
  location?: string | null;
  applicationInfo: string;
  postedByAdmin: boolean;
  submittedBy?: string | null;
  expiresAt?: string | null;
}

export const createPosting = (data: CreatePostingInput): Promise<any> =>
  pool.query(
    `INSERT INTO job_postings
      (title, organization, category, description, location, application_info,
       posted_by_admin, submitted_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
     RETURNING ${JOB_POSTING_COLUMNS}`,
    [
      data.title, data.organization, data.category, data.description,
      data.location || null, data.applicationInfo, data.postedByAdmin,
      data.submittedBy || null, data.expiresAt || null,
    ]
  );

export const updatePosting = async (id: number | string, data: Partial<CreatePostingInput>): Promise<any> => {
  const existing = await getPostingById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  const merged = {
    title: data.title ?? row.title,
    organization: data.organization ?? row.organization,
    category: data.category ?? row.category,
    description: data.description ?? row.description,
    location: data.location !== undefined ? data.location : row.location,
    application_info: data.applicationInfo ?? row.application_info,
    expires_at: data.expiresAt !== undefined ? data.expiresAt : row.expires_at,
  };

  return pool.query(
    `UPDATE job_postings
     SET title = $1, organization = $2, category = $3, description = $4,
         location = $5, application_info = $6, expires_at = $7
     WHERE id = $8
     RETURNING ${JOB_POSTING_COLUMNS}`,
    [merged.title, merged.organization, merged.category, merged.description,
      merged.location, merged.application_info, merged.expires_at, id]
  );
};

export const deletePosting = (id: number | string): Promise<any> =>
  pool.query('DELETE FROM job_postings WHERE id = $1 RETURNING id', [id]);

/* ─────────────── SUBMISSIONS (pending queue) ────────────── */

interface CreateSubmissionInput {
  membershipNo: string;
  submitterName?: string | null;
  submitterMobile?: string | null;
  title: string;
  organization: string;
  category: 'govt' | 'private';
  description: string;
  location?: string | null;
  applicationInfo: string;
}

export const createSubmission = (data: CreateSubmissionInput): Promise<any> => {
  const historyEntry = {
    status: 'pending',
    remark: 'Initial submission',
    changed_at: new Date().toISOString(),
    changed_by: data.membershipNo,
  };

  return pool.query(
    `INSERT INTO job_submissions
      (membership_no, submitter_name, submitter_mobile, title, organization,
       category, description, location, application_info, status, history, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10::jsonb,NOW())
     RETURNING *`,
    [
      data.membershipNo, data.submitterName || null, data.submitterMobile || null,
      data.title, data.organization, data.category, data.description,
      data.location || null, data.applicationInfo, JSON.stringify([historyEntry]),
    ]
  );
};

export const getSubmissionsBySubmitter = (membershipNo: string): Promise<any> =>
  pool.query(
    'SELECT * FROM job_submissions WHERE membership_no = $1 ORDER BY submitted_at DESC',
    [membershipNo]
  );

export const getSubmissionById = (id: number | string): Promise<any> =>
  pool.query('SELECT * FROM job_submissions WHERE id = $1', [id]);

interface AdminSubmissionListFilters {
  status?: string;
  limit?: number;
  offset?: number;
}

export const adminListSubmissions = (filters: AdminSubmissionListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return pool.query(
    `SELECT * FROM job_submissions
     ${wherePart}
     ORDER BY submitted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const adminCountSubmissions = async (filters: Omit<AdminSubmissionListFilters, 'limit' | 'offset'>): Promise<number> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(`SELECT COUNT(*) FROM job_submissions ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

/**
 * Rejects a submission — appends a history entry and sets the terminal
 * 'rejected' status. Approval doesn't go through here: the route reads the
 * submission, creates a job_postings row via createPosting(), and leaves
 * the submission row as-is other than appending an 'approved' history
 * entry for the audit trail (status column has no 'approved' value since
 * the row is superseded, not itself the source of truth once approved).
 */
export const rejectSubmission = async (
  id: number | string,
  { remark, changedBy }: { remark: string; changedBy: string }
): Promise<any> => {
  const existing = await getSubmissionById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  let history = row.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history)) history = [];

  history.push({
    status: 'rejected',
    remark,
    changed_at: new Date().toISOString(),
    changed_by: changedBy,
  });

  return pool.query(
    `UPDATE job_submissions
     SET status = 'rejected', admin_remarks = $1, reviewed_by = $2, reviewed_at = NOW(), history = $3::jsonb
     WHERE id = $4
     RETURNING *`,
    [remark, changedBy, JSON.stringify(history), id]
  );
};

export const appendApprovedHistory = async (
  id: number | string,
  { changedBy }: { changedBy: string }
): Promise<any> => {
  const existing = await getSubmissionById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  let history = row.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history)) history = [];

  history.push({
    status: 'approved',
    remark: 'Approved and published',
    changed_at: new Date().toISOString(),
    changed_by: changedBy,
  });

  return pool.query(
    `UPDATE job_submissions
     SET reviewed_by = $1, reviewed_at = NOW(), history = $2::jsonb
     WHERE id = $3
     RETURNING *`,
    [changedBy, JSON.stringify(history), id]
  );
};
