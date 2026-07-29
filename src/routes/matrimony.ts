import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as candidateModel from '../models/candidateModel';
import * as portalModel from '../models/portalModel';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

async function resolveCandidateMedia(row: any) {
  return {
    ...row,
    photo: await getSignedMediaUrl(row.photo),
    photos: await resolveMediaUrls(row.photos),
    form_url: await getSignedMediaUrl(row.manual_form),
  };
}

export default async function matrimonyRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /matrimony/candidates ── browse/search/sort/filter
  fastify.get('/matrimony/candidates', async (req: FastifyRequest, reply: FastifyReply) => {
    const { search, minAge, maxAge, education, gotra, sort, gender, page = '1', limit = '20' } = req.query as any;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const offset = (parseInt(page, 10) - 1) * pLimit;

    try {
      const result = await candidateModel.browse({
        viewerMembershipNo: req.user.membership_no,
        genderNotEqual: gender,
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

  // ── GET /matrimony/profile ── the member's own submitted candidate profile(s)
  fastify.get('/matrimony/profile', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await candidateModel.getBySubmitter(req.user.membership_no);
      const candidates = await Promise.all(result.rows.map(resolveCandidateMedia));
      return reply.send({ success: true, candidates });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch your profile' });
    }
  });

  // ── POST /matrimony/profile ── create or update own candidate profile
  // Multipart: text fields + optional 'form' file (biodata document) +
  // optional 'photos' files (one or more).
  fastify.post('/matrimony/profile', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['form', 'photos']);
      const {
        id, name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
        technicalEducation, professionalEducation, occupation, father, mother,
        address, phone, email,
      } = fields as any;

      if (!name?.trim() || !gender) {
        return reply.status(400).send({ success: false, message: 'Name and gender are required' });
      }

      let formUrl: string | undefined;
      if (files.form[0]) {
        formUrl = await uploadToFirebase(files.form[0], UPLOAD_PATHS.MATRIMONY_FORM(req.user.membership_no));
      }
      let photoUrls: string[] | undefined;
      if (files.photos.length > 0) {
        photoUrls = await Promise.all(
          files.photos.map((f) => uploadToFirebase(f, UPLOAD_PATHS.MATRIMONY_CANDIDATE(req.user.membership_no)))
        );
      }

      const data = {
        name: name.trim(), gender, dob, age: age ? parseInt(age, 10) : null, height, bloodGroup,
        gotra, bansha, education, technicalEducation, professionalEducation, occupation,
        father, mother, address, phone, email,
        photo: photoUrls?.[0], photos: photoUrls, formUrl,
        submittedBy: req.user.membership_no,
      };

      let result;
      if (id) {
        // Only allow updating a candidate profile you actually submitted.
        const existing = await candidateModel.getById(id);
        if (existing.rows[0]?.author_id !== req.user.membership_no) {
          return reply.status(403).send({ success: false, message: 'You can only edit your own profile' });
        }
        result = await candidateModel.updateCandidate(id, data);
      } else {
        result = await candidateModel.createCandidate(data);
      }

      const candidate = await resolveCandidateMedia(result.rows[0]);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'matrimony_profile_submitted',
        targetType: 'candidate',
        targetId: String(candidate.id),
        req,
      });

      return reply.status(201).send({ success: true, candidate });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to save your matrimony profile' });
    }
  });

  // ── POST /matrimony/candidates/:id/swipe ── { direction: 'like' | 'pass' }
  fastify.post('/matrimony/candidates/:id/swipe', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { direction } = req.body as any;
    if (!['like', 'pass'].includes(direction)) {
      return reply.status(400).send({ success: false, message: 'direction must be "like" or "pass"' });
    }
    try {
      const { matched } = await candidateModel.recordSwipe(req.user.membership_no, id, direction);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'matrimony_swipe',
        targetType: 'candidate',
        targetId: String(id),
        metadata: { direction },
        req,
      });

      if (matched) {
        // Reuse the existing notification system so a match feels like a real event.
        try {
          const result = await candidateModel.getById(id);
          const ownerId = result.rows[0]?.author_id;
          if (ownerId) {
            await portalModel.createNotification(ownerId, 'matrimony_match', req.user.membership_no, "It's a match! You both showed interest.", null);
          }
        } catch { /* non-fatal */ }
      }
      return reply.send({ success: true, matched });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to record your response' });
    }
  });

  // ── GET /matrimony/matches ──
  fastify.get('/matrimony/matches', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await candidateModel.getMatches(req.user.membership_no);
      const matches = await Promise.all(result.rows.map(resolveCandidateMedia));
      return reply.send({ success: true, matches });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch matches' });
    }
  });
}
