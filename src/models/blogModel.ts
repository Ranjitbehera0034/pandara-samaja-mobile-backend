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
