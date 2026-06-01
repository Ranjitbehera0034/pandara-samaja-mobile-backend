import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as blogModel from '../models/blogModel';

export default async function announcementsRoutes(fastify: FastifyInstance) {

  // All require auth
  fastify.addHook('preHandler', fastify.authenticate);

  /**
   * GET /api/posts
   * Get all admin blog/announcement posts
   * Matches web backend GET /api/posts (blogController.getAll)
   */
  fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const posts = await blogModel.getAll();
      // Web backend returns raw array — match exactly
      return reply.send(posts);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch posts' });
    }
  });

  /**
   * GET /api/posts/:id
   * Get a single announcement
   */
  fastify.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const post = await blogModel.getOne(id);
      if (!post) return reply.status(404).send({ error: 'Post not found' });
      return reply.send(post);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch post' });
    }
  });
}
