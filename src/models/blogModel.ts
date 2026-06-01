import pool from '../config/db';

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
  return res.rows;
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
  return res.rows[0] || null;
};
