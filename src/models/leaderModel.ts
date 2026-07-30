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

  // Admin listing: filter by level/location/free-text search across
  // name/name_or/role/role_or/location, paginated (capped like the other
  // admin list routes).
  static async adminList(filters: { level?: string; location?: string; search?: string; limit?: number; offset?: number }) {
    const params: any[] = [];
    const conditions: string[] = [];

    if (filters.level) {
      params.push(filters.level);
      conditions.push(`level = $${params.length}`);
    }
    if (filters.location) {
      params.push(filters.location);
      conditions.push(`location = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      const idx = params.length;
      conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(name_or) LIKE LOWER($${idx}) OR LOWER(role) LIKE LOWER($${idx}) OR LOWER(role_or) LIKE LOWER($${idx}) OR LOWER(location) LIKE LOWER($${idx}))`);
    }

    const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT * FROM leaders
       ${wherePart}
       ORDER BY level, display_order ASC, created_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return result.rows;
  }

  static async adminCount(filters: { level?: string; location?: string; search?: string }) {
    const params: any[] = [];
    const conditions: string[] = [];

    if (filters.level) {
      params.push(filters.level);
      conditions.push(`level = $${params.length}`);
    }
    if (filters.location) {
      params.push(filters.location);
      conditions.push(`location = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      const idx = params.length;
      conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(name_or) LIKE LOWER($${idx}) OR LOWER(role) LIKE LOWER($${idx}) OR LOWER(role_or) LIKE LOWER($${idx}) OR LOWER(location) LIKE LOWER($${idx}))`);
    }

    const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`SELECT COUNT(*) FROM leaders ${wherePart}`, params);
    return parseInt(result.rows[0].count, 10);
  }

  // Distinct locations for a given level — mirrors the member-facing
  // GET /api/leaders/locations, but under the admin auth/prefix.
  static async distinctLocations(level?: string) {
    const params: any[] = [];
    let wherePart = "WHERE location IS NOT NULL AND TRIM(location) != ''";
    if (level) {
      params.push(level);
      wherePart += ` AND level = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT DISTINCT location FROM leaders ${wherePart} ORDER BY location ASC`,
      params
    );
    return result.rows.map(r => r.location);
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

  // Merge-with-existing partial update (mirrors memberModel.update /
  // blogModel.update elsewhere in this codebase) so a PUT that only sends
  // e.g. { role: '...' } doesn't null out name/level/location/etc.
  static async update(id: number | string, data: any) {
    const existing = await LeaderModel.findById(id);
    if (!existing) return null;

    const merged = {
      name: data.name !== undefined ? data.name : existing.name,
      name_or: data.name_or !== undefined ? data.name_or : existing.name_or,
      role: data.role !== undefined ? data.role : existing.role,
      role_or: data.role_or !== undefined ? data.role_or : existing.role_or,
      level: data.level !== undefined ? data.level : existing.level,
      location: data.location !== undefined ? data.location : existing.location,
      image_url: data.image_url !== undefined ? data.image_url : existing.image_url,
      display_order: data.display_order !== undefined ? data.display_order : existing.display_order,
    };

    const result = await pool.query(
      `UPDATE leaders
       SET name = $1, name_or = $2, role = $3, role_or = $4, level = $5, location = $6, image_url = $7, display_order = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [merged.name, merged.name_or || null, merged.role, merged.role_or || null, merged.level, merged.location || null, merged.image_url || null, merged.display_order ?? 0, id]
    );
    return result.rows[0] || null;
  }

  static async delete(id: number | string) {
    const result = await pool.query('DELETE FROM leaders WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] || null;
  }
}

export default LeaderModel;
