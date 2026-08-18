import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jobModel from '../models/jobModel';
import { JOB_INGEST_KEY } from '../config/secrets';

// Ingestion path for the scraper/ GitHub Action (OSSC/OPSC government
// vacancy notices, OCR'd + LLM-structured, see scraper/README.md). No
// member/admin JWT applies to this caller, so it's a wholly separate,
// shared-secret-gated route file rather than living under /api/portal or
// /api/admin. Every accepted notice lands in the same job_submissions
// pending queue member submissions use — never auto-published, since a
// misread deadline or eligibility detail would mislead a real applicant.
export default async function jobIngestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-ingest-key'];
    if (!JOB_INGEST_KEY || key !== JOB_INGEST_KEY) {
      return reply.status(401).send({ success: false, message: 'Invalid or missing ingest key' });
    }
  });

  // ── GET /api/ingest/jobs/seen?source=ossc ── source_refs already
  // ingested for this source, so the scraper can skip them without keeping
  // its own state between runs.
  fastify.get('/jobs/seen', async (req: FastifyRequest, reply: FastifyReply) => {
    const { source } = req.query as any;
    if (!source?.trim()) {
      return reply.status(400).send({ success: false, message: 'source is required' });
    }
    try {
      const seen = await jobModel.getSeenSourceRefs(`${source.trim()}:`);
      return reply.send({ success: true, seen });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch seen source refs' });
    }
  });

  // ── POST /api/ingest/jobs ── one OCR'd + LLM-structured notice.
  // sourceRef's UNIQUE constraint on job_submissions is the actual dedup
  // guard — a repeat submission for an already-seen notice fails here with
  // a 409 rather than creating a duplicate pending row.
  fastify.post('/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { title, organization, description, location, applicationInfo, sourceRef } = body;

    if (!title?.trim() || !organization?.trim() || !description?.trim() || !applicationInfo?.trim() || !sourceRef?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, organization, description, applicationInfo and sourceRef are required' });
    }

    try {
      const result = await jobModel.createSubmission({
        membershipNo: null,
        submitterName: `${organization.trim()} — auto-detected`,
        title: title.trim(),
        organization: organization.trim(),
        category: 'govt',
        description: description.trim(),
        location: location?.trim() || null,
        applicationInfo: applicationInfo.trim(),
        sourceRef: sourceRef.trim(),
      });

      return reply.status(201).send({ success: true, submission: result.rows[0] });
    } catch (err: any) {
      // Unique violation on source_ref == already ingested, not a real error.
      if (err?.code === '23505') {
        return reply.status(409).send({ success: false, message: 'Already ingested' });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to ingest job posting' });
    }
  });
}
