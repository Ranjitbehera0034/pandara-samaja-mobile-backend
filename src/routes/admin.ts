import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import UserModel from '../models/userModel';
import * as memberModel from '../models/memberModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { JWT_SECRET } from '../config/secrets';

export default async function adminRoutes(fastify: FastifyInstance) {
  // ── POST /api/admin/login ──
  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as any;
    if (!username || !password) {
      return reply.status(400).send({ success: false, message: 'Username and password are required' });
    }

    try {
      const user = await UserModel.findByUsername(username.trim());
      if (!user) {
        return reply.status(401).send({ success: false, message: 'Invalid username or password' });
      }

      const valid = await UserModel.verifyPassword(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ success: false, message: 'Invalid username or password' });
      }

      await UserModel.updateLastLogin(user.id);

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, type: 'admin' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      return reply.send({
        success: true,
        token,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── GET /api/admin/me ──
  fastify.get('/me', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = await UserModel.findById((req.user as any).id);
      if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
      return reply.send({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── POST /api/admin/users ── (superadmin only — create additional admin/superadmin accounts)
  fastify.post('/users', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can create admin accounts' });
    }
    const { username, password, role } = req.body as any;
    if (!username || !password) {
      return reply.status(400).send({ success: false, message: 'Username and password are required' });
    }
    if (!['admin', 'superadmin'].includes(role)) {
      return reply.status(400).send({ success: false, message: 'Role must be "admin" or "superadmin"' });
    }

    try {
      const created = await UserModel.create(username.trim(), password, role);
      return reply.status(201).send({ success: true, user: created });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || 'Failed to create user' });
    }
  });

  // ════════════════════════════════════════════════
  //  MEMBER MANAGEMENT (admin + superadmin)
  // ════════════════════════════════════════════════

  // ── GET /api/admin/members ──
  fastify.get('/members', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', search } = req.query as any;
    const pPage = parseInt(page, 10);
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const filters = search ? { search } : {};
      const [result, total] = await Promise.all([
        memberModel.getFiltered(pLimit, offset, filters),
        memberModel.getFilteredCount(filters),
      ]);
      return reply.send({
        success: true,
        members: result.rows,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch members' });
    }
  });

  // ── GET /api/admin/members/:id ──
  fastify.get('/members/:id', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const member = await memberModel.getOne(id);
      if (!member) return reply.status(404).send({ success: false, message: 'Member not found' });
      return reply.send({ success: true, member });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch member' });
    }
  });

  // ── PUT /api/admin/members/:id/ban ──
  fastify.put('/members/:id/ban', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { banned } = req.body as any;
    try {
      const updated = await memberModel.setBanned(id, !!banned);
      if (!updated) return reply.status(404).send({ success: false, message: 'Member not found' });
      return reply.send({ success: true, member: updated });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update member status' });
    }
  });
}
