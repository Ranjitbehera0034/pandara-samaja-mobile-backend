import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as candidateModel from '../models/candidateModel';
import * as matrimonyApplicationModel from '../models/matrimonyApplicationModel';
import * as memberModel from '../models/memberModel';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

// The static, public, permanent URL for the blank registration form PDF —
// centralized here (rather than hardcoded in the mobile app) in case it
// ever needs to change.
const MATRIMONY_FORM_TEMPLATE_URL =
  'https://storage.googleapis.com/nikhila-odisha-pandara-samaja.firebasestorage.app/matrimony/templates/pandara-caste-matrimony-form.pdf';

export async function resolveCandidateMedia(row: any) {
  return {
    ...row,
    photo: await getSignedMediaUrl(row.photo),
    photos: await resolveMediaUrls(row.photos),
    form_url: await getSignedMediaUrl(row.manual_form),
    match_evidence_url: await getSignedMediaUrl(row.match_evidence_url),
  };
}

async function resolveApplicationMedia(row: any) {
  return {
    ...row,
    uploaded_file_url: await getSignedMediaUrl(row.uploaded_file_url),
    photos: await resolveMediaUrls(row.photos),
  };
}

export default async function matrimonyRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /matrimony/candidates ── browse the directory of all approved,
  // unmatched candidates. No gender-exclusivity — `gender` is just an
  // optional display filter now, not a forced opposite-gender default.
  fastify.get('/matrimony/candidates', async (req: FastifyRequest, reply: FastifyReply) => {
    const { search, minAge, maxAge, education, gotra, sort, gender, page = '1', limit = '20' } = req.query as any;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const offset = (parseInt(page, 10) - 1) * pLimit;

    try {
      const result = await candidateModel.browse({
        viewerMembershipNo: req.user.membership_no,
        gender,
        search,
        minAge: minAge ? parseInt(minAge, 10) : undefined,
        maxAge: maxAge ? parseInt(maxAge, 10) : undefined,
        education,
        gotra,
        sort,
        limit: pLimit,
        offset,
      });
      const candidates = await Promise.all(result.rows.map(resolveCandidateMedia));
      return reply.send({ success: true, candidates, page: parseInt(page, 10) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch candidates' });
    }
  });

  // ── GET /matrimony/candidates/:id ──
  fastify.get('/matrimony/candidates/:id', async (req: FastifyRequest, reply: FastifyReply) => {
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

  // ── GET /matrimony/form-template ── static blank-form PDF URL
  fastify.get('/matrimony/form-template', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ success: true, url: MATRIMONY_FORM_TEMPLATE_URL });
  });

  // ── POST /matrimony/applications ── submit a filled-and-signed copy of
  // the official paper registration form (photo or PDF) for review. Any
  // member can submit for themselves or a family member.
  fastify.post('/matrimony/applications', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['form', 'photos']);
      const { candidateName, relationToHof, gender, uploadedByMobile } = fields as any;

      if (!candidateName?.trim()) {
        return reply.status(400).send({ success: false, message: 'candidateName is required' });
      }
      if (!relationToHof?.trim()) {
        return reply.status(400).send({ success: false, message: 'relationToHof is required' });
      }
      if (!gender?.trim()) {
        return reply.status(400).send({ success: false, message: 'gender is required' });
      }
      if (!files.form[0]) {
        return reply.status(400).send({ success: false, message: 'The filled-and-signed registration form (file field "form") is required' });
      }

      const submitter = await memberModel.getOne(req.user.membership_no);
      if (!submitter) {
        return reply.status(404).send({ success: false, message: 'Submitting member not found' });
      }

      const file = files.form[0];
      const uploadedFileUrl = await uploadToFirebase(file, UPLOAD_PATHS.MATRIMONY_FORM(req.user.membership_no));
      const ext = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.') + 1).toLowerCase() : null;

      // Personal photos are optional — the form scan is the only required
      // file — so this list may be empty.
      const photoUrls = await Promise.all(
        files.photos.map((f) => uploadToFirebase(f, UPLOAD_PATHS.MATRIMONY_CANDIDATE(req.user.membership_no)))
      );

      const result = await matrimonyApplicationModel.create({
        memberId: req.user.membership_no,
        membershipNo: req.user.membership_no,
        memberName: candidateName.trim(),
        relationToHof: relationToHof.trim(),
        uploadedByName: submitter.name || null,
        uploadedByMobile: uploadedByMobile?.trim() || submitter.mobile || null,
        memberMobile: submitter.mobile || null,
        uploadedFileUrl,
        fileType: ext,
        photos: photoUrls,
        verificationChecklist: { gender: gender.trim() },
      });

      const application = await resolveApplicationMedia(result.rows[0]);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'matrimony_application_submitted',
        targetType: 'matrimony_application',
        targetId: String(application.id),
        actorName: req.user.name,
        req,
      });

      return reply.status(201).send({ success: true, application });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit matrimony application' });
    }
  });

  // ── GET /matrimony/applications/mine ── the logged-in member's own
  // submitted applications and their review status.
  fastify.get('/matrimony/applications/mine', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await matrimonyApplicationModel.getBySubmitter(req.user.membership_no);
      const applications = await Promise.all(result.rows.map(resolveApplicationMedia));
      return reply.send({ success: true, applications });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch your applications' });
    }
  });

  // ── POST /matrimony/applications/:id/resubmit ── re-upload after a
  // correction request.
  fastify.post('/matrimony/applications/:id/resubmit', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const existing = await matrimonyApplicationModel.getById(id);
      const application = existing.rows[0];
      if (!application) {
        return reply.status(404).send({ success: false, message: 'Application not found' });
      }
      if (application.member_id !== req.user.membership_no) {
        return reply.status(403).send({ success: false, message: 'You can only resubmit your own application' });
      }
      if (application.status !== 'correction_needed') {
        return reply.status(400).send({ success: false, message: 'This application is not awaiting a correction, so it cannot be resubmitted' });
      }

      const { files } = await readMultipartFiles(req, ['form']);
      if (!files.form[0]) {
        return reply.status(400).send({ success: false, message: 'The corrected registration form (file field "form") is required' });
      }

      const submitter = await memberModel.getOne(req.user.membership_no);
      const file = files.form[0];
      const uploadedFileUrl = await uploadToFirebase(file, UPLOAD_PATHS.MATRIMONY_FORM(req.user.membership_no));
      const ext = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.') + 1).toLowerCase() : null;

      const result = await matrimonyApplicationModel.resubmit(id, {
        uploadedFileUrl,
        fileType: ext,
        uploadedByName: submitter?.name || null,
        uploadedByMobile: submitter?.mobile || null,
      });

      const application2 = await resolveApplicationMedia(result.rows[0]);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'matrimony_application_resubmitted',
        targetType: 'matrimony_application',
        targetId: String(id),
        actorName: req.user.name,
        req,
      });

      return reply.send({ success: true, application: application2 });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to resubmit your application' });
    }
  });
}
