import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as candidateModel from '../models/candidateModel';
import * as memberModel from '../models/memberModel';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
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
    match_evidence_url: await getSignedMediaUrl(row.match_evidence_url),
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

  // ── POST /api/admin/matrimony ── admin-created candidate profile.
  // Multipart so admin can attach personal photos and/or a biodata form
  // image in the same request as the text fields — previously JSON-only,
  // which meant an admin-direct-created candidate could never carry any
  // media at all (only ones approved from a member application could, via
  // the form scan alone).
  fastify.post('/matrimony', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['photos', 'form']);
      if (!fields.name?.trim() || !fields.gender) {
        return reply.status(400).send({ success: false, message: 'Name and gender are required' });
      }

      const admin = req.user as any;
      const photoUrls = await Promise.all(
        files.photos.map((f) => uploadToFirebase(f, UPLOAD_PATHS.MATRIMONY_CANDIDATE(admin.username)))
      );
      const formUrl = files.form[0]
        ? await uploadToFirebase(files.form[0], UPLOAD_PATHS.MATRIMONY_FORM(admin.username))
        : undefined;

      const result = await candidateModel.createCandidate({
        ...fields,
        photos: photoUrls,
        formUrl,
        submittedBy: fields.submittedBy || null,
      });
      const candidate = await resolveCandidateMedia(result.rows[0]);
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

  // ── PUT /api/admin/matrimony/:id ── edit any field. Multipart for the
  // same reason as POST above — photos/photos and form are additive
  // (candidateModel.updateCandidate COALESCEs them), so omitting the files
  // entirely on a text-only edit leaves existing media untouched.
  fastify.put('/matrimony/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const { files, fields } = await readMultipartFiles(req, ['photos', 'form']);

      // New photos are ADDED to whatever the candidate already has, not a
      // replacement — the client only ever sends newly-picked local files
      // (the existing ones are resolved signed URLs by the time the app
      // sees them, which can't be re-uploaded as-is), so replacing here
      // would silently delete every photo already on file each time an
      // admin adds one more.
      let photos: string[] | undefined;
      if (files.photos.length > 0) {
        const existing = await candidateModel.getById(id);
        const existingPhotos: string[] = existing.rows[0]?.photos || [];
        const newUrls = await Promise.all(
          files.photos.map((f) => uploadToFirebase(f, UPLOAD_PATHS.MATRIMONY_CANDIDATE(String(id))))
        );
        photos = [...existingPhotos, ...newUrls];
      }
      const formUrl = files.form[0]
        ? await uploadToFirebase(files.form[0], UPLOAD_PATHS.MATRIMONY_FORM(String(id)))
        : undefined;

      const result = await candidateModel.updateCandidate(id, { ...fields, photos, formUrl });
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Candidate not found' });
      return reply.send({ success: true, candidate: await resolveCandidateMedia(result.rows[0]) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update candidate' });
    }
  });

  // ── PUT /api/admin/matrimony/:id/photos/reassign-to-form ── reclassify
  // one existing personal photo as the candidate's biodata form image — the
  // admin-support fix for a candidate who uploaded their form scan into the
  // photos section by mistake. Matches by the resolved (signed) URL the
  // admin is currently looking at rather than array index — resolveMediaUrls
  // drops null entries, so client-visible position isn't guaranteed to line
  // up with the raw stored array's position.
  fastify.put('/matrimony/:id/photos/reassign-to-form', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { photoUrl } = req.body as any;
    if (!photoUrl) {
      return reply.status(400).send({ success: false, message: 'photoUrl is required' });
    }

    try {
      const existing = await candidateModel.getById(id);
      const row = existing.rows[0];
      if (!row) return reply.status(404).send({ success: false, message: 'Candidate not found' });

      const rawPhotos: string[] = row.photos || [];
      const resolved = await Promise.all(
        rawPhotos.map(async (raw) => ({ raw, resolved: await getSignedMediaUrl(raw) }))
      );
      const match = resolved.find((r) => r.resolved === photoUrl);
      if (!match) {
        return reply.status(404).send({ success: false, message: 'That photo was not found on this candidate — it may have already changed' });
      }

      const newPhotos = rawPhotos.filter((p) => p !== match.raw);
      const result = await candidateModel.reassignPhotoToForm(id, newPhotos, match.raw);

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'matrimony_photo_reassigned_to_form',
        targetType: 'candidate',
        targetId: String(id),
        metadata: { replacedExistingForm: !!row.manual_form },
        req,
      });

      return reply.send({ success: true, candidate: await resolveCandidateMedia(result.rows[0]) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reassign photo' });
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
