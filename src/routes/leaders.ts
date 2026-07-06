import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';

export default async function leadersRoutes(fastify: FastifyInstance) {
  // Require authentication for leaders routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/leaders ──
  // Fetch leaders filtered by level and optionally location
  fastify.get('/leaders', async (req: FastifyRequest, reply: FastifyReply) => {
    const { level, location } = req.query as any;

    if (!level) {
      return reply.status(400).send({
        success: false,
        message: 'Level is required',
      });
    }

    try {
      const params: any[] = [level];
      let query = 'SELECT * FROM leaders WHERE level = $1';

      if (location) {
        params.push(location);
        query += ' AND location = $2';
      }

      query += ' ORDER BY display_order ASC, created_at ASC';

      const res = await pool.query(query, params);

      return reply.send({
        success: true,
        data: res.rows,
      });
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
