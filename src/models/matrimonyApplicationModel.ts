import db from '../config/db';

/**
 * Model for `matrimony_applications` — the document-upload-and-review
 * queue for the matrimony directory. A member uploads a photo/PDF of the
 * official filled-and-signed paper registration form; an admin reviews it
 * and either approves it (publishing a `candidates` row), asks for a
 * correction, or rejects it. See src/models/candidateModel.ts for the
 * published-directory side of this feature.
 */

interface CreateApplicationInput {
  memberId: string;
  membershipNo: string;
  memberName: string;
  relationToHof: string;
  uploadedByName?: string | null;
  uploadedByMobile?: string | null;
  memberMobile?: string | null;
  uploadedFileUrl: string;
  fileType?: string | null;
  // Extra metadata that doesn't have a dedicated column (e.g. the
  // candidate's gender, needed later at approval time to create the
  // `candidates` row) is stashed in `verification_checklist` jsonb.
  verificationChecklist?: Record<string, any>;
}

export const create = (data: CreateApplicationInput): Promise<any> => {
  const {
    memberId, membershipNo, memberName, relationToHof, uploadedByName,
    uploadedByMobile, memberMobile, uploadedFileUrl, fileType, verificationChecklist,
  } = data;

  const historyEntry = {
    status: 'pending',
    remark: 'Initial submission',
    changed_at: new Date().toISOString(),
    changed_by: memberId,
  };

  return db.query(
    `INSERT INTO matrimony_applications
      (member_id, membership_no, member_name, relation_to_hof, uploaded_by_name,
       uploaded_by_mobile, member_mobile, uploaded_file_url, file_type, status,
       verification_checklist, version, history, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,1,$11::jsonb,NOW())
     RETURNING *`,
    [
      memberId, membershipNo, memberName, relationToHof, uploadedByName || null,
      uploadedByMobile || null, memberMobile || null, uploadedFileUrl, fileType || null,
      verificationChecklist ? JSON.stringify(verificationChecklist) : null,
      JSON.stringify([historyEntry]),
    ]
  );
};

export const getBySubmitter = (memberId: string): Promise<any> =>
  db.query(
    'SELECT * FROM matrimony_applications WHERE member_id = $1 ORDER BY submitted_at DESC',
    [memberId]
  );

export const getById = (id: number | string): Promise<any> =>
  db.query('SELECT * FROM matrimony_applications WHERE id = $1', [id]);

interface AdminListFilters {
  status?: string;
  limit?: number;
  offset?: number;
}

export const adminList = (filters: AdminListFilters): Promise<any> => {
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

  return db.query(
    `SELECT * FROM matrimony_applications
     ${wherePart}
     ORDER BY submitted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const adminCount = async (filters: Omit<AdminListFilters, 'limit' | 'offset'>): Promise<number> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(`SELECT COUNT(*) FROM matrimony_applications ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

interface AppendHistoryInput {
  status: string;
  remark: string;
  changedBy: string;
}

/**
 * Appends a new entry to the existing `history` jsonb array and updates
 * `status`/`admin_remarks`/`reviewed_by`/`reviewed_at`. Used by the admin
 * approve / request-correction / reject actions. Read-modify-write (rather
 * than a pure SQL jsonb expression) so we can stamp `changed_at` in JS and
 * keep the shape identical to the initial-submission history entry above.
 */
export const appendHistoryAndSetStatus = async (
  id: number | string,
  { status, remark, changedBy }: AppendHistoryInput
): Promise<any> => {
  const existing = await getById(id);
  const row = existing.rows[0];
  if (!row) return null;

  let history = row.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history)) history = [];

  history.push({
    status,
    remark,
    changed_at: new Date().toISOString(),
    changed_by: changedBy,
  });

  const result = await db.query(
    `UPDATE matrimony_applications
     SET status = $1, admin_remarks = $2, reviewed_by = $3, reviewed_at = NOW(), history = $4::jsonb
     WHERE id = $5
     RETURNING *`,
    [status, remark, changedBy, JSON.stringify(history), id]
  );
  return result;
};

interface ResubmitInput {
  uploadedFileUrl: string;
  fileType?: string | null;
  uploadedByName?: string | null;
  uploadedByMobile?: string | null;
}

/**
 * Re-upload after a `correction_needed` verdict: bumps `version`, resets
 * `status` to 'pending', and appends a history entry. Whether the current
 * status is actually `correction_needed` is enforced by the caller (route),
 * not here, per the task spec.
 */
export const resubmit = async (
  id: number | string,
  { uploadedFileUrl, fileType, uploadedByName, uploadedByMobile }: ResubmitInput
): Promise<any> => {
  const existing = await getById(id);
  const row = existing.rows[0];
  if (!row) return null;

  let history = row.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history)) history = [];

  history.push({
    status: 'pending',
    remark: 'Resubmitted after correction',
    changed_at: new Date().toISOString(),
    changed_by: row.member_id,
  });

  const result = await db.query(
    `UPDATE matrimony_applications
     SET uploaded_file_url = $1, file_type = $2,
         uploaded_by_name = COALESCE($3, uploaded_by_name),
         uploaded_by_mobile = COALESCE($4, uploaded_by_mobile),
         version = version + 1, status = 'pending', history = $5::jsonb
     WHERE id = $6
     RETURNING *`,
    [uploadedFileUrl, fileType || null, uploadedByName || null, uploadedByMobile || null, JSON.stringify(history), id]
  );
  return result;
};
