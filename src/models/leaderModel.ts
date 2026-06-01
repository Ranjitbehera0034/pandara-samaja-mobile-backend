import pool from '../config/db';

export class LeaderModel {
  static async findAll() {
    const result = await pool.query('SELECT * FROM leaders ORDER BY level, display_order, created_at ASC');
    return result.rows;
  }

  static async findByLevel(level: string) {
    const result = await pool.query('SELECT * FROM leaders WHERE level = $1 ORDER BY display_order, created_at ASC', [level]);
    return result.rows;
  }

  static async findById(id: number | string) {
    const result = await pool.query('SELECT * FROM leaders WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async create(data: any) {
    const { name, name_or, role, role_or, level, location, image_url, display_order } = data;
    const result = await pool.query(
      `INSERT INTO leaders (name, name_or, role, role_or, level, location, image_url, display_order) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, name_or || null, role, role_or || null, level, location || null, image_url || null, display_order || 0]
    );
    return result.rows[0];
  }

  static async update(id: number | string, data: any) {
    const { name, name_or, role, role_or, level, location, image_url, display_order } = data;
    const result = await pool.query(
      `UPDATE leaders 
       SET name = $1, name_or = $2, role = $3, role_or = $4, level = $5, location = $6, image_url = COALESCE($7, image_url), display_order = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [name, name_or || null, role, role_or || null, level, location || null, image_url || null, display_order || 0, id]
    );
    return result.rows[0] || null;
  }

  static async delete(id: number | string) {
    const result = await pool.query('DELETE FROM leaders WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] || null;
  }
}

export default LeaderModel;
