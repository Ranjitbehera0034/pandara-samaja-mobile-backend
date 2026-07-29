import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import { verifyAdmin } from '../middleware/adminAuth';

export default async function adminPostsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/posts ── list/search all portal_posts, any moderation_status
  fastify.get('/posts', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', search } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);

    try {
      const [posts, total] = await Promise.all([
        portalModel.getPostsAdmin({ page: pPage, limit: pLimit, search }),
        portalModel.getPostsAdminCount(search),
      ]);
      return reply.send({
        success: true,
        posts,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch posts' });
    }
  });

  // ── DELETE /api/admin/posts/:id ── permanent delete
  fastify.delete('/posts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await portalModel.deletePostPermanently(id);
      if (!result) return reply.status(404).send({ success: false, message: 'Post not found' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete post' });
    }
  });

  // ── PUT /api/admin/posts/:id/hide ── { hidden: boolean } toggles
  // moderation_status between 'visible'/'hidden_pending_review' without
  // needing an actual report filed.
  fastify.put('/posts/:id/hide', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { hidden } = req.body as any;
    try {
      const result = await portalModel.setPostHidden(id, !!hidden);
      if (!result.ok) {
        return reply.status(503).send({ success: false, message: 'Content moderation column pending migration' });
      }
      if (!result.row) return reply.status(404).send({ success: false, message: 'Post not found' });
      return reply.send({ success: true, post: result.row });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update post visibility' });
    }
  });
}
