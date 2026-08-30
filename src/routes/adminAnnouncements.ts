import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as blogModel from '../models/blogModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { uploadToFirebase, UPLOAD_PATHS } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';
import pool from '../config/db';

// Admin-gated announcement CRUD. Member-facing GET /api/posts and
// GET /api/posts/:id (src/routes/announcements.ts) stay exactly as-is.
export default async function adminAnnouncementsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/announcements ── admin-scoped list (member-facing
  // GET /api/posts can't be reused here — it's gated to member JWTs only).
  fastify.get('/announcements', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const posts = await blogModel.getAll();
      return reply.send({ success: true, posts });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch announcements' });
    }
  });

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

      // Broadcast to every member — in-app notification + push. An
      // announcement has no single human "actor" the way a like/comment/
      // follow does, and `portal_notifications.actor_id` is NOT NULL with a
      // foreign key to members(membership_no) (no admins table row exists
      // there), so a NULL or admin-id sentinel isn't possible without a
      // schema change. Each recipient row is instead its own actor_id — the
      // FK/NOT NULL constraint is trivially satisfied (every recipient is by
      // definition a valid member) and the existing INNER JOIN in
      // portalModel.getNotifications still resolves. actor_name is set
      // explicitly to a fixed system label — previously this was left unset
      // and the display query's COALESCE(actor_name, members.name) fell
      // through to the joined member row, which (since actor_id ===
      // recipient_id here) resolved to the RECIPIENT'S OWN head of family,
      // so every member saw "<their own head of family> posted" instead of
      // a real, generic label. actor_avatar still resolves to the
      // recipient's own photo via that join — a smaller cosmetic issue than
      // the name one, left for a future pass.
      //
      // Wrapped so a failure here can never fail announcement creation
      // itself — the announcement above has already been created.
      try {
        await pool.query(
          `INSERT INTO portal_notifications (recipient_id, actor_id, type, message, actor_name)
           SELECT membership_no, membership_no, 'announcement', $1, 'New Announcement'
           FROM members
           WHERE is_banned IS NULL OR is_banned = false`,
          [post.title]
        );
        broadcastPushToAllMembers(
          post.title,
          'New community announcement',
          { type: 'announcement' }
        ).catch(() => { /* never throws, defensive only */ });
      } catch (broadcastErr) {
        fastify.log.error(broadcastErr as any, '[ANNOUNCEMENTS] Failed to broadcast new announcement');
      }

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
