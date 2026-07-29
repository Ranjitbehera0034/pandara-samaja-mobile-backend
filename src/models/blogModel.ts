import pool from '../config/db';
import { getSignedMediaUrl } from '../utils/firebaseStorage';

/**
 * Get all blog/announcement posts ordered by newest first
 * Table: posts (id, title, content, image_url, video_url, created_at)
 */
export const getAll = async () => {
  const res = await pool.query(
    `SELECT id, title, content, image_url, video_url, created_at
     FROM posts
     ORDER BY created_at DESC`
  );
  return Promise.all(res.rows.map(async (row) => ({
    ...row,
    image_url: await getSignedMediaUrl(row.image_url),
    video_url: await getSignedMediaUrl(row.video_url),
  })));
};

/**
 * Get a single blog post by ID
 */
export const getOne = async (id: string) => {
  const res = await pool.query(
    `SELECT id, title, content, image_url, video_url, created_at
     FROM posts
     WHERE id = $1`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    image_url: await getSignedMediaUrl(row.image_url),
    video_url: await getSignedMediaUrl(row.video_url),
  };
};

/* ─────────────── ADMIN CRUD ────────────── */
// Member-facing getAll()/getOne() above stay read-only and untouched; these
// are only ever called from the admin-gated announcement routes.

export const create = async ({
  title,
  content,
  image_url,
  video_url,
}: {
  title: string;
  content?: string | null;
  image_url?: string | null;
  video_url?: string | null;
}) => {
  const res = await pool.query(
    `INSERT INTO posts (title, content, image_url, video_url, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, title, content, image_url, video_url, created_at`,
    [title, content || null, image_url || null, video_url || null]
  );
  return res.rows[0];
};

export const update = async (
  id: string,
  data: { title?: string; content?: string | null; image_url?: string | null; video_url?: string | null }
) => {
  const existing = await pool.query('SELECT * FROM posts WHERE id = $1', [id]);
  const row = existing.rows[0];
  if (!row) return null;

  const merged = {
    title: data.title !== undefined ? data.title : row.title,
    content: data.content !== undefined ? data.content : row.content,
    image_url: data.image_url !== undefined ? data.image_url : row.image_url,
    video_url: data.video_url !== undefined ? data.video_url : row.video_url,
  };

  const res = await pool.query(
    `UPDATE posts SET title = $1, content = $2, image_url = $3, video_url = $4
     WHERE id = $5
     RETURNING id, title, content, image_url, video_url, created_at`,
    [merged.title, merged.content, merged.image_url, merged.video_url, id]
  );
  return res.rows[0];
};

export const remove = async (id: string) => {
  const res = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING id', [id]);
  return res.rows[0] || null;
};
