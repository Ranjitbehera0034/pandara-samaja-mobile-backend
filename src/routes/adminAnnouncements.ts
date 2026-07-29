import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as blogModel from '../models/blogModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { uploadToFirebase, UPLOAD_PATHS } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

// Admin-gated announcement CRUD. Member-facing GET /api/posts and
// GET /api/posts/:id (src/routes/announcements.ts) stay exactly as-is.
export default async function adminAnnouncementsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── POST /api/admin/announcements ──
  // Multipart: text fields (title, content) + optional 'image'/'video' files.
  fastify.post('/announcements', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['image', 'video']);
      const { title, content } = fields;

      if (!title?.trim()) {
        return reply.status(400).send({ success: false, message: 'Title is required' });
      }

      let imageUrl: string | undefined;
      if (files.image[0]) {
        imageUrl = await uploadToFirebase(files.image[0], UPLOAD_PATHS.ANNOUNCEMENTS());
      }
      let videoUrl: string | undefined;
      if (files.video[0]) {
        videoUrl = await uploadToFirebase(files.video[0], UPLOAD_PATHS.ANNOUNCEMENTS());
      }

      const post = await blogModel.create({
        title: title.trim(),
        content: content || null,
        image_url: imageUrl || null,
        video_url: videoUrl || null,
      });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'announcement_created',
        targetType: 'post',
        targetId: String(post.id),
        req,
      });

      return reply.status(201).send({ success: true, post });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create announcement' });
    }
  });

  // ── PUT /api/admin/announcements/:id ──
  fastify.put('/announcements/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const { files, fields } = await readMultipartFiles(req, ['image', 'video']);
      const { title, content } = fields;

      const data: { title?: string; content?: string; image_url?: string; video_url?: string } = {};
      if (title !== undefined) data.title = title.trim();
      if (content !== undefined) data.content = content;
      if (files.image[0]) data.image_url = await uploadToFirebase(files.image[0], UPLOAD_PATHS.ANNOUNCEMENTS());
      if (files.video[0]) data.video_url = await uploadToFirebase(files.video[0], UPLOAD_PATHS.ANNOUNCEMENTS());

      const post = await blogModel.update(id, data);
      if (!post) return reply.status(404).send({ success: false, message: 'Announcement not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'announcement_updated',
        targetType: 'post',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, post });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update announcement' });
    }
  });

  // ── DELETE /api/admin/announcements/:id ──
  fastify.delete('/announcements/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const removed = await blogModel.remove(id);
      if (!removed) return reply.status(404).send({ success: false, message: 'Announcement not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'announcement_deleted',
        targetType: 'post',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete announcement' });
    }
  });
}
