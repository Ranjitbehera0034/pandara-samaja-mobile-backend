import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as courseLessonSubmissionModel from '../models/courseLessonSubmissionModel';
import { COURSE_INGEST_KEY } from '../config/secrets';

// Ingestion path for the scraper/ GitHub Action's daily YouTube-channel
// check (see scraper/src/sources/youtubeChannels.ts). No member/admin JWT
// applies to this caller, so it's a wholly separate, shared-secret-gated
// route file, same pattern as jobIngest.ts. Every accepted video lands in
// course_lesson_submissions, never auto-published — an off-topic upload
// from an otherwise-trusted channel reaching members unreviewed is the
// same failure mode a misread job deadline is.
export default async function courseIngestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-ingest-key'];
    if (!COURSE_INGEST_KEY || key !== COURSE_INGEST_KEY) {
      return reply.status(401).send({ success: false, message: 'Invalid or missing ingest key' });
    }
  });

  // ── GET /api/ingest/course-lessons/seen ── source_refs already ingested,
  // so the scraper can skip them without keeping its own state between runs.
  fastify.get('/course-lessons/seen', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const seen = await courseLessonSubmissionModel.getSeenSourceRefs();
      return reply.send({ success: true, seen });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch seen source refs' });
    }
  });

  // ── POST /api/ingest/course-lessons ── one newly-discovered video.
  // source_ref's UNIQUE constraint is the actual dedup guard — a repeat
  // submission for an already-seen video fails here with a 409 rather
  // than creating a duplicate pending row.
  fastify.post('/course-lessons', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { title, platform, externalUrl, category, channelName, sourceRef } = body;

    if (!title?.trim() || !externalUrl?.trim() || !sourceRef?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, externalUrl and sourceRef are required' });
    }

    try {
      const result = await courseLessonSubmissionModel.createSubmission({
        title: title.trim(),
        platform: platform?.trim() || 'YouTube',
        externalUrl: externalUrl.trim(),
        category: category?.trim() || null,
        channelName: channelName?.trim() || null,
        sourceRef: sourceRef.trim(),
      });

      return reply.status(201).send({ success: true, submission: result.rows[0] });
    } catch (err: any) {
      if (err?.code === '23505') {
        return reply.status(409).send({ success: false, message: 'Already ingested' });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to ingest course lesson' });
    }
  });
}
