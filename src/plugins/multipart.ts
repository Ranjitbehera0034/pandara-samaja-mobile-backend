import fp from 'fastify-plugin';
import fastifyMultipart from '@fastify/multipart';

export default fp(async (fastify) => {
  fastify.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max
      files: 5,
    },
  });
});
