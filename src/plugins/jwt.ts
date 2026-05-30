import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { JWT_SECRET } from '../config/secrets';

export default fp(async (fastify) => {
  fastify.register(fastifyJwt, {
    secret: JWT_SECRET,
  });

  // Decorate with authenticate helper
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      // Ensure it's a member portal token
      if (request.user?.type !== 'member_portal') {
        return reply.status(403).send({ success: false, message: 'Invalid token type' });
      }
    } catch (err) {
      reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
  });
});
