import pool from '../config/db';
import * as jobModel from './jobModel';

/**
 * Member-suggested corrections to an already-published job posting — same
 * shape and safety property as job_submissions: nothing a member edits
 * goes live until an admin approves it. An admin/superadmin editing the
 * same posting directly (jobModel.updatePosting via PUT /api/admin/jobs/:id)
 * never touches this table at all — that path already applies immediately.
 */

const SUGGESTION_COLUMNS = `id, job_id, suggested_by, suggester_name, title, organization, sector,
  description, location, application_info, eligibility, last_date, registration_start_date,
  application_fee, no_of_vacancies, note, status, admin_remarks, reviewed_by, reviewed_at, submitted_at`;

interface CreateSuggestionInput {
  jobId: number | string;
  suggestedBy: string;
  suggesterName?: string | null;
  title?: string | null;
  organization?: string | null;
  sector?: string | null;
  description?: string | null;
  location?: string | null;
  applicationInfo?: string | null;
  eligibility?: string | null;
  lastDate?: string | null;
  registrationStartDate?: string | null;
  applicationFee?: string | null;
  noOfVacancies?: string | null;
  note: string;
}

export const createSuggestion = (data: CreateSuggestionInput): Promise<any> =>
  pool.query(
    `INSERT INTO job_edit_suggestions
      (job_id, suggested_by, suggester_name, title, organization, sector, description, location,
       application_info, eligibility, last_date, registration_start_date, application_fee,
       no_of_vacancies, note, status, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',NOW())
     RETURNING ${SUGGESTION_COLUMNS}`,
    [
      data.jobId, data.suggestedBy, data.suggesterName || null, data.title || null,
      data.organization || null, data.sector || null, data.description || null,
      data.location || null, data.applicationInfo || null, data.eligibility || null,
      data.lastDate || null, data.registrationStartDate || null, data.applicationFee || null,
      data.noOfVacancies || null, data.note,
    ]
  );

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
    conditions.push(`s.status = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return pool.query(
    `SELECT s.*, j.title AS current_title, j.organization AS current_organization
     FROM job_edit_suggestions s
     JOIN job_postings j ON j.id = s.job_id
     ${wherePart}
     ORDER BY s.submitted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getSuggestionById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${SUGGESTION_COLUMNS} FROM job_edit_suggestions WHERE id = $1`, [id]);

export const rejectSuggestion = (
  id: number | string,
  { remark, changedBy }: { remark: string; changedBy: string }
): Promise<any> =>
  pool.query(
    `UPDATE job_edit_suggestions
     SET status = 'rejected', admin_remarks = $1, reviewed_by = $2, reviewed_at = NOW()
     WHERE id = $3 AND status = 'pending'
     RETURNING ${SUGGESTION_COLUMNS}`,
    [remark || null, changedBy, id]
  );

// Approval applies only the fields the member actually proposed a change
// for (non-null columns) onto the live posting — jobModel.updatePosting
// already merges `undefined` fields against the existing row, so a NULL
// suggestion field is simply left out of the update payload rather than
// blanking it.
export const approveSuggestion = async (
  id: number | string,
  { changedBy }: { changedBy: string }
): Promise<any> => {
  const existing = await getSuggestionById(id);
  const suggestion = existing.rows[0];
  if (!suggestion) return { rows: [] };
  if (suggestion.status !== 'pending') return { rows: [], alreadyReviewed: true };

  const updateInput: Record<string, any> = {};
  if (suggestion.title !== null) updateInput.title = suggestion.title;
  if (suggestion.organization !== null) updateInput.organization = suggestion.organization;
  if (suggestion.sector !== null) updateInput.sector = suggestion.sector;
  if (suggestion.description !== null) updateInput.description = suggestion.description;
  if (suggestion.location !== null) updateInput.location = suggestion.location;
  if (suggestion.application_info !== null) updateInput.applicationInfo = suggestion.application_info;
  if (suggestion.eligibility !== null) updateInput.eligibility = suggestion.eligibility;
  if (suggestion.last_date !== null) updateInput.lastDate = suggestion.last_date;
  if (suggestion.registration_start_date !== null) updateInput.registrationStartDate = suggestion.registration_start_date;
  if (suggestion.application_fee !== null) updateInput.applicationFee = suggestion.application_fee;
  if (suggestion.no_of_vacancies !== null) updateInput.noOfVacancies = suggestion.no_of_vacancies;

  const jobResult = await jobModel.updatePosting(suggestion.job_id, updateInput);

  await pool.query(
    `UPDATE job_edit_suggestions
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2`,
    [changedBy, id]
  );

  return { rows: jobResult.rows };
};
