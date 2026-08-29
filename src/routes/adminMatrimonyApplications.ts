import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as matrimonyApplicationModel from '../models/matrimonyApplicationModel';
import * as candidateModel from '../models/candidateModel';
import { getSignedMediaUrl } from '../utils/firebaseStorage';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastNewCandidate } from '../utils/matrimonyNotifications';

async function resolveApplicationMedia(row: any) {
  return {
    ...row,
    uploaded_file_url: await getSignedMediaUrl(row.uploaded_file_url),
  };
}

// Reads the gender stashed in `verification_checklist` jsonb at submission
// time (see routes/matrimony.ts's POST /matrimony/applications) — the
// `matrimony_applications` table itself has no dedicated gender column.
function extractGender(application: any): string | null {
  let checklist = application.verification_checklist;
  if (typeof checklist === 'string') {
    try { checklist = JSON.parse(checklist); } catch { checklist = null; }
  }
  return checklist?.gender || null;
}

export default async function adminMatrimonyApplicationsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/matrimony/applications ── review queue. Defaults to
  // ALL statuses (not just pending) so admins can see the whole queue
  // including history, unless a `status` filter is explicitly passed.
  fastify.get('/matrimony/applications', async (req: FastifyRequest, reply: FastifyReply) => {
    const { status, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const [result, total] = await Promise.all([
        matrimonyApplicationModel.adminList({ status, limit: pLimit, offset }),
        matrimonyApplicationModel.adminCount({ status }),
      ]);
      const applications = await Promise.all(result.rows.map(resolveApplicationMedia));
      return reply.send({
        success: true,
        applications,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch matrimony applications' });
    }
  });

  // ── GET /api/admin/matrimony/applications/:id ──
  fastify.get('/matrimony/applications/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await matrimonyApplicationModel.getById(id);
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ success: false, message: 'Application not found' });
      return reply.send({ success: true, application: await resolveApplicationMedia(row) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch application' });
    }
  });

  // ── POST /api/admin/matrimony/applications/:id/approve ── approve the
  // uploaded form and publish it into the browsable candidates directory.
  fastify.post('/matrimony/applications/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;

    try {
      const existing = await matrimonyApplicationModel.getById(id);
      const application = existing.rows[0];
      if (!application) {
        return reply.status(404).send({ success: false, message: 'Application not found' });
      }

      const updated = await matrimonyApplicationModel.appendHistoryAndSetStatus(id, {
        status: 'approved',
        remark: 'Approved',
        changedBy: admin.username,
      });

      try {
        const body = (req.body as any) || {};
        const gender = body.gender || extractGender(application);

        const candidateResult = await candidateModel.createCandidate({
          name: application.member_name,
          gender,
          phone: application.member_mobile,
          formUrl: application.uploaded_file_url,
          photos: application.photos,
          submittedBy: application.member_id,
          status: 'approved',
        });

        await logActivity({
          actorType: admin.role,
          actorId: String(admin.id),
          action: 'matrimony_application_approved',
          targetType: 'matrimony_application',
          targetId: String(id),
          metadata: { candidateId: candidateResult.rows[0]?.id },
          req,
        });

        await broadcastNewCandidate(fastify, candidateResult.rows[0]);

        return reply.send({
          success: true,
          application: updated.rows[0],
          candidate: candidateResult.rows[0],
        });
      } catch (candidateErr) {
        // The application was already marked approved above — don't lose
        // that, but make sure this partial-completion state is loud and
        // clear rather than silently swallowed.
        fastify.log.error(candidateErr, `Application ${id} was marked approved but candidate creation failed`);
        return reply.status(500).send({
          success: false,
          message: 'Application was approved, but creating the published candidate profile failed. Please retry or create the candidate manually.',
          application: updated.rows[0],
        });
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve application' });
    }
  });

  // ── POST /api/admin/matrimony/applications/:id/request-correction ──
  fastify.post('/matrimony/applications/:id/request-correction', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { remark } = (req.body as any) || {};
    const admin = req.user as any;

    if (!remark?.trim()) {
      return reply.status(400).send({ success: false, message: 'remark is required' });
    }

    try {
      const result = await matrimonyApplicationModel.appendHistoryAndSetStatus(id, {
        status: 'correction_needed',
        remark: remark.trim(),
        changedBy: admin.username,
      });
      if (!result?.rows[0]) return reply.status(404).send({ success: false, message: 'Application not found' });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'matrimony_application_correction_requested',
        targetType: 'matrimony_application',
        targetId: String(id),
        metadata: { remark: remark.trim() },
        req,
      });

      return reply.send({ success: true, application: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to request correction' });
    }
  });

  // ── POST /api/admin/matrimony/applications/:id/reject ──
  fastify.post('/matrimony/applications/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { remark } = (req.body as any) || {};
    const admin = req.user as any;

    if (!remark?.trim()) {
      return reply.status(400).send({ success: false, message: 'remark is required' });
    }

    try {
      const result = await matrimonyApplicationModel.appendHistoryAndSetStatus(id, {
        status: 'rejected',
        remark: remark.trim(),
        changedBy: admin.username,
      });
      if (!result?.rows[0]) return reply.status(404).send({ success: false, message: 'Application not found' });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'matrimony_application_rejected',
        targetType: 'matrimony_application',
        targetId: String(id),
        metadata: { remark: remark.trim() },
        req,
      });

      return reply.send({ success: true, application: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject application' });
    }
  });
}
