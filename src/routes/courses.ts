import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as courseModel from '../models/courseModel';

// Member-facing courses — registered under /api/portal alongside jobs/
// posts/etc. Read-only: courses are entirely admin-curated (see
// ARCHITECTURE.md's "Courses" section), no member submission path.
// A lesson is a link out to an external platform (YouTube/Udemy/
// Coursera/...) — this app never hosts or streams the video itself.
export default async function coursesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/courses ── published courses, newest first
  fastify.get('/courses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { category, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await courseModel.listPublished({ category, limit: pLimit, offset });
      return reply.send({ success: true, courses: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch courses' });
    }
  });

  // ── GET /api/portal/courses/:id ── published course + its lessons
  fastify.get('/courses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await courseModel.getPublishedById(id);
      const course = result.rows[0];
      if (!course) {
        return reply.status(404).send({ success: false, message: 'Course not found' });
      }
      const lessons = await courseModel.getLessonsByCourseId(id);
      return reply.send({ success: true, course: { ...course, lessons: lessons.rows } });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch course' });
    }
  });
}
