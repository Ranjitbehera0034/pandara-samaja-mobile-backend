import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jobModel from '../models/jobModel';
import * as memberModel from '../models/memberModel';
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
    const { category, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await jobModel.listPublished({ category, limit: pLimit, offset });
      return reply.send({ success: true, jobs: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch jobs' });
    }
  });

  // ── POST /api/portal/jobs/submissions ── member submits a job posting for review
  fastify.post('/jobs/submissions', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { title, organization, category, description, location, applicationInfo } = body;

    if (!title?.trim() || !organization?.trim() || !description?.trim() || !applicationInfo?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, organization, description and applicationInfo are required' });
    }
    if (category !== 'govt' && category !== 'private') {
      return reply.status(400).send({ success: false, message: 'category must be "govt" or "private"' });
    }

    try {
      const submitter = await memberModel.getOne(req.user.membership_no);

      const result = await jobModel.createSubmission({
        membershipNo: req.user.membership_no,
        submitterName: req.user.name,
        submitterMobile: submitter?.mobile || null,
        title: title.trim(),
        organization: organization.trim(),
        category,
        description: description.trim(),
        location: location?.trim() || null,
        applicationInfo: applicationInfo.trim(),
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
      if (!job) return reply.status(404).send({ success: false, message: 'Job not found' });
      return reply.send({ success: true, job });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch job' });
    }
  });
}
