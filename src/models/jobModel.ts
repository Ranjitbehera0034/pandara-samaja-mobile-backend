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
  application_info, contact_phone, posted_by_admin, submitted_by, moderation_status,
  created_at, expires_at`;

interface PublishedListFilters {
  category?: string;
  limit?: number;
  offset?: number;
}

export const listPublished = (filters: PublishedListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [
    '(expires_at IS NULL OR expires_at > NOW())',
    `moderation_status = 'visible'`,
  ];

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
  contactPhone?: string | null;
  postedByAdmin: boolean;
  submittedBy?: string | null;
  expiresAt?: string | null;
}

export const createPosting = (data: CreatePostingInput): Promise<any> =>
  pool.query(
    `INSERT INTO job_postings
      (title, organization, category, description, location, application_info,
       contact_phone, posted_by_admin, submitted_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
     RETURNING ${JOB_POSTING_COLUMNS}`,
    [
      data.title, data.organization, data.category, data.description,
      data.location || null, data.applicationInfo, data.contactPhone || null,
      data.postedByAdmin, data.submittedBy || null, data.expiresAt || null,
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
  // null only for automated ingestion (scraper/) — a real member submission
  // always has one, enforced by the route, not this layer.
  membershipNo: string | null;
  submitterName?: string | null;
  // Required for member submissions (validated in the route) — the
  // submitter's own accountability contact, shown on the published listing
  // so applicants know who to hold accountable and admin can call to
  // verify before approving. Distinct from applicationInfo, which may
  // point elsewhere (a company HR line, a link) rather than the poster
  // themselves. Left null for OCR-sourced rows — there's no submitter to call.
  submitterMobile?: string | null;
  title: string;
  organization: string;
  category: 'govt' | 'private';
  description: string;
  location?: string | null;
  applicationInfo: string;
  // Identifies the originating notice for automated ingestion (e.g.
  // 'ossc:<postback-id>') — its UNIQUE constraint is what lets the scraper
  // detect "already ingested" via a failed insert instead of keeping its
  // own state. Null for member submissions.
  sourceRef?: string | null;
}

export const createSubmission = (data: CreateSubmissionInput): Promise<any> => {
  const historyEntry = {
    status: 'pending',
    remark: 'Initial submission',
    changed_at: new Date().toISOString(),
    changed_by: data.membershipNo || data.sourceRef || 'system',
  };

  return pool.query(
    `INSERT INTO job_submissions
      (membership_no, submitter_name, submitter_mobile, title, organization,
       category, description, location, application_info, source_ref, status, history, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11::jsonb,NOW())
     RETURNING *`,
    [
      data.membershipNo || null, data.submitterName || null, data.submitterMobile || null,
      data.title, data.organization, data.category, data.description,
      data.location || null, data.applicationInfo, data.sourceRef || null,
      JSON.stringify([historyEntry]),
    ]
  );
};

// Which source_refs (for a given source prefix, e.g. 'ossc:') have already
// been ingested — lets the scraper skip notices it's already submitted
// without keeping its own state between runs.
export const getSeenSourceRefs = async (sourcePrefix: string): Promise<string[]> => {
  const res = await pool.query(
    `SELECT source_ref FROM job_submissions WHERE source_ref LIKE $1`,
    [`${sourcePrefix}%`]
  );
  return res.rows.map((r: any) => r.source_ref);
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

/* ─────────────── MODERATION — reported listings (mirrors portal_stories) ────────────── */

// A member reports a live listing — auto-hides it pending admin review,
// same as story reports. Re-reporting just refreshes the reason/timestamp.
export const reportJob = async (jobId: number | string, reporterId: string, reason?: string): Promise<void> => {
  await pool.query(
    `INSERT INTO job_reports (job_id, reporter_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id, reporter_id) DO UPDATE SET reason = $3, created_at = NOW()`,
    [jobId, reporterId, reason || null]
  );
  await pool.query(`UPDATE job_postings SET moderation_status = 'hidden_pending_review' WHERE id = $1`, [jobId]);
};

export const getReportedJobs = async (): Promise<any> => {
  const res = await pool.query(
    `SELECT j.*,
            COALESCE(
              json_agg(
                json_build_object('reporter_id', r.reporter_id, 'reason', r.reason, 'created_at', r.created_at)
              ) FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS reports
     FROM job_postings j
     LEFT JOIN job_reports r ON r.job_id = j.id
     WHERE j.moderation_status = 'hidden_pending_review'
     GROUP BY j.id
     ORDER BY j.created_at DESC`
  );
  return res.rows;
};

// Report was unfounded — restore the listing and clear its reports.
export const approveReportedJob = async (jobId: number | string): Promise<any> => {
  const res = await pool.query(
    `UPDATE job_postings SET moderation_status = 'visible' WHERE id = $1 RETURNING id`,
    [jobId]
  );
  if (res.rows[0]) {
    await pool.query('DELETE FROM job_reports WHERE job_id = $1', [jobId]);
  }
  return res.rows[0] || null;
};

// Report was valid — permanently remove the listing (job_reports cascades).
export const rejectReportedJob = async (jobId: number | string): Promise<any> => {
  const res = await pool.query('DELETE FROM job_postings WHERE id = $1 RETURNING id', [jobId]);
  return res.rows[0] || null;
};
