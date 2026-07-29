import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as candidateModel from '../models/candidateModel';
import { getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';

// Reused from src/routes/matrimony.ts's own resolveCandidateMedia (not
// exported there) — kept identical so admin-viewed candidates resolve
// media exactly the same way as member-viewed ones.
async function resolveCandidateMedia(row: any) {
  return {
    ...row,
    photo: await getSignedMediaUrl(row.photo),
    photos: await resolveMediaUrls(row.photos),
    form_url: await getSignedMediaUrl(row.form_url),
  };
}

export default async function adminMatrimonyRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/matrimony ── list/search all candidates, any status
  fastify.get('/matrimony', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', search, status } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const [result, total] = await Promise.all([
        candidateModel.adminList({ search, status, limit: pLimit, offset }),
        candidateModel.adminCount({ search, status }),
      ]);
      const candidates = await Promise.all(result.rows.map(resolveCandidateMedia));
      return reply.send({
        success: true,
        candidates,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch candidates' });
    }
  });

  // ── GET /api/admin/matrimony/:id ──
  fastify.get('/matrimony/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await candidateModel.getById(id);
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ success: false, message: 'Candidate not found' });
      return reply.send({ success: true, candidate: await resolveCandidateMedia(row) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch candidate' });
    }
  });

  // ── POST /api/admin/matrimony ── admin-created candidate profile
  fastify.post('/matrimony', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body?.name?.trim() || !body?.gender) {
      return reply.status(400).send({ success: false, message: 'Name and gender are required' });
    }
    try {
      const result = await candidateModel.createCandidate({
        ...body,
        submittedBy: body.submittedBy || null,
      });
      const candidate = await resolveCandidateMedia(result.rows[0]);
      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'matrimony_profile_admin_created',
        targetType: 'candidate',
        targetId: String(candidate.id),
        req,
      });
      return reply.status(201).send({ success: true, candidate });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create candidate' });
    }
  });

  // ── PUT /api/admin/matrimony/:id ── edit any field
  fastify.put('/matrimony/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await candidateModel.updateCandidate(id, req.body as any);
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Candidate not found' });
      return reply.send({ success: true, candidate: await resolveCandidateMedia(result.rows[0]) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update candidate' });
    }
  });

  // ── DELETE /api/admin/matrimony/:id ── permanent delete
  fastify.delete('/matrimony/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await candidateModel.deleteCandidate(id);
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Candidate not found' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete candidate' });
    }
  });

  // ── PUT /api/admin/matrimony/:id/ban ── { banned: boolean }
  fastify.put('/matrimony/:id/ban', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { banned } = req.body as any;
    try {
      const result = await candidateModel.setStatus(id, banned ? 'banned' : 'approved');
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Candidate not found' });
      return reply.send({ success: true, candidate: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update candidate status' });
    }
  });
}
