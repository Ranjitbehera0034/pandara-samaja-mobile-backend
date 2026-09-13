import pool from '../config/db';

/**
 * Model for Courses — admin-curated links out to free external learning
 * platforms (YouTube, Udemy, Coursera, etc.). See ARCHITECTURE.md's
 * "Courses" section for why this follows the Announcements shape
 * (admin-authored only, no submission queue) rather than the Jobs shape.
 */

const COURSE_COLUMNS = `id, title, description, category, thumbnail_url, is_published, created_at`;
const LESSON_COLUMNS = `id, course_id, title, platform, external_url, order_index, created_at`;

interface PublishedListFilters {
  category?: string;
  limit?: number;
  offset?: number;
}

export const listPublished = (filters: PublishedListFilters): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = ['is_published = true'];

  if (filters.category) {
    params.push(filters.category);
    conditions.push(`category = $${params.length}`);
  }

  const limit = Math.min(filters.limit ?? 20, 50);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return pool.query(
    `SELECT ${COURSE_COLUMNS} FROM courses
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getPublishedById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = $1 AND is_published = true`, [id]);

export const getLessonsByCourseId = (courseId: number | string): Promise<any> =>
  pool.query(
    `SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE course_id = $1 ORDER BY order_index ASC, id ASC`,
    [courseId]
  );

/* ─────────────── ADMIN ────────────── */

interface AdminListFilters {
  category?: string;
  limit?: number;
  offset?: number;
}

export const adminList = (filters: AdminListFilters): Promise<any> => {
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
    `SELECT ${COURSE_COLUMNS},
            (SELECT COUNT(*) FROM course_lessons WHERE course_lessons.course_id = courses.id) AS lesson_count
     FROM courses
     ${wherePart}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const adminGetById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = $1`, [id]);

interface CreateCourseInput {
  title: string;
  description?: string | null;
  category?: string | null;
  thumbnailUrl?: string | null;
}

export const createCourse = (data: CreateCourseInput): Promise<any> =>
  pool.query(
    `INSERT INTO courses (title, description, category, thumbnail_url, is_published, created_at)
     VALUES ($1, $2, $3, $4, false, NOW())
     RETURNING ${COURSE_COLUMNS}`,
    [data.title, data.description || null, data.category || null, data.thumbnailUrl || null]
  );

export const updateCourse = async (id: number | string, data: Partial<CreateCourseInput>): Promise<any> => {
  const existing = await adminGetById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  const merged = {
    title: data.title ?? row.title,
    description: data.description !== undefined ? data.description : row.description,
    category: data.category !== undefined ? data.category : row.category,
    thumbnail_url: data.thumbnailUrl !== undefined ? data.thumbnailUrl : row.thumbnail_url,
  };

  return pool.query(
    `UPDATE courses SET title = $1, description = $2, category = $3, thumbnail_url = $4
     WHERE id = $5
     RETURNING ${COURSE_COLUMNS}`,
    [merged.title, merged.description, merged.category, merged.thumbnail_url, id]
  );
};

export const setPublished = (id: number | string, isPublished: boolean): Promise<any> =>
  pool.query(
    `UPDATE courses SET is_published = $1 WHERE id = $2 RETURNING ${COURSE_COLUMNS}`,
    [isPublished, id]
  );

export const deleteCourse = (id: number | string): Promise<any> =>
  pool.query('DELETE FROM courses WHERE id = $1 RETURNING id', [id]);

/* ─────────────── ADMIN — LESSONS ────────────── */

interface CreateLessonInput {
  courseId: number | string;
  title: string;
  platform: string;
  externalUrl: string;
}

export const addLesson = async (data: CreateLessonInput): Promise<any> => {
  const nextOrder = await pool.query(
    `SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM course_lessons WHERE course_id = $1`,
    [data.courseId]
  );

  return pool.query(
    `INSERT INTO course_lessons (course_id, title, platform, external_url, order_index, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING ${LESSON_COLUMNS}`,
    [data.courseId, data.title, data.platform, data.externalUrl, nextOrder.rows[0].next]
  );
};

export const getLessonById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE id = $1`, [id]);

export const updateLesson = async (
  id: number | string,
  data: Partial<Pick<CreateLessonInput, 'title' | 'platform' | 'externalUrl'>>
): Promise<any> => {
  const existing = await getLessonById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  const merged = {
    title: data.title ?? row.title,
    platform: data.platform ?? row.platform,
    external_url: data.externalUrl ?? row.external_url,
  };

  return pool.query(
    `UPDATE course_lessons SET title = $1, platform = $2, external_url = $3
     WHERE id = $4
     RETURNING ${LESSON_COLUMNS}`,
    [merged.title, merged.platform, merged.external_url, id]
  );
};

export const deleteLesson = (id: number | string): Promise<any> =>
  pool.query('DELETE FROM course_lessons WHERE id = $1 RETURNING id', [id]);
