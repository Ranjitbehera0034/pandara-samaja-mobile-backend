import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as candidateModel from '../models/candidateModel';
import * as memberModel from '../models/memberModel';
import { uploadToFirebase, getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
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
    form_url: await getSignedMediaUrl(row.manual_form),
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

  // ── GET /api/admin/matrimony/history ── matched/archived candidates,
  // preserved (not deleted) once they're removed from the active directory.
  fastify.get('/matrimony/history', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const [result, total] = await Promise.all([
        candidateModel.getHistory({ limit: pLimit, offset }),
        candidateModel.getHistoryCount(),
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
      return reply.status(500).send({ success: false, message: 'Failed to fetch matrimony history' });
    }
  });

  // ── POST /api/admin/matrimony/:id/confirm-match ── marriage/engagement
  // confirmation: removes the candidate from the active directory and,
  // when the partner is a registered member, adds a new family_members
  // entry to that member's own record.
  fastify.post('/matrimony/:id/confirm-match', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;

    try {
      const existing = await candidateModel.getById(id);
      const candidate = existing.rows[0];
      if (!candidate) {
        return reply.status(404).send({ success: false, message: 'Candidate not found' });
      }

      const { files, fields } = await readMultipartFiles(req, ['evidence']);
      const { matchedPartnerMemberId, matchedPartnerName, matchedPartnerGender, matchDate } = fields as any;

      if (!matchedPartnerName?.trim()) {
        return reply.status(400).send({ success: false, message: 'matchedPartnerName is required' });
      }
      if (!matchedPartnerGender?.trim()) {
        return reply.status(400).send({ success: false, message: 'matchedPartnerGender is required' });
      }
      if (!files.evidence[0]) {
        return reply.status(400).send({ success: false, message: 'Evidence file (field "evidence") is required' });
      }

      let partnerMember: any = null;
      if (matchedPartnerMemberId?.trim()) {
        partnerMember = await memberModel.getOne(matchedPartnerMemberId.trim());
        if (!partnerMember) {
          return reply.status(404).send({ success: false, message: 'matchedPartnerMemberId does not match any known member' });
        }
      }

      const evidenceUrl = await uploadToFirebase(files.evidence[0], `matrimony/evidence/${id}`);

      const result = await candidateModel.confirmMatch(id, {
        matchedPartnerName: matchedPartnerName.trim(),
        matchedPartnerGender: matchedPartnerGender.trim(),
        matchedPartnerMemberId: matchedPartnerMemberId?.trim() || null,
        matchDate: matchDate?.trim() || null,
        evidenceUrl,
        verifiedBy: admin.username,
      });
      const updatedCandidate = result.rows[0];

      if (partnerMember) {
        let familyMembers = partnerMember.family_members ?? [];
        if (typeof familyMembers === 'string') {
          try { familyMembers = JSON.parse(familyMembers); } catch { familyMembers = []; }
        }
        if (!Array.isArray(familyMembers)) familyMembers = [];

        familyMembers.push({
          name: updatedCandidate.name,
          gender: updatedCandidate.gender,
          relation: updatedCandidate.gender === 'Female' ? 'Wife' : 'Husband',
          age: updatedCandidate.age ? String(updatedCandidate.age) : '',
          profile_pic: updatedCandidate.photo || null,
          marital_status: 'Married',
        });

        await memberModel.update(partnerMember.membership_no, { family_members: familyMembers });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'matrimony_match_confirmed',
        targetType: 'candidate',
        targetId: String(id),
        metadata: { matchedPartnerMemberId: matchedPartnerMemberId?.trim() || null },
        req,
      });

      return reply.send({ success: true, candidate: await resolveCandidateMedia(updatedCandidate) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to confirm match' });
    }
  });
}
