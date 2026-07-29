import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import LeaderModel from '../models/leaderModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

// Admin-gated leader CRUD. Member-facing GET /api/leaders and
// GET /api/leaders/locations (src/routes/leaders.ts) stay exactly as-is.
export default async function adminLeadersRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/leaders ── list all, optional level/search, paginated
  fastify.get('/leaders', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', level, search } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const [rows, total] = await Promise.all([
        LeaderModel.adminList({ level, search, limit: pLimit, offset }),
        LeaderModel.adminCount({ level, search }),
      ]);
      const leaders = await Promise.all(rows.map(async (row: any) => ({
        ...row,
        image_url: await getSignedMediaUrl(row.image_url),
      })));
      return reply.send({
        success: true,
        leaders,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch leaders' });
    }
  });

  // ── POST /api/admin/leaders ──
  // Multipart: text fields (name, name_or, role, role_or, level, location,
  // display_order) + optional 'image' file, mirroring adminAnnouncements.ts.
  fastify.post('/leaders', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['image']);
      const { name, name_or, role, role_or, level, location, display_order } = fields as any;

      if (!name?.trim() || !role?.trim() || !level?.trim()) {
        return reply.status(400).send({ success: false, message: 'name, role, and level are required' });
      }

      let imageUrl: string | undefined;
      if (files.image[0]) {
        imageUrl = await uploadToFirebase(files.image[0], UPLOAD_PATHS.LEADERS());
      }

      const leader = await LeaderModel.create({
        name: name.trim(),
        name_or: name_or || null,
        role: role.trim(),
        role_or: role_or || null,
        level: level.trim(),
        location: location || null,
        display_order: display_order !== undefined && display_order !== '' ? parseInt(display_order, 10) : 0,
        image_url: imageUrl || null,
      });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'leader_created',
        targetType: 'leader',
        targetId: String(leader.id),
        req,
      });

      return reply.status(201).send({
        success: true,
        leader: { ...leader, image_url: await getSignedMediaUrl(leader.image_url) },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create leader' });
    }
  });

  // ── PUT /api/admin/leaders/:id ── edit any field, optional new image
  fastify.put('/leaders/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const { files, fields } = await readMultipartFiles(req, ['image']);
      const { name, name_or, role, role_or, level, location, display_order } = fields as any;

      const data: Record<string, any> = {};
      if (name !== undefined) data.name = name.trim();
      if (name_or !== undefined) data.name_or = name_or || null;
      if (role !== undefined) data.role = role.trim();
      if (role_or !== undefined) data.role_or = role_or || null;
      if (level !== undefined) data.level = level.trim();
      if (location !== undefined) data.location = location || null;
      if (display_order !== undefined && display_order !== '') data.display_order = parseInt(display_order, 10);
      if (files.image[0]) data.image_url = await uploadToFirebase(files.image[0], UPLOAD_PATHS.LEADERS());

      const leader = await LeaderModel.update(id, data);
      if (!leader) return reply.status(404).send({ success: false, message: 'Leader not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'leader_updated',
        targetType: 'leader',
        targetId: String(id),
        req,
      });

      return reply.send({
        success: true,
        leader: { ...leader, image_url: await getSignedMediaUrl(leader.image_url) },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update leader' });
    }
  });

  // ── DELETE /api/admin/leaders/:id ── permanent delete
  fastify.delete('/leaders/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const removed = await LeaderModel.delete(id);
      if (!removed) return reply.status(404).send({ success: false, message: 'Leader not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'leader_deleted',
        targetType: 'leader',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete leader' });
    }
  });
}
