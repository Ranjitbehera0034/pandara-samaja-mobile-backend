import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import { getSignedMediaUrl } from '../utils/firebaseStorage';

export default async function leadersRoutes(fastify: FastifyInstance) {
  // Require authentication for leaders routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/leaders ──
  // Fetch leaders filtered by level and/or location, or free-text searched
  // by name/role/location. `level` used to be required; it's now optional
  // so a search can span every level at once.
  fastify.get('/leaders', async (req: FastifyRequest, reply: FastifyReply) => {
    const { level, location, search } = req.query as any;

    try {
      const params: any[] = [];
      const conditions: string[] = [];

      if (level) {
        params.push(level);
        conditions.push(`level = $${params.length}`);
      }
      if (location) {
        params.push(location);
        conditions.push(`location = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        const idx = params.length;
        conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(name_or) LIKE LOWER($${idx}) OR LOWER(role) LIKE LOWER($${idx}) OR LOWER(role_or) LIKE LOWER($${idx}) OR LOWER(location) LIKE LOWER($${idx}))`);
      }

      const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM leaders ${wherePart} ORDER BY level, display_order ASC, created_at ASC`;

      const res = await pool.query(query, params);
      const data = await Promise.all(res.rows.map(async (row) => ({
        ...row,
        image_url: await getSignedMediaUrl(row.image_url),
      })));

      return reply.send({ success: true, data });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch leaders' });
    }
  });

  // ── GET /api/leaders/locations ──
  // Fetch distinct locations for leaders of a given level
  fastify.get('/leaders/locations', async (req: FastifyRequest, reply: FastifyReply) => {
    const { level } = req.query as any;

    if (!level) {
      return reply.status(400).send({
        success: false,
        message: 'Level is required',
      });
    }

    try {
      const res = await pool.query(
        `SELECT DISTINCT location 
         FROM leaders 
         WHERE level = $1 AND location IS NOT NULL AND TRIM(location) != '' 
         ORDER BY location ASC`,
        [level]
      );

      const locations = res.rows.map(row => row.location);

      return reply.send({
        success: true,
        data: locations,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch locations' });
    }
  });
}
