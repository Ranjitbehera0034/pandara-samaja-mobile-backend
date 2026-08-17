import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jobModel from '../models/jobModel';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';

// Broadcasts a new job posting to every member — in-app notification row
// per member (same actor_id-is-the-recipient workaround adminAnnouncements
// uses, since portal_notifications.actor_id is NOT NULL with a members FK
// and there's no admin row to point at) + a push notification. Wrapped so
// a failure here can never fail the posting/approval that triggered it.
async function broadcastNewJob(fastify: FastifyInstance, job: any) {
  try {
    await pool.query(
      `INSERT INTO portal_notifications (recipient_id, actor_id, type, message)
       SELECT membership_no, membership_no, 'new_job', $1
       FROM members
       WHERE is_banned IS NULL OR is_banned = false`,
      [job.title]
    );
    broadcastPushToAllMembers(
      job.title,
      `New ${job.category === 'govt' ? 'government' : 'private'} job posting`,
      { type: 'new_job', jobId: String(job.id) }
    ).catch(() => { /* never throws, defensive only */ });
  } catch (broadcastErr) {
    fastify.log.error(broadcastErr as any, '[JOBS] Failed to broadcast new job posting');
  }
}

export default async function adminJobsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/jobs ── published postings, any category
  fastify.get('/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { category, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await jobModel.adminListPostings({ category, limit: pLimit, offset });
      return reply.send({ success: true, jobs: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch jobs' });
    }
  });

  // ── POST /api/admin/jobs ── admin-created posting, pre-approved and
  // published immediately (e.g. a real government vacancy found by hand).
  fastify.post('/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { title, organization, category, description, location, applicationInfo, contactPhone, expiresAt } = body;

    if (!title?.trim() || !organization?.trim() || !description?.trim() || !applicationInfo?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, organization, description and applicationInfo are required' });
    }
    if (category !== 'govt' && category !== 'private') {
      return reply.status(400).send({ success: false, message: 'category must be "govt" or "private"' });
    }

    try {
      const result = await jobModel.createPosting({
        title: title.trim(),
        organization: organization.trim(),
        category,
        description: description.trim(),
        location: location?.trim() || null,
        applicationInfo: applicationInfo.trim(),
        contactPhone: contactPhone?.trim() || null,
        postedByAdmin: true,
        expiresAt: expiresAt || null,
      });
      const job = result.rows[0];

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_admin_created',
        targetType: 'job_posting',
        targetId: String(job.id),
        req,
      });

      await broadcastNewJob(fastify, job);

      return reply.status(201).send({ success: true, job });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create job posting' });
    }
  });

  // ── PUT /api/admin/jobs/:id ──
  fastify.put('/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await jobModel.updatePosting(id, req.body as any);
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Job not found' });
      return reply.send({ success: true, job: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update job posting' });
    }
  });

  // ── DELETE /api/admin/jobs/:id ──
  fastify.delete('/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await jobModel.deletePosting(id);
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Job not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_deleted',
        targetType: 'job_posting',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete job posting' });
    }
  });

  // ── GET /api/admin/jobs/submissions ── review queue, defaults to ALL
  // statuses unless a status filter is passed (matches the matrimony
  // applications queue convention).
  fastify.get('/jobs/submissions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { status, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const [result, total] = await Promise.all([
        jobModel.adminListSubmissions({ status, limit: pLimit, offset }),
        jobModel.adminCountSubmissions({ status }),
      ]);
      return reply.send({
        success: true,
        submissions: result.rows,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch job submissions' });
    }
  });

  // ── POST /api/admin/jobs/submissions/:id/approve ── publish into job_postings
  fastify.post('/jobs/submissions/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;

    try {
      const existing = await jobModel.getSubmissionById(id);
      const submission = existing.rows[0];
      if (!submission) {
        return reply.status(404).send({ success: false, message: 'Submission not found' });
      }
      if (submission.status === 'rejected') {
        return reply.status(400).send({ success: false, message: 'This submission was already rejected' });
      }

      const body = (req.body as any) || {};

      const postingResult = await jobModel.createPosting({
        title: submission.title,
        organization: submission.organization,
        category: submission.category,
        description: submission.description,
        location: submission.location,
        applicationInfo: submission.application_info,
        contactPhone: submission.submitter_mobile,
        postedByAdmin: false,
        submittedBy: submission.membership_no,
        expiresAt: body.expiresAt || null,
      });
      const job = postingResult.rows[0];

      await jobModel.appendApprovedHistory(id, { changedBy: admin.username });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_submission_approved',
        targetType: 'job_submission',
        targetId: String(id),
        metadata: { jobId: job.id },
        req,
      });

      await broadcastNewJob(fastify, job);

      return reply.send({ success: true, job });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve job submission' });
    }
  });

  // ── POST /api/admin/jobs/submissions/:id/reject ──
  fastify.post('/jobs/submissions/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { remark } = (req.body as any) || {};
    const admin = req.user as any;

    if (!remark?.trim()) {
      return reply.status(400).send({ success: false, message: 'remark is required' });
    }

    try {
      const result = await jobModel.rejectSubmission(id, { remark: remark.trim(), changedBy: admin.username });
      if (!result.rows[0]) return reply.status(404).send({ success: false, message: 'Submission not found' });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_submission_rejected',
        targetType: 'job_submission',
        targetId: String(id),
        metadata: { remark: remark.trim() },
        req,
      });

      return reply.send({ success: true, submission: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject job submission' });
    }
  });

  // ── GET /api/admin/jobs/reports ── live listings flagged by members,
  // pending review. Mirrors GET /admin/story-reports exactly.
  fastify.get('/jobs/reports', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const jobs = await jobModel.getReportedJobs();
      return reply.send({ success: true, jobs });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch reported jobs' });
    }
  });

  // ── POST /api/admin/jobs/reports/:id/approve ── report was unfounded, restore the listing
  fastify.post('/jobs/reports/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;
    try {
      const result = await jobModel.approveReportedJob(id);
      if (!result) return reply.status(404).send({ success: false, message: 'Job not found' });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_report_approved',
        targetType: 'job_posting',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve job' });
    }
  });

  // ── POST /api/admin/jobs/reports/:id/reject ── report was valid, delete the listing
  fastify.post('/jobs/reports/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;
    try {
      const result = await jobModel.rejectReportedJob(id);
      if (!result) return reply.status(404).send({ success: false, message: 'Job not found' });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_report_rejected',
        targetType: 'job_posting',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject job' });
    }
  });
}
