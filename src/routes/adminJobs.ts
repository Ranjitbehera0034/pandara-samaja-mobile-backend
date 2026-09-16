import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jobModel from '../models/jobModel';
import * as jobEditSuggestionModel from '../models/jobEditSuggestionModel';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';

// Broadcasts a new job posting to every member — in-app notification row
// per member (actor_id-is-the-recipient workaround adminAnnouncements uses,
// since portal_notifications.actor_id is NOT NULL with a members FK and
// there's no admin row to point at) + a push notification. actor_name is
// set explicitly to a fixed system label — leaving it unset let the
// display query's COALESCE(actor_name, members.name) fall through to the
// joined member row, which (since actor_id === recipient_id here) resolved
// to the RECIPIENT'S OWN head of family, making every member see "<their
// own head of family> posted a job" instead of a real, generic label.
// Wrapped so a failure here can never fail the posting/approval that
// triggered it.
async function broadcastNewJob(fastify: FastifyInstance, job: any) {
  try {
    await pool.query(
      `INSERT INTO portal_notifications (recipient_id, actor_id, type, post_id, message, actor_name)
       SELECT membership_no, membership_no, 'new_job', $1, $2, 'New Job Posted'
       FROM members
       WHERE is_banned IS NULL OR is_banned = false`,
      [String(job.id), job.title]
    );
    broadcastPushToAllMembers(
      job.title,
      job.category === 'govt' ? 'ନୂଆ ସରକାରୀ ଚାକିରି' : 'ନୂଆ ବେସରକାରୀ ଚାକିରି',
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
    const {
      title, organization, category, sector, description, location, applicationInfo, contactPhone,
      eligibility, lastDate, registrationStartDate, applicationFee, noOfVacancies, expiresAt,
    } = body;

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
        sector: sector?.trim() || null,
        description: description.trim(),
        location: location?.trim() || null,
        applicationInfo: applicationInfo.trim(),
        contactPhone: contactPhone?.trim() || null,
        eligibility: eligibility?.trim() || null,
        lastDate: lastDate?.trim() || null,
        registrationStartDate: registrationStartDate?.trim() || null,
        applicationFee: applicationFee?.trim() || null,
        noOfVacancies: noOfVacancies?.trim() || null,
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

      // Approval accepts optional per-field overrides — the scraper's OCR
      // extraction is best-effort against messy government PDFs (see
      // scraper/src/structure.ts) and previously had no way to be
      // corrected before going live to real members; an admin can now
      // clean up a garbled eligibility/date/vacancy-count value here
      // instead of either publishing it as-is or rejecting the whole
      // submission. Falls back to the submission's own extracted value
      // when a field isn't overridden.
      const postingResult = await jobModel.createPosting({
        title: (body.title?.trim()) || submission.title,
        organization: (body.organization?.trim()) || submission.organization,
        category: submission.category,
        sector: body.sector !== undefined ? (body.sector?.trim() || null) : submission.sector,
        description: (body.description?.trim()) || submission.description,
        location: body.location !== undefined ? (body.location?.trim() || null) : submission.location,
        applicationInfo: (body.applicationInfo?.trim()) || submission.application_info,
        contactPhone: submission.submitter_mobile,
        eligibility: body.eligibility !== undefined ? (body.eligibility?.trim() || null) : submission.eligibility,
        lastDate: body.lastDate !== undefined ? (body.lastDate?.trim() || null) : submission.last_date,
        registrationStartDate: body.registrationStartDate !== undefined ? (body.registrationStartDate?.trim() || null) : submission.registration_start_date,
        applicationFee: body.applicationFee !== undefined ? (body.applicationFee?.trim() || null) : submission.application_fee,
        noOfVacancies: body.noOfVacancies !== undefined ? (body.noOfVacancies?.trim() || null) : submission.no_of_vacancies,
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

  /* ─────────────── JOB EDIT SUGGESTIONS (review queue) ────────────── */
  // A member's proposed correction to an already-published posting — see
  // routes/jobs.ts's POST /jobs/:id/edit-suggestions and
  // jobEditSuggestionModel.ts. Approving here is the only way one of these
  // reaches the live posting; an admin editing the posting directly via
  // PUT /jobs/:id above is a separate path and was never gated by this.

  // ── GET /api/admin/jobs/edit-suggestions ──
  fastify.get('/jobs/edit-suggestions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { status, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await jobEditSuggestionModel.adminList({ status, limit: pLimit, offset });
      return reply.send({ success: true, suggestions: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch job edit suggestions' });
    }
  });

  // ── POST /api/admin/jobs/edit-suggestions/:id/approve ── applies the
  // proposed fields onto the live posting immediately.
  fastify.post('/jobs/edit-suggestions/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const admin = req.user as any;

    try {
      const result = await jobEditSuggestionModel.approveSuggestion(id, { changedBy: admin.username });
      if ((result as any).alreadyReviewed) {
        return reply.status(400).send({ success: false, message: 'This suggestion was already reviewed' });
      }
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Suggestion not found' });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_edit_suggestion_approved',
        targetType: 'job_edit_suggestion',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, job: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve edit suggestion' });
    }
  });

  // ── POST /api/admin/jobs/edit-suggestions/:id/reject ──
  fastify.post('/jobs/edit-suggestions/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { remark } = (req.body as any) || {};
    const admin = req.user as any;

    try {
      const result = await jobEditSuggestionModel.rejectSuggestion(id, {
        remark: remark?.trim() || '',
        changedBy: admin.username,
      });
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Suggestion not found or already reviewed' });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'job_edit_suggestion_rejected',
        targetType: 'job_edit_suggestion',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, suggestion: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject edit suggestion' });
    }
  });
}
