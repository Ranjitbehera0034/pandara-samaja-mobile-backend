import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as courseModel from '../models/courseModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';

// Admin-gated Courses CRUD. See ARCHITECTURE.md's "Courses" section —
// admin-authored only, no member submission queue, same shape as
// Announcements. A lesson is a title + platform + external URL; this app
// never hosts or streams the underlying video.
export default async function adminCoursesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/courses ── all courses (published + draft)
  fastify.get('/courses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { category, page = '1', limit = '20' } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const result = await courseModel.adminList({ category, limit: pLimit, offset });
      return reply.send({ success: true, courses: result.rows, page: pPage });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch courses' });
    }
  });

  // ── GET /api/admin/courses/:id ── course + its lessons, regardless of publish state
  fastify.get('/courses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await courseModel.adminGetById(id);
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

  // ── POST /api/admin/courses ── created as a draft (is_published = false);
  // publish explicitly once lessons have been added, via the /publish route.
  fastify.post('/courses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { title, description, category, thumbnailUrl } = (req.body as any) || {};
    if (!title?.trim()) {
      return reply.status(400).send({ success: false, message: 'title is required' });
    }

    try {
      const result = await courseModel.createCourse({
        title: title.trim(),
        description: description?.trim() || null,
        category: category?.trim() || null,
        thumbnailUrl: thumbnailUrl?.trim() || null,
      });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'course_created',
        targetType: 'course',
        targetId: String(result.rows[0].id),
        req,
      });

      return reply.status(201).send({ success: true, course: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create course' });
    }
  });

  // ── PUT /api/admin/courses/:id ──
  fastify.put('/courses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { title, description, category, thumbnailUrl } = (req.body as any) || {};

    try {
      const result = await courseModel.updateCourse(id, {
        title: title?.trim(),
        description: description !== undefined ? (description?.trim() || null) : undefined,
        category: category !== undefined ? (category?.trim() || null) : undefined,
        thumbnailUrl: thumbnailUrl !== undefined ? (thumbnailUrl?.trim() || null) : undefined,
      });
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Course not found' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'course_updated',
        targetType: 'course',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, course: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update course' });
    }
  });

  // ── PATCH /api/admin/courses/:id/publish ── { isPublished: boolean }.
  // Broadcasts a push only on the false -> true transition, so re-toggling
  // or unrelated edits never re-notify every member.
  fastify.patch('/courses/:id/publish', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { isPublished } = (req.body as any) || {};
    if (typeof isPublished !== 'boolean') {
      return reply.status(400).send({ success: false, message: 'isPublished must be a boolean' });
    }

    try {
      const existing = await courseModel.adminGetById(id);
      const before = existing.rows[0];
      if (!before) {
        return reply.status(404).send({ success: false, message: 'Course not found' });
      }

      const result = await courseModel.setPublished(id, isPublished);
      const course = result.rows[0];

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: isPublished ? 'course_published' : 'course_unpublished',
        targetType: 'course',
        targetId: String(id),
        req,
      });

      if (isPublished && !before.is_published) {
        broadcastPushToAllMembers(
          course.title,
          'ନୂଆ କୋର୍ସ ପ୍ରକାଶିତ ହେଲା — ଏବେ ଶିଖନ୍ତୁ',
          { type: 'course', courseId: String(id) }
        ).catch(() => { /* never throws, defensive only */ });
      }

      return reply.send({ success: true, course });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update publish state' });
    }
  });

  // ── DELETE /api/admin/courses/:id ── cascades to its lessons (FK ON DELETE CASCADE)
  fastify.delete('/courses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await courseModel.deleteCourse(id);
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Course not found' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'course_deleted',
        targetType: 'course',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete course' });
    }
  });

  /* ─────────────── LESSONS ────────────── */

  // ── POST /api/admin/courses/:id/lessons ── appended to the end of the list
  fastify.post('/courses/:id/lessons', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { title, platform, externalUrl } = (req.body as any) || {};

    if (!title?.trim() || !platform?.trim() || !externalUrl?.trim()) {
      return reply.status(400).send({ success: false, message: 'title, platform and externalUrl are required' });
    }

    try {
      const course = await courseModel.adminGetById(id);
      if (!course.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Course not found' });
      }

      const result = await courseModel.addLesson({
        courseId: id,
        title: title.trim(),
        platform: platform.trim().toLowerCase(),
        externalUrl: externalUrl.trim(),
      });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'course_lesson_added',
        targetType: 'course',
        targetId: String(id),
        req,
      });

      return reply.status(201).send({ success: true, lesson: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to add lesson' });
    }
  });

  // ── PUT /api/admin/courses/:id/lessons/:lessonId ──
  fastify.put('/courses/:id/lessons/:lessonId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { lessonId } = req.params as any;
    const { title, platform, externalUrl } = (req.body as any) || {};

    try {
      const result = await courseModel.updateLesson(lessonId, {
        title: title?.trim(),
        platform: platform?.trim()?.toLowerCase(),
        externalUrl: externalUrl?.trim(),
      });
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Lesson not found' });
      }
      return reply.send({ success: true, lesson: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update lesson' });
    }
  });

  // ── DELETE /api/admin/courses/:id/lessons/:lessonId ──
  fastify.delete('/courses/:id/lessons/:lessonId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { lessonId } = req.params as any;
    try {
      const result = await courseModel.deleteLesson(lessonId);
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Lesson not found' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'course_lesson_deleted',
        targetType: 'course',
        targetId: String(req.params && (req.params as any).id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete lesson' });
    }
  });
}
