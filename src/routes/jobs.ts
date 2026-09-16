import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jobModel from '../models/jobModel';
import * as jobEditSuggestionModel from '../models/jobEditSuggestionModel';
import { logActivity } from '../utils/activityLog';

// Member-facing job board — registered under the shared /api/portal prefix
// alongside posts/stories/etc, so every route here is namespaced under
// /jobs to avoid colliding with theirs. Admin-gated CRUD + the submission
// review queue live in routes/adminJobs.ts. "Apply" here means the
// posting carries instructions/a link for how to apply outside the app —
// there's no in-app application tracking, same framing as the news reader
// pointing out to the real article rather than hosting it.
export default async function jobsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/jobs ── published postings, newest first
  fastify.get('/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { category, sector, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await jobModel.listPublished({ category, sector, limit: pLimit, offset });
      return reply.send({ success: true, jobs: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch jobs' });
    }
  });

  // ── POST /api/portal/jobs/submissions ── member submits a job posting for review.
  // contactPhone is the submitter's OWN accountability number — required so
  // applicants know who to hold accountable and admin can call to verify
  // before approving; it's distinct from applicationInfo (which may point
  // elsewhere, e.g. a company HR line or a link).
  fastify.post('/jobs/submissions', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const {
      title, organization, category, sector, description, location, applicationInfo, contactPhone,
      eligibility, lastDate, registrationStartDate, applicationFee, noOfVacancies,
    } = body;

    if (!title?.trim() || !organization?.trim() || !description?.trim() || !applicationInfo?.trim() || !contactPhone?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, organization, description, applicationInfo and contactPhone are required' });
    }
    if (category !== 'govt' && category !== 'private') {
      return reply.status(400).send({ success: false, message: 'category must be "govt" or "private"' });
    }

    try {
      const result = await jobModel.createSubmission({
        membershipNo: req.user.membership_no,
        submitterName: req.user.name,
        submitterMobile: contactPhone.trim(),
        title: title.trim(),
        organization: organization.trim(),
        category,
        sector: sector?.trim() || null,
        description: description.trim(),
        location: location?.trim() || null,
        applicationInfo: applicationInfo.trim(),
        eligibility: eligibility?.trim() || null,
        lastDate: lastDate?.trim() || null,
        registrationStartDate: registrationStartDate?.trim() || null,
        applicationFee: applicationFee?.trim() || null,
        noOfVacancies: noOfVacancies?.trim() || null,
      });

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'job_submitted',
        targetType: 'job_submission',
        targetId: String(result.rows[0].id),
        actorName: req.user.name,
        req,
      });

      return reply.status(201).send({ success: true, submission: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit job posting' });
    }
  });

  // ── GET /api/portal/jobs/submissions/mine ── the logged-in member's own submissions
  fastify.get('/jobs/submissions/mine', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await jobModel.getSubmissionsBySubmitter(req.user.membership_no);
      return reply.send({ success: true, submissions: result.rows });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch your submissions' });
    }
  });

  // ── GET /api/portal/jobs/:id ── kept below the more specific /jobs/submissions*
  // routes for readability (Fastify's router matches static segments before
  // parametric ones regardless of registration order, so this isn't load-bearing).
  fastify.get('/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await jobModel.getPostingById(id);
      const job = result.rows[0];
      if (!job || job.moderation_status !== 'visible') {
        return reply.status(404).send({ success: false, message: 'Job not found' });
      }
      return reply.send({ success: true, job });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch job' });
    }
  });

  // ── POST /api/portal/jobs/:id/report ── auto-hides the listing pending
  // admin review, mirrors POST /portal/stories/:id/report exactly.
  fastify.post('/jobs/:id/report', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { reason } = (req.body as any) || {};
    try {
      const existing = await jobModel.getPostingById(id);
      if (!existing.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Job not found' });
      }

      await jobModel.reportJob(id, req.user.membership_no, reason);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'job_reported',
        targetType: 'job_posting',
        targetId: String(id),
        actorName: req.user.name,
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to report job' });
    }
  });

  // ── POST /api/portal/jobs/:id/edit-suggestions ── a member spots wrong
  // or outdated info on an already-published posting and proposes a fix.
  // Every field is optional — only send the ones actually being corrected,
  // left NULL otherwise — but `note` (what's being corrected and why) is
  // required so an admin can review it without diffing every field.
  // Never applied automatically: lands in job_edit_suggestions for an
  // admin to approve or reject (see routes/adminJobs.ts). An admin/
  // superadmin editing the same posting directly via PUT
  // /api/admin/jobs/:id is a completely separate path and applies
  // immediately, untouched by this route.
  fastify.post('/jobs/:id/edit-suggestions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const body = (req.body as any) || {};
    const { note } = body;

    if (!note?.trim()) {
      return reply.status(400).send({ success: false, message: 'note is required — briefly describe what you\'re correcting' });
    }

    try {
      const existing = await jobModel.getPostingById(id);
      if (!existing.rows[0] || existing.rows[0].moderation_status !== 'visible') {
        return reply.status(404).send({ success: false, message: 'Job not found' });
      }

      const result = await jobEditSuggestionModel.createSuggestion({
        jobId: id,
        suggestedBy: req.user.membership_no,
        suggesterName: req.user.name,
        title: body.title?.trim() || null,
        organization: body.organization?.trim() || null,
        sector: body.sector?.trim() || null,
        description: body.description?.trim() || null,
        location: body.location?.trim() || null,
        applicationInfo: body.applicationInfo?.trim() || null,
        eligibility: body.eligibility?.trim() || null,
        lastDate: body.lastDate?.trim() || null,
        registrationStartDate: body.registrationStartDate?.trim() || null,
        applicationFee: body.applicationFee?.trim() || null,
        noOfVacancies: body.noOfVacancies?.trim() || null,
        note: note.trim(),
      });

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'job_edit_suggested',
        targetType: 'job_posting',
        targetId: String(id),
        actorName: req.user.name,
        req,
      });

      return reply.status(201).send({ success: true, suggestion: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit edit suggestion' });
    }
  });
}
