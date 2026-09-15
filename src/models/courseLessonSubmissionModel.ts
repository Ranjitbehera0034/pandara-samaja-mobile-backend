import pool from '../config/db';
import * as courseModel from './courseModel';

/**
 * Review queue for videos the daily YouTube-channel scraper discovers
 * (see scraper/src/sources/youtubeChannels.ts) — mirrors job_submissions'
 * shape and safety property exactly: nothing an automated source finds
 * goes live until an admin approves it. Approval creates a real
 * course_lessons row, either under an existing course or a brand new one,
 * the same way job submission approval calls createPosting().
 */

const SUBMISSION_COLUMNS = `id, title, platform, external_url, category, channel_name,
  source_ref, status, admin_remarks, reviewed_by, reviewed_at, submitted_at`;

interface CreateSubmissionInput {
  title: string;
  platform: string;
  externalUrl: string;
  category?: string | null;
  channelName?: string | null;
  sourceRef: string;
}

export const createSubmission = (data: CreateSubmissionInput): Promise<any> =>
  pool.query(
    `INSERT INTO course_lesson_submissions
      (title, platform, external_url, category, channel_name, source_ref, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
     RETURNING ${SUBMISSION_COLUMNS}`,
    [data.title, data.platform, data.externalUrl, data.category || null, data.channelName || null, data.sourceRef]
  );

// Which source_refs have already been ingested — lets the scraper skip
// videos it's already submitted without keeping its own state between runs.
export const getSeenSourceRefs = async (): Promise<string[]> => {
  const res = await pool.query(`SELECT source_ref FROM course_lesson_submissions WHERE source_ref LIKE 'youtube:%'`);
  return res.rows.map((r: any) => r.source_ref);
};

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

  return pool.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM course_lesson_submissions
     ${wherePart}
     ORDER BY submitted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getSubmissionById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${SUBMISSION_COLUMNS} FROM course_lesson_submissions WHERE id = $1`, [id]);

export const rejectSubmission = (
  id: number | string,
  { remark, changedBy }: { remark: string; changedBy: string }
): Promise<any> =>
  pool.query(
    `UPDATE course_lesson_submissions
     SET status = 'rejected', admin_remarks = $1, reviewed_by = $2, reviewed_at = NOW()
     WHERE id = $3 AND status = 'pending'
     RETURNING ${SUBMISSION_COLUMNS}`,
    [remark || null, changedBy, id]
  );

interface ApproveInput {
  // Attach to this existing course...
  existingCourseId?: number | string;
  // ...or create a new one with this title (published immediately — an
  // admin approving this submission at all is the human review step,
  // same as job submission approval publishing straight to job_postings).
  newCourseTitle?: string;
  newCourseCategory?: string;
  changedBy: string;
}

export const approveSubmission = async (id: number | string, input: ApproveInput): Promise<any> => {
  const existing = await getSubmissionById(id);
  const submission = existing.rows[0];
  if (!submission) return { rows: [] };
  if (submission.status !== 'pending') return { rows: [], alreadyReviewed: true };

  let courseId = input.existingCourseId;
  if (!courseId) {
    if (!input.newCourseTitle?.trim()) {
      throw new Error('Either existingCourseId or newCourseTitle is required');
    }
    const courseResult = await courseModel.createCourse({
      title: input.newCourseTitle.trim(),
      category: input.newCourseCategory || submission.category || null,
    });
    const newCourseId: number = courseResult.rows[0].id;
    await courseModel.setPublished(newCourseId, true);
    courseId = newCourseId;
  }

  const lessonResult = await courseModel.addLesson({
    courseId: courseId!,
    title: submission.title,
    platform: submission.platform,
    externalUrl: submission.external_url,
  });

  await pool.query(
    `UPDATE course_lesson_submissions
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2`,
    [input.changedBy, id]
  );

  return { rows: lessonResult.rows, courseId };
};
